/**
 * 工作空间扫描器：把 pmwork 工作空间的目录状态读成一份结构化 JSON。
 * 只读，绝不写工作空间里的任何文件。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { countAnnotations, linkReferences } from './citations.mjs';
import { countWords, firstHeading, parseFrontmatter } from './frontmatter.mjs';
import { readMeta } from './meta.mjs';
import { scanPrototypes } from './prototypes.mjs';

const SKIP = new Set(['.git', 'node_modules', '.DS_Store', '.gitkeep']);
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
/** 图片资料的兜底分组：没有归到某份文档名下的图都算这一堆（ingest.py 的落点同名） */
const UNSORTED_ASSETS = '未分类';
/**
 * 一份产物的**正文容器**，本身不是产物 —— 它属于旁边那份 `_manifest_<名>.md`。
 * 工作空间的 scripts/layout.py 定义了这套落点：converted/ 的目录结构镜像 raw/，
 * 一源多产物的正文收进 SplittingObject/<名>/，整目录合并的收进 MergedObject/。
 */
const PAYLOAD_DIRS = new Set(['SplittingObject', 'MergedObject']);
/** 镜像目录里的产物入口文件名 */
const MANIFEST_RE = /^_manifest_(.+)\.md$/;

function rel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

/**
 * 读 input/.ingestignore —— 不进转换、也不算「待转换」的资料清单。
 * gitignore 风格：一行一个模式，# 是注释，路径相对 input/ 写。
 * 工作空间 scripts/layout.py 的 load_ignore()（三个转换脚本共用）读的是同一份，
 * 两边规则改动要同步。
 */
function readIgnorePatterns(root) {
  const file = path.join(root, 'input', '.ingestignore');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.replace(/\/+$/, ''));
}

