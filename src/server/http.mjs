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
import { probeOrigin, scanPrototypes } from './prototypes.mjs';
import { scanWorkspace } from './scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../../dist');

/** 大 CSV 行数缓存：key = abs + mtime，避免翻页时反复全量扫 */
const tableRowCountCache = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.woff2': 'font/woff2',
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
  for (const dir of ['input', 'output', 'prototypes/.axhub']) {
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

async function handleApi(req, res, url) {
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
      const body = await readBody(req);
      const project = addProject(body.root, body.name);
      return json(res, 200, project);
    }
  }

  if (head === 'projects' && id && !action) {
    if (req.method === 'DELETE') return json(res, 200, { removed: removeProject(id) });
    if (req.method === 'PATCH') {
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
    const data = scanPrototypes(project.root);
    data.serverRunning = await probeOrigin(data.origin);
    if (data.origin && !data.serverRunning) data.note = 'Axhub Make 服务没在运行，链接暂时打不开';
    return json(res, 200, data);
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

  // 交给系统：在访达里定位，或用默认程序打开原始文档
  if (head === 'projects' && id && action === 'reveal' && req.method === 'POST') {
    const project = requireProject(id);
    const body = await readBody(req);
    const abs = resolveInside(project.root, body.path);
    if (!fs.existsSync(abs)) return json(res, 404, { error: '文件不存在' });
    revealInSystem(abs, body.mode);
    return json(res, 200, { ok: true, path: abs });
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

export function createServer({ devOrigin = '' } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
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
