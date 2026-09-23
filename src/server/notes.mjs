/**
 * 批注文件：读 `output/records/notes/I<编号>.md`，以及唯一的写入收口 `appendNotes`。
 *
 * 这是 AGENTS.md 不变量 1 第六条窄例外的**第二种写入**。
 * 和记录状态写入同形（看板自己写盘、不 spawn），但有一款是实质扩张：
 * **允许新建**批注文件。同编号的记录文件必须已经存在，不存在就 404，
 * 不因此去建记录。只追加，不改已有条目，不删、不改名。
 * **别在这个模块里加第二个写入口。**
 *
 * 格式的唯一事实源是工作空间 `output/records/README.md` 的「批注」一节。
 * 读失败、整份认不出条目时，返回「这份读不出来」，而不是空列表 ——
 * 空列表在界面上就是「没有批注」，坏文件会被人当成已经处理完。
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveInside } from './paths.mjs';
import { RECORDS_DIR, scanRecords } from './records.mjs';

export const NOTES_DIR = `${RECORDS_DIR}/notes`;

const ID_RE = /^I\d{4}$/;
const STRUCTURES = new Set(['段落', '表格行', '列表项', '跨块']);
/** 单条意见上限。超了整批不落盘，不写半批。 */
const COMMENT_LIMIT = 1000;
/** 单批条数上限。数的是请求里的条数，去重之前就拦。 */
const BATCH_LIMIT = 50;

const BATCH_RE = /^##[ \t]+(\d{4}-\d{2}-\d{2})[ \t]*·[ \t]*第[ \t]*(\d+)[ \t]*批(.*)$/;
const NOTE_RE = /^###[ \t]+(N\d{4})[ \t]*·[ \t]*(\S+)[ \t]*$/;
const FIELD_RE = /^-[ \t]*(状态|回执|源码区间|来源)[ \t]*[:：][ \t]?(.*)$/;
const OPINION_RE = /^(?:-[ \t]*)?意见[ \t]*[:：][ \t]?(.*)$/;


function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 比较用的相对路径：反斜杠折成斜杠，去掉 `./` 前缀。不做 `../` 解析，那是 resolveInside 的事。 */
export function normalizeWorkspacePath(value) {
  let text = String(value || '').replace(/\\/g, '/');
  while (text.startsWith('./')) text = text.slice(2);
  return text.replace(/\/+$/, '');
}

/**
 * 条目指纹：源码区间 + 原文 + 意见。
 * 迁移脚本用的是同一串，改这里要一起改 `migrate_note_history.py`。
 */
export function noteFingerprint(note) {
  const start = Number.isFinite(note.start) ? String(note.start) : '';
  const end = Number.isFinite(note.end) ? String(note.end) : '';
  return `${start},${end}\0${note.quote ?? ''}\0${note.comment ?? ''}`;
}

function codePoints(value) {
  return [...String(value)].length;
}

/**
 * 按预览路径反查记录编号。找不到不是错误 —— 调用方退回看板缓存。
 * 同一路径有多条记录时留编号最小的那条，结果稳定，不跟着目录顺序漂。
 *
 * @param {string} root
 * @param {string} file 工作空间相对路径
 * @returns {string | null}
 */
export function findRecordByTarget(root, file) {
  const wanted = normalizeWorkspacePath(file);
  if (!wanted) return null;
  let items = [];
  try {
    items = scanRecords(root).items || [];
  } catch {
    return null;
  }
  const hits = items.filter((item) => item && normalizeWorkspacePath(item.target) === wanted && ID_RE.test(item.id));
  if (!hits.length) return null;
  hits.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hits[0].id;
}

/**
 * 把批注文件解析成批次。认不出的 `###` 直接跳过；
 * 整份一个条目都没有时，由调用方决定这是「空文件」还是「读不出来」。
 *
 * @param {string} text
 * @returns {Array<{ date: string, index: number, migrated: boolean, notes: object[] }>}
 */
