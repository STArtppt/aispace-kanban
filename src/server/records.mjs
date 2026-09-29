/**
 * 产出物记录清单：扫 `output/records/`，把每份 `I<编号>.md` 的 front-matter
 * 拼成一份索引。**不生成任何索引文件** —— 与 `questions.mjs` 同一条理由：
 * 生成物会漂，而「索引和正文对不上」正是这套结构要消除的病根。
 *
 * 读的部分（`scanRecords` / `readRecord`）不写任何东西。
 * 写的部分只有一个 `writeRecordStatus`，它是 **AGENTS.md 不变量 1 的第六条窄例外**：
 * 只改已存在记录文件的人写区三个字段与正文「## 状态流水」小节，
 * 六条约束写在本文件下半部分的分隔线之后与 AGENTS.md 里。
 * **别在这个模块里加第二个写入口。**
 *
 * 字段契约的唯一事实源是工作空间里的 `output/records/README.md`
 * （模板在 templates/pm-aispace/ 下）；三套状态机那张表在
 * `src/shared/recordStatus.mjs`，前端与校验脚本用的是同一份。
 * 这里**只在写入时校验**：读的时候不替数据遮掩，`kind` 写错、状态越界都如实呈现出来
 * （坏数据要在界面上看得见，校验由工作空间的 `scripts/check_markdown.py` 报）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.mjs';
import { replaceFileAtomic, setFrontmatterFields } from './patchMarkdown.mjs';
import { resolveInside } from './paths.mjs';
import { outputPlacement } from './scan.mjs';
import { isValidStatus, needsResolvedBy, statusValuesOf } from '../shared/recordStatus.mjs';

/** 记录目录，相对工作空间根。改这里要同步 records/README.md 与校验脚本。 */
export const RECORDS_DIR = 'output/records';

/** 文件名即编号：`I` + 四位数字。问题那边有分叉编号，记录没有历史包袱，不开这个口子。 */
export const FILE_RE = /^(I\d{4})\.md$/;
const ID_RE = /^I\d{4}$/;

/** 目录里的说明文件，不是记录。 */
const SKIP_FILES = new Set(['README.md']);

/** front-matter 缺了这些键就算解析不出来（与 check_markdown.py 的 RECORD_REQUIRED 同源） */
const REQUIRED = ['id', 'kind', 'title', 'target', 'status', 'created'];

/**
 * 只读文件开头这么多字节去找 front-matter。记录的 front-matter 是十行以内的扁平键值，
 * 离这个上限很远；够不着的（正文被写进了 front-matter 之类）退回整份读，不漏条。
 */
const HEAD_BYTES = 8 * 1024;

/** 解析结果缓存，键带 mtime 与 size —— 与 `questions.mjs` 同一个写法，agent 改了文件键就变。 */
const parsedCache = new Map();
const CACHE_LIMIT = 4000;

function cacheGet(key) {
  return parsedCache.get(key);
}

function cacheSet(key, value) {
  if (parsedCache.size >= CACHE_LIMIT) parsedCache.clear();
  parsedCache.set(key, value);
}

/** 扁平解析器对 `key:`（空值）给的是空数组，不是空字符串，这里统一压成字符串 */
function str(value) {
  if (Array.isArray(value)) return value.length ? String(value[0]).trim() : '';
  return value == null ? '' : String(value).trim();
}

/** 读文件开头一段；不够就退回整份读（front-matter 异常地长时才会走到） */
function readHead(abs, size) {
  if (size <= HEAD_BYTES) return fs.readFileSync(abs, 'utf8');
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const head = buf.subarray(0, read).toString('utf8');
    return head.indexOf('\n---', 3) === -1 ? fs.readFileSync(abs, 'utf8') : head;
  } finally {
    fs.closeSync(fd);
  }
}

