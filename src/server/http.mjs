import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  addProject,
  DEFAULT_TEMPLATE_ID,
  getProject,
  inspectWorkspace,
  listTemplates,
  projectStatus,
  readCreatePrompt,
  readHelpDoc,
  readProjects,
  removeProject,
  resolveTemplate,
  resolveTemplateRoot,
  suggestRelinkCandidates,
  updateProject,
  userTemplatesRoot,
  writeRuntimeInfo,
} from './config.mjs';
import { captureStatus, startCapture } from './capture.mjs';
import { CAPTURE_PACKAGE_PATH, readPackageBody, receiveCapturePackage } from './capture-inbox.mjs';
import { appendNoteHistory, clearNoteHistory, listNoteHistory } from './note-history.mjs';
import { resolveInside } from './paths.mjs';
import { matchesAllTokens, queryTokens } from '../shared/textMatch.mjs';
import { PYTHON_CANDIDATES, pickDirectory, revealInSystem } from './platform.mjs';
import { resolvePrototypeCover, resolvePrototypeServeDir, resolveRefreshTarget, scanPrototypes } from './prototypes.mjs';
import { readQuestion, scanQuestions, writeQuestion } from './questions.mjs';
import { REFERENCES_DIR, resolveReferenceDir, scanReferences } from './references.mjs';
import { scanWorkspace, verifySource } from './scan.mjs';
import { readSheetPage, scanSheet } from './spreadsheet.mjs';
import { resolveAppVersion } from './version.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../../dist');
const ROOT = path.resolve(HERE, '../..');
const APP_VERSION = resolveAppVersion(ROOT);

/** 大 CSV 行数缓存：key = abs + mtime，避免翻页时反复全量扫 */
const tableRowCountCache = new Map();

/**
 * 每个项目至多一个进行中的 ingest 任务。
 * status: running | done | error；日志只保留尾部，避免 PDF 批量转换时撑爆内存。
 */
const ingestJobs = new Map();
const INGEST_LOG_LIMIT = 32 * 1024;

/**
 * 每个项目至多一个进行中的**数据源采集**任务。与 ingestJobs 并列，**不共用同一把锁** ——
 * 正在转一份大 PDF 的时候不该连 schema 都刷不了，两件事互不相干。
 * 形状与 ingestJobs 完全一致，走的也是同一套「立即返回 + 轮询进度」。
 */
const sourceJobs = new Map();

/**
 * 每个项目至多一个进行中的**原型刷新**任务。与 ingestJobs / sourceJobs 并列，**不共用锁** ——
 * 刷新原型不该挡住资料转换。形状照抄 ingest，多一个 item（原型 slug）。
 * 脚本在工作空间之外，看板只 spawn；10 分钟看门狗（脚本自身导出超时 5 分钟，留一倍余量）。
 */
const protoSyncJobs = new Map();
const PROTO_SYNC_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 目录选择框是模态的，同一时刻只允许一个。
 * true = 正在等用户在桌面上选；第二个请求直接 409，不要弹出两个。
 */
let directoryPickBusy = false;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/**
 * 从工作空间伺服出去的参考页与原型包**必须**落进不透明源。
 *
 * 这些 HTML 是别人写的（采下来的线上页面、工具产出的包），而看板的接口没有鉴权：
 * 不隔离的话，它们的脚本和 /api/projects/* 同源，可以直接列出你所有登记的工作空间、读任意文件。
 * `sandbox` 指令让响应落进不透明源 —— 页面照常渲染、脚本照常跑，但同源请求、cookie、
 * 看板自己的 localStorage 全拿不到；不给 allow-top-navigation，frame-busting 脚本也跳不走外层窗口。
 *
 * 不透明源里 `window.localStorage` 的 getter 会直接抛 SecurityError。工具导出的 React 包
 * 经常在 useEffect 里无 try 地 setItem（离线包的「场景预警」页就是这样），于是白屏。
 * 下面这块垫片把 Storage API 补成**这份文档自己的内存表**，影子在 window 上，
 * 够不到看板同源的真实 localStorage，也不让同源 /api 请求复活。
 */
const SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups';

const STORAGE_SHIM = `<script>(function(){
  void "aispace-kanban-storage-shim";
  function mem(){
    var m = Object.create(null);
    var api = {
      getItem: function(k){ k = String(k); return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function(k, v){ m[String(k)] = String(v); },
      removeItem: function(k){ delete m[String(k)]; },
      clear: function(){ for (var k in m) delete m[k]; },
      key: function(i){ return Object.keys(m)[i] || null; }
    };
    Object.defineProperty(api, "length", { get: function(){ return Object.keys(m).length; } });
    return new Proxy(api, {
      get: function(t, p){ return p in t ? t[p] : t.getItem(p); },
      set: function(t, p, v){ if (p in t && p !== "length") { t[p] = v; return true; } t.setItem(p, v); return true; },
      deleteProperty: function(t, p){ t.removeItem(p); return true; }
    });
  }
  try {
    Object.defineProperty(window, "localStorage", { configurable: true, enumerable: true, value: mem() });
    Object.defineProperty(window, "sessionStorage", { configurable: true, enumerable: true, value: mem() });
  } catch (e) {}
})();</script>`;

function injectStorageShim(html) {
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.slice(0, head.index + head[0].length) + STORAGE_SHIM + html.slice(head.index + head[0].length);
  const htmlTag = html.match(/<html[^>]*>/i);
  if (htmlTag) {
    return html.slice(0, htmlTag.index + htmlTag[0].length) + STORAGE_SHIM + html.slice(htmlTag.index + htmlTag[0].length);
  }
  return STORAGE_SHIM + html;
}

/** 直出一个静态文件。isolate = true 时挂 sandbox 头（伺服工作空间里的页面一律要挂）。 */
function sendStaticFile(res, abs, { isolate = false } = {}) {
  const ext = path.extname(abs).toLowerCase();
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-cache',
  };
  if (isolate) headers['content-security-policy'] = SANDBOX_CSP;
  // 隔离 HTML 要先注入垫片再出，不能再 pipe 原文件
  if (isolate && (ext === '.html' || ext === '.htm')) {
    const body = injectStorageShim(fs.readFileSync(abs, 'utf8'));
    headers['content-length'] = Buffer.byteLength(body);
    res.writeHead(200, headers);
    return res.end(body);
  }
  res.writeHead(200, headers);
  return fs.createReadStream(abs).pipe(res);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * 按行分页读 CSV/TSV，不把整文件塞进 JSON。
 * 点表主表常有数十 MB / 十几万行，整文接口会 413；看板只需要摘要 + 一页样例。
 * 不做完整 CSV 引号态机：测点表无跨行字段，按行切片后前端再用 Papa 解析当页。
 */
