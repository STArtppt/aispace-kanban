import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
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
import { probeOrigin, scanPrototypes } from './prototypes.mjs';
import { scanWorkspace } from './scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../../dist');

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

/** 跑模板仓的初始化脚本，把它的 JSON 输出捞回来。 */
function runInit(templateRoot, name, target) {
  return new Promise((resolve) => {
    const child = spawn(
      'python3',
      [path.join(templateRoot, 'scripts', 'init_workspace.py'), '--name', name, '--path', target, '--json'],
      { cwd: templateRoot },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => resolve({ ok: false, error: `启动初始化脚本失败：${err.message}` }));
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

async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean).slice(1); // 去掉 'api'
  const [head, id, action] = segments;

  if (head === 'health') return json(res, 200, { ok: true });

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
    if (stats.size > 4 * 1024 * 1024) return json(res, 413, { error: '文件太大，请用系统程序打开' });
    return json(res, 200, {
      path: url.searchParams.get('path'),
      size: stats.size,
      mtime: stats.mtime.toISOString(),
      content: fs.readFileSync(abs, 'utf8'),
    });
  }

  // 交给系统：在访达里定位，或用默认程序打开原始文档
  if (head === 'projects' && id && action === 'reveal' && req.method === 'POST') {
    const project = requireProject(id);
    const body = await readBody(req);
    const abs = resolveInside(project.root, body.path);
    if (!fs.existsSync(abs)) return json(res, 404, { error: '文件不存在' });
    const args = body.mode === 'open' ? [abs] : ['-R', abs];
    if (process.platform !== 'darwin') {
      return json(res, 501, { error: '这个功能目前只在 macOS 上可用', path: abs });
    }
    spawn('open', args, { detached: true, stdio: 'ignore' }).unref();
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
