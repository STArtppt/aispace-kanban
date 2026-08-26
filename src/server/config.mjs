/**
 * 全局配置：项目注册表。
 * 位置和 Axhub Make 的 ~/.axhub/make/projects.json 对齐，方便记忆。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const CONFIG_DIR = path.join(os.homedir(), '.pmwork', 'dashboard');
export const PROJECTS_FILE = path.join(CONFIG_DIR, 'projects.json');
export const RUNTIME_FILE = path.join(CONFIG_DIR, 'runtime.json');
export const DEFAULT_TEMPLATE_ID = 'pm-aispace';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EMPTY = { schemaVersion: 1, activeProjectId: '', templateRoot: '', projects: [] };

/**
 * 把「这台机器上的看板运行时信息」落到本机配置目录，供**工作空间脚本**反查。
 *
 * 为什么需要：看板 spawn ingest.py 时会注入 ANYDOC_BIN，所以从界面点「转换」永远
 * 找得到本地 anydoc。但 agent / 用户在终端里直接跑 `python3 scripts/ingest.py` 时
 * 没有这层注入，脚本只能找 PATH——找不到就退回 MinerU（要外发文件），
 * 或者 .doc / .ppt 直接转不了。工作空间又无从知道看板装在哪。
 *
 * 于是看板每次启动往这里写一行，脚本按需来读。写的是**看板自己的配置目录**
 * （projects.json 的邻居），不碰任何工作空间，不违反只读红线。
 * 路径会随升级 / npx 缓存清理过期，所以读的一方必须校验文件还在（见 scripts/anydoc.py）。
 */
export function writeRuntimeInfo(info) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      RUNTIME_FILE,
      `${JSON.stringify({ ...info, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // 写不进去（只读 HOME、权限不足）不该拦住看板启动：脚本那边照常降级，
    // 只是终端里跑转换时得自己配 ANYDOC_BIN
  }
}

/** 用户自建模板落这里，升级 npm 包不会被覆盖。 */
export function userTemplatesRoot() {
  return path.join(os.homedir(), '.pmwork', 'templates');
}

/**
 * 内置模板目录（templates/，里面有 init_workspace.py 和各模板子目录）。
 * 顺序：配置里写死的 > 环境变量 > 仓库内 templates/。
 * 判定文件是共享的 init_workspace.py，不再是某个模板自己的 scripts/。
 */
export function resolveTemplateRoot() {
  const candidates = [
    readProjects().templateRoot,
    process.env.PMWORK_TEMPLATE_ROOT,
    path.resolve(HERE, '../../templates'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, 'init_workspace.py'))) {
      return path.resolve(candidate);
    }
  }
  return '';
}

function readTemplateMeta(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'template.yaml'), 'utf8');
    const data = YAML.parse(raw);
    if (!data || typeof data !== 'object') return null;
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name) return null;
    const id = typeof data.id === 'string' ? data.id.trim() : '';
    const description = typeof data.description === 'string' ? data.description.trim() : '';
    return { id, name, description };
  } catch {
    return null;
  }
}

function scanTemplateDir(root, builtin, byId) {
  if (!root) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const abs = path.join(root, entry.name);
    const meta = readTemplateMeta(abs);
    if (!meta) continue;
    const id = meta.id || entry.name;
    byId.set(id, {
      id,
      name: meta.name,
      description: meta.description,
      root: abs,
      builtin,
    });
  }
}

/**
 * 列出可用模板。先扫内置 templates/，再扫 ~/.pmwork/templates/；同 id 用户覆盖内置。
 * 读失败的目录直接跳过，不让列表接口崩。
 */
export function listTemplates() {
  const byId = new Map();
  scanTemplateDir(resolveTemplateRoot(), true, byId);
  scanTemplateDir(userTemplatesRoot(), false, byId);
  return [...byId.values()].sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh');
  });
}

export function resolveTemplate(id) {
  const key = (id || '').trim();
  if (!key) return null;
  return listTemplates().find((item) => item.id === key) || null;
}

/** 把 create-prompt.md 里的路径占位符换成这台机器上的真实路径。读不到就返回空串。 */
export function readCreatePrompt() {
  const bundled = resolveTemplateRoot();
  if (!bundled) return '';
  let text = '';
  try {
    text = fs.readFileSync(path.join(bundled, 'create-prompt.md'), 'utf8');
  } catch {
    return '';
  }
  const skillCreator = path.join(bundled, 'pm-aispace', '.claude', 'skills', 'skill-creator');
  const initScript = path.join(bundled, 'init_workspace.py');
  return text
    .replaceAll('{{userRoot}}', userTemplatesRoot())
    .replaceAll('{{skillCreator}}', skillCreator)
    .replaceAll('{{initScript}}', initScript);
}

/**
 * 看板帮助文档（templates/help.md）。和 create-prompt.md 同一个落点、同一套占位符——
 * 它们都是「随包发出去、给人看的文字」，不属于任何一个模板。
 */
export function readHelpDoc() {
  const bundled = resolveTemplateRoot();
  if (!bundled) return '';
  try {
    return fs.readFileSync(path.join(bundled, 'help.md'), 'utf8')
      .replaceAll('{{userRoot}}', userTemplatesRoot())
      .replaceAll('{{configDir}}', CONFIG_DIR);
  } catch {
    return '';
  }
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
