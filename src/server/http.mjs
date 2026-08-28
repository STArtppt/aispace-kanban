import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  addProject,
  DEFAULT_TEMPLATE_ID,
  getProject,
  inspectWorkspace,
  listTemplates,
  projectStatus,
  readCreatePrompt,
  readHelpDoc,
  readProjects,
  removeProject,
  resolveTemplate,
  resolveTemplateRoot,
  suggestRelinkCandidates,
  updateProject,
  userTemplatesRoot,
  writeRuntimeInfo,
} from './config.mjs';
import { PYTHON_CANDIDATES, revealInSystem } from './platform.mjs';
import { resolvePrototypeServeDir, scanPrototypes } from './prototypes.mjs';
import { REFERENCES_DIR, resolveReferenceDir, scanReferences } from './references.mjs';
import { scanWorkspace, verifySource } from './scan.mjs';
import { resolveAppVersion } from './version.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../../dist');
const ROOT = path.resolve(HERE, '../..');
const APP_VERSION = resolveAppVersion(ROOT);

/** 大 CSV 行数缓存：key = abs + mtime，避免翻页时反复全量扫 */
const tableRowCountCache = new Map();

/**
 * 每个项目至多一个进行中的 ingest 任务。
 * status: running | done | error；日志只保留尾部，避免 PDF 批量转换时撑爆内存。
 */
const ingestJobs = new Map();
const INGEST_LOG_LIMIT = 32 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/**
 * 从工作空间伺服出去的参考页与原型包**必须**落进不透明源。
 *
 * 这些 HTML 是别人写的（采下来的线上页面、工具产出的包），而看板的接口没有鉴权：
 * 不隔离的话，它们的脚本和 /api/projects/* 同源，可以直接列出你所有登记的工作空间、读任意文件。
 * `sandbox` 指令让响应落进不透明源 —— 页面照常渲染、脚本照常跑，但同源请求、cookie、
 * localStorage 全拿不到；不给 allow-top-navigation，frame-busting 脚本也跳不走外层窗口。
 */
const SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups';

/** 直出一个静态文件。isolate = true 时挂 sandbox 头（伺服工作空间里的页面一律要挂）。 */
function sendStaticFile(res, abs, { isolate = false } = {}) {
  const ext = path.extname(abs).toLowerCase();
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-cache',
  };
  if (isolate) headers['content-security-policy'] = SANDBOX_CSP;
  res.writeHead(200, headers);
  return fs.createReadStream(abs).pipe(res);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/** 把相对路径解回工作空间内的绝对路径，挡掉 ../ 穿越。 */
function resolveInside(root, relPath) {
  const abs = path.resolve(root, relPath || '');
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    const err = new Error('路径超出工作空间范围');
    err.statusCode = 403;
    throw err;
  }
  return abs;
}

/**
 * 按行分页读 CSV/TSV，不把整文件塞进 JSON。
 * 点表主表常有数十 MB / 十几万行，整文接口会 413；看板只需要摘要 + 一页样例。
 * 不做完整 CSV 引号态机：测点表无跨行字段，按行切片后前端再用 Papa 解析当页。
 */
async function readCsvPage(abs, { offset = 0, limit = 50 } = {}) {
  const stats = fs.statSync(abs);
  const cacheKey = `${abs}\0${stats.mtimeMs}`;
  const cachedTotal = tableRowCountCache.get(cacheKey);

  const stream = fs.createReadStream(abs, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let headerLine = '';
  let totalRows = 0;
  const lines = [];
  let seenHeader = false;

  for await (const raw of rl) {
    const line = seenHeader ? raw : raw.replace(/^\uFEFF/, '');
    if (!line.trim()) continue;
    if (!seenHeader) {
      headerLine = line;
      seenHeader = true;
      continue;
    }
    if (totalRows >= offset && lines.length < limit) lines.push(line);
    totalRows += 1;
    // 行数已知且本页已凑齐 → 提前结束，翻页不再扫完全文件
    if (cachedTotal !== undefined && lines.length >= limit && totalRows >= offset + limit) {
      rl.close();
      break;
    }
  }

  const finalTotal = cachedTotal !== undefined ? cachedTotal : totalRows;
  if (cachedTotal === undefined) tableRowCountCache.set(cacheKey, finalTotal);
  // 缓存膨胀时丢掉最旧的一批（本机看板场景极少触发）
  if (tableRowCountCache.size > 64) {
    const first = tableRowCountCache.keys().next().value;
    tableRowCountCache.delete(first);
  }

  return {
    headerLine,
    lines,
    totalRows: finalTotal,
    offset,
    limit,
    size: stats.size,
    mtime: stats.mtime.toISOString(),
  };
}

/** 用指定解释器跑一次初始化脚本。解释器不在 PATH 上时返回 missing，交给外层换下一个。 */
function runInitOnce(bin, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if (err.code === 'ENOENT') return resolve({ missing: true });
      resolve({ ok: false, error: `启动初始化脚本失败：${err.message}` });
    });
    child.on('close', () => {
      try {
        const parsed = JSON.parse(stdout.trim() || stderr.trim());
        resolve(parsed.ok ? { ok: true, root: parsed.root } : { ok: false, error: parsed.error });
      } catch {
        resolve({ ok: false, error: stderr.trim() || stdout.trim() || '初始化脚本没有返回结果' });
      }
    });
  });
}