/** 把模式里的 * / ? 通配翻成正则，其余字符原样转义 */
function globToRegExp(pattern) {
  const body = pattern
    .split('')
    .map((ch) => (ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`);
}

/**
 * 返回「这份资料是否被忽略」的判定函数。
 * 入参是相对工作空间根的路径（input/raw/客户版/x.doc），而模式相对 input/ 写
 * （raw/客户版），所以先剥掉 input/ 前缀再比。
 */
function makeIgnoreMatcher(patterns) {
  if (!patterns.length) return () => false;
  const compiled = patterns.map((p) => ({ raw: p, re: globToRegExp(p) }));
  return (relPath) => {
    const p = relPath.startsWith('input/') ? relPath.slice('input/'.length) : relPath;
    const name = p.split('/').pop();
    return compiled.some(
      // 目录前缀命中：写 raw/客户版 等于连同其下所有文件
      ({ raw, re }) => p === raw || p.startsWith(`${raw}/`) || re.test(p) || re.test(name),
    );
  };
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

/**
 * input/converted 下的一份产物。三种形态：
 *
 *  1. `_manifest_<名>.md` —— 新布局的产物入口。正文在 frontmatter `payload:` 指的同级容器目录里
 *     （SplittingObject/<名>/ 或 MergedObject/），摘要留在镜像目录，界面上按「一份产物」呈现。
 *  2. 单个 .md / .csv —— 一源一产物，文件自己就是全部。
 *  3. 目录 + 里面的 `_manifest.md` —— 旧布局的目录型产物。旧工作空间还没搬迁就靠这一支。
 *
 * `path` 指的是产物的「包」（有正文目录就是正文目录，否则就是文件本身），`manifestPath` 单独给
 * 出摘要在哪 —— 新布局里摘要不在正文目录内，前端不能再按 `path + '/_manifest.md'` 拼。
 */
function describeConverted(root, abs) {
  const convertedDir = path.join(root, 'input', 'converted');
  const isDirEntry = fs.statSync(abs).isDirectory();
  const nameHit = isDirEntry ? null : path.basename(abs).match(MANIFEST_RE);

  // 产物入口：要读正文、算字数、取溯源的那一份
  const entry = isDirEntry ? path.join(abs, '_manifest.md') : abs;
  const hasManifest = entry.endsWith('.md') && fs.existsSync(entry);
  const { meta, body } = hasManifest
    ? parseFrontmatter(readTextSafe(entry))
    : { meta: {}, body: '' };

  // 正文目录。旧布局就是产物目录本身；新布局按 payload 找同级容器。
  let payload = isDirEntry ? abs : '';
  if (!payload && nameHit && meta.payload) {
    const candidate = path.resolve(path.dirname(abs), String(meta.payload));
    // frontmatter 是工作空间里的用户内容，不许它把路径指到 converted/ 外面去
    const inside = candidate === convertedDir || candidate.startsWith(convertedDir + path.sep);
    if (inside && fs.existsSync(candidate)) payload = candidate;
  }

  const isDir = Boolean(payload);
  const ext = isDirEntry ? '' : path.extname(abs).toLowerCase();
  // 转换产物用文件名当标题，不用正文一级标题：模板/手册类文档的 h1 经常是
  // 「文档概述」这类章节名，复制引用时对不上磁盘上的那份文件。
  const label = nameHit ? nameHit[1] : path.basename(abs, isDirEntry ? '' : ext);
  const item = {
    path: rel(root, payload || abs),
    name: nameHit ? nameHit[1] : path.basename(abs),
    isDir,
    ext,
    reader: isDir ? 'markdown' : readerKind(ext),
    title: label,
    /**
     * 产物在目录树里的位置，相对 input/converted/。新布局下 converted/ 与 raw/ 同构，
     * 所以这就是资料自己的整理方式；摘要文件在树里显示成产物名（去掉 `_manifest_` 前缀），
     * 不然树里全是 `_manifest_xxx.md`，正文却藏在 SplittingObject/ 下面看不见。
     */
    treePath: rel(convertedDir, nameHit ? path.join(path.dirname(abs), label) : abs),
    ...stat(hasManifest ? entry : abs),
  };
  if (hasManifest) item.manifestPath = rel(root, entry);

  if (isDir) {
    // 顶层文件：html 原型只看一层；csv 递归（点表分册在 分册/*.csv）
    const topFiles = listFiles(payload, { recursive: false });
    const allFiles = listFiles(payload, { recursive: true });
    const sheets = allFiles
      .filter((f) => /\.(csv|tsv)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, 'zh'))
      .map((f) => {
        // 用相对正文目录的路径当显示名，区分 测点主表.csv 与 分册/xx.csv
        const name = path.relative(payload, f).split(path.sep).join('/');
        const sheetExt = path.extname(f).toLowerCase();
        return {
          path: rel(root, f),
          name,
          ext: sheetExt,
          reader: 'table',
          title: name.replace(/\.(csv|tsv)$/i, ''),
          ...stat(f),
        };
      });
    item.sheets = sheets;

    // 点表等产物常带 sqlite 供 SQL 检索；只记路径，看板不读二进制
    const sqlite = allFiles.find((f) => /\.sqlite$/i.test(f));
    if (sqlite) item.sqlitePath = rel(root, sqlite);

    // 单文件 HTML 原型包：正文目录里保留 .html
    const htmlFiles = topFiles
      .filter((f) => /\.html?$/i.test(f))
      .sort((a, b) => a.localeCompare(b));
    if (htmlFiles.length) {
      const htmlAbs = htmlFiles[0];
      item.reader = 'html';
      item.htmlPath = rel(root, htmlAbs);
      item.htmlName = path.basename(htmlAbs);
      item.size = stat(htmlAbs).size + (hasManifest ? stat(entry).size : 0);
    } else {
      item.size = sheets.reduce((sum, s) => sum + s.size, 0);
      // 有 csv 的目录型产物（xlsx 拆表 / 点表）按表格读；摘要在 manifest 里
      if (sheets.length) item.reader = 'table';
    }
  }

  // frontmatter 里带着溯源信息，是这个看板最有价值的部分
  if (hasManifest) {
    item.source = meta.source || '';
    // 点表这类产物汇总整个目录（几百个源文件 → 一份主表），source 记的是目录。
    // 这两个字段告诉扫描器该目录下哪些扩展名已被消费，见 scanInput 的 pending 计算。
    item.sourceIsDir = String(meta.source_is_dir || '') === 'true';
    item.sourceKinds = String(meta.source_kinds || '')
      .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    item.sourceSha256 = meta.source_sha256 || '';
    item.convertedBy = meta.converted_by || '';
    item.convertedAt = meta.converted_at || '';
    item.warning = meta.warning || '';
    item.extractedImages = Number(meta.extracted_images || 0);
    item.words = countWords(body);
    // manifest 可写 preview: <正文目录>/foo.html，相对 manifest 自己所在目录
    if (item.reader === 'html' && meta.preview) {
      const previewAbs = path.join(path.dirname(entry), String(meta.preview));
      if (fs.existsSync(previewAbs)) {
        item.htmlPath = rel(root, previewAbs);
        item.htmlName = path.basename(previewAbs);
      }
    }
  }
  return item;
}

/**
 * 递归走 input/converted/，把产物认出来。目录结构镜像 input/raw/，中间那些镜像目录
 * 本身不是产物，要走进去；SplittingObject/ MergedObject/ 是正文容器，跳过不进
 * （它们的内容已经挂在旁边那份 manifest 的 sheets 上了）。
 */
function collectConverted(root, dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (!entry.isDirectory()) {
      out.push(describeConverted(root, abs));
      continue;
    }
    if (PAYLOAD_DIRS.has(entry.name)) continue;
    // 旧布局的目录型产物：目录里直接躺着 _manifest.md，整个目录算一份产物
    if (fs.existsSync(path.join(abs, '_manifest.md'))) {
      out.push(describeConverted(root, abs));
      continue;
    }
    collectConverted(root, abs, out);
  }
}

/**
 * 返回 { item, body }：body 只在扫描期内用来反查引用关系，不进 JSON。
 * 非 markdown 产物没有正文可分析，body 为空串。
 */
function describeOutput(root, abs) {
  const ext = path.extname(abs).toLowerCase();
  const item = {
    path: rel(root, abs),
    name: path.basename(abs),
    ext,
    reader: readerKind(ext),
    ...stat(abs),
  };
  if (item.reader !== 'markdown') {
    item.title = path.basename(abs, ext);
    return { item, body: '' };
  }
  const { meta, body } = parseFrontmatter(readTextSafe(abs));
  item.title = firstHeading(body) || path.basename(abs, ext);
  item.words = countWords(body);
  if (meta.status) item.status = meta.status;
  if (meta.date) item.date = meta.date;
  // 一条标注都没有时不写这个字段：界面上「0 条」和「旧服务进程没这字段」都是不显示
  const annotations = countAnnotations(body);
  if (annotations.total) item.annotations = annotations;
  return { item, body };
}

/**
 * 把 input/assets/ 下的图片按首层目录聚成「图库」。
 * 一份 PDF 能抽出几十张图，全摞在一个网格里等于找不到；目录名就是转换产物的 slug，
 * 所以标题回填成那份文档的标题。直接躺在 assets/ 根下的图（旧版 ingest.py 的落点）
 * 与 assets/未分类/ 合成同一堆，免得同一批图分裂成两个图库。
 */
function groupAssets(root, assets, converted) {
  const prefix = 'input/assets/';
  const byKey = new Map();
  for (const item of assets) {
    if (!item.path.startsWith(prefix)) continue;
    const segments = item.path.slice(prefix.length).split('/');
    const key = segments.length > 1 ? segments[0] : UNSORTED_ASSETS;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(item);
  }

  // 图库目录名跟着源文件名走，产物名也是 —— 但产物已经不在 converted/ 根下了
  // （目录结构镜像 raw/），所以按名字认，不按路径拼。
  const docTitle = (key) => {
    const doc = converted.find((c) => c.title === key || c.name === key || c.name === `${key}.md`);
    return doc ? doc.title || doc.name : '';
  };

  const groups = [];
  for (const [key, images] of byKey) {
    images.sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }));
    // 组自己的路径必须真实存在，「在访达中显示」才点得开：旧落点没有 未分类/ 这层目录
    const dirExists = fs.existsSync(path.join(root, 'input', 'assets', key));
    groups.push({
      path: dirExists ? `${prefix}${key}` : 'input/assets',
      name: key,
      reader: 'gallery',
      title: (key === UNSORTED_ASSETS ? '' : docTitle(key)) || key,
      images,
      size: images.reduce((sum, i) => sum + i.size, 0),
      mtime: images.reduce((latest, i) => (i.mtime > latest ? i.mtime : latest), ''),
    });
  }
  // 未分类是兜底堆，排在有出处的文档图库后面
  groups.sort((a, b) => {
    if (a.name === UNSORTED_ASSETS) return 1;
    if (b.name === UNSORTED_ASSETS) return -1;
    return a.title.localeCompare(b.title, 'zh');
  });
  return groups;
}

/**
 * 读回「哪些原始图片已经拷进 assets/ 了」（ingest.py 写在 assets/<组>/_manifest.md 的
 * sources 列表里）。图片没有 .md 产物，光看 converted/ 会让它永远停在待转换列表里 ——
 * 那是本仓踩过的坑：文件明明已经入库，界面上还在催人转换。
 * 旧版 ingest.py 不写这份清单，读不到就退回改动前的行为（图片仍算待转换）。
 */
function readAssetSources(root) {
  const assetsDir = path.join(root, 'input', 'assets');
  const out = new Set();
  if (!fs.existsSync(assetsDir)) return out;
  for (const entry of fs.readdirSync(assetsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const manifest = path.join(assetsDir, entry.name, '_manifest.md');
    if (!fs.existsSync(manifest)) continue;
    const { meta } = parseFrontmatter(readTextSafe(manifest));
    const sources = Array.isArray(meta.sources) ? meta.sources : [];
    for (const src of sources) {
      if (src) out.add(src);
    }
  }
  return out;
}

/**
 * 反查产物记着的原件还在不在、动没动过。转换是单向的：产物留着、原件被删掉时，
 * 光看 converted/ 一切正常，只有 pending 少一项 —— 溯源已经断了却没人知道。
 *
 * missing（原件不见了）只标注、不追责：转完删原件省空间是正当用法，所以它不进 warnings 计数，
 * 界面上也不给 orange。stale（原件在转换后动过）才是真要人重转一次的，走 orange。
 * source 为空的产物（手写的 md、旧版转换器）不判断，什么都不返回。
 */
function attachSourceState(root, converted) {
  for (const item of converted) {
    const source = (item.source || '').replace(/\/+$/, '');
    // 绝对路径和 ../ 一律不碰：frontmatter 是工作空间里的用户内容，不拿它去 stat 工作空间外
    if (!source || path.isAbsolute(source) || source.split('/').includes('..')) continue;
    let s;
    try {
      s = fs.statSync(path.join(root, source));
    } catch {
      item.sourceState = 'missing';
      continue;
    }
    // 目录型 source（点表这类几百个文件汇总成一份的产物）：目录的 mtime 只反映条目增删，
    // 改文件内容不会动它 —— 判不出「改过」，就只报「还在」，不假装知道。
    if (s.isDirectory()) {
      item.sourceState = 'ok';
      continue;
    }
    // 只比 mtime，不算哈希：scan 是 fs.watch 每次都要跑的热路径，几百份资料挨个哈希会把界面拖死。
    // 代价是 git checkout / 网盘同步这类只动 mtime 不动内容的操作会误报，所以文案只陈述
    // 「原件在转换后改动过」这个事实，要坐实得点「校验原件」走 sha256（verify-source 接口）。
    item.sourceState = item.mtime && s.mtime.toISOString() > item.mtime ? 'stale' : 'ok';
  }
}

/** 流式算 sha256：大 PDF 有几百 MB，不能整个读进内存。 */
function sha256File(abs) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(abs);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 精确校验一份产物的原件动没动过：拿 frontmatter 里的 source_sha256 跟现在的原件重算一遍比。
 * 这是 attachSourceState 那套 mtime 廉价判据的「坐实」手段 —— 只在用户点「校验原件」时跑一次，
 * 绝不进扫描热路径。比不了的情况（没记来源、没记 sha256、来源是目录）一律返回 unknown +
 * 一句中文原因，不要猜，也不要拿 mtime 的结论冒充哈希的结论。
 */
export async function verifySource(root, relPath) {
  const abs = path.join(root, relPath);
  // 目录型产物的溯源信息写在 _manifest.md 里
  const isDir = fs.existsSync(abs) && fs.statSync(abs).isDirectory();
  const manifest = isDir ? path.join(abs, '_manifest.md') : abs;
  if (!fs.existsSync(manifest)) {
    const err = new Error('产物不存在');
    err.statusCode = 404;
    throw err;
  }
  const { meta } = parseFrontmatter(readTextSafe(manifest));
  const source = String(meta.source || '').replace(/\/+$/, '');
  const sourceSha256 = String(meta.source_sha256 || '');
  const out = { path: relPath, source, sourceSha256, checkedAt: new Date().toISOString() };
  if (!source) return { ...out, state: 'unknown', reason: '这份产物没记来源' };
  // 与 attachSourceState 同一条守卫：frontmatter 是用户内容，不拿它去读工作空间外的文件
  if (path.isAbsolute(source) || source.split('/').includes('..')) {
    return { ...out, state: 'unknown', reason: '来源路径指向工作空间外，看板不读' };
  }
  let stats;
  try {
    stats = fs.statSync(path.join(root, source));
  } catch {
    return { ...out, state: 'missing', reason: '原件已经不在这个路径上了' };
  }
  if (stats.isDirectory()) {
    return { ...out, state: 'unknown', reason: '来源是一个目录，没有单份 sha256 可比' };
  }
  if (!sourceSha256) {
    return { ...out, state: 'unknown', reason: '产物里没记 source_sha256' };
  }
  const actualSha256 = await sha256File(path.join(root, source));
  return {
    ...out,
    actualSha256,
    size: stats.size,
    state: actualSha256 === sourceSha256 ? 'ok' : 'stale',
  };
}

function scanInput(root) {
  const inputDir = path.join(root, 'input');
  const isIgnored = makeIgnoreMatcher(readIgnorePatterns(root));
  const raw = listFiles(path.join(inputDir, 'raw')).map((abs) => {
    const p = rel(root, abs);
    return {
      path: p,
      name: path.basename(abs),
      ext: path.extname(abs).toLowerCase(),
      reader: readerKind(path.extname(abs).toLowerCase()),
      // 忽略的资料仍留在 raw 列表和总量里 —— 藏起来就等于忘了它还在
      ignored: isIgnored(p),
      ...stat(abs),
    };
  });

  const convertedDir = path.join(inputDir, 'converted');
  const converted = [];
  collectConverted(root, convertedDir, converted);
  attachSourceState(root, converted);

  // 只收图片：assets/ 下还有 ingest.py 写的 _manifest.md，它不该出现在图库里
  const assets = listFiles(path.join(inputDir, 'assets'))
    .filter((abs) => IMAGE_EXT.has(path.extname(abs).toLowerCase()))
    .map((abs) => ({
      path: rel(root, abs),
      name: path.basename(abs),
      ext: path.extname(abs).toLowerCase(),
      reader: 'image',
      ...stat(abs),
    }));
  const assetGroups = groupAssets(root, assets, converted);

  // 哪些原始资料还没转换 —— 这是 PM 最该先看到的缺口
  const convertedSources = new Set(converted.map((c) => c.source).filter(Boolean));
  // 目录型产物（点表：几百个源文件汇总成一份主表）按「目录前缀 + 已消费的扩展名」覆盖。
  // 只按目录一刀切会把目录里真没处理的文件（如 .bak）也藏起来，那就看不见缺口了。
  const coveredDirs = converted
    .filter((c) => c.sourceIsDir && c.source)
    .map((c) => ({ prefix: c.source + '/', kinds: c.sourceKinds }));
  // 图片的「产物」就是 assets/ 里那份拷贝，没有 .md，靠图库清单认账
  const assetSources = readAssetSources(root);
  const isCovered = (r) =>
    convertedSources.has(r.path) ||
    assetSources.has(r.path) ||
    coveredDirs.some((d) => r.path.startsWith(d.prefix) && d.kinds.includes(r.ext));
  // 忽略的不算缺口：它们是「看过、判定用不上」，跟「还没转」不是一回事
  const pending = raw.filter((r) => !r.ignored && !isCovered(r));
  const ignored = raw.filter((r) => r.ignored);

  const indexPath = path.join(inputDir, 'INDEX.md');
  // 模板工作空间才有 scripts/ingest.py；自己 mkdir 的只有目录约定，不能在看板里触发转换
  const canIngest = fs.existsSync(path.join(root, 'scripts', 'ingest.py'));
  return {
    raw,
    converted,
    assets,
    assetGroups,
    pending,
    indexPath: fs.existsSync(indexPath) ? rel(root, indexPath) : '',
    canIngest,
    stats: {
      raw: raw.length,
      converted: converted.length,
      assets: assets.length,
      pending: pending.length,
      ignored: ignored.length,
      warnings: converted.filter((c) => c.warning).length,
      orphaned: converted.filter((c) => c.sourceState === 'missing').length,
      stale: converted.filter((c) => c.sourceState === 'stale').length,
      words: converted.reduce((sum, c) => sum + (c.words || 0), 0),
      bytes: raw.reduce((sum, r) => sum + r.size, 0),
    },
  };
}

/**
 * 返回 { output, docs }：docs 是各产出的正文，只供 attachReferences 用，不进 JSON。
 */
function scanOutput(root) {
  const outputDir = path.join(root, 'output');
  const groups = {};
  const docs = [];
  for (const group of ['analysis', 'docs', 'decisions']) {
    groups[group] = listFiles(path.join(outputDir, group))
      .map((abs) => {
        const { item, body } = describeOutput(root, abs);
        if (body) docs.push({ path: item.path, text: body });
        return item;
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  }
  const all = Object.values(groups).flat();
  const annotated = all.filter((f) => f.annotations);
  return {
    output: {
      ...groups,
      stats: {
        analysis: groups.analysis.length,
        docs: groups.docs.length,
        decisions: groups.decisions.length,
        total: all.length,
        words: all.reduce((sum, f) => sum + (f.words || 0), 0),
        lastUpdated: all.length ? all.reduce((a, b) => (a.mtime > b.mtime ? a : b)).mtime : '',
        annotated: annotated.length,
        annotations: annotated.reduce((sum, f) => sum + f.annotations.total, 0),
      },
    },
    docs,
  };
}

/**
 * 给每份转换产物挂上「哪些产出引用了它」。
 *
 * 一份产出都还没有时，所有资料当然都是零引用 —— 那种情况下 referencedBy 全是空数组，
 * 由前端决定不提示（刚建的工作空间不该满屏缺口）。服务端不在这里做判断，
 * 因为「有没有产出」前端本来就知道，放这儿反而多一处要对齐的口径。
 */
function attachReferences(input, docs) {
  const map = linkReferences(input.converted, docs);
  for (const item of input.converted) {
    item.referencedBy = map.get(item.path) || [];
  }
}

export function scanWorkspace(project, status = { ok: true, reasons: [] }) {
  const root = project.root;
  const input = scanInput(root);
  const { output, docs } = scanOutput(root);
  attachReferences(input, docs);
  return {
    project: { id: project.id, name: project.name, root },
    // 目录被改名/移走时不能扫出一份「什么都没有」的空结果 —— 那和真的空工作空间没法区分
    available: status.ok,
    unavailableReasons: status.reasons,
    scannedAt: new Date().toISOString(),
    meta: readMeta(root),
    input,
    output,
    prototypes: scanPrototypes(root, project.id),
  };
}
