/**
 * 全局配置：项目注册表。
 * 位置和 Axhub Make 的 ~/.axhub/make/projects.json 对齐，方便记忆。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_DIR = path.join(os.homedir(), '.pmwork', 'dashboard');
export const PROJECTS_FILE = path.join(CONFIG_DIR, 'projects.json');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EMPTY = { schemaVersion: 1, activeProjectId: '', templateRoot: '', projects: [] };

/**
 * 找工作空间模板的位置 —— 新建工作空间时要调它的 init_workspace.py。
 * 模板随本仓一起维护，就在仓库根的 template/；配置和环境变量仍可覆盖。
 * 顺序：配置里写死的 > 环境变量 > 仓库内 template/。
 */
export function resolveTemplateRoot() {
  const candidates = [
    readProjects().templateRoot,
    process.env.PMWORK_TEMPLATE_ROOT,
    path.resolve(HERE, '../../template'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, 'scripts', 'init_workspace.py'))) {
      return path.resolve(candidate);
    }
  }
  return '';
}

export function readProjects() {
  try {
    const raw = fs.readFileSync(PROJECTS_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.projects)) return { ...EMPTY };
    return { ...EMPTY, ...data };
  } catch {
    return { ...EMPTY };
  }
}

export function writeProjects(data) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PROJECTS_FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return data;
}

/**
 * 判断一个目录是不是 pmwork 工作空间。
 * 判据取 AGENTS.md 里定义的流水线目录，宽松一点：有 input/ 和 output/ 就认。
 */
export function inspectWorkspace(root) {
  const abs = path.resolve(root);
  const reasons = [];
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return { ok: false, root: abs, reasons: ['目录不存在'] };
  }
  for (const dir of ['input', 'output']) {
    if (!fs.existsSync(path.join(abs, dir))) reasons.push(`缺少 ${dir}/ 目录`);
  }
  return { ok: reasons.length === 0, root: abs, reasons };
}

/**
 * 登记条目的健康度。目录被改名 / 移走 / 删掉都会落到 ok:false。
 * 看板据此在侧栏挂提示，而不是安安静静扫出一份空结果。
 */
export function projectStatus(project) {
  const info = inspectWorkspace(project.root);
  return { ok: info.ok, reasons: info.reasons };
}

/**
 * 目录丢了以后猜猜它去哪了：在原父目录里找还没被登记过的、长得像工作空间的兄弟目录。
 * 只是给一键重连当候选，猜错了用户还能自己填路径。
 */
export function suggestRelinkCandidates(root, { limit = 8 } = {}) {
  const parent = path.dirname(path.resolve(root));
  const taken = new Set(readProjects().projects.map((p) => p.root));
  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const abs = path.join(parent, entry.name);
    if (taken.has(abs)) continue;
    if (!inspectWorkspace(abs).ok) continue;
    let mtime = '';
    try {
      mtime = fs.statSync(abs).mtime.toISOString();
    } catch {
      /* 读不到就不排序，不影响候选本身 */
    }
    out.push({ root: abs, name: entry.name, mtime });
  }
  // 改名后的目录通常刚被动过，最近改动的排前面
  out.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
  return out.slice(0, limit);
}

function slugId(root) {
  const base = path.basename(root).replace(/[^\w一-鿿-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return base || 'workspace';
}

export function addProject(root, name) {
  const info = inspectWorkspace(root);
  if (!info.ok) {
    const err = new Error(`不是有效的工作空间：${info.reasons.join('、')}`);
    err.statusCode = 400;
    throw err;
  }
  const data = readProjects();
  const existing = data.projects.find((p) => p.root === info.root);
  if (existing) {
    data.activeProjectId = existing.id;
    writeProjects(data);
    return existing;
  }
  let id = slugId(info.root);
  let n = 2;
  while (data.projects.some((p) => p.id === id)) id = `${slugId(info.root)}-${n++}`;
  const now = new Date().toISOString();
  const project = {
    id,
    name: name?.trim() || path.basename(info.root),
    root: info.root,
    createdAt: now,
    updatedAt: now,
  };
  data.projects.push(project);
  data.activeProjectId = id;
  writeProjects(data);
  return project;
}

/**
 * 改登记信息：换路径（目录被改名/移动后重连）或改显示名。
 * id 不动 —— 它只是个稳定的 key，跟目录名脱钩，换了路径也不用重新选一遍项目。
 */
export function updateProject(id, patch = {}) {
  const data = readProjects();
  const project = data.projects.find((p) => p.id === id);
  if (!project) {
    const err = new Error(`没有登记过的项目：${id}`);
    err.statusCode = 404;
    throw err;
  }
  if (typeof patch.root === 'string' && patch.root.trim()) {
    const info = inspectWorkspace(patch.root.trim());
    if (!info.ok) {
      const err = new Error(`不是有效的工作空间：${info.reasons.join('、')}`);
      err.statusCode = 400;
      throw err;
    }
    const clash = data.projects.find((p) => p.id !== id && p.root === info.root);
    if (clash) {
      const err = new Error(`这个目录已经登记为「${clash.name}」了`);
      err.statusCode = 409;
      throw err;
    }
    project.root = info.root;
  }
  if (typeof patch.name === 'string' && patch.name.trim()) {
    project.name = patch.name.trim();
  }
  project.updatedAt = new Date().toISOString();
  writeProjects(data);
  return project;
}

export function removeProject(id) {
  const data = readProjects();
  const next = data.projects.filter((p) => p.id !== id);
  if (next.length === data.projects.length) return false;
  data.projects = next;
  if (data.activeProjectId === id) data.activeProjectId = next[0]?.id || '';
  writeProjects(data);
  return true;
}

export function getProject(id) {
  const data = readProjects();
  return data.projects.find((p) => p.id === id) || null;
}
