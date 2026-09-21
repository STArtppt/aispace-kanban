/**
 * 未决问题清单：扫 `output/analysis/questions/`，把每份 `Q<编号>.md` 的 front-matter
 * 拼成一份索引。**不生成任何索引文件** —— 生成物会漂，而「索引和正文对不上」正是这套结构
 * 要消除的病根（见 openspec changes/open-questions-workbench 的 design 决策 1）。
 *
 * 读的部分（`scanQuestions` / `readQuestion`）不写任何东西。
 * 写的部分只有一个 `writeQuestion`，它是 **AGENTS.md 不变量 1 的第四条窄例外**：
 * 只改已存在问题文件的人写区四个字段与正文「## 人工反馈」小节，六条约束写在本文件下半部分
 * 的分隔线之后与 AGENTS.md 里。**别在这个模块里加第二个写入口。**
 *
 * 字段契约的唯一事实源是工作空间里的 `output/analysis/questions/README.md`
 * （模板在 templates/pm-aispace/ 下），校验脚本 `scripts/check_questions.py` 与本文件
 * 都按它来。这里**不做校验**：非法组合由校验脚本报，看板只负责如实呈现，
 * 把 `conflict` 这类脏数据显示出来，而不是替它遮掩。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.mjs';
import { resolveInside } from './paths.mjs';

/** 问题目录，相对工作空间根。改这里要同步 README.md 与两个脚本。 */
export const QUESTIONS_DIR = 'output/analysis/questions';

/** 文件名即编号：四位数字，末尾允许一个小写字母（迁移出来的分叉编号 `Q0016b`） */
const FILE_RE = /^(Q\d{4}[a-z]?)\.md$/;
const ID_RE = /^Q\d{4}[a-z]?$/;

/** 目录里的过程件，不是问题。与 check_questions.py 的 SKIP_FILES 同一份名单。 */
const SKIP_FILES = new Set(['README.md', 'MIGRATION-REVIEW.md', 'TRIAGE.md']);

/** front-matter 缺了这些键就算解析不出来（与 check_questions.py 的 REQUIRED 同源） */
const REQUIRED = ['id', 'title', 'status', 'blocks', 'asked_of', 'source'];

/**
 * 只读文件开头这么多字节去找 front-matter。问题文件的 front-matter 是十几行扁平键值，
 * 离这个上限很远；够不着的（正文被写进了 front-matter 之类）退回整份读，不漏条。
 */
const HEAD_BYTES = 8 * 1024;

/**
 * 解析结果缓存，键带上 mtime 与 size —— 与 http.mjs 的 tableRowCountCache 同一个写法。
 * agent 在终端里改了某个问题文件，它的键就变了，下一次扫描自然重读那一份，
 * 不需要另外挂失效钩子（SSE 那边只负责催前端重新取）。
 */
const parsedCache = new Map();
/** 缓存上限：一个工作空间两三百条，留足几个工作空间的余量，超了整个丢掉重来 */
const CACHE_LIMIT = 4000;

function cacheGet(key) {
  return parsedCache.get(key);
}

function cacheSet(key, value) {
  if (parsedCache.size >= CACHE_LIMIT) parsedCache.clear();
  parsedCache.set(key, value);
}

/**
 * 扁平解析器对 `key:`（空值）给的是空数组，不是空字符串。
 * 迁移出来的条目 `blocks` / `evidence` 大都是空的，不归一化的话前端到处要判两种形态。
 */
function str(value) {
  if (Array.isArray(value)) return value.length ? String(value[0]).trim() : '';
  return value == null ? '' : String(value).trim();
}

/** `ai_source` / `flows_to` 可以写成一行，也可以写成 `- item` 列表，两种都认 */
function list(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  const one = str(value);
  return one ? [one] : [];
}

