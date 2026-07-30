/**
 * 工作空间扫描器：把 pmwork 工作空间的目录状态读成一份结构化 JSON。
 * 只读，绝不写工作空间里的任何文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { countWords, firstHeading, parseFrontmatter } from './frontmatter.mjs';
import { readMeta } from './meta.mjs';
import { scanPrototypes } from './prototypes.mjs';

const SKIP = new Set(['.git', 'node_modules', '.DS_Store', '.gitkeep']);
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

function rel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

function listFiles(dir, { recursive = true } = {}) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) out.push(...listFiles(abs, { recursive }));
    } else {
      out.push(abs);
    }
  }
  return out;
}

function stat(abs) {
  const s = fs.statSync(abs);
  return { size: s.size, mtime: s.mtime.toISOString() };
}

/** 判断这份产物该怎么读：网页里渲染，还是交给系统打开。 */
function readerKind(ext) {
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.csv' || ext === '.tsv') return 'table';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'external'; // docx/pdf/xlsx… 网页不渲染，点开走系统
}

function readTextSafe(abs, limit = 2 * 1024 * 1024) {
  try {
    if (fs.statSync(abs).size > limit) return '';
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

/** input/converted 下的一个产物：可能是单个 .md，也可能是 xlsx 拆出来的目录。 */
function describeConverted(root, abs) {
  const isDir = fs.statSync(abs).isDirectory();
  const manifest = isDir ? path.join(abs, '_manifest.md') : abs;
  const ext = path.extname(abs).toLowerCase();
  const item = {
    path: rel(root, abs),
    name: path.basename(abs),
    isDir,
    ext,
    reader: isDir ? 'markdown' : readerKind(ext),
    ...stat(isDir ? manifest : abs),
  };
  if (isDir) {
    const sheets = listFiles(abs, { recursive: false })
      .filter((f) => /\.(csv|tsv)$/i.test(f))
      .sort((a, b) => a.localeCompare(b))
      .map((f) => {
        const name = path.basename(f);
        const ext = path.extname(f).toLowerCase();
        return {
          path: rel(root, f),
          name,
          ext,
          reader: 'table',
          title: name.replace(/\.(csv|tsv)$/i, ''),
          ...stat(f),
        };
      });
    item.sheets = sheets;
    item.size = sheets.reduce((sum, s) => sum + s.size, 0);
  }
  // frontmatter 里带着溯源信息，是这个看板最有价值的部分
  if (fs.existsSync(manifest) && manifest.endsWith('.md')) {
    const { meta, body } = parseFrontmatter(readTextSafe(manifest));
    item.source = meta.source || '';
    item.sourceSha256 = meta.source_sha256 || '';
    item.convertedBy = meta.converted_by || '';
    item.convertedAt = meta.converted_at || '';
    item.warning = meta.warning || '';
    item.extractedImages = Number(meta.extracted_images || 0);
    item.title = firstHeading(body);
    item.words = countWords(body);
  }
  return item;
}

function describeOutput(root, abs) {
  const ext = path.extname(abs).toLowerCase();
  const item = {
    path: rel(root, abs),
    name: path.basename(abs),
    ext,
    reader: readerKind(ext),
    ...stat(abs),
  };
  if (item.reader === 'markdown') {
    const { meta, body } = parseFrontmatter(readTextSafe(abs));
    item.title = firstHeading(body) || path.basename(abs, ext);
    item.words = countWords(body);
    if (meta.status) item.status = meta.status;
    if (meta.date) item.date = meta.date;
  } else {
    item.title = path.basename(abs, ext);
  }
  return item;
}

function scanInput(root) {
  const inputDir = path.join(root, 'input');
  const raw = listFiles(path.join(inputDir, 'raw')).map((abs) => ({
    path: rel(root, abs),
    name: path.basename(abs),
    ext: path.extname(abs).toLowerCase(),
    reader: readerKind(path.extname(abs).toLowerCase()),
    ...stat(abs),
  }));

  const convertedDir = path.join(inputDir, 'converted');
  const converted = [];
  if (fs.existsSync(convertedDir)) {
    for (const entry of fs.readdirSync(convertedDir, { withFileTypes: true })) {
      if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
      converted.push(describeConverted(root, path.join(convertedDir, entry.name)));
    }
  }

  const assets = listFiles(path.join(inputDir, 'assets')).map((abs) => ({
    path: rel(root, abs),
    name: path.basename(abs),
    ext: path.extname(abs).toLowerCase(),
    reader: 'image',
    ...stat(abs),
  }));

  // 哪些原始资料还没转换 —— 这是 PM 最该先看到的缺口
  const convertedSources = new Set(converted.map((c) => c.source).filter(Boolean));
  const pending = raw.filter((r) => !convertedSources.has(r.path));

  const indexPath = path.join(inputDir, 'INDEX.md');
  return {
    raw,
    converted,
    assets,
    pending,
    indexPath: fs.existsSync(indexPath) ? rel(root, indexPath) : '',
    stats: {
      raw: raw.length,
      converted: converted.length,
      assets: assets.length,
      pending: pending.length,
      warnings: converted.filter((c) => c.warning).length,
      words: converted.reduce((sum, c) => sum + (c.words || 0), 0),
      bytes: raw.reduce((sum, r) => sum + r.size, 0),
    },
  };
}

function scanOutput(root) {
  const outputDir = path.join(root, 'output');
  const groups = {};
  for (const group of ['analysis', 'docs', 'decisions']) {
    groups[group] = listFiles(path.join(outputDir, group))
      .map((abs) => describeOutput(root, abs))
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  }
  const all = Object.values(groups).flat();
  return {
    ...groups,
    stats: {
      analysis: groups.analysis.length,
      docs: groups.docs.length,
      decisions: groups.decisions.length,
      total: all.length,
      words: all.reduce((sum, f) => sum + (f.words || 0), 0),
      lastUpdated: all.length ? all.reduce((a, b) => (a.mtime > b.mtime ? a : b)).mtime : '',
    },
  };
}

export function scanWorkspace(project, status = { ok: true, reasons: [] }) {
  const root = project.root;
  return {
    project: { id: project.id, name: project.name, root },
    // 目录被改名/移走时不能扫出一份「什么都没有」的空结果 —— 那和真的空工作空间没法区分
    available: status.ok,
    unavailableReasons: status.reasons,
    scannedAt: new Date().toISOString(),
    meta: readMeta(root),
    input: scanInput(root),
    output: scanOutput(root),
    prototypes: scanPrototypes(root),
  };
}