export function parseNoteDocument(text) {
  /** @type {Array<{ date: string, index: number, migrated: boolean, notes: object[] }>} */
  const batches = [];
  let batch = null;
  let note = null;
  /** @type {'quote' | 'comment' | ''} */
  let mode = '';

  function finishNote() {
    if (!note || !batch) {
      note = null;
      mode = '';
      return;
    }
    const quote = note.quoteLines.join('\n');
    const comment = note.commentLines.join('\n');
    const item = {
      noteId: note.noteId,
      structure: note.structure,
      status: note.status,
      receipt: note.receipt,
      quote,
      comment,
      migrated: note.migrated || batch.migrated || undefined,
    };
    if (Number.isFinite(note.start) && Number.isFinite(note.end)) {
      item.start = note.start;
      item.end = note.end;
    }
    if (!item.migrated) delete item.migrated;
    batch.notes.push(item);
    note = null;
    mode = '';
  }

  function finishBatch() {
    finishNote();
    if (batch && batch.notes.length) batches.push(batch);
    batch = null;
  }

  for (const line of String(text || '').split(/\r?\n/)) {
    const batchMatch = BATCH_RE.exec(line);
    if (batchMatch) {
      finishBatch();
      batch = {
        date: batchMatch[1],
        index: Number(batchMatch[2]),
        migrated: /迁移/.test(batchMatch[3] || ''),
        notes: [],
      };
      continue;
    }
    const noteMatch = NOTE_RE.exec(line);
    if (noteMatch) {
      finishNote();
      if (!batch) {
        // 条目不在批次标题下：仍收进来，让坏格式在界面上看得见，而不是整份消失
        batch = { date: '', index: 0, migrated: false, notes: [] };
      }
      note = {
        noteId: noteMatch[1],
        structure: noteMatch[2],
        status: '',
        receipt: '',
        start: undefined,
        end: undefined,
        quoteLines: [],
        commentLines: [],
        migrated: false,
      };
      mode = '';
      continue;
    }
    if (line.startsWith('## ')) {
      finishBatch();
      continue;
    }
    if (!note) continue;
    const field = FIELD_RE.exec(line);
    if (field) {
      mode = '';
      const value = field[2].trim();
      if (field[1] === '状态') note.status = value;
      else if (field[1] === '回执') note.receipt = value;
      else if (field[1] === '来源') note.migrated = /迁移/.test(value);
      else if (field[1] === '源码区间') {
        const span = /^(\d+)\s*,\s*(\d+)$/.exec(value);
        if (span) {
          note.start = Number(span[1]);
          note.end = Number(span[2]);
        }
      }
      continue;
    }
    if (line.startsWith('>')) {
      mode = 'quote';
      note.quoteLines.push(line.replace(/^>[ \t]?/, ''));
      continue;
    }
    const opinion = OPINION_RE.exec(line);
    if (opinion) {
      mode = 'comment';
      note.commentLines.push(opinion[1]);
      continue;
    }
    if (mode === 'quote') {
      if (!line.trim()) mode = '';
      continue;
    }
    if (mode === 'comment') {
      if (!line.trim()) {
        mode = '';
        continue;
      }
      note.commentLines.push(line);
    }
  }
  finishBatch();
  return batches;
}

function toBatches(recordId, parsed) {
  return parsed.map((batch) => ({
    id: `ws-${recordId}-${batch.date || 'loose'}-${batch.index}`,
    archivedAt: batch.date ? `${batch.date}T12:00:00.000Z` : '',
    recordId,
    notes: batch.notes,
  }));
}

/**
 * 读一份批注文件。文件不在 = 还没写过，不是错误。
 * 文件在但一个条目都解析不出来 = 读不出来，调用方必须把这件事显示出来。
 *
 * @param {string} root
 * @param {string} recordId
 */
export function readNoteFile(root, recordId) {
  const id = String(recordId || '').trim();
  if (!ID_RE.test(id)) {
    return { exists: false, broken: false, batches: [] };
  }
  const rel = `${NOTES_DIR}/${id}.md`;
  let abs;
  try {
    abs = resolveInside(root, rel);
  } catch {
    return { exists: false, broken: true, reason: '批注路径越出了工作空间', batches: [] };
  }
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    return { exists: false, broken: false, batches: [] };
  }
  let text = '';
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return {
      exists: true,
      broken: true,
      reason: `读取失败：${(err && err.message) || '未知原因'}`,
      batches: [],
    };
  }
  let parsed = [];
  try {
    parsed = parseNoteDocument(text);
  } catch (err) {
    return {
      exists: true,
      broken: true,
      reason: `解析失败：${(err && err.message) || '未知原因'}`,
      batches: [],
    };
  }
  if (text.trim() && !parsed.some((batch) => batch.notes.length)) {
    return {
      exists: true,
      broken: true,
      reason: '内容不是约定的批注格式，一条都没有读出来',
      batches: [],
    };
  }
  return { exists: true, broken: false, batches: toBatches(id, parsed) };
}

