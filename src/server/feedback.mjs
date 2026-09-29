/**
 * 看板反馈单：扫 `output/feedback/`，把每份 `F<编号>.md` 的 front-matter 拼成索引。
 * **不生成任何索引文件** —— 与问题单、记录单同一条理由。
 *
 * 读的部分（`listFeedback` / `readFeedback`）不写任何东西。
 * 写的部分只有 `markSent`，它是 **AGENTS.md 不变量 1 的第八条窄例外**：
 * 只改已存在反馈单的 `sent_at` 与正文「## 发送记录」，六条约束写在本文件下半部分。
 * **别在这个模块里加第二个写入口。**
 *
 * 旧目录 `.kanban-feedback/` 只统计 `.md` 份数（`legacyCount`），不读内容、不移动。
 * 字段契约的事实源是工作空间里的 `output/feedback/README.md`。
 * 这里不做状态枚举校验：写歪的状态原样返回，界面归到「未识别」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { FEEDBACK_EMAIL } from '../shared/feedbackMail.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { replaceFileAtomic, setFrontmatterFields } from './patchMarkdown.mjs';
import { resolveInside } from './paths.mjs';

/** 反馈单目录，相对工作空间根。 */
export const FEEDBACK_DIR = 'output/feedback';

/** 迁移前的隐藏目录。只数份数，不解析。 */
const LEGACY_DIR = '.kanban-feedback';

const FILE_RE = /^(F\d{4})\.md$/;
const ID_RE = /^F\d{4}$/;

/** 正文里约定的六节，顺序固定。文件里多出来的节照样返回，不丢。 */
const CONTENT_HEADINGS = ['现象', '期望', '最小复现', '疑似源码位置', '建议改法', '临时绕法'];

const SEND_HEADING = '发送记录';

/** 载荷里出现这些键一律 400。它们属于智能体，看板不写。 */
const AI_FIELDS = ['id', 'title', 'status', 'created', 'receipt'];

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function conflict(message) {
  const err = new Error(message);
  err.statusCode = 409;
  return err;
}

function str(value) {
  if (Array.isArray(value)) return value.length ? String(value[0]).trim() : '';
  return value == null ? '' : String(value).trim();
}

/** 服务所在机器的本地时间，写进人看的文件，不用 UTC 的 `Z`。 */
function stampNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * `.kanban-feedback/` 根上的 `.md` 份数。目录不在、读不动，都当 0。
 * 不打开任何一个文件 —— 旧单的正文可能夹着真实资料，统计不需要看它。
 */
function countLegacy(root) {
  let abs;
  try {
    abs = resolveInside(root, LEGACY_DIR);
  } catch {
    return 0;
  }
  let entries;
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return 0;
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) count += 1;
  }
  return count;
}

function describe(meta, { id, name, relPath, mtime }) {
  return {
    id,
    name,
    path: relPath,
    mtime,
    title: str(meta.title),
    status: str(meta.status),
    created: str(meta.created),
    receipt: str(meta.receipt),
    sent_at: str(meta.sent_at),
  };
}

function brokenItem({ id, name, relPath, mtime, reason }) {
  return {
    id,
    name,
    path: relPath,
    mtime,
    title: '',
    status: '',
    created: '',
    receipt: '',
    sent_at: '',
    broken: true,
    reason,
  };
}

/**
 * @param {string} root 工作空间根
 * @returns {{ dir: string, available: boolean, legacyCount: number, items: object[] }}
 */
export function listFeedback(root) {
  const legacyCount = countLegacy(root);
  const dir = resolveInside(root, FEEDBACK_DIR);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { dir: FEEDBACK_DIR, available: false, legacyCount, items: [] };
  }

  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { dir: FEEDBACK_DIR, available: false, legacyCount, items: [] };
  }

  const items = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const matched = FILE_RE.exec(entry.name);
    if (!matched) continue;
    const id = matched[1];
    const abs = path.join(dir, entry.name);
    const relPath = `${FEEDBACK_DIR}/${entry.name}`;
    let stats;
    try {
      stats = fs.statSync(abs);
    } catch {
      continue;
    }
    const mtime = stats.mtime.toISOString();
    try {
      const text = fs.readFileSync(abs, 'utf8');
      const { meta } = parseFrontmatter(text);
      items.push(
        Object.keys(meta).length
          ? describe(meta, { id, name: entry.name, relPath, mtime })
          : brokenItem({ id, name: entry.name, relPath, mtime, reason: '没有 front-matter，无法解析' }),
      );
    } catch (err) {
      items.push(
        brokenItem({
          id,
          name: entry.name,
          relPath,
          mtime,
          reason: `读取失败：${(err && err.message) || '未知原因'}`,
        }),
      );
    }
  }

  items.sort((a, b) => a.id.localeCompare(b.id));
  return { dir: FEEDBACK_DIR, available: true, legacyCount, items };
}