/** 跑共享的初始化脚本，把它的 JSON 输出捞回来。解释器名各平台不同，挨个试。 */
async function runInit(templatesRoot, fromDir, name, target) {
  const script = [
    path.join(templatesRoot, 'init_workspace.py'),
    '--from', fromDir,
    '--name', name,
    '--path', target,
    '--json',
  ];
  for (const [bin, ...prefix] of PYTHON_CANDIDATES) {
    const result = await runInitOnce(bin, [...prefix, ...script], templatesRoot);
    if (!result.missing) return result;
  }
  return {
    ok: false,
    error: '找不到 Python 3。新建工作空间要靠模板的 init_workspace.py，'
      + '请先装 Python 3（Windows 装完用 py 或 python，macOS / Linux 用 python3），再试一次。',
  };
}

/** 找一个能用的 Python 3。解释器名各平台不同，挨个试到 `--version` 成功为止。 */
function findPython() {
  return new Promise((resolve) => {
    const candidates = [...PYTHON_CANDIDATES];
    const tryNext = () => {
      const next = candidates.shift();
      if (!next) return resolve(null);
      const [bin, ...prefix] = next;
      const child = spawn(bin, [...prefix, '--version'], { stdio: 'ignore' });
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        if (ok) resolve([bin, ...prefix]);
        else tryNext();
      };
      child.on('error', () => done(false));
      child.on('close', (code) => done(code === 0));
    };
    tryNext();
  });
}

/**
 * 从脚本输出里提炼人话。ingest.py 自己会打中文日志，优先复用最后几行；
 * 常见缺依赖场景再补一句「下一步怎么做」。
 */
function summarizeIngestLog(log, exitCode) {
  const text = (log || '').trim();
  const lines = text ? text.split(/\r?\n/).filter(Boolean) : [];
  const tail = lines.slice(-8).join('\n');
  const lower = text.toLowerCase();

  if (/找不到 python|no such file|not found.*python|python was not found/i.test(text)) {
    return {
      message: '找不到 Python 3。请先装 Python 3（Windows 用 py 或 python，macOS / Linux 用 python3），再试一次。',
      log: tail,
    };
  }
  // 必须排在 mineru 那条前面：那条吃的是整段日志，只要任何地方出现过 mineru 和「缺 / 失败」
  // 就会先命中，把「扫描件需 OCR」「找不到 anydoc」说成「检查 token」。
  if (/扫描件需 OCR/.test(text)) {
    return {
      message: '这份 PDF 是扫描件，本地引擎抽不出文字。在工作空间根目录的 .env 里配 MINERU_API_KEY 后会自动走 OCR'
        + '（token 在 https://mineru.net/apiManage 申请）。'
        + (tail ? `\n\n${tail}` : ''),
      log: tail,
    };
  }
  if (/找不到 anydoc/i.test(text)) {
    return {
      message: '找不到 anydoc。看板依赖里应带 @firecrawl/anydoc；自己跑脚本请设置 ANYDOC_BIN 或把 anydoc 放到 PATH。'
        + '不要用 npx（首次会联网下载）。'
        + (tail ? `\n\n${tail}` : ''),
      log: tail,
    };
  }
  if (/mineru|MINERU_API_KEY/i.test(text) && /失败|error|无效|invalid|未配置|缺|401|403|未授权/i.test(text)) {
    return {
      message: 'MinerU 转换失败。检查工作空间根目录的 .env 是否配置了 MINERU_API_KEY'
        + '（可参考 .env.example；token 在 https://mineru.net/apiManage 申请）。'
        + (tail ? `\n\n${tail}` : ''),
      log: tail,
    };
  }
  if (/缺少 markitdown/i.test(text)) {
    return {
      message: '转换需要 markitdown，请先 `pip install \'markitdown[all]\'`，再试一次。'
        + (tail ? `\n\n${tail}` : ''),
      log: tail,
    };
  }
  if (exitCode === 0) {
    // 没文件 / 台账更新 / 兜底：优先用脚本自己打的中文行
    const empty = lines.find((l) => l.includes('input/raw/ 里没有文件'));
    const updated = lines.find((l) => l.includes('台账已更新'));
    return {
      message: empty || updated || '转换完成。',
      log: tail,
    };
  }
  const failLine = [...lines].reverse().find((l) => /失败|有 \d+ 个文件转换失败/.test(l));
  return {
    message: failLine
      || (tail ? `转换脚本异常退出（退出码 ${exitCode}）。\n\n${tail}` : `转换脚本异常退出（退出码 ${exitCode}）。`),
    log: tail,
  };
}