/**
 * 工作空间批注与看板缓存合并。缓存那一半原样带上，只加 `source`。
 * 没有记录时 `recordId` 是 null，调用方走缓存并在界面上说明。
 *
 * @param {string} root
 * @param {string} file
 * @param {object[]} cacheBatches `listNoteHistory` 返回的 batches
 */
export function mergeNoteHistory(root, file, cacheBatches) {
  const cache = (Array.isArray(cacheBatches) ? cacheBatches : []).map((batch) => ({
    ...batch,
    source: 'cache',
  }));
  const recordId = findRecordByTarget(root, file);
  if (!recordId) {
    return { file, recordId: null, batches: sortBatches(cache) };
  }
  const read = readNoteFile(root, recordId);
  const workspace = read.broken
    ? []
    : read.batches.map((batch) => ({ ...batch, source: 'workspace', recordId }));
  return {
    file,
    recordId,
    noteFile: `${NOTES_DIR}/${recordId}.md`,
    ...(read.broken ? { noteFileBroken: true, noteFileReason: read.reason || '批注文件读不出来' } : {}),
    batches: sortBatches([...workspace, ...cache]),
  };
}

function sortBatches(batches) {
  return [...batches].sort((a, b) => String(b.archivedAt || '').localeCompare(String(a.archivedAt || '')));
}

function assertRecordId(recordId) {
  const id = String(recordId || '').trim();
  if (!ID_RE.test(id)) {
    throw badRequest(`记录编号不合法：${id || '(空)'}。只接受 I 加四位数字，不接受路径。`);
  }
  return id;
}

function normalizeIncoming(raw) {
  if (!Array.isArray(raw)) throw badRequest('批注内容要是一个列表。');
  if (raw.length > BATCH_LIMIT) {
    throw badRequest(`一批最多 ${BATCH_LIMIT} 条，这次有 ${raw.length} 条。没有落盘。`);
  }
  if (!raw.length) throw badRequest('没有可落盘的批注。');
  return raw.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw badRequest(`第 ${index + 1} 条不是批注。`);
    }
    const pathKeys = ['file', 'path', 'target', 'noteFile', 'root'].filter((key) => key in value);
    if (pathKeys.length) {
      throw badRequest(`批注条目里不接受路径（${pathKeys.join('、')}）。`);
    }
    if ('status' in value && value.status !== 'pending') {
      throw badRequest('看板写入的状态只能是 pending。adopted / rejected / unclear 由 agent 回写。');
    }
    const quote = typeof value.quote === 'string' ? value.quote : '';
    const comment = typeof value.comment === 'string' ? value.comment : '';
    if (typeof value.quote !== 'undefined' && typeof value.quote !== 'string') {
      throw badRequest(`第 ${index + 1} 条的原文不是字符串。`);
    }
    if (typeof value.comment !== 'undefined' && typeof value.comment !== 'string') {
      throw badRequest(`第 ${index + 1} 条的意见不是字符串。`);
    }
    if (!quote && !comment) throw badRequest(`第 ${index + 1} 条没有原文也没有意见。`);
    const length = codePoints(comment);
    if (length > COMMENT_LIMIT) {
      throw badRequest(`第 ${index + 1} 条意见超过 ${COMMENT_LIMIT} 字（当前 ${length} 字）。没有落盘。`);
    }
    const note = {
      quote,
      comment,
      structure: STRUCTURES.has(value.structure) ? value.structure : '段落',
    };
    if (Number.isFinite(value.start) && Number.isFinite(value.end) && value.end >= value.start && value.start >= 0) {
      note.start = Math.floor(value.start);
      note.end = Math.floor(value.end);
    }
    if (Number.isFinite(value.number) && value.number >= 1) note.number = Math.floor(value.number);
    return note;
  });
}

