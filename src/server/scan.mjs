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
  if (ext === '.html' || ext === '.htm') return 'html';
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

/** input/converted 下的一个产物：.md、xlsx 拆目录、或 html 原型目录。 */
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
    // 顶层文件：html 原型只看一层；csv 递归（点表分册在 分册/*.csv）
    const topFiles = listFiles(abs, { recursive: false });
    const allFiles = listFiles(abs, { recursive: true });
    const sheets = allFiles
      .filter((f) => /\.(csv|tsv)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, 'zh'))
      .map((f) => {
        // 用相对转换目录的路径当显示名，区分 测点主表.csv 与 分册/xx.csv
        const name = path.relative(abs, f).split(path.sep).join('/');
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

    // 点表等产物常带 sqlite 供 SQL 检索；只记路径，看板不读二进制
    const sqlite = allFiles.find((f) => /\.sqlite$/i.test(f));
    if (sqlite) item.sqlitePath = rel(root, sqlite);

    // 单文件 HTML 原型包：目录内保留 .html + _manifest.md
    const htmlFiles = topFiles
      .filter((f) => /\.html?$/i.test(f))
      .sort((a, b) => a.localeCompare(b));
    if (htmlFiles.length) {
      const htmlAbs = htmlFiles[0];
      item.reader = 'html';
      item.htmlPath = rel(root, htmlAbs);
      item.htmlName = path.basename(htmlAbs);
      item.size = stat(htmlAbs).size + (fs.existsSync(manifest) ? stat(manifest).size : 0);
    } else {
      item.size = sheets.reduce((sum, s) => sum + s.size, 0);
      // 有 csv 的目录型产物（xlsx 拆表 / 点表）按表格读；摘要在 _manifest.md
      if (sheets.length) item.reader = 'table';
    }
  }
  // frontmatter 里带着溯源信息，是这个看板最有价值的部分
  if (fs.existsSync(manifest) && manifest.endsWith('.md')) {
    const { meta, body } = parseFrontmatter(readTextSafe(manifest));
    item.source = meta.source || '';
    // 点表这类产物汇总整个目录（几百个源文件 → 一份主表），source 记的是目录。
    // 这两个字段告诉扫描器该目录下哪些扩展名已被消费，见 scanInput 的 pending 计算。
    item.sourceIsDir = String(meta.source_is_dir || '') === 'true';
    item.sourceKinds = String(meta.source_kinds || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    item.sourceSha256 = meta.source_sha256 || '';
    item.convertedBy = meta.converted_by || '';
    item.convertedAt = meta.converted_at || '';
    item.warning = meta.warning || '';
    item.extractedImages = Number(meta.extracted_images || 0);
    item.title = firstHeading(body);
    item.words = countWords(body);
    // manifest 可写 preview: foo.html，优先用它
    if (item.reader === 'html' && meta.preview) {
      const previewAbs = path.join(abs, meta.preview);
      if (fs.existsSync(previewAbs)) {
        item.htmlPath = rel(root, previewAbs);
        item.htmlName = path.basename(previewAbs);
      }
    }
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
  // 目录型产物（点表：几百个源文件汇总成一份主表）按「目录前缀 + 已消费的扩展名」覆盖。
  // 只按目录一刀切会把目录里真没处理的文件（如 .bak）也藏起来，那就看不见缺口了。
  const coveredDirs = converted
    .filter((c) => c.sourceIsDir && c.source)
    .map((c) => ({ prefix: c.source + '/', kinds: c.sourceKinds }));
  const isCovered = (r) =>
    convertedSources.has(r.path) ||
    coveredDirs.some((d) => r.path.startsWith(d.prefix) && d.kinds.includes(r.ext));
  const pending = raw.filter((r) => !isCovered(r));

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
    prototypes: scanPrototypes(root, project.id),
  };
}
