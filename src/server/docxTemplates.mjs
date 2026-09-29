/**
 * `output/docx-template/` 的只读清单。每个模板一个子目录。
 * 不进产出列表、搜索和完整度 —— 所以不放进 scan，单独给工作台的模版洗炼页。
 * 这个模块不写任何文件（写模板目录的是工作空间的 docx_template.py，见 docxTools.mjs）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveInside } from './paths.mjs';
import { docKeyOf } from './scan.mjs';

export const DOCX_TEMPLATE_DIR = 'output/docx-template';

/** 一个模板目录里约定的六样。`collect` 是目录，其余是文件。 */
const PARTS = [
  { key: 'profile', name: 'profile.json', dir: false },
  { key: 'reference', name: 'reference.docx', dir: false },
  { key: 'cover', name: 'cover.docx', dir: false },
  { key: 'spec', name: 'spec.md', dir: false },
  { key: 'collect', name: 'collect', dir: true },
  { key: 'sample', name: 'sample.docx', dir: false },
];

/** 采集报告可能有几百 KB；读不了、不是 JSON 一律当没有。 */
function readReport(root, relDir) {
  try {
    return JSON.parse(fs.readFileSync(resolveInside(root, `${relDir}/collect/report.json`), 'utf8'));
  } catch {
    return null;
  }
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/** 只接受一层基名：不含分隔符、不含 `..`、不以 `.` 开头。 */
function assertName(name) {
  const wanted = String(name || '').trim();
  if (
    !wanted
    || wanted.startsWith('.')
    || wanted === '.'
    || wanted.includes('..')
    || wanted.includes('/')
    || wanted.includes('\\')
  ) {
    throw badRequest(`模板名不合法：${wanted || '(空)'}。只接受一层目录名，不能带路径。`);
  }
  return wanted;
}

function statPart(dirAbs, part) {
  const abs = path.join(dirAbs, part.name);
  try {
    const stats = fs.statSync(abs);
    const ok = part.dir ? stats.isDirectory() : stats.isFile();
    if (!ok) return { exists: false, mtime: '' };
    return { exists: true, mtime: stats.mtime.toISOString() };
  } catch {
    return { exists: false, mtime: '' };
  }
}

function describeDir(root, name) {
  const relPath = `${DOCX_TEMPLATE_DIR}/${name}`;
  const abs = resolveInside(root, relPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return null;
  const stats = fs.statSync(abs);
  const files = {};
  for (const part of PARTS) files[part.key] = statPart(abs, part);
  const item = {
    name,
    path: relPath,
    mtime: stats.mtime.toISOString(),
    files,
    // 有 reference.docx 才算「已生成」：只采集过的目录能继续做，但不能拿来转 Word
    generated: files.reference.exists,
  };
  // 来源：采集报告里记的工作空间相对路径。给出 docKey，「继续」「重新提炼」才能不收路径地接着做
  const report = files.collect.exists ? readReport(root, relPath) : null;
  if (report && typeof report.source === 'string') {
    item.source = report.source;
    if (report.source.startsWith('input/raw/') && fs.existsSync(resolveInside(root, report.source))) {
      item.sourceDocKey = docKeyOf(report.source);
    }
  }
  return item;
}

/**
 * @param {string} root
 * @returns {{ dir: string, available: boolean, items: object[] }}
 */
export function listDocxTemplates(root) {
  const dir = resolveInside(root, DOCX_TEMPLATE_DIR);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { dir: DOCX_TEMPLATE_DIR, available: false, items: [] };
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { dir: DOCX_TEMPLATE_DIR, available: false, items: [] };
  }
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const item = describeDir(root, entry.name);
    if (item) items.push(item);
  }
  items.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return { dir: DOCX_TEMPLATE_DIR, available: true, items };
}

/**
 * @param {string} root
 * @param {string} name 模板目录的基名
 */
export function readDocxTemplate(root, name) {
  const wanted = assertName(name);
  const item = describeDir(root, wanted);
  if (!item) {
    const err = new Error(`找不到这个模板：${wanted}`);
    err.statusCode = 404;
    throw err;
  }
  let spec = '';
  if (item.files.spec.exists) {
    try {
      spec = fs.readFileSync(resolveInside(root, `${item.path}/spec.md`), 'utf8');
    } catch {
      spec = '';
    }
  }
  const report = item.files.collect.exists ? readReport(root, item.path) : null;
  return { ...item, spec, ...(report ? { report } : {}) };
}
