/**
 * 提炼 Word 模板、把产出 .md 转成 Word：参数校验与 spawn 的唯一收口。
 *
 * **AGENTS.md 不变量 1 的第九条窄例外**（「看板只 spawn，工作空间脚本写盘」一族，与第七条同构）：
 * - 看板只 spawn 工作空间的 `scripts/docx_template.py` / `scripts/md2docx.py`，自己不写、不 rename、不 unlink 任何一个字节；
 * - 请求**不带任何路径**：来源只用扫描时下发的 `docKey` 指定，这里重新走目录反查，查不到 400；
 *   模板名只接受一层基名；决定 JSON 限 256KB、拒绝路径类键名，经 stdin 交给脚本（脚本再校验结构）；
 * - 同名 `.docx` 没有生成标记一律 409，带标记也要用户确认 `overwrite`（脚本再校验一次）；
 * - 同步等脚本退出、带超时；同一模板 / 同一目标文件在前一个没结束时直接 409。
 * 环回与跨站两道闸在 http.mjs 的路由上（`allowMutations` + `rejectIfForeignOrigin`）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DOCX_TEMPLATE_DIR } from './docxTemplates.mjs';
import { readDocxMarker } from './docxMarker.mjs';
import { resolveInside } from './paths.mjs';
import { findPandoc, findPython } from './platform.mjs';
import { findDocByKey } from './scan.mjs';

const TIMEOUT_MS = { collect: 60_000, build: 120_000, convert: 120_000 };
const MAX_DECISIONS_BYTES = 256 * 1024;
const FORBIDDEN_KEY = /path|file|dir|folder|url/i;
const BAD_NAME_CHARS = /[/\\:*?"<>|\0]/;
export const BASE_TEMPLATE = '@base';

/** 进行中的模板名 / 目标文件：同一目标的第二个请求直接 409，不排队。 */
const busyTemplates = new Set();
const busyTargets = new Set();

function httpError(status, message, kind) {
  const err = new Error(message);
  err.statusCode = status;
  if (kind) err.kind = kind;
  return err;
}

/** 与 scripts/docx_template.py 的 check_name 同一规则（两边各拦一次）。 */
export function assertTemplateName(name) {
  const wanted = typeof name === 'string' ? name : '';
  if (!wanted || wanted !== wanted.trim() || wanted.startsWith('.') || wanted.includes('..')
      || BAD_NAME_CHARS.test(wanted) || wanted.length > 80) {
    throw httpError(400, `模板名不合法：${wanted || '(空)'}。只接受一层目录名：不以 . 开头，不含 / \\ : * ? " < > | 和 ..，不超过 80 字。`, 'bad-name');
  }
  return wanted;
}

