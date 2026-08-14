import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  addProject,
  getProject,
  inspectWorkspace,
  projectStatus,
  readProjects,
  removeProject,
  resolveTemplateRoot,
  suggestRelinkCandidates,
  updateProject,
} from './config.mjs';
import { PYTHON_CANDIDATES, revealInSystem } from './platform.mjs';
import { resolvePrototypeServeDir, scanPrototypes } from './prototypes.mjs';
import { scanWorkspace, verifySource } from './scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../../dist');

/** 大 CSV 行数缓存：key = abs + mtime，避免翻页时反复全量扫 */
const tableRowCountCache = new Map();

/**
 * 每个项目至多一个进行中的 ingest 任务。
 * status: running | done | error；日志只保留尾部，避免 PDF 批量转换时撑爆内存。
 */
const ingestJobs = new Map();
const INGEST_LOG_LIMIT = 32 * 1024;

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

/** 把相对路径解回工作空间内的绝对路径，挡掉 ../ 穿越。 */
function resolveInside(root, relPath) {
  const abs = path.resolve(root, relPath || '');
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    const err = new Error('路径超出工作空间范围');
    err.statusCode = 403;
    throw err;
  }
  return abs;
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

/** 跑模板仓的初始化脚本，把它的 JSON 输出捞回来。解释器名各平台不同，挨个试。 */
async function runInit(templateRoot, name, target) {
  const script = [path.join(templateRoot, 'scripts', 'init_workspace.py'), '--name', name, '--path', target, '--json'];
  for (const [bin, ...prefix] of PYTHON_CANDIDATES) {
    const result = await runInitOnce(bin, [...prefix, ...script], templateRoot);
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
  if (/mineru|MINERU_API_KEY/i.test(text) && /失败|error|无效|invalid|未配置|缺|401|403|未授权/i.test(text)) {
    return {
      message: 'MinerU 转换失败。检查工作空间根目录的 .env 是否配置了 MINERU_API_KEY'
        + '（可参考 .env.example；token 在 https://mineru.net/apiManage 申请）。'
        + (tail ? `\n\n${tail}` : ''),
      log: tail,
    };
  }
  if (/缺少 pandoc/i.test(text)) {
    return {
      message: '转换需要 pandoc，请先安装（macOS：`brew install pandoc`），再试一次。'
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
 * 在工作空间里异步跑 scripts/ingest.py。
 * 看板只 spawn，真正写 input/converted/ 的是工作空间自己的脚本 —— 与 runInit 同构。
 * 接口立刻返回，进度靠 GET /ingest 轮询；写盘会被 watchWorkspace 捕获，页面自己刷新。
 */
async function startIngest(project) {
  const existing = ingestJobs.get(project.id);
  if (existing?.status === 'running') {
    const err = new Error('这个工作空间正在转换资料，等这轮结束后再试。');
    err.statusCode = 409;
    throw err;
  }

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
    message: '正在转换 input/raw/ … 大 PDF 可能要几分钟。',
    log: '',
  };
  ingestJobs.set(project.id, job);

  const child = spawn(bin, [...prefix, script], {
    cwd: project.root,
    env: process.env,
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
  };
}

function ingestStatus(projectId) {
  const job = ingestJobs.get(projectId);
  if (!job) {
    return { status: 'idle', message: '', startedAt: '', finishedAt: '', exitCode: null, log: '' };
  }
  return {
    status: job.status,
    message: job.message || '',
    startedAt: job.startedAt || '',
    finishedAt: job.finishedAt || '',
    exitCode: job.exitCode,
    log: job.log || '',
  };
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

/** 监听工作空间的资料与产出目录，变了就通过 SSE 推给前端。 */
function watchWorkspace(root, onChange) {
  const watchers = [];
  // prototypes/ 整树：HTML 包增删或 zip 替换后要推 SSE 刷新
  for (const dir of ['input', 'output', 'prototypes']) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    try {
      watchers.push(fs.watch(abs, { recursive: true }, onChange));
    } catch {
      // 平台不支持 recursive 就退化成不监听，前端还有手动刷新
    }
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

async function handleApi(req, res, url, { allowMutations = true } = {}) {
  const segments = url.pathname.split('/').filter(Boolean).slice(1).map(decodeSegment); // 去掉 'api'
  const [head, id, action] = segments;

  // platform 给前端定文案用（"在访达中显示" 还是 "在文件资源管理器中显示"）——
  // 定位动作发生在**服务所在的机器**上，所以不能拿浏览器的 navigator 判断。
  if (head === 'health') return json(res, 200, { ok: true, platform: process.platform });

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
      const body = await readBody(req);
      const project = addProject(body.root, body.name);
      return json(res, 200, project);
    }
  }

  if (head === 'projects' && id && !action) {
    if (req.method === 'DELETE') {
      if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
      return json(res, 200, { removed: removeProject(id) });
    }
    if (req.method === 'PATCH') {
      if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
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

  if (head === 'template') {
    const root = resolveTemplateRoot();
    return json(res, 200, { root, ok: Boolean(root) });
  }

  // 新建工作空间：调模板的 init_workspace.py（默认是本仓 template/），建完自动登记
  if (head === 'workspaces' && req.method === 'POST') {
    if (rejectIfRemoteWrite(res, allowMutations)) return undefined;
    const body = await readBody(req);
    const name = (body.name || '').trim();
    const target = (body.path || '').trim();
    if (!name || !target) return json(res, 400, { error: '名称和路径都要填' });
    const templateRoot = resolveTemplateRoot();
    if (!templateRoot) {
      return json(res, 500, {
        error: '找不到工作空间模板。它应该在看板仓库的 template/ 下，或用 PMWORK_TEMPLATE_ROOT 环境变量指过去。',
      });
    }
    const result = await runInit(templateRoot, name, target);
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

  // 伺服 axhub-make 导出的 HTML 包（文件夹或已解压到缓存的 zip）
  // 路径：/api/projects/:id/proto/:slug[/...相对路径]
  if (head === 'projects' && id && action === 'proto') {
    const project = requireProject(id);
    const slug = segments[3] || '';
    if (!slug) return json(res, 400, { error: '缺少原型包标识' });
    const serveDir = resolvePrototypeServeDir(project.root, slug);
    if (!serveDir) return json(res, 404, { error: '找不到这个原型包' });
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
    const ext = path.extname(abs).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': mime,
      'cache-control': 'no-cache',
    });
    return fs.createReadStream(abs).pipe(res);
  }

  // 读文件正文：md / csv / txt 走这里，图片也走这里（按 MIME 直出）
  if (head === 'projects' && id && action === 'file') {
    const project = requireProject(id);
    const abs = resolveInside(project.root, url.searchParams.get('path'));
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return json(res, 404, { error: '文件不存在' });
    const ext = path.extname(abs).toLowerCase();
    const mime = MIME[ext];
    // 图片等二进制直出；html/htm 也直出，供 iframe 预览单文件原型（不要包成 JSON）
    const rawStream = mime && (!mime.startsWith('text') || ext === '.html' || ext === '.htm');
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
    if (ext !== '.csv' && ext !== '.tsv') {
      return json(res, 400, { error: '只支持预览 .csv / .tsv 表格' });
    }
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const page = await readCsvPage(abs, { offset, limit });
    return json(res, 200, { path: relPath, ...page });
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
      const started = await startIngest(project);
      return json(res, 200, started);
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
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
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
