/**
 * xlsx / xlsm 只读解析：把一张 sheet 编成与 csv 分页相同的行文本。
 *
 * 路径由调用方先过 resolveInside()。本模块不写磁盘、不覆盖、不删；
 * 解析结果只留在进程内存，按 绝对路径 + mtimeMs 失效，最多缓存 4 本。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { matchesAllTokens } from '../shared/textMatch.mjs';

// SheetJS 社区版以 CJS 为主；createRequire 避开 ESM 互操作把 readFile 挂丢。
// 必须写成 require('xlsx') 字面量：组包脚本按这个扫 dependencies。
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

/** 解开后内存会放大；超过这个体积请用系统程序打开，不要在预览里硬看 */
const MAX_BYTES = 8 * 1024 * 1024;
const CACHE_LIMIT = 4;

/**
 * @typedef {{ headerLine: string, lines: string[] }} SheetTable
 * @typedef {{ sheets: string[], byName: Map<string, SheetTable> }} WorkbookCache
 */

/** @type {Map<string, WorkbookCache>} */
const cache = new Map();

function fail(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  throw err;
}

function cacheKey(abs, mtimeMs) {
  return `${abs}\0${mtimeMs}`;
}

function cacheGet(abs, mtimeMs) {
  const key = cacheKey(abs, mtimeMs);
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(abs, mtimeMs, book) {
  const key = cacheKey(abs, mtimeMs);
  cache.set(key, book);
  while (cache.size > CACHE_LIMIT) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowToCsv(cells) {
  return cells.map(csvEscape).join(',');
}

/**
 * 单元格显示值：已格式化的缓存结果优先；没有缓存值时留下公式字面量。
 * 不走 sheet_to_json：raw:false 在没有 v/w 时给出空串，公式就丢了。
 */
function cellDisplay(cell) {
  if (!cell) return '';
  if (cell.w != null && cell.w !== '') return String(cell.w);
  if (cell.v != null && cell.v !== '') return String(cell.v);
  if (typeof cell.f === 'string' && cell.f) {
    return cell.f.startsWith('=') ? cell.f : `=${cell.f}`;
  }
  if (cell.v != null) return String(cell.v);
  return '';
}

function sheetToCsvLines(sheet) {
  if (!sheet || !sheet['!ref']) return [];
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const lines = [];
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    const cells = [];
    let empty = true;
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const value = cellDisplay(sheet[XLSX.utils.encode_cell({ r, c })]);
      cells.push(value);
      if (value !== '') empty = false;
    }
    if (!empty) lines.push(rowToCsv(cells));
  }
  return lines;
}

function classifyReadError(err) {
  const msg = String(err?.message || err);
  if (/password|encrypt/i.test(msg)) {
    fail('这是加密文件，看板读不了，请用系统程序打开', 400);
  }
  fail(`读不了这份工作簿：${msg}`, 400);
}

/** xlsx/xlsm 是 ZIP；加密工作簿常见为 OLE 复合文档。其它魔术头一律当坏文件。 */
function assertWorkbookMagic(abs) {
  const fd = fs.openSync(abs, 'r');
  const buf = Buffer.alloc(8);
  try {
    fs.readSync(fd, buf, 0, 8, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (buf[0] === 0x50 && buf[1] === 0x4b) return; // PK = ZIP
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
    fail('这是加密文件，看板读不了，请用系统程序打开', 400);
  }
  fail('读不了这份工作簿：不是有效的 Excel 工作簿', 400);
}

/**
 * @param {string} abs 绝对路径（调用方已过 resolveInside）
 * @returns {{ book: WorkbookCache, stats: fs.Stats }}
 */
function loadWorkbook(abs) {
  const stats = fs.statSync(abs);
  if (stats.size > MAX_BYTES) {
    fail('这份工作簿超过 8 MiB，网页里不解析，请用系统程序打开', 413);
  }
  const cached = cacheGet(abs, stats.mtimeMs);
  if (cached) return { book: cached, stats };

  assertWorkbookMagic(abs);

  let workbook;
  try {
    workbook = XLSX.readFile(abs, { cellFormula: true, cellNF: true, cellText: true });
  } catch (err) {
    classifyReadError(err);
  }

  const sheets = workbook.SheetNames || [];
  if (!sheets.length) fail('这份工作簿里没有工作表', 400);

  const byName = new Map();
  for (const name of sheets) {
    const csvLines = sheetToCsvLines(workbook.Sheets[name]);
    byName.set(name, {
      headerLine: csvLines[0] || '',
      lines: csvLines.slice(1),
    });
  }

  const book = { sheets, byName };
  cacheSet(abs, stats.mtimeMs, book);
  return { book, stats };
}

function resolveSheetName(book, sheet) {
  if (!sheet) return book.sheets[0];
  if (book.byName.has(sheet)) return sheet;
  fail(`没有叫「${sheet}」的工作表。可用的表：${book.sheets.join('、')}`, 400);
}

/**
 * 按 sheet 切一页，响应形状与 readCsvPage 对齐，另带 sheets / sheet。
 *
 * @param {string} abs
 * @param {{ sheet?: string, offset?: number, limit?: number }} [opts]
 */
export function readSheetPage(abs, { sheet, offset = 0, limit = 50 } = {}) {
  const { book, stats } = loadWorkbook(abs);
  const name = resolveSheetName(book, sheet);
  const table = book.byName.get(name);
  const start = Math.max(0, offset);
  return {
    headerLine: table.headerLine,
    lines: table.lines.slice(start, start + limit),
    totalRows: table.lines.length,
    offset: start,
    limit,
    size: stats.size,
    mtime: stats.mtime.toISOString(),
    sheets: book.sheets,
    sheet: name,
  };
}

/**
 * 在已经解析出的行数组上做与 csv 相同的「整行包含全部分词」。
 * 命中 text 就是分页接口会给前端的那一行 csv。
 *
 * @param {string} abs
 * @param {{ sheet?: string, tokens: string[], limit: number, budgetMs: number, isAborted?: () => boolean }} opts
 */
export function scanSheet(
  abs,
  { sheet, tokens, limit, budgetMs, isAborted = () => false },
) {
  const { book, stats } = loadWorkbook(abs);
  const name = resolveSheetName(book, sheet);
  const table = book.byName.get(name);
  const deadline = Date.now() + budgetMs;
  const rows = [];
  let truncated = false;
  let partial = false;
  let aborted = false;
  let scannedRows = 0;

  for (const line of table.lines) {
    if (matchesAllTokens(line, tokens)) rows.push({ row: scannedRows, text: line });
    scannedRows += 1;
    if (rows.length >= limit) {
      truncated = true;
      break;
    }
    if (scannedRows % 2000 === 0) {
      if (isAborted()) {
        aborted = true;
        break;
      }
      if (Date.now() > deadline) {
        partial = true;
        break;
      }
    }
  }

  return {
    rows,
    scannedRows,
    truncated,
    partial,
    aborted,
    totalRows: table.lines.length,
    size: stats.size,
    mtime: stats.mtime.toISOString(),
    sheets: book.sheets,
    sheet: name,
  };
}