function appendIngestLog(job, chunk) {
  job.log = (job.log || '') + chunk;
  if (job.log.length > INGEST_LOG_LIMIT) {
    job.log = job.log.slice(job.log.length - INGEST_LOG_LIMIT);
  }
}

/**
 * 转换 / 忽略只认 input/raw/ 下真实存在的路径。
 * 相对路径统一成 /，跟 scan 的 rel()、前端 FileItem.path 对齐。
 */
function resolveRawTarget(root, relPath) {
  const raw = typeof relPath === 'string' ? relPath.trim() : '';
  if (!raw) return null;
  const rel = raw.replace(/\\/g, '/');
  const abs = resolveInside(root, rel);
  const rawRoot = path.resolve(root, 'input', 'raw');
  if (abs !== rawRoot && !abs.startsWith(rawRoot + path.sep)) {
    const err = new Error('只能针对 input/raw/ 下的资料');
    err.statusCode = 400;
    throw err;
  }
  if (!fs.existsSync(abs)) {
    const err = new Error(`路径不存在：${rel}`);
    err.statusCode = 404;
    throw err;
  }
  // 目录是允许的：ingest.py 的 paths 参数本来就吃目录；「忽略此目录」也走这里。
  return { abs, rel, isDir: fs.statSync(abs).isDirectory() };
}

/**
 * 把一条模式追加进 input/.ingestignore。
 * 看板只追加一行，不删、不改原件；ingest.py 和 scan.mjs 读的是同一份。
 * 不经过 ingest.py：这不是转换，旧工作空间的脚本也没有写入入口。
 * 模式相对 input/ 写（raw/某目录），跟手改那份文件的约定一致。
 */
