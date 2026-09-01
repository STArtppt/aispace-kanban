/**
 * 预览批注的历史批次。
 *
 * 写在看板自己的配置目录 ~/.pmwork/dashboard/note-history/，不碰工作空间。
 * 当前正在写的批注仍在浏览器本地；文档被改动后，前端把这一批归档到这里，
 * 页面上的标记点随之清掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.mjs';

const HISTORY_ROOT = path.join(CONFIG_DIR, 'note-history');
const STRUCTURES = new Set(['段落', '表格行', '列表项', '跨块']);

/** 项目 id 可以含中文，但不能含路径分隔符和 Windows 非法文件名字符。 */
function historyFile(projectId) {
  const safe = String(projectId).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'workspace';
  return path.join(HISTORY_ROOT, `${safe}.json`);
}

function readStore(projectId) {
  try {
    const raw = JSON.parse(fs.readFileSync(historyFile(projectId), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    /** @type {Record<string, object[]>} */
    const next = {};
    for (const [file, batches] of Object.entries(raw)) {
      if (typeof file !== 'string' || !Array.isArray(batches)) continue;
      const kept = batches.map(asBatch).filter(Boolean);
      if (kept.length) next[file] = kept;
    }
    return next;
  } catch {
    // 文件不在或坏了都当没有历史：少一批记录，也好过接口崩
    return {};
  }
}

function writeStore(projectId, store) {
  fs.mkdirSync(HISTORY_ROOT, { recursive: true });
  const file = historyFile(projectId);
  if (!Object.keys(store).length) {
    try {
      fs.unlinkSync(file);
    } catch {
      // 本来就没有
    }
    return;
  }
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function asNote(value) {
  if (!value || typeof value !== 'object') return null;
  const quote = typeof value.quote === 'string' ? value.quote : '';
  const comment = typeof value.comment === 'string' ? value.comment : '';
  if (!quote && !comment) return null;
  const structure = STRUCTURES.has(value.structure) ? value.structure : '段落';
  const note = { quote, comment, structure };
  if (Number.isFinite(value.start) && Number.isFinite(value.end) && value.end >= value.start) {
    note.start = value.start;
    note.end = value.end;
  }
  if (Number.isFinite(value.number) && value.number >= 1) {
    note.number = Math.floor(value.number);
  }
  return note;
}

function asBatch(value) {
  if (!value || typeof value !== 'object') return null;
  const notes = Array.isArray(value.notes) ? value.notes.map(asNote).filter(Boolean) : [];
  if (!notes.length) return null;
  return {
    id: typeof value.id === 'string' && value.id ? value.id : `h-${Date.now()}`,
    archivedAt: typeof value.archivedAt === 'string' ? value.archivedAt : new Date().toISOString(),
    notes,
  };
}

function normalizeNotes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(asNote).filter(Boolean);
}

export function listNoteHistory(projectId, file) {
  const store = readStore(projectId);
  return { file, batches: store[file] || [] };
}

export function appendNoteHistory(projectId, file, rawNotes) {
  const notes = normalizeNotes(rawNotes);
  if (!notes.length) {
    const err = new Error('没有可归档的批注');
    err.statusCode = 400;
    throw err;
  }
  const store = readStore(projectId);
  const batch = {
    id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `h-${Date.now()}`,
    archivedAt: new Date().toISOString(),
    notes,
  };
  const batches = [batch, ...(store[file] || [])];
  store[file] = batches;
  writeStore(projectId, store);
  return { file, batch, batches };
}

export function clearNoteHistory(projectId, file) {
  const store = readStore(projectId);
  delete store[file];
  writeStore(projectId, store);
  return { file, batches: [] };
}
