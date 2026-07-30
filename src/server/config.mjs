/**
 * 全局配置：项目注册表。
 * 位置和 Axhub Make 的 ~/.axhub/make/projects.json 对齐，方便记忆。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR = path.join(os.homedir(), '.pmwork', 'dashboard');
export const PROJECTS_FILE = path.join(CONFIG_DIR, 'projects.json');

const EMPTY = { schemaVersion: 1, activeProjectId: '', projects: [] };

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