/** 按 `## ` 拆节。发送记录单独拿出去，不跟六个内容节混在一个数组里。 */
function splitSections(body) {
  const re = /^##[ \t]+(.+?)[ \t]*$/gm;
  const marks = [...body.matchAll(re)];
  const sections = [];
  /** @type {{ title: string, body: string }[]} */
  const sends = [];
  for (let i = 0; i < marks.length; i += 1) {
    const heading = marks[i][1].trim();
    const start = marks[i].index + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : body.length;
    const text = body.slice(start, end).replace(/^\r?\n/, '').replace(/\s*$/, '');
    if (heading === SEND_HEADING) {
      sends.push(...splitSends(text));
      continue;
    }
    sections.push({ heading, body: text });
  }
  // 六个约定节缺了也补一个空位，界面不用自己猜「这节是没有，还是解析漏了」
  const ordered = [];
  for (const heading of CONTENT_HEADINGS) {
    const found = sections.find((section) => section.heading === heading);
    ordered.push(found || { heading, body: '' });
  }
  for (const section of sections) {
    if (!CONTENT_HEADINGS.includes(section.heading)) ordered.push(section);
  }
  return { sections: ordered, sends };
}

function splitSends(sectionBody) {
  const re = /^###[ \t]+(.+?)[ \t]*$/gm;
  const marks = [...sectionBody.matchAll(re)];
  const sends = [];
  for (let i = 0; i < marks.length; i += 1) {
    const title = marks[i][1].trim();
    const start = marks[i].index + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : sectionBody.length;
    const text = sectionBody.slice(start, end).replace(/^\r?\n/, '').replace(/\s*$/, '');
    sends.push({ title, body: text });
  }
  return sends;
}

function locate(root, id) {
  const wanted = String(id || '').trim();
  if (!ID_RE.test(wanted)) {
    throw badRequest(`反馈单编号不合法：${wanted || '(空)'}`);
  }
  const relPath = `${FEEDBACK_DIR}/${wanted}.md`;
  const abs = resolveInside(root, relPath);
  return { wanted, relPath, abs };
}

/**
 * @param {string} root
 * @param {string} id 如 `F0003`。只接受编号
 */
export function readFeedback(root, id) {
  const { wanted, relPath, abs } = locate(root, id);
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    const err = new Error(`找不到这份反馈单：${wanted}`);
    err.statusCode = 404;
    throw err;
  }
  const stats = fs.statSync(abs);
  const text = fs.readFileSync(abs, 'utf8');
  const { meta, body } = parseFrontmatter(text);
  const mtime = stats.mtime.toISOString();
  const base = Object.keys(meta).length
    ? describe(meta, { id: wanted, name: `${wanted}.md`, relPath, mtime })
    : brokenItem({
        id: wanted,
        name: `${wanted}.md`,
        relPath,
        mtime,
        reason: '没有 front-matter，无法解析',
      });
  const { sections, sends } = splitSections(body);
  return { ...base, sections, sends };
}

/**
 * 在「## 发送记录」末尾追加一条 `###`。这一节不存在就 409，不替智能体把结构补上。
 */
function appendSend(body, entry) {
  const heading = /^##[ \t]+发送记录[ \t]*$/m.exec(body);
  if (!heading) {
    throw conflict(
      '这份反馈单没有「## 发送记录」一节，看板认不出结构，没有写入。'
        + '请让工作空间智能体按 output/feedback/README.md 补上这一节。',
    );
  }
  const start = heading.index + heading[0].length;
  const after = body.slice(start).search(/^##[ \t]+/m);
  const cut = after === -1 ? body.length : start + after;
  const section = body.slice(start, cut).replace(/\s*$/, '');
  const tail = body.slice(cut);
  return `${body.slice(0, start)}${section}\n\n${entry}\n${tail ? `\n${tail}` : ''}`;
}

/**
 * 用户确认「我已发出」之后，写 `sent_at` 并追加一条发送记录。
 *
 * @param {string} root
 * @param {string} id
 * @param {object} payload 只允许带 `sent_at`（值忽略，时间以服务端为准），其它键 400
 */
export function markSent(root, id, payload) {
  const patch = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  if (!patch) throw badRequest('请求体要是一个对象。');

  const intruders = AI_FIELDS.filter((key) => key in patch);
  if (intruders.length) {
    throw badRequest(
      `这些字段属于 AI 写区，看板不写：${intruders.join('、')}。`
        + '人和智能体的写区是物理隔开的，那就是这套并发方案本身（见 feedback/README.md）。',
    );
  }
  const unknown = Object.keys(patch).filter((key) => key !== 'sent_at');
  if (unknown.length) {
    throw badRequest(`不认识这些字段：${unknown.join('、')}。看板只收 sent_at。`);
  }

  const { wanted, abs } = locate(root, id);
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    const err = new Error(
      `找不到这份反馈单：${wanted}。看板不新建反馈单，写反馈单是工作空间智能体的事。`,
    );
    err.statusCode = 404;
    throw err;
  }

  const text = fs.readFileSync(abs, 'utf8');
  const { meta } = parseFrontmatter(text);
  if (!text.startsWith('---') || text.indexOf('\n---', 3) === -1 || !Object.keys(meta).length) {
    throw conflict('这份反馈单没有可解析的 front-matter，看板认不出结构，没有写入。');
  }

  const at = stampNow();
  let next = setFrontmatterFields(text, { sent_at: at });
  const close = next.indexOf('\n---', 3);
  const headRaw = next.slice(0, close + 4);
  const bodyRaw = next.slice(close + 4).replace(/^\r?\n/, '');
  const entry = `### ${at} 已发送至 ${FEEDBACK_EMAIL}`;
  next = `${headRaw}\n${appendSend(bodyRaw, entry)}`;
  if (!next.endsWith('\n')) next += '\n';
  replaceFileAtomic(abs, next);
  return readFeedback(root, wanted);
}