async function readCsvPage(abs, { offset = 0, limit = 50 } = {}) {
  const stats = fs.statSync(abs);
  const cacheKey = `${abs}\0${stats.mtimeMs}`;
  const cachedTotal = tableRowCountCache.get(cacheKey);

  const stream = fs.createReadStream(abs, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let headerLine = '';
  let totalRows = 0;
  const lines = [];
  let seenHeader = false;

  for await (const raw of rl) {
    const line = seenHeader ? raw : raw.replace(/^\uFEFF/, '');
    if (!line.trim()) continue;
    if (!seenHeader) {
      headerLine = line;
      seenHeader = true;
      continue;
    }
    if (totalRows >= offset && lines.length < limit) lines.push(line);
    totalRows += 1;
    // 行数已知且本页已凑齐 → 提前结束，翻页不再扫完全文件
    if (cachedTotal !== undefined && lines.length >= limit && totalRows >= offset + limit) {
      rl.close();
      break;
    }
  }

  const finalTotal = cachedTotal !== undefined ? cachedTotal : totalRows;
  if (cachedTotal === undefined) tableRowCountCache.set(cacheKey, finalTotal);
  // 缓存膨胀时丢掉最旧的一批（本机看板场景极少触发）
  if (tableRowCountCache.size > 64) {
    const first = tableRowCountCache.keys().next().value;
    tableRowCountCache.delete(first);
  }

  return {
    headerLine,
    lines,
    totalRows: finalTotal,
    offset,
    limit,
    size: stats.size,
    mtime: stats.mtime.toISOString(),
  };
}

/**
 * 整表检索的默认上限与时间预算。
 * 200 条对「找到那一行」已经够用；5s 是本机读几十 MB 的宽裕上界。
 * 两个数都拍得偏保守 —— 超了就如实说「没扫完」，**绝不谎称已经搜遍整张表**，
 * 那种假阴性比没有搜索更坏。
 */
const TABLE_SCAN_LIMIT = 200;
const TABLE_SCAN_MAX_LIMIT = 500;
const TABLE_SCAN_BUDGET_MS = 5000;
/** 每隔这么多行看一次时钟与客户端是否还在。Date.now() 不贵，但没必要每行都问 */
const TABLE_SCAN_CHECK_EVERY = 2000;

/**
 * 整表流式检索：逐行读，判定「这一行是否包含全部关键词」，攒够 limit 或超时就停。
 *
 * 与 readCsvPage 并列，用的是同一套 readline 流 —— 分页接口存在的理由就是
 * 「整表进不了 JSON」，检索同样不把整张表读进内存，更不落任何索引文件（只读红线）。
 * 判定在**整行原始文本**上做，服务端不解析 CSV：片段切分与加粗留给前端，
 * 两边的口径靠共用的 textMatch 内核保证一致。
 *
 * @param {string} abs 表格绝对路径（调用方已过 resolveInside）
 * @param {{ tokens: string[], limit?: number, budgetMs?: number, isAborted?: () => boolean }} opts
 */
async function scanCsv(abs, { tokens, limit = TABLE_SCAN_LIMIT, budgetMs = TABLE_SCAN_BUDGET_MS, isAborted = () => false }) {
  const stats = fs.statSync(abs);
  const cacheKey = `${abs}\0${stats.mtimeMs}`;
  const cachedTotal = tableRowCountCache.get(cacheKey);

  const stream = fs.createReadStream(abs, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const deadline = Date.now() + budgetMs;

  const rows = [];
  let seenHeader = false;
  let scannedRows = 0;
  let truncated = false;
  let partial = false;
  let aborted = false;

  for await (const raw of rl) {
    const line = seenHeader ? raw : raw.replace(/^\uFEFF/, '');
    if (!line.trim()) continue;
    // 表头不算数据行，也不作为命中返回
    if (!seenHeader) {
      seenHeader = true;
      continue;
    }
    if (matchesAllTokens(line, tokens)) rows.push({ row: scannedRows, text: line });
    scannedRows += 1;
    if (rows.length >= limit) {
      truncated = true;
      rl.close();
      break;
    }
    if (scannedRows % TABLE_SCAN_CHECK_EVERY === 0) {
      // 客户端走了（改词、关检索条、换文件）就立刻停，别把整个文件读完再丢弃结果
      if (isAborted()) {
        aborted = true;
        rl.close();
        break;
      }
      if (Date.now() > deadline) {
        partial = true;
        rl.close();
        break;
      }
    }
  }
  // rl.close() 不会销毁底层流，显式收掉文件句柄
  stream.destroy();

  const scannedAll = !truncated && !partial && !aborted;
  // 扫完了就顺手把行数喂给 /table 共用的那份缓存（key 同为 路径 + mtime）
  if (scannedAll && cachedTotal === undefined) {
    tableRowCountCache.set(cacheKey, scannedRows);
    if (tableRowCountCache.size > 64) {
      const first = tableRowCountCache.keys().next().value;
      tableRowCountCache.delete(first);
    }
  }

  return {
    rows,
    scannedRows,
    truncated,
    partial,
    aborted,
    // 没扫完时行数只能靠缓存；缓存也没有就不给 —— 前端据此不显示总数，不瞎猜
    totalRows: scannedAll ? scannedRows : cachedTotal,
    size: stats.size,
    mtime: stats.mtime.toISOString(),
  };
}

/** 用指定解释器跑一次初始化脚本。解释器不在 PATH 上时返回 missing，交给外层换下一个。 */
function runInitOnce(bin, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if (err.code === 'ENOENT') return resolve({ missing: true });
      resolve({ ok: false, error: `启动初始化脚本失败：${err.message}` });
    });
    child.on('close', () => {
      try {
        const parsed = JSON.parse(stdout.trim() || stderr.trim());
        resolve(parsed.ok ? { ok: true, root: parsed.root } : { ok: false, error: parsed.error });
      } catch {
        resolve({ ok: false, error: stderr.trim() || stdout.trim() || '初始化脚本没有返回结果' });
      }
    });
  });
}

/** 跑共享的初始化脚本，把它的 JSON 输出捞回来。解释器名各平台不同，挨个试。 */
async function runInit(templatesRoot, fromDir, name, target) {
  const script = [
    path.join(templatesRoot, 'init_workspace.py'),
    '--from', fromDir,
    '--name', name,
    '--path', target,
    '--json',
  ];
  for (const [bin, ...prefix] of PYTHON_CANDIDATES) {
    const result = await runInitOnce(bin, [...prefix, ...script], templatesRoot);
    if (!result.missing) return result;
  }
  return {
    ok: false,
    error: '找不到 Python 3。新建工作空间要靠模板的 init_workspace.py，'
      + '请先装 Python 3（Windows 装完用 py 或 python，macOS / Linux 用 python3），再试一次。',
  };
}

/** 找一个能用的 Python 3。解释器名各平台不同，挨个试到 `--version` 成功为止。 */
function findPython() {
  return new Promise((resolve) => {
    const candidates = [...PYTHON_CANDIDATES];
    const tryNext = () => {
      const next = candidates.shift();
      if (!next) return resolve(null);
      const [bin, ...prefix] = next;
      const child = spawn(bin, [...prefix, '--version'], { stdio: 'ignore' });
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        if (ok) resolve([bin, ...prefix]);
        else tryNext();
      };
      child.on('error', () => done(false));
      child.on('close', (code) => done(code === 0));
    };
    tryNext();
  });
}

/**
 * 从脚本输出里提炼人话。ingest.py 自己会打中文日志，优先复用最后几行；
 * 常见缺依赖场景再补一句「下一步怎么做」。
 */
function summarizeIngestLog(log, exitCode) {
  const text = (log || '').trim();
  const lines = text ? text.split(/\r?\n/).filter(Boolean) : [];
  const tail = lines.slice(-8).join('\n');
  const lower = text.toLowerCase();

  if (/找不到 python|no such file|not found.*python|python was not found/i.test(text)) {
    return {
      message: '找不到 Python 3。请先装 Python 3（Windows 用 py 或 python，macOS / Linux 用 python3），再试一次。',
      log: tail,
    };
  }
  // 必须排在 mineru 那条前面：那条吃的是整段日志，只要任何地方出现过 mineru 和「缺 / 失败」
  // 就会先命中，把「扫描件需 OCR」「找不到 anydoc」说成「检查 token」。
  if (/扫描件需 OCR/.test(text)) {
    return {
      message: '这份 PDF 是扫描件，本地引擎抽不出文字。在工作空间根目录的 .env 里配 MINERU_API_KEY 后会自动走 OCR'
        + '（token 在 https://mineru.net/apiManage 申请）。'
        + (tail ? `\n\n${tail}` : ''),
      log: tail,
    };
  }
  if (/找不到 anydoc/i.test(text)) {
    return {
      message: '找不到 anydoc。看板依赖里应带 @firecrawl/anydoc；自己跑脚本请设置 ANYDOC_BIN 或把 anydoc 放到 PATH。'
        + '不要用 npx（首次会联网下载）。'
        + (tail ? `\n\n${tail}` : ''),
      log: tail,
    };
  }
  if (/mineru|MINERU_API_KEY/i.test(text) && /失败|error|无效|invalid|未配置|缺|401|403|未授权/i.test(text)) {
    return {
      message: 'MinerU 转换失败。检查工作空间根目录的 .env 是否配置了 MINERU_API_KEY'
        + '（可参考 .env.example；token 在 https://mineru.net/apiManage 申请）。'
        + (tail ? `\n\n${tail}` : ''),
      log: tail,
    };
  }
  if (/缺少 markitdown/i.test(text)) {
    return {
      message: '转换需要 markitdown，请先 `pip install \'markitdown[all]\'`，再试一次。'
        + (tail ? `\n\n${tail}` : ''),
      log: tail,
    };
  }
  if (exitCode === 0) {
    // 没文件 / 台账更新 / 兜底：优先用脚本自己打的中文行
    const empty = lines.find((l) => l.includes('input/raw/ 里没有文件'));
    const updated = lines.find((l) => l.includes('台账已更新'));
    return {
      message: empty || updated || '转换完成。',
      log: tail,
    };
  }
  const failLine = [...lines].reverse().find((l) => /失败|有 \d+ 个文件转换失败/.test(l));
  return {
    message: failLine
      || (tail ? `转换脚本异常退出（退出码 ${exitCode}）。\n\n${tail}` : `转换脚本异常退出（退出码 ${exitCode}）。`),
    log: tail,
  };
}

function appendIngestLog(job, chunk) {
  job.log = (job.log || '') + chunk;
  if (job.log.length > INGEST_LOG_LIMIT) {
    job.log = job.log.slice(job.log.length - INGEST_LOG_LIMIT);
  }
}

/**
 * 转换 / 忽略只认 input/raw/ 下真实存在的路径。
 * 相对路径统一成 /，跟 scan 的 rel()、前端 FileItem.path 对齐。
 */