function addIgnore(project, relPath) {
  const raw = typeof relPath === 'string' ? relPath.trim() : '';
  if (!raw) {
    const err = new Error('请指定要忽略的文件或目录');
    err.statusCode = 400;
    throw err;
  }
  const target = resolveRawTarget(project.root, raw);
  const rawRoot = path.resolve(project.root, 'input', 'raw');
  if (target.abs === rawRoot) {
    const err = new Error('不能忽略整个 input/raw/，请指定其中的文件或子目录');
    err.statusCode = 400;
    throw err;
  }
  // input/raw/客户版/a.pdf → raw/客户版/a.pdf
  const pattern = target.rel.replace(/^input\//, '').replace(/\/+$/, '');
  const file = path.join(project.root, 'input', '.ingestignore');
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const existing = prev
    .split('\n')
    .map((l) => l.trim().replace(/\/+$/, ''))
    .filter((l) => l && !l.startsWith('#'));
  // 已有更宽的目录模式，或同一行已经写过，就别重复追加
  if (existing.some((p) => pattern === p || pattern.startsWith(`${p}/`))) {
    return { ok: true, pattern, already: true };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = prev
    ? `${prev.endsWith('\n') ? prev : `${prev}\n`}${pattern}\n`
    : `# 忽略清单 —— 不转换、看板上也不算「待转换」\n# 路径相对 input/ 写，例如 raw/某目录 或 raw/某文件.pdf\n\n${pattern}\n`;
  fs.writeFileSync(file, body, 'utf8');
  return { ok: true, pattern, already: false };
}

/**
 * 解析看板自带的 anydoc CLI。找不到就不注入 —— 用户可能自己 npm i -g 了，ingest.py 会走 PATH。
 * 不用 npx：首次会联网下载，把「本地、不外发」这条改动要解决的问题请回来。
 */
function resolveAnydocBin() {
  try {
    return createRequire(import.meta.url).resolve('@firecrawl/anydoc/cli.js');
  } catch {
    return '';
  }
}

/**
 * 在工作空间里异步跑 scripts/ingest.py。
 * 看板只 spawn，真正写 input/converted/ 的是工作空间自己的脚本 —— 与 runInit 同构。
 * 接口立刻返回，进度靠 GET /ingest 轮询；写盘会被 watchWorkspace 捕获，页面自己刷新。
 * relPath 有值时只转它（ingest.py 的 paths 参数，可以是文件也可以是目录）；缺省转整个 input/raw/。
 */
async function startIngest(project, relPath) {
  const existing = ingestJobs.get(project.id);
  if (existing?.status === 'running') {
    const err = new Error('这个工作空间正在转换资料，等这轮结束后再试。');
    err.statusCode = 409;
    throw err;
  }

  const target = resolveRawTarget(project.root, relPath);

  const script = path.join(project.root, 'scripts', 'ingest.py');
  if (!fs.existsSync(script)) {
    const err = new Error(
      '这个工作空间没有 scripts/ingest.py，看板没法替你转换。'
        + '用模板新建工作空间会自带转换脚本；自己 mkdir 的目录需要自己装脚本，'
        + '或在终端里按自己的方式处理 input/raw/。',
    );
    err.statusCode = 400;
    throw err;
  }

  const py = await findPython();
  if (!py) {
    const err = new Error(
      '找不到 Python 3。转换脚本要靠它跑，请先装 Python 3'
        + '（Windows 用 py 或 python，macOS / Linux 用 python3），再试一次。',
    );
    err.statusCode = 400;
    throw err;
  }

  const [bin, ...prefix] = py;
  const job = {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    exitCode: null,
    path: target ? target.rel : '',
    message: target
      ? `正在转换 ${target.rel}${target.isDir ? '/ 下的资料' : ''} … 大 PDF 可能要几分钟。`
      : '正在转换 input/raw/ … 大 PDF 可能要几分钟。',
    log: '',
  };
  ingestJobs.set(project.id, job);

  const args = target ? [...prefix, script, target.rel] : [...prefix, script];
  const env = { ...process.env };
  const anydocBin = resolveAnydocBin();
  if (anydocBin) env.ANYDOC_BIN = anydocBin;
  const child = spawn(bin, args, {
    cwd: project.root,
    env,
  });

  child.stdout.on('data', (chunk) => appendIngestLog(job, chunk.toString()));
  child.stderr.on('data', (chunk) => appendIngestLog(job, chunk.toString()));
  child.on('error', (err) => {
    // spawn 异步失败（解释器中途消失等）：不能让未处理的 error 把常驻服务带崩
    if (job.status !== 'running') return;
    job.status = 'error';
    job.finishedAt = new Date().toISOString();
    job.exitCode = null;
    job.message = err.code === 'ENOENT'
      ? '找不到 Python 3。请先装 Python 3（Windows 用 py 或 python，macOS / Linux 用 python3），再试一次。'
      : `启动转换脚本失败：${err.message}`;
  });
  child.on('close', (code) => {
    if (job.status !== 'running') return;
    const exitCode = code ?? 1;
    job.exitCode = exitCode;
    job.finishedAt = new Date().toISOString();
    const summary = summarizeIngestLog(job.log, exitCode);
    job.message = summary.message;
    job.log = summary.log;
    job.status = exitCode === 0 ? 'done' : 'error';
  });

  return {
    status: job.status,
    startedAt: job.startedAt,
    message: job.message,
    path: job.path || '',
  };
}

function ingestStatus(projectId) {
  const job = ingestJobs.get(projectId);
  if (!job) {
    return { status: 'idle', message: '', startedAt: '', finishedAt: '', exitCode: null, log: '', path: '' };
  }
  return {
    status: job.status,
    message: job.message || '',
    startedAt: job.startedAt || '',
    finishedAt: job.finishedAt || '',
    exitCode: job.exitCode,
    log: job.log || '',
    path: job.path || '',
  };
}

/** 壳页里要拼进 HTML 的都是用户目录名和 meta.json 里的字符串 —— 一律转义。 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SHOT_LABEL = { hero: '首屏', full: '完整页', mobile: '移动端' };

/**
 * 参考查看器：**看板自己的**一张 HTML。
 *
 * iframe 铺满装那份被隔离的 index.html，缩略图和灯箱画在壳上 ——
 * 不能注入进原始页面（那等于给它开口子），也不需要它配合（它在不透明源里，
 * 壳页同样拿不到它的 DOM）。一张截图都没有时整个缩略图区域不渲染。
 */
function renderReferenceViewer({ title, frameUrl, shots }) {
  const cards = shots
    .map(
      (shot, i) => `<button type="button" class="thumb" data-index="${i}" title="${escapeHtml(shot.label)}">`
        + `<img src="${escapeHtml(shot.url)}" alt="${escapeHtml(shot.label)}" loading="lazy">`
        + `<span>${escapeHtml(shot.label)}</span></button>`,
    )
    .join('');
  const shotsJson = JSON.stringify(shots).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · 参考</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0b0b0c; }
  iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
  .bar {
    position: fixed; left: 16px; bottom: 16px; z-index: 10;
    display: flex; align-items: flex-end; gap: 8px;
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .thumb {
    display: flex; flex-direction: column; gap: 4px; align-items: center;
    padding: 6px; border: 1px solid rgba(255,255,255,.18); border-radius: 8px;
    background: rgba(20,20,22,.82); color: rgba(255,255,255,.78);
    backdrop-filter: blur(8px); cursor: pointer;
  }
  .thumb:hover { border-color: rgba(255,255,255,.45); color: #fff; }
  .thumb img { width: 104px; height: 66px; object-fit: cover; object-position: top center; border-radius: 4px; background: #fff; }
  .exit {
    padding: 7px 10px; border: 1px solid rgba(255,255,255,.18); border-radius: 8px;
    background: rgba(20,20,22,.82); color: rgba(255,255,255,.78);
    backdrop-filter: blur(8px); text-decoration: none; white-space: nowrap;
  }
  .exit:hover { border-color: rgba(255,255,255,.45); color: #fff; }
  /* 不透明：底下装的是别人的页面，半透明会把它的正文透上来，图就看不清了 */
  .box { position: fixed; inset: 0; z-index: 20; display: none; background: #0b0b0c; }
  .box[data-open="1"] { display: flex; flex-direction: column; }
  .box header {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 12px 16px; color: rgba(255,255,255,.8);
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
  }
  .box .body { flex: 1; min-height: 0; overflow: auto; padding: 0 16px 16px; text-align: center; }
  .box .body img { max-width: 100%; border-radius: 6px; background: #fff; }
  .box nav { display: flex; gap: 6px; }
  .box button {
    padding: 5px 10px; border: 1px solid rgba(255,255,255,.2); border-radius: 6px;
    background: transparent; color: rgba(255,255,255,.8); cursor: pointer; font: inherit;
  }
  .box button:hover { border-color: rgba(255,255,255,.5); color: #fff; }
</style>
</head>
<body>
<iframe src="${escapeHtml(frameUrl)}" title="${escapeHtml(title)}"></iframe>
<div class="bar">
  ${cards}
  <a class="exit" href="${escapeHtml(frameUrl)}" target="_blank" rel="noreferrer">直接打开原始页面</a>
</div>
<div class="box" id="box" data-open="0">
  <header>
    <span id="box-label"></span>
    <nav>
      <button type="button" id="prev">上一张</button>
      <button type="button" id="next">下一张</button>
      <button type="button" id="close">关闭</button>
    </nav>
  </header>
  <div class="body"><img id="box-img" alt=""></div>
</div>
<script>
  var shots = ${shotsJson};
  var box = document.getElementById('box');
  var img = document.getElementById('box-img');
  var label = document.getElementById('box-label');
  var at = 0;
  function show(i) {
    if (!shots.length) return;
    at = (i + shots.length) % shots.length;
    img.src = shots[at].url;
    img.alt = shots[at].label;
    label.textContent = shots[at].label + '（' + (at + 1) + '/' + shots.length + '）';
    box.dataset.open = '1';
  }
  // 灯箱只是盖在 iframe 上，关掉后里面的页面状态不动（从没卸载过）
  function hide() { box.dataset.open = '0'; }
  Array.prototype.forEach.call(document.querySelectorAll('.thumb'), function (el) {
    el.addEventListener('click', function () { show(Number(el.dataset.index)); });
  });
  document.getElementById('prev').addEventListener('click', function () { show(at - 1); });
  document.getElementById('next').addEventListener('click', function () { show(at + 1); });
  document.getElementById('close').addEventListener('click', hide);
  box.addEventListener('click', function (e) { if (e.target === box) hide(); });
  document.addEventListener('keydown', function (e) {
    if (box.dataset.open !== '1') return;
    if (e.key === 'Escape') hide();
    if (e.key === 'ArrowLeft') show(at - 1);
    if (e.key === 'ArrowRight') show(at + 1);
  });
</script>
</body>
</html>`;
}

function requireProject(id) {
  const project = getProject(id);
  if (!project) {
    const err = new Error(`没有登记过的项目：${id}`);
    err.statusCode = 404;
    throw err;
  }
  return project;
}

/**
 * 监听工作空间的资料、产出与视觉目录，变了就通过 SSE 推给前端。
 *
 * `visualization/` 整树（覆盖 references/ 与 prototypes/ 两个子目录）：
 * 参考或原型包增删、zip 替换后都要推。它**可能启动时还不存在** —— 老工作空间要等用户
 * 手工 `mv` 才有，采集也是第一次采才建。所以再非递归地看一眼工作空间根，
 * 这个目录冒出来时补挂递归 watcher，用户跑完 mv 不用重启服务就能看到卡片。
 */
function watchWorkspace(root, onChange) {
  const watchers = [];
  const watched = new Set();

  function watchTree(dir) {
    const abs = path.join(root, dir);
    if (watched.has(dir) || !fs.existsSync(abs)) return;
    try {
      watchers.push(fs.watch(abs, { recursive: true }, onChange));
      watched.add(dir);
    } catch {
      // 平台不支持 recursive 就退化成不监听，前端还有手动刷新
    }
  }

  for (const dir of ['input', 'output', 'visualization']) watchTree(dir);

  // 根上（非递归）：捕获 input / output / visualization 启动后才被创建的情况
  try {
    watchers.push(
      fs.watch(root, (event, name) => {
        if (name === 'visualization' || name === 'input' || name === 'output') watchTree(String(name));
        onChange(event, name);
      }),
    );
  } catch {
    /* 同上 */
  }

  for (const file of ['project.yaml', 'project.yml']) {
    const abs = path.join(root, file);
    if (fs.existsSync(abs)) {
      try {
        watchers.push(fs.watch(abs, onChange));
      } catch {
        /* 同上 */
      }
    }
  }
  return () => watchers.forEach((w) => w.close());
}

function serveStatic(req, res, urlPath) {
  if (!fs.existsSync(DIST)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('前端还没构建。开发时请跑 pnpm dev（会自动起 Vite），或先 pnpm build。');
    return;
  }
  let abs = path.join(DIST, urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath));
  if (!abs.startsWith(DIST)) abs = path.join(DIST, 'index.html');
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) abs = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
}

/** 路径段可能是百分号编码的 —— 项目 id 取自目录名，中文目录很常见。坏编码就按原样用。 */
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * 会起子进程或写盘的接口：监听非环回地址时一律拒绝。
 * 看板没有鉴权，`--host 0.0.0.0` 是给评审只读分享用的，不能变成局域网里的可执行入口。
 */
function rejectIfRemoteWrite(res, allowMutations) {
  if (allowMutations) return false;
  json(res, 403, {
    error: '当前服务监听的不是本机回环地址，已禁用会改动本机状态的操作'
      + '（新建 / 登记 / 转换资料等）。只读浏览不受影响；'
      + '要在看板里操作，请用默认的 127.0.0.1 再起一次服务。',
  });
  return true;
}

async function handleApi(req, res, url, { allowMutations = true } = {}) {
  const segments = url.pathname.split('/').filter(Boolean).slice(1).map(decodeSegment); // 去掉 'api'
  const [head, id, action] = segments;

  // platform 给前端定文案用（"在访达中显示" 还是 "在文件资源管理器中显示"）——
  // 定位动作发生在**服务所在的机器**上，所以不能拿浏览器的 navigator 判断。
  // version 可选：老服务进程没有，侧栏缺了就不显示，退回改动前的行为。
  if (head === 'health') {
    return json(res, 200, { ok: true, platform: process.platform, version: APP_VERSION });
  }

  if (head === 'projects' && !id) {
    if (req.method === 'GET') {
      const data = readProjects();
      // 带上每条的健康度，侧栏才能把「目录不在了」直接标出来
      return json(res, 200, {
        ...data,
        projects: data.projects.map((p) => ({ ...p, status: projectStatus(p) })),
      });
    }
    if (req.method === 'POST') {
      if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
      const body = await readBody(req);
      const project = addProject(body.root, body.name);
      return json(res, 200, project);
    }
  }

  if (head === 'projects' && id && !action) {
    if (req.method === 'DELETE') {
      if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
      return json(res, 200, { removed: removeProject(id) });
    }
    if (req.method === 'PATCH') {
      if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
      const body = await readBody(req);
      return json(res, 200, updateProject(id, { root: body.root, name: body.name }));
    }
    if (req.method === 'GET') {
      const project = requireProject(id);
      return json(res, 200, { ...project, status: projectStatus(project) });
    }
  }

  // 目录丢了以后的重连候选：原父目录下还没登记过的工作空间
  if (head === 'projects' && id && action === 'candidates') {
    const project = requireProject(id);
    return json(res, 200, { candidates: suggestRelinkCandidates(project.root) });
  }

  if (head === 'inspect') {
    return json(res, 200, inspectWorkspace(url.searchParams.get('root') || ''));
  }

  if (head === 'help') {
    const text = readHelpDoc();
    return json(res, 200, { ok: Boolean(text), text });
  }

  if (head === 'template') {
    const root = resolveTemplateRoot();
    return json(res, 200, { root, ok: Boolean(root) });
  }

  if (head === 'templates') {
    const root = resolveTemplateRoot();
    const templates = listTemplates().map(({ id, name, description, builtin }) => ({
      id,
      name,
      description,
      builtin,
    }));
    return json(res, 200, {
      templates,
      userRoot: userTemplatesRoot(),
      createPrompt: readCreatePrompt(),
      root,
      ok: Boolean(root) || templates.length > 0,
    });
  }

  // 新建工作空间：调共享 init_workspace.py 铺选中的模板，建完自动登记
  if (head === 'workspaces' && req.method === 'POST') {
    if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
    const body = await readBody(req);
    const name = (body.name || '').trim();
    const target = (body.path || '').trim();
    if (!name || !target) return json(res, 400, { error: '名称和路径都要填' });
    const templatesRoot = resolveTemplateRoot();
    if (!templatesRoot) {
      return json(res, 500, {
        error: '找不到工作空间模板。它应该在看板仓库的 templates/ 下，或用 PMWORK_TEMPLATE_ROOT 环境变量指过去。',
      });
    }
    const templateId = (body.template || DEFAULT_TEMPLATE_ID).trim();
    const tpl = resolveTemplate(templateId);
    if (!tpl) {
      return json(res, 400, { error: `没有这个模板：${templateId}` });
    }
    const result = await runInit(templatesRoot, tpl.root, name, target);
    if (!result.ok) return json(res, 400, { error: result.error });
    const project = addProject(result.root, name);
    return json(res, 200, project);
  }

  if (head === 'projects' && id && action === 'scan') {
    const project = requireProject(id);
    const status = projectStatus(project);
    return json(res, 200, scanWorkspace(project, status));
  }

  if (head === 'projects' && id && action === 'prototypes') {
    const project = requireProject(id);
    return json(res, 200, scanPrototypes(project.root, project.id));
  }

  if (head === 'projects' && id && action === 'references') {
    const project = requireProject(id);
    return json(res, 200, scanReferences(project.root, project.id));
  }

  // 伺服工具产出的可点击 HTML 包（文件夹或已解压到缓存的 zip）
  // 路径：/api/projects/:id/proto/:slug[/...相对路径]
  // url 形态的原型不走这里 —— 它没有本地产物，前端直接开 target。
  if (head === 'projects' && id && action === 'proto') {
    const project = requireProject(id);
    const slug = segments[3] || '';
    if (!slug) return json(res, 400, { error: '缺少原型包标识' });
    const serveDir = resolvePrototypeServeDir(project.root, slug);
    if (!serveDir) return json(res, 404, { error: '找不到这个原型包' });
    const relParts = segments.slice(4);
    const relFile = relParts.length ? relParts.join('/') : 'index.html';
    // 挡 ../ 穿越：只能落在 serveDir 内
    const abs = path.resolve(serveDir, relFile);
    const base = path.resolve(serveDir);
    if (abs !== base && !abs.startsWith(base + path.sep)) {
      return json(res, 403, { error: '路径超出原型包范围' });
    }
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      return json(res, 404, { error: '文件不存在' });
    }
    // 别人做的包，一律关进不透明源
    return sendStaticFile(res, abs, { isolate: true });
  }

  // 伺服参考页：/api/projects/:id/ref/:slug[/...相对路径]
  //   .../view  → 看板自己的查看器壳页（同源，带缩略图与灯箱）
  //   其余      → visualization/references/<slug>/ 下的静态文件，HTML 带 sandbox 头
  if (head === 'projects' && id && action === 'ref') {
    const project = requireProject(id);
    const slug = segments[3] || '';
    if (!slug) return json(res, 400, { error: '缺少参考标识' });
    const refDir = resolveReferenceDir(project.root, slug);
    if (!refDir) return json(res, 404, { error: '找不到这份参考' });
    const relParts = segments.slice(4);

    if (relParts.length === 1 && relParts[0] === 'view') {
      const listed = scanReferences(project.root, project.id);
      const item = listed.items.find((i) => i.itemKey === slug);
      if (!item) return json(res, 404, { error: '找不到这份参考' });
      const shots = ['hero', 'full', 'mobile']
        .filter((k) => item.screenshots[k])
        .map((k) => ({ key: k, label: SHOT_LABEL[k], url: item.screenshots[k] }));
      const body = renderReferenceViewer({
        title: item.title,
        frameUrl: `/api/projects/${encodeURIComponent(project.id)}/ref/${encodeURIComponent(slug)}/index.html`,
        shots,
      });
      // 壳页是看板自己的 HTML，不带 sandbox —— 被它装载的 index.html 才带
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'content-length': Buffer.byteLength(body),
      });
      return res.end(body);
    }

    const relFile = relParts.length ? relParts.join('/') : 'index.html';
    // 两道闸：先保证没跑出工作空间，再保证没跑出这份参考自己的目录
    const abs = resolveInside(project.root, path.join(REFERENCES_DIR, slug, relFile));
    const base = path.resolve(refDir);
    if (abs !== base && !abs.startsWith(base + path.sep)) {
      const err = new Error('路径超出参考目录范围');
      err.statusCode = 403;
      throw err;
    }
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      return json(res, 404, { error: '文件不存在' });
    }
    // 采下来的页面是别人写的，一律关进不透明源（截图是普通静态资源，挂着也无害）
    return sendStaticFile(res, abs, { isolate: true });
  }

  // 读文件正文：md / csv / txt 走这里，图片也走这里（按 MIME 直出）
  if (head === 'projects' && id && action === 'file') {
    const project = requireProject(id);
    const abs = resolveInside(project.root, url.searchParams.get('path'));
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return json(res, 404, { error: '文件不存在' });
    const ext = path.extname(abs).toLowerCase();
    const mime = MIME[ext];
    // 图片等二进制直出；html/htm 也直出，供 iframe 预览单文件原型（不要包成 JSON）
    const rawStream = mime && (!mime.startsWith('text') || ext === '.html' || ext === '.htm');
    if (rawStream) {
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' });
      return fs.createReadStream(abs).pipe(res);
    }
    const stats = fs.statSync(abs);
    // 大 CSV 请走 /table 分页；其它大文本仍建议系统打开，避免一次 JSON 几十 MB
    if (stats.size > 4 * 1024 * 1024) {
      if (ext === '.csv' || ext === '.tsv') {
        return json(res, 413, {
          error: '表格文件较大，请用分页预览接口打开',
          code: 'USE_TABLE_API',
        });
      }
      return json(res, 413, { error: '文件太大，请用系统程序打开' });
    }
    return json(res, 200, {
      path: url.searchParams.get('path'),
      size: stats.size,
      mtime: stats.mtime.toISOString(),
      content: fs.readFileSync(abs, 'utf8'),
    });
  }

  // 表格分页：点表主表等大 CSV 只返回表头 + 一页行，附总行数
  if (head === 'projects' && id && action === 'table') {
    const project = requireProject(id);
    const relPath = url.searchParams.get('path') || '';
    const abs = resolveInside(project.root, relPath);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return json(res, 404, { error: '文件不存在' });
    const ext = path.extname(abs).toLowerCase();
    if (ext !== '.csv' && ext !== '.tsv') {
      return json(res, 400, { error: '只支持预览 .csv / .tsv 表格' });
    }
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const page = await readCsvPage(abs, { offset, limit });
    return json(res, 200, { path: relPath, ...page });
  }

  // 按需校验溯源：重算原件的 sha256 跟产物记的比。扫描只看 mtime（快但会误报），
  // 这里是用户点了「校验原件」才跑的坐实手段，一次只算一份。
  if (head === 'projects' && id && action === 'verify-source') {
    const project = requireProject(id);
    const relPath = url.searchParams.get('path') || '';
    resolveInside(project.root, relPath);
    return json(res, 200, await verifySource(project.root, relPath));
  }

  // 交给系统：在访达里定位，或用默认程序打开原始文档
  if (head === 'projects' && id && action === 'reveal' && req.method === 'POST') {
    // 起系统进程只在服务所在机器上有意义；远程分享场景禁掉，避免被当成任意 open 入口
    if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
    const project = requireProject(id);
    const body = await readBody(req);
    const abs = resolveInside(project.root, body.path);
    if (!fs.existsSync(abs)) return json(res, 404, { error: '文件不存在' });
    revealInSystem(abs, body.mode);
    return json(res, 200, { ok: true, path: abs });
  }

  // 触发工作空间自己的 scripts/ingest.py：看板只 spawn，不直接写盘
  if (head === 'projects' && id && action === 'ingest') {
    const project = requireProject(id);
    if (req.method === 'GET') {
      return json(res, 200, ingestStatus(project.id));
    }
    if (req.method === 'POST') {
      if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
      const body = await readBody(req);
      const started = await startIngest(project, body.path);
      return json(res, 200, started);
    }
  }

  // 往 input/.ingestignore 追加一行：用户在待转换列表点「忽略」时走这里
  if (head === 'projects' && id && action === 'ignore' && req.method === 'POST') {
    if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
    const project = requireProject(id);
    const body = await readBody(req);
    return json(res, 200, addIgnore(project, body.path));
  }

  if (head === 'projects' && id && action === 'events') {
    const project = requireProject(id);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    let timer = null;
    const stop = watchWorkspace(project.root, () => {
      clearTimeout(timer);
      timer = setTimeout(() => res.write(`event: change\ndata: ${Date.now()}\n\n`), 300);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clearTimeout(timer);
      stop();
    });
    return undefined;
  }

  return json(res, 404, { error: `未知接口：${url.pathname}` });
}

/**
 * @param {{ devOrigin?: string, allowMutations?: boolean }} [opts]
 * allowMutations：监听环回地址时为 true（默认）；`--host 0.0.0.0` 时由 CLI 传 false，
 * 禁掉会起子进程 / 写注册表的接口，只读分享不受影响。
 */
export function createServer({ devOrigin = '', allowMutations = true } = {}) {
  // 每次起服务刷新一次：让终端里跑 scripts/ingest.py 的人也能找到本地 anydoc，
  // 不必手配 ANYDOC_BIN。写的是看板自己的配置目录，不碰工作空间。
  // 连 node 自身的路径一起记：anydoc 的 npm 包入口是 cli.js，没有 node 就跑不起来，
  // 而 agent 的非交互 shell 里 nvm / volta 装的 node 常常不在 PATH 上。
  writeRuntimeInfo({
    anydocBin: resolveAnydocBin(),
    node: process.execPath,
    version: APP_VERSION,
  });
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(req, res, url, { allowMutations });
      }
    } catch (err) {
      return json(res, err.statusCode || 500, { error: err.message });
    }
    if (devOrigin) {
      res.writeHead(302, { location: devOrigin + url.pathname + url.search });
      return res.end();
    }
    return serveStatic(req, res, url.pathname);
  });
}