/** 读文件开头一段；不够就退回整份读（front-matter 异常地长时才会走到） */
function readHead(abs, size) {
  if (size <= HEAD_BYTES) return fs.readFileSync(abs, 'utf8');
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const head = buf.subarray(0, read).toString('utf8');
    // 闭合的 `---` 在窗口内就够了；不在，说明这份文件形状特殊，老老实实整份读
    return head.indexOf('\n---', 3) === -1 ? fs.readFileSync(abs, 'utf8') : head;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 把 front-matter 拼成一条索引项。
 * 解析不出来的**不丢**：降级成 `broken` 条目返回，让坏数据在界面上可见 ——
 * 一条坏数据不能拖垮整个接口，也不该悄悄消失。
 */
function describe(meta, { id, name, relPath, mtime }) {
  const missing = REQUIRED.filter((key) => !(key in meta));
  const item = {
    id: str(meta.id) || id,
    name,
    path: relPath,
    mtime,
    title: str(meta.title),
    status: str(meta.status),
    blocks: str(meta.blocks),
    asked_of: str(meta.asked_of),
    source: str(meta.source),
    context: str(meta.context),
    created: str(meta.created),
    updated: str(meta.updated),
    human_answer: str(meta.human_answer),
    due: str(meta.due),
    evidence: str(meta.evidence),
    ai_conclusion: str(meta.ai_conclusion),
    flows_to: list(meta.flows_to),
  };
  if (missing.length) {
    item.broken = true;
    item.reason = `front-matter 缺少必填字段：${missing.join('、')}`;
  }
  return item;
}

/** 整份文件都解析不出 front-matter 时的降级形态 */
function brokenItem({ id, name, relPath, mtime, reason }) {
  return {
    id,
    name,
    path: relPath,
    mtime,
    title: '',
    status: '',
    blocks: '',
    asked_of: '',
    source: '',
    context: '',
    created: '',
    updated: '',
    human_answer: '',
    due: '',
    evidence: '',
    ai_conclusion: '',
    flows_to: [],
    broken: true,
    reason,
  };
}

/**
 * 扫出一个工作空间的全部问题索引。
 *
 * 目录不存在**不是错误** —— 旧工作空间还没迁移过来，返回空列表并把 `available: false`
 * 告诉前端，由它显示「这个工作空间还没有结构化问题清单」，而不是报错。
 *
 * @param {string} root 工作空间根
 * @returns {{ dir: string, available: boolean, items: object[] }}
 */
export function scanQuestions(root) {
  const dir = resolveInside(root, QUESTIONS_DIR);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { dir: QUESTIONS_DIR, available: false, items: [] };
  }

  const items = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // 目录读不动（权限之类）当作没有，前端走空态，不让整个接口挂掉
    return { dir: QUESTIONS_DIR, available: false, items: [] };
  }

  for (const entry of entries) {
    if (!entry.isFile() || SKIP_FILES.has(entry.name)) continue;
    const matched = FILE_RE.exec(entry.name);
    if (!matched) continue;
    const id = matched[1];
    const abs = path.join(dir, entry.name);
    const relPath = `${QUESTIONS_DIR}/${entry.name}`;

    let stats;
    try {
      stats = fs.statSync(abs);
    } catch {
      continue;
    }
    const mtime = stats.mtime.toISOString();
    const key = `${abs}\0${stats.mtimeMs}\0${stats.size}`;
    const cached = cacheGet(key);
    if (cached) {
      items.push(cached);
      continue;
    }

    let item;
    try {
      const text = readHead(abs, stats.size);
      const { meta } = parseFrontmatter(text);
      item = Object.keys(meta).length
        ? describe(meta, { id, name: entry.name, relPath, mtime })
        : brokenItem({ id, name: entry.name, relPath, mtime, reason: '没有 front-matter，无法解析' });
    } catch (err) {
      item = brokenItem({
        id,
        name: entry.name,
        relPath,
        mtime,
        reason: `读取失败：${(err && err.message) || '未知原因'}`,
      });
    }
    cacheSet(key, item);
    items.push(item);
  }

  // 编号是定长的，字符串序就是编号序（Q0016b 紧跟在 Q0016 后面）
  items.sort((a, b) => a.id.localeCompare(b.id));
  return { dir: QUESTIONS_DIR, available: true, items };
}