function resolveRawTarget(root, relPath) {
  const raw = typeof relPath === 'string' ? relPath.trim() : '';
  if (!raw) return null;
  const rel = raw.replace(/\\/g, '/');
  const abs = resolveInside(root, rel);
  const rawRoot = path.resolve(root, 'input', 'raw');
  if (abs !== rawRoot && !abs.startsWith(rawRoot + path.sep)) {
    const err = new Error('只能针对 input/raw/ 下的资料');
    err.statusCode = 400;
    throw err;
  }
  if (!fs.existsSync(abs)) {
    const err = new Error(`路径不存在：${rel}`);
    err.statusCode = 404;
    throw err;
  }
  // 目录是允许的：ingest.py 的 paths 参数本来就吃目录；「忽略此目录」也走这里。
  return { abs, rel, isDir: fs.statSync(abs).isDirectory() };
}

/**
 * 把一条模式追加进 input/.ingestignore。
 * 看板只追加一行，不删、不改原件；ingest.py 和 scan.mjs 读的是同一份。
 * 不经过 ingest.py：这不是转换，旧工作空间的脚本也没有写入入口。
 * 模式相对 input/ 写（raw/某目录），跟手改那份文件的约定一致。
 */
function addIgnore(project, relPath) {
  const raw = typeof relPath === 'string' ? relPath.trim() : '';
  if (!raw) {
    const err = new Error('请指定要忽略的文件或目录');
    err.statusCode = 400;
    throw err;
  }
  const target = resolveRawTarget(project.root, raw);
  const rawRoot = path.resolve(project.root, 'input', 'raw');
  if (target.abs === rawRoot) {
    const err = new Error('不能忽略整个 input/raw/，请指定其中的文件或子目录');
    err.statusCode = 400;
    throw err;
  }
  // input/raw/客户版/a.pdf → raw/客户版/a.pdf
  const pattern = target.rel.replace(/^input\//, '').replace(/\/+$/, '');
  const file = path.join(project.root, 'input', '.ingestignore');
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const existing = prev
    .split('\n')
    .map((l) => l.trim().replace(/\/+$/, ''))
    .filter((l) => l && !l.startsWith('#'));
  // 已有更宽的目录模式，或同一行已经写过，就别重复追加
  if (existing.some((p) => pattern === p || pattern.startsWith(`${p}/`))) {
    return { ok: true, pattern, already: true };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = prev
    ? `${prev.endsWith('\n') ? prev : `${prev}\n`}${pattern}\n`
    : `# 忽略清单 —— 不转换、看板上也不算「待转换」\n# 路径相对 input/ 写，例如 raw/某目录 或 raw/某文件.pdf\n\n${pattern}\n`;
  fs.writeFileSync(file, body, 'utf8');
  return { ok: true, pattern, already: false };
}

/**
 * 解析看板自带的 anydoc CLI。找不到就不注入 —— 用户可能自己 npm i -g 了，ingest.py 会走 PATH。
 * 不用 npx：首次会联网下载，把「本地、不外发」这条改动要解决的问题请回来。
 */
function resolveAnydocBin() {
  try {
    return createRequire(import.meta.url).resolve('@firecrawl/anydoc/cli.js');
  } catch {
    return '';
  }
}

/**
 * 在工作空间里异步跑 scripts/ingest.py。
 * 看板只 spawn，真正写 input/converted/ 的是工作空间自己的脚本 —— 与 runInit 同构。
 * 接口立刻返回，进度靠 GET /ingest 轮询；写盘会被 watchWorkspace 捕获，页面自己刷新。
 * relPath 有值时只转它（ingest.py 的 paths 参数，可以是文件也可以是目录）；缺省转整个 input/raw/。
 */
async function startIngest(project, relPath) {
  const existing = ingestJobs.get(project.id);
  if (existing?.status === 'running') {
    const err = new Error('这个工作空间正在转换资料，等这轮结束后再试。');
    err.statusCode = 409;
    throw err;
  }

  const target = resolveRawTarget(project.root, relPath);

  const script = path.join(project.root, 'scripts', 'ingest.py');
  if (!fs.existsSync(script)) {
    const err = new Error(
      '这个工作空间没有 scripts/ingest.py，看板没法替你转换。'
        + '用模板新建工作空间会自带转换脚本；自己 mkdir 的目录需要自己装脚本，'
        + '或在终端里按自己的方式处理 input/raw/。',
    );
    err.statusCode = 400;
    throw err;
  }

  const py = await findPython();
  if (!py) {
    const err = new Error(
      '找不到 Python 3。转换脚本要靠它跑，请先装 Python 3'
        + '（Windows 用 py 或 python，macOS / Linux 用 python3），再试一次。',
    );
    err.statusCode = 400;
    throw err;
  }

  const [bin, ...prefix] = py;
  const job = {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    exitCode: null,
    path: target ? target.rel : '',
    message: target
      ? `正在转换 ${target.rel}${target.isDir ? '/ 下的资料' : ''} … 大 PDF 可能要几分钟。`
      : '正在转换 input/raw/ … 大 PDF 可能要几分钟。',
    log: '',
  };
  ingestJobs.set(project.id, job);

  const args = target ? [...prefix, script, target.rel] : [...prefix, script];
  const env = { ...process.env };
  const anydocBin = resolveAnydocBin();
  if (anydocBin) env.ANYDOC_BIN = anydocBin;
  const child = spawn(bin, args, {
    cwd: project.root,
    env,
  });

  child.stdout.on('data', (chunk) => appendIngestLog(job, chunk.toString()));
  child.stderr.on('data', (chunk) => appendIngestLog(job, chunk.toString()));
  child.on('error', (err) => {
    // spawn 异步失败（解释器中途消失等）：不能让未处理的 error 把常驻服务带崩
    if (job.status !== 'running') return;
    job.status = 'error';
    job.finishedAt = new Date().toISOString();
    job.exitCode = null;
    job.message = err.code === 'ENOENT'
      ? '找不到 Python 3。请先装 Python 3（Windows 用 py 或 python，macOS / Linux 用 python3），再试一次。'
      : `启动转换脚本失败：${err.message}`;
  });
  child.on('close', (code) => {
    if (job.status !== 'running') return;
    const exitCode = code ?? 1;
    job.exitCode = exitCode;
    job.finishedAt = new Date().toISOString();
    const summary = summarizeIngestLog(job.log, exitCode);
    job.message = summary.message;
    job.log = summary.log;
    job.status = exitCode === 0 ? 'done' : 'error';
  });

  return {
    status: job.status,
    startedAt: job.startedAt,
    message: job.message,
    path: job.path || '',
  };
}

function ingestStatus(projectId) {
  const job = ingestJobs.get(projectId);
  if (!job) {
    return { status: 'idle', message: '', startedAt: '', finishedAt: '', exitCode: null, log: '', path: '' };
  }
  return {
    status: job.status,
    message: job.message || '',
    startedAt: job.startedAt || '',
    finishedAt: job.finishedAt || '',
    exitCode: job.exitCode,
    log: job.log || '',
    path: job.path || '',
  };
}

/**
 * 从 db_ingest.py 的输出里提炼人话。脚本自己打的就是中文，失败时是 `✗ <原因>`，
 * 所以优先原样用它那一行 —— 缺哪个环境变量、该装哪个包、只读会话为什么设不上，
 * 脚本比看板清楚得多，别在这儿重写一遍。
 */
function summarizeSourceLog(log, exitCode) {
  const text = (log || '').trim();
  const lines = text ? text.split(/\r?\n/).filter(Boolean) : [];
  const tail = lines.slice(-8).join('\n');
  if (/找不到 python|no such file|not found.*python|python was not found/i.test(text)) {
    return {
      message: '找不到 Python 3。采集脚本要靠它跑，请先装 Python 3（Windows 用 py 或 python，macOS / Linux 用 python3），再试一次。',
      log: tail,
    };
  }
  const failLine = [...lines].reverse().find((l) => l.trimStart().startsWith('✗'));
  if (exitCode === 0) {
    const okLine = [...lines].reverse().find((l) => l.includes('schema 快照已更新'));
    return { message: okLine || 'schema 采集完成。', log: tail };
  }
  return {
    message: (failLine || '').replace(/^\s*✗\s*/, '')
      || (tail ? `采集脚本异常退出（退出码 ${exitCode}）。\n\n${tail}` : `采集脚本异常退出（退出码 ${exitCode}）。`),
    log: tail,
  };
}

/**
 * 采集的目标只能是 input/sources/ 下真实存在的那份 yaml。
 * 源名来自请求，所以第一件事是 resolveInside —— 挡 `../` 穿越（红线）。
 */
function resolveSourceTarget(root, rawName) {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name) {
    const err = new Error('要采哪个数据源？没给源名。');
    err.statusCode = 400;
    throw err;
  }
  const abs = resolveInside(root, path.join('input', 'sources', `${name}.yaml`));
  const sourcesRoot = path.resolve(root, 'input', 'sources');
  if (!abs.startsWith(sourcesRoot + path.sep)) {
    const err = new Error('只能采 input/sources/ 下配好的数据源');
    err.statusCode = 400;
    throw err;
  }
  if (!fs.existsSync(abs)) {
    const err = new Error(`没有这个数据源：${name}。配置要放在 input/sources/${name}.yaml。`);
    err.statusCode = 404;
    throw err;
  }
  return { abs, name };
}

/**
 * 在工作空间里异步跑 `scripts/db_ingest.py schema <源名>`。
 * 与 startIngest 同构：看板只 spawn，真正写 input/converted/_sources/ 的是工作空间自己的脚本；
 * 接口立刻返回，进度靠轮询；写盘会被 watchWorkspace 捕获，页面自己刷新。
 *
 * **看板自己不连数据库**、不加驱动依赖 —— 连库这件事整个发生在子进程里。
 */
async function startSourceIngest(project, sourceName) {
  const existing = sourceJobs.get(project.id);
  if (existing?.status === 'running') {
    const err = new Error(`这个工作空间正在采「${existing.source}」的 schema，等这轮结束后再试。`);
    err.statusCode = 409;
    throw err;
  }

  const target = resolveSourceTarget(project.root, sourceName);

  const script = path.join(project.root, 'scripts', 'db_ingest.py');
  if (!fs.existsSync(script)) {
    const err = new Error(
      '这个工作空间没有 scripts/db_ingest.py，看板没法替你采集。'
        + '用新版模板新建的工作空间会自带这个脚本；老工作空间可以从模板里拷一份 '
        + 'scripts/db_ingest.py 过来（它还需要同目录的 envfile.py 和 layout.py）。',
    );
    err.statusCode = 400;
    throw err;
  }

  const py = await findPython();
  if (!py) {
    const err = new Error(
      '找不到 Python 3。采集脚本要靠它跑，请先装 Python 3'
        + '（Windows 用 py 或 python，macOS / Linux 用 python3），再试一次。',
    );
    err.statusCode = 400;
    throw err;
  }

  const [bin, ...prefix] = py;
  const job = {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    exitCode: null,
    source: target.name,
    message: `正在采「${target.name}」的 schema … 库大或网络慢时要等一会儿。`,
    log: '',
  };
  sourceJobs.set(project.id, job);

  const child = spawn(bin, [...prefix, script, 'schema', target.name], { cwd: project.root });
  child.stdout.on('data', (chunk) => appendIngestLog(job, chunk.toString()));
  child.stderr.on('data', (chunk) => appendIngestLog(job, chunk.toString()));
  child.on('error', (err) => {
    // spawn 异步失败（解释器中途消失等）：不能让未处理的 error 把常驻服务带崩
    if (job.status !== 'running') return;
    job.status = 'error';
    job.finishedAt = new Date().toISOString();
    job.exitCode = null;
    job.message = err.code === 'ENOENT'
      ? '找不到 Python 3。请先装 Python 3（Windows 用 py 或 python，macOS / Linux 用 python3），再试一次。'
      : `启动采集脚本失败：${err.message}`;
  });
  child.on('close', (code) => {
    if (job.status !== 'running') return;
    const exitCode = code ?? 1;
    job.exitCode = exitCode;
    job.finishedAt = new Date().toISOString();
    const summary = summarizeSourceLog(job.log, exitCode);
    job.message = summary.message;
    job.log = summary.log;
    job.status = exitCode === 0 ? 'done' : 'error';
  });

  return {
    status: job.status,
    startedAt: job.startedAt,
    message: job.message,
    source: job.source,
  };
}

function sourceIngestStatus(projectId) {
  const job = sourceJobs.get(projectId);
  if (!job) {
    return { status: 'idle', message: '', startedAt: '', finishedAt: '', exitCode: null, log: '', source: '' };
  }
  return {
    status: job.status,
    message: job.message || '',
    startedAt: job.startedAt || '',
    finishedAt: job.finishedAt || '',
    exitCode: job.exitCode,
    log: job.log || '',
    source: job.source || '',
  };
}

/**
 * 脚本输出约定 `✓ / ! / · / ✗` 开头的行（前面可以有缩进）。
 * 退出码 0：message 取所有 `!` 行（没有就取 `✓` 行）；非 0：取最后一条 `✗` 行。
 * 原文照搬，看板不改写。
 */
function summarizeProtoSyncLog(log, exitCode) {
  const text = (log || '').trim();
  const lines = text ? text.split(/\r?\n/).filter(Boolean) : [];
  const marked = (sym) => lines.filter((l) => l.trimStart().startsWith(sym)).map((l) => l.trim());
  const tail = lines.slice(-16).join('\n');
  if (exitCode === 0) {
    const warns = marked('!');
    const oks = marked('✓');
    const picked = warns.length ? warns : oks;
    return { message: picked.length ? picked.join('\n') : '刷新完成。', log: tail };
  }
  const fails = marked('✗');
  const lastFail = fails.length ? fails[fails.length - 1] : '';
  return {
    message: lastFail || `刷新脚本异常退出（退出码 ${exitCode}）。`,
    log: tail,
  };
}

/**
 * 起原型工作区的 workspace-sync.mjs --both。看板只 spawn，自己不写任何一个字节。
 * 命令参数由服务端固定为 `<原型目录> --both`，不从任何文件或请求读参数。
 * 用看板自己的 node（process.execPath），不查 PATH。
 */
function startProtoSync(project, itemKey) {
  const existing = protoSyncJobs.get(project.id);
  if (existing?.status === 'running') {
    const err = new Error(`正在刷新「${existing.title || existing.item}」，等这轮结束后再试。`);
    err.statusCode = 409;
    throw err;
  }

  const status = projectStatus(project);
  if (!status.ok) {
    const err = new Error(
      `这个工作空间现在不可用${status.reasons?.length ? `：${status.reasons.join('；')}` : ''}。`,
    );
    err.statusCode = 400;
    throw err;
  }

  const target = resolveRefreshTarget(project.root, itemKey);
  const item = typeof itemKey === 'string' ? itemKey.trim() : '';

  const job = {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    exitCode: null,
    item,
    title: target.title,
    message: `正在刷新「${target.title}」…导出离线包可能要一两分钟。`,
    log: '',
  };
  protoSyncJobs.set(project.id, job);

  const child = spawn(process.execPath, [target.script, target.protoDir, '--both'], {
    cwd: target.protoDir,
  });

  const watchdog = setTimeout(() => {
    if (job.status !== 'running') return;
    try {
      child.kill();
    } catch {
      /* 进程已经没了 */
    }
    job.status = 'error';
    job.finishedAt = new Date().toISOString();
    job.message = '刷新超过 10 分钟仍未结束，已终止。再点一次刷新即可。';
  }, PROTO_SYNC_TIMEOUT_MS);
  if (typeof watchdog.unref === 'function') watchdog.unref();

  child.stdout.on('data', (chunk) => appendIngestLog(job, chunk.toString()));
  child.stderr.on('data', (chunk) => appendIngestLog(job, chunk.toString()));
  child.on('error', (err) => {
    clearTimeout(watchdog);
    // spawn 异步失败：不能让未处理的 error 把常驻服务带崩
    if (job.status !== 'running') return;
    job.status = 'error';
    job.finishedAt = new Date().toISOString();
    job.exitCode = null;
    job.message = err.code === 'ENOENT'
      ? '找不到 Node。看板自己的进程路径失效了，重启看板服务再试。'
      : `启动同步脚本失败：${err.message}`;
  });
  child.on('close', (code) => {
    clearTimeout(watchdog);
    if (job.status !== 'running') return;
    const exitCode = code ?? 1;
    job.exitCode = exitCode;
    job.finishedAt = new Date().toISOString();
    const summary = summarizeProtoSyncLog(job.log, exitCode);
    job.message = summary.message;
    job.log = summary.log;
    job.status = exitCode === 0 ? 'done' : 'error';
  });

  return {
    status: job.status,
    startedAt: job.startedAt,
    message: job.message,
    item: job.item,
  };
}

function protoSyncStatus(projectId) {
  const job = protoSyncJobs.get(projectId);
  if (!job) {
    return { status: 'idle', message: '', startedAt: '', finishedAt: '', exitCode: null, log: '', item: '' };
  }
  return {
    status: job.status,
    message: job.message || '',
    startedAt: job.startedAt || '',
    finishedAt: job.finishedAt || '',
    exitCode: job.exitCode,
    log: job.log || '',
    item: job.item || '',
  };
}

/** 壳页里要拼进 HTML 的都是用户目录名和 meta.json 里的字符串 —— 一律转义。 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SHOT_LABEL = { hero: '首屏', full: '完整页', mobile: '移动端' };

/**
 * 参考查看器：**看板自己的**一张 HTML。
 *
 * iframe 铺满装那份被隔离的 index.html，缩略图和灯箱画在壳上 ——
 * 不能注入进原始页面（那等于给它开口子），也不需要它配合（它在不透明源里，
 * 壳页同样拿不到它的 DOM）。一张截图都没有时整个缩略图区域不渲染。
 */
function renderReferenceViewer({ title, frameUrl, shots }) {
  const cards = shots
    .map(
      (shot, i) => `<button type="button" class="thumb" data-index="${i}" title="${escapeHtml(shot.label)}">`
        + `<img src="${escapeHtml(shot.url)}" alt="${escapeHtml(shot.label)}" loading="lazy">`
        + `<span>${escapeHtml(shot.label)}</span></button>`,
    )
    .join('');
  const shotsJson = JSON.stringify(shots).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · 参考</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0b0b0c; }
  iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
  .bar {
    position: fixed; left: 16px; bottom: 16px; z-index: 10;
    display: flex; align-items: flex-end; gap: 8px;
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .thumb {
    display: flex; flex-direction: column; gap: 4px; align-items: center;
    padding: 6px; border: 1px solid rgba(255,255,255,.18); border-radius: 8px;
    background: rgba(20,20,22,.82); color: rgba(255,255,255,.78);
    backdrop-filter: blur(8px); cursor: pointer;
  }
  .thumb:hover { border-color: rgba(255,255,255,.45); color: #fff; }
  .thumb img { width: 104px; height: 66px; object-fit: cover; object-position: top center; border-radius: 4px; background: #fff; }
  .exit {
    padding: 7px 10px; border: 1px solid rgba(255,255,255,.18); border-radius: 8px;
    background: rgba(20,20,22,.82); color: rgba(255,255,255,.78);
    backdrop-filter: blur(8px); text-decoration: none; white-space: nowrap;
  }
  .exit:hover { border-color: rgba(255,255,255,.45); color: #fff; }
  /* 不透明：底下装的是别人的页面，半透明会把它的正文透上来，图就看不清了 */
  .box { position: fixed; inset: 0; z-index: 20; display: none; background: #0b0b0c; }
  .box[data-open="1"] { display: flex; flex-direction: column; }
  .box header {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 12px 16px; color: rgba(255,255,255,.8);
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
  }
  .box .body { flex: 1; min-height: 0; overflow: auto; padding: 0 16px 16px; text-align: center; }
  .box .body img { max-width: 100%; border-radius: 6px; background: #fff; }
  .box nav { display: flex; gap: 6px; }
  .box button {
    padding: 5px 10px; border: 1px solid rgba(255,255,255,.2); border-radius: 6px;
    background: transparent; color: rgba(255,255,255,.8); cursor: pointer; font: inherit;
  }
  .box button:hover { border-color: rgba(255,255,255,.5); color: #fff; }
</style>
</head>
<body>
<iframe src="${escapeHtml(frameUrl)}" title="${escapeHtml(title)}"></iframe>
<div class="bar">
  ${cards}
  <a class="exit" href="${escapeHtml(frameUrl)}" target="_blank" rel="noreferrer">直接打开原始页面</a>
</div>
<div class="box" id="box" data-open="0">
  <header>
    <span id="box-label"></span>
    <nav>
      <button type="button" id="prev">上一张</button>
      <button type="button" id="next">下一张</button>
      <button type="button" id="close">关闭</button>
    </nav>
  </header>
  <div class="body"><img id="box-img" alt=""></div>
</div>
<script>
  var shots = ${shotsJson};
  var box = document.getElementById('box');
  var img = document.getElementById('box-img');
  var label = document.getElementById('box-label');
  var at = 0;
  function show(i) {
    if (!shots.length) return;
    at = (i + shots.length) % shots.length;
    img.src = shots[at].url;
    img.alt = shots[at].label;
    label.textContent = shots[at].label + '（' + (at + 1) + '/' + shots.length + '）';
    box.dataset.open = '1';
  }
  // 灯箱只是盖在 iframe 上，关掉后里面的页面状态不动（从没卸载过）
  function hide() { box.dataset.open = '0'; }
  Array.prototype.forEach.call(document.querySelectorAll('.thumb'), function (el) {
    el.addEventListener('click', function () { show(Number(el.dataset.index)); });
  });
  document.getElementById('prev').addEventListener('click', function () { show(at - 1); });
  document.getElementById('next').addEventListener('click', function () { show(at + 1); });
  document.getElementById('close').addEventListener('click', hide);
  box.addEventListener('click', function (e) { if (e.target === box) hide(); });
  document.addEventListener('keydown', function (e) {
    if (box.dataset.open !== '1') return;
    if (e.key === 'Escape') hide();
    if (e.key === 'ArrowLeft') show(at - 1);
    if (e.key === 'ArrowRight') show(at + 1);
  });
</script>
</body>
</html>`;
}

function requireProject(id) {
  const project = getProject(id);
  if (!project) {
    const err = new Error(`没有登记过的项目：${id}`);
    err.statusCode = 404;
    throw err;
  }
  return project;
}

/**
 * 监听工作空间的资料、产出与视觉目录，变了就通过 SSE 推给前端。
 *
 * `visualization/` 整树（覆盖 references/ 与 prototypes/ 两个子目录）：
 * 参考或原型包增删、zip 替换后都要推。原型刷新写的镜像和离线 zip 也在这棵树上，
 * 完成后原型 tab 会自己刷新。推送给原型仓的 `.workspace-inbox.md` 在工作空间外，
 * 不接 SSE，只在任务结果行体现。
 * 它**可能启动时还不存在** —— 老工作空间要等用户
 * 手工 `mv` 才有，采集也是第一次采才建。所以再非递归地看一眼工作空间根，
 * 这个目录冒出来时补挂递归 watcher，用户跑完 mv 不用重启服务就能看到卡片。
 */
function watchWorkspace(root, onChange) {
  const watchers = [];
  const watched = new Set();

  function watchTree(dir) {
    const abs = path.join(root, dir);
    if (watched.has(dir) || !fs.existsSync(abs)) return;
    try {
      watchers.push(fs.watch(abs, { recursive: true }, onChange));
      watched.add(dir);
    } catch {
      // 平台不支持 recursive 就退化成不监听，前端还有手动刷新
    }
  }

  for (const dir of ['input', 'output', 'visualization']) watchTree(dir);

  // 根上（非递归）：捕获 input / output / visualization 启动后才被创建的情况
  try {
    watchers.push(
      fs.watch(root, (event, name) => {
        if (name === 'visualization' || name === 'input' || name === 'output') watchTree(String(name));
        onChange(event, name);
      }),
    );
  } catch {
    /* 同上 */
  }

  for (const file of ['project.yaml', 'project.yml']) {
    const abs = path.join(root, file);
    if (fs.existsSync(abs)) {
      try {
        watchers.push(fs.watch(abs, onChange));
      } catch {
        /* 同上 */
      }
    }
  }
  return () => watchers.forEach((w) => w.close());
}

function serveStatic(req, res, urlPath) {
  if (!fs.existsSync(DIST)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('前端还没构建。开发时请跑 pnpm dev（会自动起 Vite），或先 pnpm build。');
    return;
  }
  let abs = path.join(DIST, urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath));
  if (!abs.startsWith(DIST)) abs = path.join(DIST, 'index.html');
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) abs = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
}

/** 路径段可能是百分号编码的 —— 项目 id 取自目录名，中文目录很常见。坏编码就按原样用。 */
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * 会起子进程或写盘的接口：监听非环回地址时一律拒绝。
 * 看板没有鉴权，`--host 0.0.0.0` 是给评审只读分享用的，不能变成局域网里的可执行入口。
 */
function rejectIfRemoteWrite(res, allowMutations) {
  if (allowMutations) return false;
  json(res, 403, {
    error: '当前服务监听的不是本机回环地址，已禁用会改动本机状态的操作'
      + '（新建 / 登记 / 转换资料等）。只读浏览不受影响；'
      + '要在看板里操作，请用默认的 127.0.0.1 再起一次服务。',
  });
  return true;
}

/**
 * **来源判定 —— 所有会写盘 / 起子进程的接口共用这一个函数。**
 *
 * 环回 ≠ 可信:服务端没有 token,`readBody` 连 Content-Type 都不看,
 * 于是浏览器里**任意一个网页**都能用 `enctype="text/plain"` 的表单往 `127.0.0.1:<端口>` POST,
 * body 拼成合法 JSON 就被收下 —— 这种表单提交不触发预检,`allowMutations` 那条闸拦不住它。
 * 所以再加一道:请求表明自己来自别的站点时一律拒绝。
 *
 * 判据两条(浏览器一定会带其中之一,非浏览器客户端如 curl 两条都没有 → 放行):
 *   1. `Sec-Fetch-Site` 存在且不是 same-origin / none → 拒(cross-site、same-site 都拒);
 *   2. 没有该头但有 `Origin`,且 Origin 的 host 与本次请求的 Host 不同 → 拒。
 *
 * ## 扩展来源(实测过,不是猜的)
 * 装真实扩展跑一次投递,打到 `127.0.0.1` 的请求带的是:
 * `Origin: chrome-extension://<id>`、**`Sec-Fetch-Site: none`**、`Sec-Fetch-Mode: cors`,
 * 而且**没有预检**(`host_permissions` 让它不走网页那套 CORS)。
 *
 * `none` 这个值很要命:它会从上面第 1 条直接放行,第 2 条又因为该头存在而被跳过 ——
 * 也就是说**任何一个已装的扩展本来能打通全部写接口**。所以这里把扩展来源单独拎出来先判:
 * 只有采集包接收端(`/capture-package`)放行,其余一律拒。
 *
 * 头里没有能区分「我们这个扩展」和「别的扩展」的东西,放行只认协议。
 * 接受这个代价:扩展要用户自己装,而这条路的写入面只有 `visualization/references/<slug>/`,
 * 包还得先过契约 C 的校验 —— 比把它对所有网页敞开小得多。
 *
 * 只读接口(扫描、读文件、SSE)不过这道闸:它们不改本机状态,
 * 而只读分享(`--host`)场景本来就要能跨机器访问。
 *
 * @param {{ allowExtensionOrigin?: boolean }} [opts] 只有 `/capture-package` 传 true
 * @returns {boolean} true = 已经回了 403，调用方直接 return
 */
function rejectIfForeignOrigin(req, res, { allowExtensionOrigin = false } = {}) {
  const site = req.headers['sec-fetch-site'];
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  // chrome-extension: / moz-extension: / safari-web-extension: 都以 -extension: 收尾
  if (/^[a-z][a-z0-9+.-]*-extension:$/i.test(origin.slice(0, origin.indexOf(':') + 1))) {
    if (allowExtensionOrigin) return false;
    json(res, 403, {
      error: `这个请求来自浏览器扩展（${origin}）。看板只在采集包接收端接受扩展投递，`
        + '其它操作请在看板自己的页面上做。',
    });
    return true;
  }
  if (site && site !== 'same-origin' && site !== 'none') {
    json(res, 403, {
      error: `这个请求来自其它站点（Sec-Fetch-Site: ${site}），看板不接受跨站的写操作。`
        + '请在看板自己的页面上操作。',
    });
    return true;
  }
  if (!site && req.headers.origin) {
    let originHost = '';
    try {
      originHost = new URL(req.headers.origin).host;
    } catch {
      originHost = '';
    }
    if (originHost !== (req.headers.host || '')) {
      json(res, 403, {
        error: `这个请求的来源（${req.headers.origin}）不是看板自己，已拒绝。请在看板自己的页面上操作。`,
      });
      return true;
    }
  }
  return false;
}

/**
 * `POST /capture-package` —— annotation-collect 扩展的投递落点(契约 D)。
 *
 * 不在 `/api/` 下面,也不带 `projectId`:**路径与端口是扩展硬编码的默认目标**,
 * 自造一个前缀等于让每个用户装完扩展第一件事是去改配置。
 * 投进哪个工作空间因此得这边定 —— 取登记表里的活动工作空间,
 * 并把落点写进 `location` 让用户一眼看见投到哪了(投错了重投即可)。
 *
 * 三道闸的顺序是有讲究的:先非环回禁写、再来源判定、最后才读请求体 ——
 * 一个该被拒的请求不应该先把几 MB 的包读进内存。
 */
async function handleCapturePackage(req, res, { allowMutations = true } = {}) {
  if (req.method !== 'POST') {
    return json(res, 405, { error: '采集包接收端只收 POST。' });
  }
  if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
  // 这是**唯一**放行扩展来源的路径；其它写接口照旧拒扩展
  if (rejectIfForeignOrigin(req, res, { allowExtensionOrigin: true })) return undefined;

  const { projects, activeProjectId } = readProjects();
  // 与前端 useWorkspace 同一条兜底链：活动工作空间 → 第一个
  const project = projects.find((p) => p.id === activeProjectId) || projects[0];
  if (!project) {
    return json(res, 409, {
      error: '看板里还没有登记任何工作空间，这个包没有落点。请先在看板上新建或登记一个工作空间再投。',
    });
  }
  const info = inspectWorkspace(project.root);
  if (!info.ok) {
    return json(res, 409, {
      error: `工作空间「${project.name}」的目录现在不可用（${info.reasons.join('、')}），没有接收。`
        + '请在看板上重连这个工作空间再投一次。',
    });
  }

  const body = await readPackageBody(req);
  const result = receiveCapturePackage(project, body);
  return json(res, 200, result);
}

async function handleApi(req, res, url, { allowMutations = true } = {}) {
  const segments = url.pathname.split('/').filter(Boolean).slice(1).map(decodeSegment); // 去掉 'api'
  const [head, id, action] = segments;

  // platform 给前端定文案用（"在访达中显示" 还是 "在文件资源管理器中显示"）——
  // 定位动作发生在**服务所在的机器**上，所以不能拿浏览器的 navigator 判断。
  // version 可选：老服务进程没有，侧栏缺了就不显示，退回改动前的行为。
  if (head === 'health') {
    return json(res, 200, { ok: true, platform: process.platform, version: APP_VERSION });
  }

  // 系统原生目录选择器。GET 只用来探这条路走不走得通（旧进程 404，前端就不显示按钮）；
  // POST 才真正弹窗。它不写任何文件，但会让服务那台机器弹窗，所以闸和写接口同级。
  if (head === 'pick-directory' && !id) {
    if (req.method === 'GET') {
      // 只读分享模式下 POST 一定 403，这里就先说 false —— 让远程访问者看见一个
      // 点了必然报错的按钮，不如不显示；前端据此走「和改动前一字不差」的手工输入。
      return json(res, 200, { available: allowMutations });
    }
    if (req.method === 'POST') {
      if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
      if (rejectIfForeignOrigin(req, res)) return undefined;
      if (directoryPickBusy) {
        return json(res, 409, {
          error: '已经开着一个目录选择框了，请先在桌面上把那个选完或关掉。',
        });
      }
      directoryPickBusy = true;
      try {
        const result = await pickDirectory({ prompt: '选择工作空间目录' });
        return json(res, 200, result);
      } finally {
        directoryPickBusy = false;
      }
    }
  }

  if (head === 'projects' && !id) {
    if (req.method === 'GET') {
      const data = readProjects();
      // 带上每条的健康度，侧栏才能把「目录不在了」直接标出来
      return json(res, 200, {
        ...data,
        projects: data.projects.map((p) => ({ ...p, status: projectStatus(p) })),
      });
    }
    if (req.method === 'POST') {
      if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
      if (rejectIfForeignOrigin(req, res)) return undefined;
      const body = await readBody(req);
      const project = addProject(body.root, body.name);
      return json(res, 200, project);
    }
  }

  if (head === 'projects' && id && !action) {
    if (req.method === 'DELETE') {
      if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
      if (rejectIfForeignOrigin(req, res)) return undefined;
      return json(res, 200, { removed: removeProject(id) });
    }
    if (req.method === 'PATCH') {
      if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
      if (rejectIfForeignOrigin(req, res)) return undefined;
      const body = await readBody(req);
      return json(res, 200, updateProject(id, { root: body.root, name: body.name }));
    }
    if (req.method === 'GET') {
      const project = requireProject(id);
      return json(res, 200, { ...project, status: projectStatus(project) });
    }
  }

  // 目录丢了以后的重连候选：原父目录下还没登记过的工作空间
  if (head === 'projects' && id && action === 'candidates') {
    const project = requireProject(id);
    return json(res, 200, { candidates: suggestRelinkCandidates(project.root) });
  }

  if (head === 'inspect') {
    return json(res, 200, inspectWorkspace(url.searchParams.get('root') || ''));
  }

  if (head === 'help') {
    const text = readHelpDoc();
    return json(res, 200, { ok: Boolean(text), text });
  }

  if (head === 'template') {
    const root = resolveTemplateRoot();
    return json(res, 200, { root, ok: Boolean(root) });
  }

  if (head === 'templates') {
    const root = resolveTemplateRoot();
    const templates = listTemplates().map(({ id, name, description, builtin }) => ({
      id,
      name,
      description,
      builtin,
    }));
    return json(res, 200, {
      templates,
      userRoot: userTemplatesRoot(),
      createPrompt: readCreatePrompt(),
      root,
      ok: Boolean(root) || templates.length > 0,
    });
  }

  // 新建工作空间：调共享 init_workspace.py 铺选中的模板，建完自动登记
  if (head === 'workspaces' && req.method === 'POST') {
    if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
    if (rejectIfForeignOrigin(req, res)) return undefined;
    const body = await readBody(req);
    const name = (body.name || '').trim();
    const target = (body.path || '').trim();
    if (!name || !target) return json(res, 400, { error: '名称和路径都要填' });
    const templatesRoot = resolveTemplateRoot();
    if (!templatesRoot) {
      return json(res, 500, {
        error: '找不到工作空间模板。它应该在看板仓库的 templates/ 下，或用 PMWORK_TEMPLATE_ROOT 环境变量指过去。',
      });
    }
    const templateId = (body.template || DEFAULT_TEMPLATE_ID).trim();
    const tpl = resolveTemplate(templateId);
    if (!tpl) {
      return json(res, 400, { error: `没有这个模板：${templateId}` });
    }
    const result = await runInit(templatesRoot, tpl.root, name, target);
    if (!result.ok) return json(res, 400, { error: result.error });
    const project = addProject(result.root, name);
    return json(res, 200, project);
  }

  if (head === 'projects' && id && action === 'scan') {
    const project = requireProject(id);
    const status = projectStatus(project);
    return json(res, 200, scanWorkspace(project, status));
  }

  if (head === 'projects' && id && action === 'prototypes') {
    const project = requireProject(id);
    return json(res, 200, scanPrototypes(project.root, project.id));
  }

  if (head === 'projects' && id && action === 'references') {
    const project = requireProject(id);
    return json(res, 200, scanReferences(project.root, project.id));
  }

  // 未决问题：扫 output/questions/ 现算索引（只读 front-matter，不读正文），
  // 带第四段编号时取那一条的全字段 + 正文。**不生成也不读取任何索引文件** ——
  // 生成物会漂，而「索引和正文对不上」正是这套结构要消除的病根。
  // 编号只接受 `Q0134` 这种形态，任何路径片段在触达文件系统前就被 readQuestion 拒掉。
  if (head === 'projects' && id && action === 'questions') {
    const project = requireProject(id);
    const questionId = segments[3] || '';
    // 保存人工反馈：**不变量 1 的第四条窄例外**，看板自己写盘的唯一一处。
    // 两道闸的顺序与其它写接口一致：先非环回禁写、再来源判定，最后才读请求体。
    // 写入面压在 questions.mjs 的 writeQuestion 里（只改已存在文件的人写区四个字段），
    // 这里不做任何字段判断 —— 契约只有一处实现，路由层再判一遍只会漂。
    if (questionId && req.method === 'POST') {
      if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
      if (rejectIfForeignOrigin(req, res)) return undefined;
      const body = await readBody(req);
      return json(res, 200, writeQuestion(project.root, questionId, body));
    }
    if (questionId) return json(res, 200, readQuestion(project.root, questionId));
    return json(res, 200, scanQuestions(project.root));
  }

  // 伺服工具产出的可点击 HTML 包（文件夹或已解压到缓存的 zip）
  // 路径：/api/projects/:id/proto/:slug[/...相对路径]
  // url 形态的原型不走这里 —— 它没有本地产物，前端直接开 target。
  if (head === 'projects' && id && action === 'proto') {
    const project = requireProject(id);
    const slug = segments[3] || '';
    if (!slug) return json(res, 400, { error: '缺少原型包标识' });
    const serveDir = resolvePrototypeServeDir(project.root, slug);
    if (!serveDir) {
      // url 形态没有包可伺服，但 scan 下发的封面地址也走这条路由 —— 只放行 cover.png，
      // 否则卡片和已接入原型行的封面永远 404、退回占位
      const coverAbs = segments.slice(4).join('/') === 'cover.png' ? resolvePrototypeCover(project.root, slug) : '';
      if (coverAbs && fs.existsSync(coverAbs)) return sendStaticFile(res, coverAbs);
      return json(res, 404, { error: '找不到这个原型包' });
    }
    const relParts = segments.slice(4);
    const relFile = relParts.length ? relParts.join('/') : 'index.html';
    // 挡 ../ 穿越：只能落在 serveDir 内
    const abs = path.resolve(serveDir, relFile);
    const base = path.resolve(serveDir);
    if (abs !== base && !abs.startsWith(base + path.sep)) {
      return json(res, 403, { error: '路径超出原型包范围' });
    }
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      return json(res, 404, { error: '文件不存在' });
    }
    // 别人做的包，一律关进不透明源
    return sendStaticFile(res, abs, { isolate: true });
  }

  // 伺服参考页：/api/projects/:id/ref/:slug[/...相对路径]
  //   .../view  → 看板自己的查看器壳页（同源，带缩略图与灯箱）
  //   其余      → visualization/references/<slug>/ 下的静态文件，HTML 带 sandbox 头
  if (head === 'projects' && id && action === 'ref') {
    const project = requireProject(id);
    const slug = segments[3] || '';
    if (!slug) return json(res, 400, { error: '缺少参考标识' });
    const refDir = resolveReferenceDir(project.root, slug);
    if (!refDir) return json(res, 404, { error: '找不到这份参考' });
    const relParts = segments.slice(4);

    if (relParts.length === 1 && relParts[0] === 'view') {
      const listed = scanReferences(project.root, project.id);
      const item = listed.items.find((i) => i.itemKey === slug);
      if (!item) return json(res, 404, { error: '找不到这份参考' });
      const shots = ['hero', 'full', 'mobile']
        .filter((k) => item.screenshots[k])
        .map((k) => ({ key: k, label: SHOT_LABEL[k], url: item.screenshots[k] }));
      const body = renderReferenceViewer({
        title: item.title,
        frameUrl: `/api/projects/${encodeURIComponent(project.id)}/ref/${encodeURIComponent(slug)}/index.html`,
        shots,
      });
      // 壳页是看板自己的 HTML，不带 sandbox —— 被它装载的 index.html 才带
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'content-length': Buffer.byteLength(body),
      });
      return res.end(body);
    }

    const relFile = relParts.length ? relParts.join('/') : 'index.html';
    // 两道闸：先保证没跑出工作空间，再保证没跑出这份参考自己的目录
    const abs = resolveInside(project.root, path.join(REFERENCES_DIR, slug, relFile));
    const base = path.resolve(refDir);
    if (abs !== base && !abs.startsWith(base + path.sep)) {
      const err = new Error('路径超出参考目录范围');
      err.statusCode = 403;
      throw err;
    }
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      return json(res, 404, { error: '文件不存在' });
    }
    // 采下来的页面是别人写的，一律关进不透明源（截图是普通静态资源，挂着也无害）
    return sendStaticFile(res, abs, { isolate: true });
  }

  // 读文件正文：md / csv / txt 走这里，图片也走这里（按 MIME 直出）
  if (head === 'projects' && id && action === 'file') {
    const project = requireProject(id);
    const abs = resolveInside(project.root, url.searchParams.get('path'));
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return json(res, 404, { error: '文件不存在' });
    const ext = path.extname(abs).toLowerCase();
    const mime = MIME[ext];
    // 图片等二进制直出；html/htm 也直出，供 iframe 预览单文件原型（不要包成 JSON）。
    // json / map 的 MIME 是 application/json，但不能走这条：阅读器要的是 { content }
    // 包装。否则文件自己的 JSON 被当成接口响应，data.content 是 undefined，预览空白。
    const rawStream =
      mime &&
      ext !== '.json' &&
      ext !== '.map' &&
      (!mime.startsWith('text') || ext === '.html' || ext === '.htm');
    if (rawStream) {
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' });
      return fs.createReadStream(abs).pipe(res);
    }
    const stats = fs.statSync(abs);
    // 大 CSV 请走 /table 分页；其它大文本仍建议系统打开，避免一次 JSON 几十 MB
    if (stats.size > 4 * 1024 * 1024) {
      if (ext === '.csv' || ext === '.tsv') {
        return json(res, 413, {
          error: '表格文件较大，请用分页预览接口打开',
          code: 'USE_TABLE_API',
        });
      }
      return json(res, 413, { error: '文件太大，请用系统程序打开' });
    }
    return json(res, 200, {
      path: url.searchParams.get('path'),
      size: stats.size,
      mtime: stats.mtime.toISOString(),
      content: fs.readFileSync(abs, 'utf8'),
    });
  }

  // 表格分页：点表主表等大 CSV 只返回表头 + 一页行，附总行数
  if (head === 'projects' && id && action === 'table') {
    const project = requireProject(id);
    const relPath = url.searchParams.get('path') || '';
    const abs = resolveInside(project.root, relPath);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return json(res, 404, { error: '文件不存在' });
    const ext = path.extname(abs).toLowerCase();
    if (ext !== '.csv' && ext !== '.tsv' && ext !== '.xlsx' && ext !== '.xlsm') {
      return json(res, 400, { error: '只支持预览 .csv / .tsv / .xlsx / .xlsm 表格' });
    }
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    // csv/tsv 带 sheet 时忽略：路径仍是文件，行为与改动前一致
    if (ext === '.xlsx' || ext === '.xlsm') {
      const sheet = url.searchParams.get('sheet') || undefined;
      const page = readSheetPage(abs, { sheet, offset, limit });
      return json(res, 200, { path: relPath, ...page });
    }
    const page = await readCsvPage(abs, { offset, limit });
    return json(res, 200, { path: relPath, ...page });
  }

  // 整表检索：不分页地扫一遍，挑出「包含全部关键词」的行。流式、只读、不落索引；
  // 命中够了或超时就停，并如实标出是截断还是没扫完（见 openspec table-full-scan-search）
  if (head === 'projects' && id && action === 'table-search') {
    const project = requireProject(id);
    const relPath = url.searchParams.get('path') || '';
    const abs = resolveInside(project.root, relPath);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return json(res, 404, { error: '文件不存在' });
    const ext = path.extname(abs).toLowerCase();
    if (ext !== '.csv' && ext !== '.tsv' && ext !== '.xlsx' && ext !== '.xlsm') {
      return json(res, 400, { error: '只支持预览 .csv / .tsv / .xlsx / .xlsm 表格' });
    }
    const tokens = queryTokens(url.searchParams.get('q') || '');
    const limit = Math.min(
      TABLE_SCAN_MAX_LIMIT,
      Math.max(1, Number(url.searchParams.get('limit')) || TABLE_SCAN_LIMIT),
    );
    const stats = fs.statSync(abs);
    // 纯空白 / 纯标点切不出关键词：直接给空结果，不为它白扫一遍大文件
    if (!tokens.length) {
      return json(res, 200, {
        path: relPath,
        rows: [],
        scannedRows: 0,
        truncated: false,
        partial: false,
        aborted: false,
        totalRows: tableRowCountCache.get(`${abs}\0${stats.mtimeMs}`),
        size: stats.size,
        mtime: stats.mtime.toISOString(),
      });
    }
    let closed = false;
    req.on('close', () => {
      closed = true;
    });
    const sheet = ext === '.xlsx' || ext === '.xlsm' ? url.searchParams.get('sheet') || undefined : undefined;
    const result =
      ext === '.xlsx' || ext === '.xlsm'
        ? scanSheet(abs, { sheet, tokens, limit, isAborted: () => closed, budgetMs: TABLE_SCAN_BUDGET_MS })
        : await scanCsv(abs, { tokens, limit, isAborted: () => closed });
    // 客户端已经走了，socket 上写什么都没人收
    if (closed) return res.end();
    return json(res, 200, { path: relPath, ...result });
  }

  // 按需校验溯源：重算原件的 sha256 跟产物记的比。扫描只看 mtime（快但会误报），
  // 这里是用户点了「校验原件」才跑的坐实手段，一次只算一份。
  if (head === 'projects' && id && action === 'verify-source') {
    const project = requireProject(id);
    const relPath = url.searchParams.get('path') || '';
    resolveInside(project.root, relPath);
    return json(res, 200, await verifySource(project.root, relPath));
  }

  // 交给系统：在访达里定位，或用默认程序打开原始文档
  if (head === 'projects' && id && action === 'reveal' && req.method === 'POST') {
    // 起系统进程只在服务所在机器上有意义；远程分享场景禁掉，避免被当成任意 open 入口
    if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
    if (rejectIfForeignOrigin(req, res)) return undefined;
    const project = requireProject(id);
    const body = await readBody(req);
    const abs = resolveInside(project.root, body.path);
    if (!fs.existsSync(abs)) return json(res, 404, { error: '文件不存在' });
    revealInSystem(abs, body.mode);
    return json(res, 200, { ok: true, path: abs });
  }

  // 触发工作空间自己的 scripts/ingest.py：看板只 spawn，不直接写盘
  if (head === 'projects' && id && action === 'ingest') {
    const project = requireProject(id);
    if (req.method === 'GET') {
      return json(res, 200, ingestStatus(project.id));
    }
    if (req.method === 'POST') {
      if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
      if (rejectIfForeignOrigin(req, res)) return undefined;
      const body = await readBody(req);
      const started = await startIngest(project, body.path);
      return json(res, 200, started);
    }
  }

  // 触发工作空间自己的 scripts/db_ingest.py：看板只 spawn，自己不连数据库、不加驱动依赖
  if (head === 'projects' && id && action === 'db-source') {
    const project = requireProject(id);
    if (req.method === 'GET') {
      return json(res, 200, sourceIngestStatus(project.id));
    }
    if (req.method === 'POST') {
      // 会起子进程，与其它同类接口一样：非环回监听时一律 403
      if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
      if (rejectIfForeignOrigin(req, res)) return undefined;
      const body = await readBody(req);
      const started = await startSourceIngest(project, body.source);
      return json(res, 200, started);
    }
  }

  // 往 input/.ingestignore 追加一行：用户在待转换列表点「忽略」时走这里
  if (head === 'projects' && id && action === 'ignore' && req.method === 'POST') {
    if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
    if (rejectIfForeignOrigin(req, res)) return undefined;
    const project = requireProject(id);
    const body = await readBody(req);
    return json(res, 200, addIgnore(project, body.path));
  }

  // 预览批注历史：写看板配置目录，不碰工作空间。file 只当键，仍过 resolveInside 挡穿越。
  if (head === 'projects' && id && action === 'note-history') {
    const project = requireProject(id);
    if (req.method === 'GET' || req.method === 'DELETE') {
      const file = (url.searchParams.get('file') || '').trim();
      if (!file) return json(res, 400, { error: '缺少文件路径' });
      resolveInside(project.root, file);
      if (req.method === 'GET') return json(res, 200, listNoteHistory(project.id, file));
      if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
      if (rejectIfForeignOrigin(req, res)) return undefined;
      return json(res, 200, clearNoteHistory(project.id, file));
    }
    if (req.method === 'POST') {
      if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
      if (rejectIfForeignOrigin(req, res)) return undefined;
      const body = await readBody(req);
      const file = typeof body.file === 'string' ? body.file.trim() : '';
      if (!file) return json(res, 400, { error: '缺少文件路径' });
      resolveInside(project.root, file);
      return json(res, 200, appendNoteHistory(project.id, file, body.notes));
    }
  }

  // 刷新已接入原型：看板只 spawn 原型工作区的 workspace-sync.mjs，自己不写任何一个字节。
  // 请求只带 itemKey，脚本路径与原型目录只来自通过三道校验的 sync.json。
  if (head === 'projects' && id && action === 'proto-sync') {
    const project = requireProject(id);
    if (req.method === 'GET') {
      return json(res, 200, protoSyncStatus(project.id));
    }
    if (req.method === 'POST') {
      if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
      if (rejectIfForeignOrigin(req, res)) return undefined;
      const body = await readBody(req);
      return json(res, 200, startProtoSync(project, body.item));
    }
  }

  // 贴 URL 采集 / 导入：看板唯一往工作空间写文件的接口。
  // 目标平面由请求体的 plane 决定（reference / prototype），**写路径始终由服务端生成** ——
  // 请求体里夹带的任何路径字段都不参与（见 capture.mjs 的 writeCaptureDir）。
  if (head === 'projects' && id && action === 'capture') {
    const project = requireProject(id);
    if (req.method === 'GET') {
      return json(res, 200, captureStatus(project.id));
    }
    if (req.method === 'POST') {
      // 先环回闸，再来源闸 —— 两条都过了才起子进程
      if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
      if (rejectIfForeignOrigin(req, res)) return undefined;
      const body = await readBody(req);
      return json(res, 200, startCapture(project, body.plane, body.url));
    }
  }

  if (head === 'projects' && id && action === 'events') {
    const project = requireProject(id);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    let timer = null;
    const stop = watchWorkspace(project.root, () => {
      clearTimeout(timer);
      timer = setTimeout(() => res.write(`event: change\ndata: ${Date.now()}\n\n`), 300);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clearTimeout(timer);
      stop();
    });
    return undefined;
  }

  return json(res, 404, { error: `未知接口：${url.pathname}` });
}

/**
 * @param {{ devOrigin?: string, allowMutations?: boolean }} [opts]
 * allowMutations：监听环回地址时为 true（默认）；`--host 0.0.0.0` 时由 CLI 传 false，
 * 禁掉会起子进程 / 写注册表的接口，只读分享不受影响。
 */
export function createServer({ devOrigin = '', allowMutations = true } = {}) {
  // 每次起服务刷新一次：让终端里跑 scripts/ingest.py 的人也能找到本地 anydoc，
  // 不必手配 ANYDOC_BIN。写的是看板自己的配置目录，不碰工作空间。
  // 连 node 自身的路径一起记：anydoc 的 npm 包入口是 cli.js，没有 node 就跑不起来，
  // 而 agent 的非交互 shell 里 nvm / volta 装的 node 常常不在 PATH 上。
  writeRuntimeInfo({
    anydocBin: resolveAnydocBin(),
    node: process.execPath,
    version: APP_VERSION,
  });
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname === CAPTURE_PACKAGE_PATH) {
        return await handleCapturePackage(req, res, { allowMutations });
      }
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(req, res, url, { allowMutations });
      }
    } catch (err) {
      return json(res, err.statusCode || 500, { error: err.message });
    }
    if (devOrigin) {
      res.writeHead(302, { location: devOrigin + url.pathname + url.search });
      return res.end();
    }
    return serveStatic(req, res, url.pathname);
  });
}