function scanForbidden(value, where = '决定') {
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanForbidden(v, `${where}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(k)) throw httpError(400, `${where} 里不允许出现路径类字段：${k}`, 'bad-decisions');
      scanForbidden(v, `${where}.${k}`);
    }
  } else if (typeof value === 'string' && /[/\\]|\.\./.test(value)) {
    throw httpError(400, `${where} 的值不能含路径分隔符：${value}`, 'bad-decisions');
  }
}

/** 服务端只查大小和键名，结构交给脚本校验（决定的口径只写在 docxkit/decisions.py 一份）。 */
export function checkDecisions(decisions) {
  const dec = decisions ?? {};
  if (typeof dec !== 'object' || Array.isArray(dec)) throw httpError(400, '决定必须是一个 JSON 对象', 'bad-decisions');
  const text = JSON.stringify(dec);
  if (Buffer.byteLength(text) > MAX_DECISIONS_BYTES) throw httpError(400, '决定超过 256KB', 'bad-decisions');
  scanForbidden(dec);
  return text;
}

function requireScript(root, file) {
  const abs = path.join(root, 'scripts', file);
  if (!fs.existsSync(abs) || !fs.existsSync(path.join(root, 'scripts', 'docxkit'))) {
    throw httpError(400,
      `这个工作空间还没有 docx 工具链（缺 scripts/${file} 或 scripts/docxkit/），看板没法替你转换。`
        + '用「复制提示词」让工作空间 AI 从看板模板补齐 scripts/docx_template.py、scripts/md2docx.py 和 scripts/docxkit/，'
        + '或手动从看板仓库的 templates/pm-aispace/scripts/ 复制过去。',
      'no-script');
  }
  return abs;
}

async function requirePython() {
  const py = await findPython();
  if (!py) {
    throw httpError(400, '找不到 Python 3。docx 工具链要靠它跑，请先装 Python 3'
      + '（Windows 用 py 或 python，macOS / Linux 用 python3），再试一次。', 'no-python');
  }
  return py;
}

function resolveDoc(root, kind, docKey) {
  const rel = findDocByKey(root, kind, docKey);
  if (!rel) {
    throw httpError(400, kind === 'raw-docx'
      ? '在 input/raw/ 里找不到这份 Word（列表可能已经变了），刷新后重新选择。'
      : '在产出文档里找不到这份 .md（列表可能已经变了），刷新后再试。', 'stale-key');
  }
  return { rel, abs: resolveInside(root, rel) };
}

/**
 * spawn 一个工作空间脚本并同步等它退出。返回解析后的最后一行 JSON；
 * 退出码按脚本约定映射：2 → 400，3 → 409，4 → 400（缺依赖），其余 → 500。
 */
async function runScript(root, script, args, { input, timeoutMs, label }) {
  const [bin, ...prefix] = await requirePython();
  const result = await new Promise((resolve) => {
    const child = spawn(bin, [...prefix, script, ...args, '--json'], {
      cwd: root,
      windowsHide: true,
      // Windows 上 Python 默认按代码页输出，脚本自己也会 reconfigure，这里再兜一层
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    // spawn 异步失败不能变成未处理的 error 把常驻服务带崩
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `启动脚本失败：${err.message}`, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.on('error', () => { /* 脚本提前退出时写 stdin 会 EPIPE，结果以退出码为准 */ });
    child.stdin.end(input ?? '');
  });

  if (result.timedOut) {
    throw httpError(500, `${label}超过 ${timeoutMs / 1000} 秒没有结束，已经终止。文档很大时请在终端里跑同一条命令：`
      + `python3 scripts/${path.basename(script)} ${args.join(' ')}`, 'timeout');
  }
  const lastLine = result.stdout.trim().split(/\r?\n/).pop() || '';
  let parsed = null;
  try { parsed = JSON.parse(lastLine); } catch { /* 下面按没有 JSON 处理 */ }
  if (result.code === 0) {
    if (parsed?.ok) return parsed;
    // 退出 0 却没给 JSON：大概率是被人改过的旧版脚本。文件可能已经写了，如实说
    throw httpError(500, `${label}的脚本退出了，但没有给出结果。去目录里看一眼，或在终端里重跑。`, 'no-result');
  }
  const message = parsed?.error
    ? `${parsed.error}${parsed.hint ? `。${parsed.hint}` : ''}`
    : (result.stderr.trim().split(/\r?\n/).slice(-3).join(' ') || `${label}失败，脚本退出码 ${result.code}`);
  const status = result.code === 2 || result.code === 4 ? 400 : result.code === 3 ? 409 : 500;
  throw httpError(status, message, parsed?.kind || (result.code === 4 ? 'no-pandoc' : undefined));
}

async function exclusive(set, key, fn) {
  if (set.has(key)) throw httpError(409, '同一个目标正在处理中，等它结束再试。', 'busy');
  set.add(key);
  try {
    return await fn();
  } finally {
    set.delete(key);
  }
}

/** POST docx-templates/:name/collect  载荷 { docKey, regenerate? } */
export async function runDocxCollect(project, name, body) {
  const root = project.root;
  const tname = assertTemplateName(name);
  const src = resolveDoc(root, 'raw-docx', body?.docKey);
  const script = requireScript(root, 'docx_template.py');
  const tdir = resolveInside(root, `${DOCX_TEMPLATE_DIR}/${tname}`);
  if (fs.existsSync(tdir) && body?.regenerate !== true) {
    throw httpError(409, `模板「${tname}」已存在。确认要重新提炼就勾选「重新生成」。`, 'name-taken');
  }
  const args = ['collect', src.rel, '--name', tname, ...(body?.regenerate === true ? ['--regenerate'] : [])];
  return exclusive(busyTemplates, `${root}\0${tname}`, () =>
    runScript(root, script, args, { timeoutMs: TIMEOUT_MS.collect, label: '采集' }));
}

/** POST docx-templates/:name/build  载荷 { docKey, decisions, regenerate? } */
export async function runDocxBuild(project, name, body) {
  const root = project.root;
  const tname = assertTemplateName(name);
  const src = resolveDoc(root, 'raw-docx', body?.docKey);
  const input = checkDecisions(body?.decisions);
  const script = requireScript(root, 'docx_template.py');
  const ref = resolveInside(root, `${DOCX_TEMPLATE_DIR}/${tname}/reference.docx`);
  if (fs.existsSync(ref) && body?.regenerate !== true) {
    throw httpError(409, `模板「${tname}」已经生成过。确认要覆盖就勾选「重新生成」。`, 'name-taken');
  }
  const args = ['build', '--name', tname, '--source', src.rel, '--decisions', '-',
    ...(body?.regenerate === true ? ['--regenerate'] : [])];
  return exclusive(busyTemplates, `${root}\0${tname}`, () =>
    runScript(root, script, args, { input, timeoutMs: TIMEOUT_MS.build, label: '生成模板' }));
}

/** POST docx/convert  载荷 { docKey, template, overwrite? } */
export async function runDocxConvert(project, body) {
  const root = project.root;
  const src = resolveDoc(root, 'output-md', body?.docKey);
  const template = body?.template === BASE_TEMPLATE ? BASE_TEMPLATE : assertTemplateName(body?.template);
  const script = requireScript(root, 'md2docx.py');
  if (template !== BASE_TEMPLATE) {
    const ref = resolveInside(root, `${DOCX_TEMPLATE_DIR}/${template}/reference.docx`);
    if (!fs.existsSync(ref)) {
      throw httpError(400, `模板「${template}」不存在或还没生成。去工作台「模版洗炼」生成它，或改用通用规范。`, 'no-template');
    }
  }
  const targetRel = src.rel.replace(/\.md$/i, '.docx');
  const target = resolveInside(root, targetRel);
  if (fs.existsSync(target)) {
    if (readDocxMarker(target) === null) {
      throw httpError(409, '同名的 Word 不是本工具生成的，为避免覆盖人工修改，请先改名或移走。', 'not-generated');
    }
    if (body?.overwrite !== true) {
      throw httpError(409, `${path.basename(targetRel)} 已存在。确认要替换就勾选「覆盖」（在 Word 里对它做过的修改会丢掉）。`, 'exists');
    }
  }
  const pandoc = await findPandoc(root);
  if (!pandoc.bin) {
    throw httpError(400, pandoc.version
      ? `本机的 pandoc 版本过低（${pandoc.version}），需要 3 以上。装好后重启看板；也可以用「复制提示词」。`
      : '本机没有 pandoc 3，装好后重启看板；也可以用「复制提示词」交给工作空间 AI。', 'no-pandoc');
  }
  const args = [src.rel, '--template', template, ...(body?.overwrite === true ? ['--overwrite'] : [])];
  return exclusive(busyTargets, target, () =>
    runScript(root, script, args, { timeoutMs: TIMEOUT_MS.convert, label: '转换' }));
}

/** `/api/health` 的可选字段 docxTools：Python、pandoc 是否可用。给了工作空间就把它的 .env 也算上。 */
export async function docxToolsHealth(root) {
  const [py, pandoc] = await Promise.all([findPython(), findPandoc(root)]);
  const out = { python: Boolean(py), pandoc: Boolean(pandoc.bin), pandocVersion: pandoc.version || null };
  if (root) {
    const has = (f) => fs.existsSync(path.join(root, 'scripts', f));
    out.scripts = has('docx_template.py') && has('md2docx.py') && has('docxkit');
  }
  return out;
}