function maxNoteNumber(text) {
  // 每次新开一个正则。复用带 /g 的正则会把 lastIndex 留到下一次，编号会算小
  let max = 0;
  for (const match of String(text).matchAll(/^###[ \t]+N(\d{4})\b/gm)) {
    max = Math.max(max, Number(match[1]));
  }
  return max;
}

function maxBatchIndex(text) {
  let max = 0;
  for (const match of String(text).matchAll(/^##[ \t]+\d{4}-\d{2}-\d{2}[ \t]*·[ \t]*第[ \t]*(\d+)[ \t]*批/gm)) {
    max = Math.max(max, Number(match[1]));
  }
  return max;
}

function quoteBlock(quote) {
  const text = String(quote ?? '');
  if (!text) return '>';
  return text.split('\n').map((line) => `> ${line}`).join('\n');
}

function renderNote(noteId, note) {
  const span = Number.isFinite(note.start) && Number.isFinite(note.end) ? `${note.start},${note.end}` : '';
  return [
    `### ${noteId} · ${note.structure}`,
    '',
    '- 状态：pending',
    '- 回执：',
    `- 源码区间：${span}`,
    '',
    quoteBlock(note.quote),
    '',
    `意见：${note.comment}`,
    '',
  ].join('\n');
}

function renderBatch(date, index, blocks) {
  return [`## ${date} · 第 ${index} 批`, '', ...blocks].join('\n');
}

/**
 * 追加一批批注。文件不存在才新建，且记录文件必须已存在。
 * 已有条目按指纹跳过，不改写。整份走临时文件再原子替换。
 *
 * @param {string} root
 * @param {string} recordId 只接受 `I0007` 这种编号
 * @param {object[]} rawNotes
 */
export function appendNotes(root, recordId, rawNotes) {
  const id = assertRecordId(recordId);
  const incoming = normalizeIncoming(rawNotes);

  const recordRel = `${RECORDS_DIR}/${id}.md`;
  const recordAbs = resolveInside(root, recordRel);
  if (!fs.existsSync(recordAbs) || fs.statSync(recordAbs).isDirectory()) {
    const err = new Error(`找不到这份产出物记录：${id}。看板不新建记录，也因此不新建它的批注文件。`);
    err.statusCode = 404;
    throw err;
  }

  const noteRel = `${NOTES_DIR}/${id}.md`;
  const noteAbs = resolveInside(root, noteRel);
  const existed = fs.existsSync(noteAbs) && !fs.statSync(noteAbs).isDirectory();
  let existing = '';
  if (existed) {
    existing = fs.readFileSync(noteAbs, 'utf8');
    if (existing.trim()) {
      const parsed = parseNoteDocument(existing);
      if (!parsed.some((batch) => batch.notes.length)) {
        throw badRequest(
          `${noteRel} 读不出来，没有往后面追加。先在编辑器里修好它，或把这份文件挪走后再复制一次。`,
        );
      }
    }
  }

  const seen = new Map();
  if (existing.trim()) {
    for (const batch of parseNoteDocument(existing)) {
      for (const note of batch.notes) seen.set(noteFingerprint(note), note.noteId);
    }
  }

  let number = maxNoteNumber(existing);
  const items = [];
  const fresh = [];
  for (const note of incoming) {
    const fp = noteFingerprint(note);
    const prev = seen.get(fp);
    if (prev) {
      items.push({ number: note.number, noteId: prev, duplicate: true });
      continue;
    }
    if (number >= 9999) {
      throw badRequest('这份批注的编号已经到 N9999，没有继续追加。');
    }
    number += 1;
    const noteId = `N${String(number).padStart(4, '0')}`;
    seen.set(fp, noteId);
    fresh.push(renderNote(noteId, note));
    items.push({ number: note.number, noteId, duplicate: false });
  }

  if (fresh.length) {
    const batchIndex = maxBatchIndex(existing) + 1;
    const section = renderBatch(today(), batchIndex, fresh);
    let next = existing;
    if (next && !next.endsWith('\n')) next += '\n';
    if (next.trim()) next += '\n';
    next += section;
    if (!next.endsWith('\n')) next += '\n';
    writeAtomic(noteAbs, next);
  }

  return {
    recordId: id,
    noteFile: noteRel,
    created: !existed && fresh.length > 0,
    items,
  };
}

function writeAtomic(abs, text) {
  const dir = path.dirname(abs);
  // 只建 notes/ 这一层。记录目录必须已经在（上面确认过记录文件），
  // 不用 recursive，避免顺手把 output/records 也建出来。
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir);
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
  }
  const tmp = path.join(dir, `.${path.basename(abs)}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, abs);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时件没写成，不用再删
    }
    throw err;
  }
}