/**
 * 按编号取单条详情：front-matter 全字段 + 正文。
 * 卡片正文才走这里，清单不读正文。
 *
 * `id` **只接受编号**，不接受任何路径 —— 带路径分隔符或 `../` 的一律在触达文件系统前拒掉，
 * 落盘路径由服务端自己用 `resolveInside()` 拼。
 *
 * @param {string} root 工作空间根
 * @param {string} id 问题编号，如 `Q0134`
 */
export function readQuestion(root, id) {
  const wanted = String(id || '').trim();
  if (!ID_RE.test(wanted)) {
    const err = new Error(`问题编号不合法：${wanted || '(空)'}`);
    err.statusCode = 400;
    throw err;
  }
  const abs = resolveInside(root, `${QUESTIONS_DIR}/${wanted}.md`);
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    const err = new Error(`找不到这条问题：${wanted}`);
    err.statusCode = 404;
    throw err;
  }
  const stats = fs.statSync(abs);
  const text = fs.readFileSync(abs, 'utf8');
  const { meta, body } = parseFrontmatter(text);
  const relPath = `${QUESTIONS_DIR}/${wanted}.md`;
  const base = Object.keys(meta).length
    ? describe(meta, { id: wanted, name: `${wanted}.md`, relPath, mtime: stats.mtime.toISOString() })
    : brokenItem({
        id: wanted,
        name: `${wanted}.md`,
        relPath,
        mtime: stats.mtime.toISOString(),
        reason: '没有 front-matter，无法解析',
      });
  return {
    ...base,
    ai_source: list(meta.ai_source),
    human_note: str(meta.human_note),
    body,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 写入：**AGENTS.md 不变量 1 的第四条窄例外**，范围就是那六条，越界即为 bug。
//
// 与前三条例外的形状不同：前三条是「看板只 spawn，工作空间自己的脚本写盘」，
// 这一条是看板服务端自己写 —— 人工反馈没有现成脚本可以承接，而且它是高频小写入。
// 作为交换，写入面压到最小：只改**已存在**的问题文件，只动人写区那四个字段
// 与正文的「## 人工反馈」小节；载荷里出现任何 AI 写区字段一律 400 且不落盘。
//
// 「人写区 / AI 写区」不是风格约定，它就是并发方案本身：流程本身就是
// 「人点保存 → 立刻复制 prompt → agent 开始改同一条」，两者几秒内动同一个文件是预期行为。
// 分区让它们物理上落在不同字段，因此不需要锁。
// ─────────────────────────────────────────────────────────────────────────────

/** 人写区 —— 看板只写这四个键。多一个都不行（连 `updated` 都不碰，那不在这四个里）。 */
const HUMAN_FIELDS = ['status', 'human_answer', 'human_note', 'due'];

/** AI 写区 —— 载荷里出现任何一个就 400。`ai_evidence` 不是契约里的字段，一并挡掉防写错。 */
const AI_FIELDS = ['evidence', 'ai_conclusion', 'ai_source', 'flows_to', 'ai_evidence'];

const STATUS_VALUES = new Set(['open', 'pending_ai', 'answered', 'dropped', 'conflict']);
const ANSWER_VALUES = new Set(['verify', 'decide', 'drop', 'ask']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 界面上的四个标准答案，写进「## 人工反馈」时用中文，人翻文件时不用回来查字典 */
const ANSWER_LABEL = {
  verify: '资料里应该有，待查证',
  decide: '我方自行决定',
  drop: '本期不做 / 不相关',
  ask: '确需对方答复',
};

/** `human_note` 的上限。README 写的是「一两句」—— 要写长文说明这条该拆，不该塞进字段里 */
const NOTE_LIMIT = 200;

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/** front-matter 是单行键值，值里不能有换行；顺手压掉首尾空白 */
function oneLine(value) {
  return String(value == null ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/** 服务所在机器的当日日期（人工反馈记的是人操作的那天，不是 agent 跑的那天） */
function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 字段级替换：只动 `updates` 里点名的键，其余行**逐字不变**。
 * 整份重新序列化会把 AI 区的写法、注释、键顺序全洗一遍 —— 那等于在改别人的写区。
 */
function setFrontmatterFields(text, updates) {
  const headEnd = text.indexOf('\n') + 1;
  const close = text.indexOf('\n---', 3);
  const head = text.slice(0, headEnd);
  const rest = text.slice(close);
  const lines = text.slice(headEnd, close).split(/\r?\n/);
  const pending = new Map(Object.entries(updates));
  const out = [];

  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([\w.-]+):\s*(.*)$/.exec(lines[i]);
    if (kv && pending.has(kv[1])) {
      out.push(`${kv[1]}: ${pending.get(kv[1])}`.trimEnd());
      pending.delete(kv[1]);
      // 人写区本不该写成列表，但文件是手写的：把这个键的 `- item` 续行一并吃掉，别留孤儿
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) i += 1;
      continue;
    }
    out.push(lines[i]);
  }
  // 文件里没有这个键（旧文件、手写漏了）就补在末尾，不重排已有的键
  for (const [key, value] of pending) out.push(`${key}: ${value}`.trimEnd());

  return head + out.join('\n') + rest;
}

/**
 * 往正文「## 人工反馈」追加一条记录。**只碰这一节** ——
 * 「## 结论」「## 轮次记录」是 agent 的写区，看板一个字都不动
 * （重开一轮时把上一轮搬进轮次记录也是 agent 的活，prompt 里会写明）。
 */
function appendFeedback(body, line) {
  const heading = /^##[ \t]+人工反馈[ \t]*$/m.exec(body);
  if (!heading) {
    return `${body.replace(/\s*$/, '')}\n\n## 人工反馈\n\n${line}\n`;
  }
  const start = heading.index + heading[0].length;
  const after = body.slice(start).search(/^##[ \t]+/m);
  const cut = after === -1 ? body.length : start + after;
  const section = body.slice(start, cut).replace(/\s*$/, '');
  return `${body.slice(0, start)}${section}${section ? '\n' : '\n\n'}${line}\n\n${body.slice(cut)}`;
}

/**
 * 保存一条人工反馈。
 *
 * @param {string} root 工作空间根
 * @param {string} id 问题编号，如 `Q0134`。**只接受编号，不接受任何路径**
 * @param {object} payload 只认 `status` / `human_answer` / `human_note` / `due` 四个键
 * @returns {object} 保存后的单条详情（前端据此立刻更新，不等 SSE）
 */
export function writeQuestion(root, id, payload) {
  const patch = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};

  // ① 先挡 AI 写区 —— 在读文件之前就拒，不落盘、也不去碰文件系统
  const intruders = AI_FIELDS.filter((key) => key in patch);
  if (intruders.length) {
    throw badRequest(
      `这些字段属于 AI 写区，看板不写：${intruders.join('、')}。`
        + '人和 agent 的写区是物理隔开的，那就是这套并发方案本身（见 questions/README.md）。',
    );
  }
  const unknown = Object.keys(patch).filter((key) => !HUMAN_FIELDS.includes(key));
  if (unknown.length) {
    throw badRequest(`不认识这些字段：${unknown.join('、')}。看板只写 ${HUMAN_FIELDS.join(' / ')}。`);
  }
  if (!Object.keys(patch).length) {
    throw badRequest('没有要保存的内容。');
  }

  const wanted = String(id || '').trim();
  if (!ID_RE.test(wanted)) {
    throw badRequest(`问题编号不合法：${wanted || '(空)'}`);
  }

  // ② 只改已存在的文件：不新建、不删除、不改名
  const relPath = `${QUESTIONS_DIR}/${wanted}.md`;
  const abs = resolveInside(root, relPath);
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    const err = new Error(`找不到这条问题：${wanted}。看板不新建问题文件，提问由技能负责。`);
    err.statusCode = 404;
    throw err;
  }

  const text = fs.readFileSync(abs, 'utf8');
  const { meta, body } = parseFrontmatter(text);
  if (!text.startsWith('---') || text.indexOf('\n---', 3) === -1 || !Object.keys(meta).length) {
    throw badRequest('这份问题文件没有可解析的 front-matter，无法做字段级写入。请先在编辑器里修好它。');
  }

  // ③ 取值校验。契约的事实源是 questions/README.md，校验脚本 check_questions.py 查的是同一套
  const updates = {};
  if ('status' in patch) {
    const status = oneLine(patch.status);
    if (!STATUS_VALUES.has(status)) {
      throw badRequest(`状态取值不在枚举内：${status || '(空)'}。只能是 ${[...STATUS_VALUES].join(' / ')}。`);
    }
    updates.status = status;
  }
  if ('human_answer' in patch) {
    const answer = oneLine(patch.human_answer);
    if (answer && !ANSWER_VALUES.has(answer)) {
      throw badRequest(`标准答案不在四值内：${answer}。只能是 ${[...ANSWER_VALUES].join(' / ')}。`);
    }
    updates.human_answer = answer;
  }
  if ('due' in patch) {
    const due = oneLine(patch.due);
    if (due && !DATE_RE.test(due)) {
      throw badRequest(`最迟答复日期要写成 YYYY-MM-DD：${due}`);
    }
    updates.due = due;
  }
  if ('human_note' in patch) {
    const note = oneLine(patch.human_note);
    if (note.length > NOTE_LIMIT) {
      throw badRequest(
        `补充说明超过 ${NOTE_LIMIT} 字（当前 ${note.length} 字）。要写这么长说明这条该拆成几条问题。`,
      );
    }
    updates.human_note = note;
  }

  // ④ `ask` 必须有时限 —— 不填 `due` 就没有任何机制逼它到期，存量那批积压就是这么来的。
  //    没改 human_answer 时看文件里原来的值，别让「只改备注」把一条合法记录改成非法的
  const answerAfter = 'human_answer' in updates ? updates.human_answer : str(meta.human_answer);
  const dueAfter = 'due' in updates ? updates.due : str(meta.due);
  if (answerAfter === 'ask' && !dueAfter) {
    throw badRequest('选「确需对方答复」必须填最迟答复日期，否则没有任何机制逼它到期。');
  }

  // ⑤ 凭据守门：`我方推断` 与「没凭据」都不能关闭问题。看板的四个标准答案本来就到不了
  //    `answered`，这道闸是防手动构造的请求绕过契约
  const statusAfter = 'status' in updates ? updates.status : str(meta.status);
  if (statusAfter === 'answered') {
    const evidence = str(meta.evidence);
    if (!evidence) throw badRequest('这条还没写 `evidence`，凭什么关的必须写出来，不能置为已消解。');
    if (evidence === '我方推断') {
      throw badRequest('`evidence: 我方推断` 不能关闭问题 —— 查不到依据的结论只能作为待验证假设停在 open。');
    }
  }

  // ⑥ 落盘：字段级替换 + 正文只追加「## 人工反馈」，先写临时文件再原子替换
  let next = setFrontmatterFields(text, updates);
  const label = ANSWER_LABEL[answerAfter] || (statusAfter === 'open' ? '重开一轮' : '');
  const note = 'human_note' in updates ? updates.human_note : '';
  const logged = [label, note].filter(Boolean).join('，');
  if (logged) {
    const close = next.indexOf('\n---', 3);
    const headRaw = next.slice(0, close + 4);
    const bodyRaw = next.slice(close + 4).replace(/^\r?\n/, '');
    const line = `- ${today()}：${logged}${dueAfter && answerAfter === 'ask' ? `（最迟 ${dueAfter}）` : ''}`;
    next = `${headRaw}\n${appendFeedback(bodyRaw, line)}`;
  }

  const tmp = path.join(path.dirname(abs), `.${wanted}.md.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, abs);
  } catch (err) {
    // 失败不留半截文件：临时件清掉，原文件还是原样（rename 之前它一个字节都没动过）
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时件本来就没建成，忽略 */
    }
    throw err;
  }

  return readQuestion(root, wanted);
}