/** 记录目录在不在。不在**不是错误** —— 老工作空间没有这个目录，走空态。 */
export function recordsDirExists(root) {
  try {
    const abs = resolveInside(root, RECORDS_DIR);
    return fs.existsSync(abs) && fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `target` 指向的产出物还在不在。
 * 不在就标「指向丢失」并**照常列出** —— 隐藏它等于把悬空引用藏起来，
 * 而这正是需要人处理的那一类（界面上用 orange）。
 * 路径越界（手写成 `../` 之类）同样算丢失：不去碰工作空间外的任何东西。
 */
function targetMissing(root, target) {
  if (!target) return true;
  try {
    return !fs.existsSync(resolveInside(root, target));
  } catch {
    return true;
  }
}

/**
 * `target` 是不是指在某组的 `一次归档/` 下。判据是 scan.mjs 的 `outputPlacement`，这里不另写一份。
 *
 * 这是**派生**标记，不是状态：不写进 front-matter、不进三套状态机、不因此改任何记录文件 ——
 * 归档改变的是位置，不是产出物的状态。归档后 `target` 仍指着旧路径时它是 false，
 * 那时照旧标「指向丢失」，由 agent 跟进 `target`（AI 写区）之后才变成 true。
 */
function targetArchived(target) {
  return Boolean(target && outputPlacement(String(target).replace(/^\.\//, ''))?.archived);
}

/**
 * 把 front-matter 拼成一条索引项。
 * 解析不出来的**不丢**：降级成 `broken` 条目返回，让坏数据在界面上可见 ——
 * 一条坏数据不能拖垮整个接口，也不该悄悄消失。
 */
function describe(meta, { id, name, relPath, mtime }) {
  const missing = REQUIRED.filter((key) => !(key in meta));
  const item = {
    // **编号以文件名为准**，不取 front-matter 里的 `id`：详情与写入都按编号拼路径，
    // 听 front-matter 的话，手写错一个字就会让这条在界面上点不开（404）。
    // 两者不一致是脏数据，下面标成 broken 让它在界面上可见，校验脚本也会报。
    id,
    name,
    path: relPath,
    mtime,
    kind: str(meta.kind),
    title: str(meta.title),
    target: str(meta.target),
    status: str(meta.status),
    created: str(meta.created),
    status_changed: str(meta.status_changed),
    updated: str(meta.updated),
    resolved_by: str(meta.resolved_by),
  };
  const reasons = [];
  if (missing.length) reasons.push(`front-matter 缺少必填字段：${missing.join('、')}`);
  const declared = str(meta.id);
  if (declared && declared !== id) {
    reasons.push(`front-matter 的 id 是 ${declared}，与文件名 ${name} 不一致`);
  }
  if (reasons.length) {
    item.broken = true;
    item.reason = reasons.join('；');
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
    kind: '',
    title: '',
    target: '',
    status: '',
    created: '',
    status_changed: '',
    updated: '',
    resolved_by: '',
    broken: true,
    reason,
  };
}

/**
 * 扫出一个工作空间的全部记录索引。**只读 front-matter，不读正文** ——
 * 清单不显示长文，状态流水按需走详情接口。
 *
 * 目录不存在**不是错误**：老工作空间还没有这个目录，返回空列表并把
 * `available: false` 告诉前端，由它显示空态并说清怎么开始。
 *
 * @param {string} root 工作空间根
 * @returns {{ dir: string, available: boolean, items: object[] }}
 */
export function scanRecords(root) {
  const relDir = RECORDS_DIR;
  let dir;
  try {
    dir = resolveInside(root, relDir);
  } catch {
    return { dir: relDir, available: false, items: [] };
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { dir: relDir, available: false, items: [] };
  }

  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // 目录读不动（权限之类）当作没有，前端走空态，不让整个接口挂掉
    return { dir: relDir, available: false, items: [] };
  }

  const items = [];
  for (const entry of entries) {
    if (!entry.isFile() || SKIP_FILES.has(entry.name)) continue;
    const matched = FILE_RE.exec(entry.name);
    if (!matched) continue;
    const id = matched[1];
    const abs = path.join(dir, entry.name);
    const relPath = `${relDir}/${entry.name}`;

    let stats;
    try {
      stats = fs.statSync(abs);
    } catch {
      continue;
    }
    const mtime = stats.mtime.toISOString();
    const key = `${abs}\0${stats.mtimeMs}\0${stats.size}`;
    let item = cacheGet(key);
    if (!item) {
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
    }
    // 指向丢失不进缓存：它取决于**别的**文件在不在，记录文件自己没变也可能变。
    // 目标已归档与它同属派生，一起在这里算、一起不进缓存
    items.push({
      ...item,
      targetMissing: targetMissing(root, item.target),
      targetArchived: targetArchived(item.target),
    });
  }

  // 编号定长，字符串序就是编号序
  items.sort((a, b) => a.id.localeCompare(b.id));
  return { dir: relDir, available: true, items };
}

/**
 * 正文里「## 状态流水」下的条目：`### <日期> · <状态>` + 一段说明。
 * 解析出来给前端直接渲染，省得前端再实现一遍同样的切法（口径分叉就会两边显示不同）。
 *
 * 认不出格式的条目**不丢**：`date` / `status` 留空，`note` 给整段原文。
 */
function parseFlow(body) {
  const heading = /^##[ \t]+状态流水[ \t]*$/m.exec(body);
  if (!heading) return [];
  const start = heading.index + heading[0].length;
  const after = body.slice(start).search(/^##[ \t]+/m);
  const section = body.slice(start, after === -1 ? body.length : start + after);

  const heads = [...section.matchAll(/^###[ \t]+(.*)$/gm)];
  return heads.map((head, i) => {
    const from = head.index + head[0].length;
    const to = i + 1 < heads.length ? heads[i + 1].index : section.length;
    const titleLine = head[1].trim();
    const split = /^(\S+)[ \t]*·[ \t]*(\S+)$/.exec(titleLine);
    return {
      date: split ? split[1] : '',
      status: split ? split[2] : '',
      title: titleLine,
      note: section.slice(from, to).trim(),
    };
  });
}

/**
 * 按编号取单条详情：front-matter 全字段 + 正文 + 解析好的状态流水。
 *
 * `id` **只接受编号**，不接受任何路径 —— 带路径分隔符或 `../` 的一律在触达文件系统前拒掉，
 * 落盘路径由服务端自己用 `resolveInside()` 拼。
 *
 * @param {string} root 工作空间根
 * @param {string} id 记录编号，如 `I0007`
 */
export function readRecord(root, id) {
  const wanted = String(id || '').trim();
  if (!ID_RE.test(wanted)) {
    const err = new Error(`记录编号不合法：${wanted || '(空)'}`);
    err.statusCode = 400;
    throw err;
  }
  const relPath = `${RECORDS_DIR}/${wanted}.md`;
  const abs = resolveInside(root, relPath);
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    const err = new Error(`找不到这份产出物记录：${wanted}`);
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
  return {
    ...base,
    targetMissing: targetMissing(root, base.target),
    targetArchived: targetArchived(base.target),
    /** 这个 `kind` 能选的状态值。前端也有同一份表，下发一遍是为了 `kind` 写错时界面有据可依 */
    statusValues: statusValuesOf(base.kind),
    flow: parseFlow(body),
    body,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 写入：**AGENTS.md 不变量 1 的第六条窄例外**，范围就是那六条，越界即为 bug。
//
// 与 `writeQuestion` 同形（看板服务端自己写盘，不是 spawn 工作空间脚本），立项理由也一样：
// 状态变更 + 一句说明是高频小写入（三类产出物、每份多次流转），没有现成的工作空间脚本
// 能承接，为它造一个子进程入口只是绕路，而每次起进程的延迟会让交互变钝。
//
// 作为交换，写入面压到最小：只改**已存在**的记录文件，只动人写区那三个字段
// （`status` / `resolved_by` / `status_changed`）与正文的「## 状态流水」小节；
// 载荷里出现任何 AI 写区字段（`target` / `updated`）一律 400 且不落盘。
//
// 「人写区 / AI 写区」不是风格约定，它就是并发方案本身：人在看板上改状态、
// agent 同时在更新 `target` 与正文别处，两者动同一个文件是预期行为。
// 分区让它们物理上落在不同字段与不同小节，因此不需要锁。
// ─────────────────────────────────────────────────────────────────────────────

/** 人写区 —— 看板只写这三个键，多一个都不行（连 `updated` 都不碰，那是 AI 写区）。 */
const HUMAN_FIELDS = ['status', 'resolved_by', 'status_changed'];

/** AI 写区 —— 载荷里出现任何一个就 400。 */
const AI_FIELDS = ['target', 'updated', 'id', 'kind', 'title', 'created'];

/** 补充说明的上限。要写长文说明它该进正文别处，由 agent 维护 —— 流水条目只放一句注解。 */
const NOTE_LIMIT = 200;

const RESOLVED_BY_RE = /^I\d{4}$/;

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

/** 服务所在机器的当日日期（状态变更记的是人操作的那天） */
function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 往正文「## 状态流水」末尾追加一条 `###` 子节。**只碰这一节** ——
 * 别的小节是 agent 的写区，看板一个字都不动。
 * 小节不存在就建在正文末尾（第一次状态变更会走到这条）。
 */
function appendFlow(body, entry) {
  const heading = /^##[ \t]+状态流水[ \t]*$/m.exec(body);
  if (!heading) {
    return `${body.replace(/\s*$/, '')}\n\n## 状态流水\n\n${entry}\n`;
  }
  const start = heading.index + heading[0].length;
  const after = body.slice(start).search(/^##[ \t]+/m);
  const cut = after === -1 ? body.length : start + after;
  const section = body.slice(start, cut).replace(/\s*$/, '');
  const tail = body.slice(cut);
  // 流水是最后一节时不留多余空行；后面还有别的小节才补一个空行隔开
  return `${body.slice(0, start)}${section}\n\n${entry}\n${tail ? `\n${tail}` : ''}`;
}

/**
 * 保存一次状态变更：改人写区三个字段 + 在「## 状态流水」末尾追加一条。
 *
 * @param {string} root 工作空间根
 * @param {string} id 记录编号，如 `I0007`。**只接受编号，不接受任何路径**
 * @param {object} payload `{ status, note, resolved_by? }` —— `note` 是这次变更的一句说明
 * @returns {object} 保存后的单条详情（前端据此立刻更新，不等 SSE）
 */
export function writeRecordStatus(root, id, payload) {
  const patch = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};

  // ① 先挡 AI 写区与建立时写定的字段 —— 在读文件之前就拒，不落盘、也不去碰文件系统
  const intruders = AI_FIELDS.filter((key) => key in patch);
  if (intruders.length) {
    throw badRequest(
      `这些字段不由看板写：${intruders.join('、')}。`
        + '`target` / `updated` 属于 AI 写区，`id` / `kind` / `title` / `created` 建立时写定；'
        + '人和 agent 的写区是物理隔开的，那就是这套并发方案本身（见 records/README.md）。',
    );
  }
  const allowed = ['status', 'note', 'resolved_by'];
  const unknown = Object.keys(patch).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw badRequest(`不认识这些字段：${unknown.join('、')}。看板只收 ${allowed.join(' / ')}。`);
  }

  const wanted = String(id || '').trim();
  if (!ID_RE.test(wanted)) {
    throw badRequest(`记录编号不合法：${wanted || '(空)'}`);
  }

  // ② 只改已存在的文件：不新建、不删除、不改名
  const relPath = `${RECORDS_DIR}/${wanted}.md`;
  const abs = resolveInside(root, relPath);
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    const err = new Error(
      `找不到这份产出物记录：${wanted}。看板不新建记录文件，建记录由工作空间的技能负责。`,
    );
    err.statusCode = 404;
    throw err;
  }

  const text = fs.readFileSync(abs, 'utf8');
  // 只取 meta：正文不经解析器回写，下面用的是原文切片 —— 重新序列化会洗掉 AI 写区的写法
  const { meta } = parseFrontmatter(text);
  if (!text.startsWith('---') || text.indexOf('\n---', 3) === -1 || !Object.keys(meta).length) {
    throw badRequest('这份记录没有可解析的 front-matter，无法做字段级写入。请先在编辑器里修好它。');
  }

  // ③ 取值校验。状态机那张表在 src/shared/recordStatus.mjs，前端与校验脚本用的是同一份
  const kind = str(meta.kind);
  const status = oneLine(patch.status);
  if (!status) throw badRequest('没有要保存的状态。');
  if (!statusValuesOf(kind).length) {
    throw badRequest(
      `这份记录的 \`kind\` 是 ${kind || '(空)'}，不在 analysis / docs / decisions 之内，`
        + '状态机无从判断。请先在编辑器里把 `kind` 修对。',
    );
  }
  if (!isValidStatus(kind, status)) {
    throw badRequest(
      `\`kind: ${kind}\` 的状态只能是 ${statusValuesOf(kind).join(' / ')}，收到的是 ${status}。三类不共用一套状态机。`,
    );
  }

  // 补充说明为空就拒：状态流水的每一条都要说清为什么，空说明等于没有出口
  const note = oneLine(patch.note);
  if (!note) {
    throw badRequest('补充说明不能为空 —— 状态流水的每一条都要说清为什么变成这个状态。');
  }
  if (note.length > NOTE_LIMIT) {
    throw badRequest(
      `补充说明超过 ${NOTE_LIMIT} 字（当前 ${note.length} 字）。`
        + '长篇内容写进正文别处由 agent 维护，流水条目只放一句话级的注解。',
    );
  }

  // 终态必须说清被谁消解，否则外部引用无处可去
  const resolvedBy = 'resolved_by' in patch ? oneLine(patch.resolved_by) : str(meta.resolved_by);
  if (needsResolvedBy(status)) {
    if (!resolvedBy) {
      throw badRequest(`\`${status}\` 是终态，必须填被哪个编号吸收 / 取代 / 推翻，否则外部引用无处可去。`);
    }
    if (!RESOLVED_BY_RE.test(resolvedBy)) {
      throw badRequest(`消解者要写成记录编号（如 I0012），收到的是 ${resolvedBy}。`);
    }
    if (resolvedBy === wanted) {
      throw badRequest('消解者不能是它自己。');
    }
  } else if ('resolved_by' in patch && resolvedBy && !RESOLVED_BY_RE.test(resolvedBy)) {
    throw badRequest(`消解者要写成记录编号（如 I0012），收到的是 ${resolvedBy}。`);
  }

  // ④ 落盘：字段级替换 + 正文只追加「## 状态流水」，先写临时文件再原子替换
  const stamp = today();
  const updates = { status, status_changed: stamp };
  if ('resolved_by' in patch || needsResolvedBy(status)) updates.resolved_by = resolvedBy;

  let next = setFrontmatterFields(text, updates);
  const close = next.indexOf('\n---', 3);
  const headRaw = next.slice(0, close + 4);
  const bodyRaw = next.slice(close + 4).replace(/^\r?\n/, '');
  const entry = `### ${stamp} · ${status}\n\n${note}`;
  next = `${headRaw}\n${appendFlow(bodyRaw, entry)}`;

  replaceFileAtomic(abs, next);

  return readRecord(root, wanted);
}
