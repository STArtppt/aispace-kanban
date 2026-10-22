/**
 * 交付稿定稿：弹系统选文件框、发一次性令牌、确认后 spawn 工作空间脚本。
 *
 * **AGENTS.md 不变量 1 的第十条窄例外**（spawn 族，与第九条同构）：
 * - 看板只 spawn 工作空间的 `scripts/finalize_delivery.py`，自己不写、不 rename、不 unlink 任何一个字节；
 * - 请求**不带任何路径**：原稿只用 `docKey`；选中文件的绝对路径只存在这里的内存 `tokens`，前端只拿令牌
 *   （10 分钟有效、用一次即废，且必须属于同一个工作空间）。确认时可附 ≤60 字的单行备注，只作为文本交给脚本；
 * - 这是唯一会读工作空间以外文件的例外：读的是脚本，只读用户在系统选文件框里亲手选中的那一个 `.docx`；
 *   这里不提供任何「按路径读外部文件」的能力；
 * - 同步等脚本退出、带超时；同一份原稿的定稿进行中第二个请求 409；同一时间只弹一个选文件框，第二个 409。
 * 环回与跨站两道闸在 http.mjs 的路由上（`allowMutations` + `rejectIfForeignOrigin`）。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { exclusive, requirePython, runScript } from './docxTools.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { resolveInside } from './paths.mjs';
import { pickDocxFile } from './platform.mjs';
import { deliveryDirOf, findDocByKey } from './scan.mjs';

export const FINAL_MD = '定稿.md';
const SCRIPT = 'finalize_delivery.py';
const TOKEN_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 120_000;
const NOTE_MAX = 60;

/** token → { root, source, abs, expires } */
const tokens = new Map();
const busySources = new Set();
let picking = false;

function httpError(status, message, kind) {
  const err = new Error(message);
  err.statusCode = status;
  if (kind) err.kind = kind;
  return err;
}

function requireScript(root) {
  const abs = path.join(root, 'scripts', SCRIPT);
  if (!fs.existsSync(abs) || !fs.existsSync(path.join(root, 'scripts', 'docxkit'))) {
    throw httpError(400, `这个工作空间还没有定稿脚本（scripts/${SCRIPT}），先更新工作空间模板`
      + '（让工作空间 AI 走 pm-template-update），再来定稿。', 'no-script');
  }
  return abs;
}

function resolveSource(root, docKey) {
  const source = findDocByKey(root, 'output-md', docKey);
  if (!source) throw httpError(400, '在产出文档里找不到这份原稿（列表可能已经变了），刷新后再试。', 'stale-key');
  return { source, mirror: deliveryDirOf(source) };
}

/** 与脚本 clean_note 同一口径：换行与 `|` 换成空格、压空白；超长 400。 */
function cleanNote(raw) {
  if (raw != null && typeof raw !== 'string') throw httpError(400, '备注必须是文字', 'bad-note');
  const text = String(raw ?? '').replace(/[\r\n|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if ([...text].length > NOTE_MAX) throw httpError(400, `备注超过 ${NOTE_MAX} 字，删短一点再试。`, 'bad-note');
  return text;
}

function realpath(abs) {
  try {
    return fs.realpathSync(abs);
  } catch {
    return null;
  }
}

/** 上一份 定稿.md 的 history 行数（= 已定稿次数）。读不到当 0。 */
function finalCount(root, mirror) {
  try {
    const { meta } = parseFrontmatter(fs.readFileSync(resolveInside(root, `${mirror}/${FINAL_MD}`), 'utf8'));
    return Array.isArray(meta.history) ? meta.history.length : 0;
  } catch {
    return 0;
  }
}

/** 与脚本 stamp_name / copy_new 同一规则，只用于确认框文案；真正的名字以脚本为准。 */
function predictCopyName(mirrorAbs, name, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}`;
  const stem = name.replace(/\.docx$/i, '').replace(/[/\\\0]/g, '-').trim() || '定稿';
  const base = `${stem}-${stamp}`;
  for (let n = 1; ; n += 1) {
    const cand = n === 1 ? `${base}.docx` : `${base}-${n}.docx`;
    if (!fs.existsSync(path.join(mirrorAbs, cand))) return cand;
  }
}

function sweepTokens() {
  const now = Date.now();
  for (const [k, v] of tokens) if (v.expires <= now) tokens.delete(k);
}

/**
 * POST delivery/final/pick  载荷 { docKey }
 * 返回 `{ picked: false }` 或 `{ picked: true, token, name, inMirror, copyAs?, nextCount }` —— **不含任何路径**。
 */
export async function pickFinal(project, body) {
  const root = project.root;
  const { source, mirror } = resolveSource(root, body?.docKey);
  if (!mirror) throw httpError(400, '只有产出三组里的 .md 原稿能定稿。', 'stale-key');
  requireScript(root);
  await requirePython();
  if (picking) throw httpError(409, '已经有一个选文件框开着了，先在桌面上选完或取消。', 'busy');

  const mirrorAbs = resolveInside(root, mirror);
  const mirrorReal = realpath(mirrorAbs);
  const defaultDir = mirrorReal ? mirrorAbs : path.dirname(resolveInside(root, source));
  picking = true;
  let result;
  try {
    result = await pickDocxFile({ prompt: '选择交出去的那份 Word（.docx）', defaultDir });
  } finally {
    picking = false;
  }
  if (!result.picked) return { picked: false };

  const abs = result.path;
  const name = path.basename(abs);
  if (!/\.docx$/i.test(name)) throw httpError(400, `选中的不是 Word 文档（.docx）：${name}`, 'not-docx');
  // 与脚本同一判据：父目录的真实路径就是镜像目录；符号链接文件按「其他目录」，宁可多复制一份
  let isLink = false;
  try { isLink = fs.lstatSync(abs).isSymbolicLink(); } catch { /* 下面 confirm 时还会再查文件在不在 */ }
  const inMirror = Boolean(mirrorReal) && !isLink && realpath(path.dirname(abs)) === mirrorReal;

  sweepTokens();
  const token = randomUUID();
  tokens.set(token, { root, source, abs, expires: Date.now() + TOKEN_TTL_MS });
  return {
    picked: true,
    token,
    name,
    inMirror,
    ...(inMirror ? {} : { copyAs: predictCopyName(mirrorAbs, name) }),
    nextCount: finalCount(root, mirror) + 1,
  };
}

/** POST delivery/final  载荷 { token, note? } */
export async function confirmFinal(project, body) {
  const root = project.root;
  const note = cleanNote(body?.note);
  const token = typeof body?.token === 'string' ? body.token : '';
  sweepTokens();
  const entry = tokens.get(token);
  if (!entry || entry.root !== root) {
    throw httpError(400, '选择已过期，请重新点定稿选一次。', 'stale-token');
  }
  return exclusive(busySources, `${root}\0${entry.source}`, async () => {
    tokens.delete(token);
    if (!fs.existsSync(entry.abs)) throw httpError(400, '选中的文件已经不在了，请重新选择。', 'docx-gone');
    const script = requireScript(root);
    // 用 --key=value：备注或路径以 - 开头时 argparse 不会把它当成选项
    const args = [entry.source, `--docx=${entry.abs}`, ...(note ? [`--note=${note}`] : [])];
    return runScript(root, script, args, { timeoutMs: TIMEOUT_MS, label: '定稿' });
  });
}
