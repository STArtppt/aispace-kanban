/**
 * 扫描 visualization/prototypes/ 里工具产出的可点击 HTML 包，以及云端发布链接。
 *
 * 两种形态（故意做得很简单）：
 *   - bundle：已构建、能直接在浏览器里打开的产物
 *       · 子目录根上有 index.html → 一个可预览原型
 *       · visualization/prototypes/ 根上直接有 index.html → 也算一个
 *       · .zip 包（根上有 index.html）→ 自动解压到 ~/.pmwork/dashboard/proto-cache/
 *         不写回工作空间（看板只读红线）
 *   - url：子目录里没有 index.html，但有 meta.json 且 kind === 'url'
 *       → 云端发布的原型，本地只留 meta.json 和可选的 cover.png，点卡片直开 target
 *   两者都没有的目录直接忽略，不产占位卡片。
 *
 * **只认已构建的产物。** 源码包（figma make 的源码导出、axhub-make 的「导出源码」包）
 * 扫不到 —— 看板不参与原型的生成过程，不为它们装依赖、不跑构建。
 * 请用工具的「导出 HTML」，或者用云端发布链接走 url 形态。
 *
 * 看板自己伺服 bundle 的静态文件，不依赖任何外部开发服务。
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.mjs';

const SKIP_DIR = new Set(['.git', 'node_modules', '.axhub', '.agents', '.claude', 'dist', 'src', 'scripts', 'rules', 'vite-plugins']);
const CACHE_ROOT = path.join(CONFIG_DIR, 'proto-cache');

/** 唯一的扫描根。工作空间根上的旧 prototypes/ 只探测、不扫描（见 detectLegacyDir）。 */
export const PROTOTYPES_DIR = path.join('visualization', 'prototypes');
/** 展示用的 POSIX 写法，sourcePath 一律用它拼（Windows 上也不出现反斜杠） */
const PROTOTYPES_REL = PROTOTYPES_DIR.split(path.sep).join('/');
/** 迁移提示里给用户复制的那条命令对应的旧位置 */
const LEGACY_DIR = 'prototypes';

function readTitle(indexAbs) {
  try {
    const head = fs.readFileSync(indexAbs, 'utf8').slice(0, 8000);
    const m = head.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = m?.[1]?.trim();
    return title || '';
  } catch {
    return '';
  }
}

function hasIndexHtml(dir) {
  try {
    return fs.existsSync(path.join(dir, 'index.html')) && fs.statSync(path.join(dir, 'index.html')).isFile();
  } catch {
    return false;
  }
}

/** 部分 zip 会包一层同名目录，解压后根上没有 index.html —— 往下一层找。 */
function resolvePackageRoot(dir) {
  if (hasIndexHtml(dir)) return dir;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }
  const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  if (subdirs.length === 1) {
    const nested = path.join(dir, subdirs[0].name);
    if (hasIndexHtml(nested)) return nested;
  }
  return '';
}

/**
 * 把 zip 解到缓存目录。缓存键 = zip 绝对路径哈希 + mtime/size，
 * 源包变了就换目录；旧目录先留着，下次可清。
 * 写的是看板自家缓存，不是工作空间。
 */
function ensureZipExtracted(zipAbs) {
  let stats;
  try {
    stats = fs.statSync(zipAbs);
  } catch {
    return { ok: false, error: 'zip 读不到' };
  }
  const key = crypto.createHash('sha1').update(zipAbs).digest('hex').slice(0, 16);
  const stamp = `${Math.trunc(stats.mtimeMs)}-${stats.size}`;
  const dest = path.join(CACHE_ROOT, key, stamp);
  const readyMark = path.join(dest, '.extract-ok');

  if (fs.existsSync(readyMark)) {
    const root = resolvePackageRoot(dest);
    if (root) return { ok: true, dir: root };
  }

  try {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    extractZip(zipAbs, dest);
    fs.writeFileSync(readyMark, `${new Date().toISOString()}\n${zipAbs}\n`, 'utf8');
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }

  const root = resolvePackageRoot(dest);
  if (!root) return { ok: false, error: 'zip 解压后找不到 index.html' };
  return { ok: true, dir: root };
}

function extractZip(zipAbs, destDir) {
  if (process.platform === 'win32') {
    // Expand-Archive 路径里的单引号用 '' 转义（PowerShell 字面量规则）
    const zipLit = String(zipAbs).replace(/'/g, "''");
    const destLit = String(destDir).replace(/'/g, "''");
    const r = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zipLit}' -DestinationPath '${destLit}' -Force`,
      ],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) {
      throw new Error(`解压失败：${(r.stderr || r.stdout || '').trim() || `退出码 ${r.status}`}`);
    }
    return;
  }
  const r = spawnSync('unzip', ['-o', '-q', zipAbs, '-d', destDir], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`解压失败：${(r.stderr || r.stdout || '').trim() || `退出码 ${r.status}`}`);
  }
}

/** meta.json 缺失 / 坏掉 / 不是对象都当作没有。 */
function readMeta(dirAbs) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dirAbs, 'meta.json'), 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
  }
}

/** 云端原型只允许 http/https；file:// 之类一律标成不可点击，看板不打开它。 */
function isOpenableTarget(target) {
  if (typeof target !== 'string' || !target) return false;
  try {
    const u = new URL(target);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 探测工作空间根上是否还有非空的旧 prototypes/。
 * **只判断存在与非空**：不读内容、不列卡片、不伺服、不解压。
 * 结果只用来在原型 tab 的空态里给一行迁移提示。
 * @returns {string} 还没搬家时返回 'prototypes'，否则 ''
 */
export function detectLegacyDir(root) {
  const abs = path.join(root, LEGACY_DIR);
  try {
    if (!fs.statSync(abs).isDirectory()) return '';
    // readdir 只列名字，不进任何一个子目录
    const names = fs.readdirSync(abs).filter((n) => !n.startsWith('.'));
    return names.length ? LEGACY_DIR : '';
  } catch {
    return '';
  }
}

/**
 * 列出 visualization/prototypes/ 下可展示的原型（不产出 url，url 由 projectId 拼）。
 * @returns {{ items: Array, note: string, updatedAt: string }}
 */
export function listPrototypePackages(root) {
  const dir = path.join(root, PROTOTYPES_DIR);
  const result = { items: [], note: '', updatedAt: '' };

  if (!fs.existsSync(dir)) {
    result.note = `工作空间里没有 ${PROTOTYPES_REL}/ 目录`;
    return result;
  }

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    result.note = `读不到 ${PROTOTYPES_REL}/ 目录`;
    return result;
  }

  /** @type {Map<string, { slug: string, title: string, form: 'bundle'|'url', kind: 'folder'|'zip'|'url', serveDir: string, target: string, cover: string, sourcePath: string, mtime: string }>} */
  const bySlug = new Map();
  let newest = 0;

  // 根上直接放 index.html（解压后整包就在 visualization/prototypes/ 里）
  if (hasIndexHtml(dir)) {
    const indexAbs = path.join(dir, 'index.html');
    const st = fs.statSync(indexAbs);
    newest = Math.max(newest, st.mtimeMs);
    bySlug.set('__root__', {
      slug: '__root__',
      title: readTitle(indexAbs) || '原型',
      form: 'bundle',
      kind: 'folder',
      serveDir: dir,
      target: '',
      cover: '',
      sourcePath: PROTOTYPES_REL,
      mtime: st.mtime.toISOString(),
    });
  }

  for (const ent of entries) {
    const name = ent.name;
    if (name.startsWith('.') || SKIP_DIR.has(name)) continue;
    const abs = path.join(dir, name);

    if (ent.isDirectory()) {
      if (hasIndexHtml(abs)) {
        const indexAbs = path.join(abs, 'index.html');
        const st = fs.statSync(indexAbs);
        newest = Math.max(newest, st.mtimeMs);
        // 同名 zip 与文件夹并存时，文件夹优先
        bySlug.set(name, {
          slug: name,
          title: readTitle(indexAbs) || name,
          form: 'bundle',
          kind: 'folder',
          serveDir: abs,
          target: '',
          cover: '',
          sourcePath: `${PROTOTYPES_REL}/${name}`,
          mtime: st.mtime.toISOString(),
        });
        continue;
      }
      // 没有 index.html 但 meta.json 记着 kind: url → 云端发布的原型
      const meta = readMeta(abs);
      if (!meta || meta.kind !== 'url') continue; // 两者都没有：不是一份原型，直接忽略
      let mtime = '';
      try {
        const st = fs.statSync(path.join(abs, 'meta.json'));
        newest = Math.max(newest, st.mtimeMs);
        mtime = st.mtime.toISOString();
      } catch {
        /* 读不到时间不影响这条原型 */
      }
      let cover = '';
      try {
        if (fs.statSync(path.join(abs, 'cover.png')).isFile()) cover = 'cover.png';
      } catch {
        /* 没有封面就走窗框占位 */
      }
      bySlug.set(name, {
        slug: name,
        title: (typeof meta.title === 'string' && meta.title.trim()) || name,
        form: 'url',
        kind: 'url',
        serveDir: '',
        // 非法地址照样带出去，让前端把卡片标成不可点击并说明原因
        target: typeof meta.target === 'string' ? meta.target : '',
        cover,
        sourcePath: `${PROTOTYPES_REL}/${name}`,
        mtime,
      });
      continue;
    }

    if (!ent.isFile() || !name.toLowerCase().endsWith('.zip')) continue;
    const slug = name.replace(/\.zip$/i, '') || name;
    if (bySlug.has(slug)) continue; // 已有同名文件夹

    const extracted = ensureZipExtracted(abs);
    if (!extracted.ok) {
      // 单个 zip 失败不拖垮整份清单，记进 note
      result.note = result.note
        ? `${result.note}；${name}：${extracted.error}`
        : `${name}：${extracted.error}`;
      continue;
    }
    const indexAbs = path.join(extracted.dir, 'index.html');
    const st = fs.statSync(abs);
    newest = Math.max(newest, st.mtimeMs);
    bySlug.set(slug, {
      slug,
      title: readTitle(indexAbs) || slug,
      form: 'bundle',
      kind: 'zip',
      serveDir: extracted.dir,
      target: '',
      cover: '',
      sourcePath: `${PROTOTYPES_REL}/${name}`,
      mtime: st.mtime.toISOString(),
    });
  }

  result.items = [...bySlug.values()].sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  if (newest) result.updatedAt = new Date(newest).toISOString();
  if (!result.items.length && !result.note) {
    result.note =
      `${PROTOTYPES_REL}/ 里还没有可展示的原型。放一份工具产出的**已构建** HTML 包`
      + '（zip 或解压后的文件夹，根目录含 index.html），或者用一份 meta.json 记一条云端发布链接'
      + '（{ "kind": "url", "title": "…", "target": "https://…" }）。'
      + '源码包（figma make 源码导出、axhub-make「导出源码」包）不在支持范围内，请先用工具的「导出 HTML」。';
  }
  return result;
}

/**
 * 给 scan / 独立接口用的完整结构（含可点击 url）。
 * 保留 clientReady / serverRunning / origin 字段形状，兼容旧前端进程。
 */
export function scanPrototypes(root, projectId = '') {
  const listed = listPrototypePackages(root);
  const idSeg = projectId ? encodeURIComponent(projectId) : '';
  const items = listed.items.map((item) => {
    const base = idSeg ? `/api/projects/${idSeg}/proto/${encodeURIComponent(item.slug)}` : '';
    if (item.form === 'url') {
      return {
        itemKey: item.slug,
        title: item.title,
        // url 形态不经看板伺服：前端认 kind === 'url' 就直开 target
        url: '',
        kind: 'url',
        target: isOpenableTarget(item.target) ? item.target : '',
        cover: item.cover && base ? `${base}/${item.cover}` : '',
        sourcePath: item.sourcePath,
        mtime: item.mtime,
      };
    }
    return {
      itemKey: item.slug,
      title: item.title,
      // 相对看板服务根路径；新窗口打开时浏览器会以当前 host 解析
      url: base ? `${base}/index.html` : '',
      kind: item.kind,
      sourcePath: item.sourcePath,
      mtime: item.mtime,
    };
  });

  const legacyDir = detectLegacyDir(root);

  return {
    clientReady: items.length > 0,
    // 静态包由看板自己伺服，不再依赖任何外部开发服务
    serverRunning: items.length > 0,
    origin: '',
    items,
    note: listed.note,
    updatedAt: listed.updatedAt,
    // 只在根上还有非空旧目录时出现，前端据此在空态给一行迁移提示（看板不代劳搬家）
    ...(legacyDir ? { legacyDir } : {}),
  };
}

/**
 * 把 bundle 形态的 slug 解析成可伺服的绝对目录（文件夹在工作空间内，zip 在缓存里）。
 * @returns {string} 包根目录；找不到或是 url 形态返回 ''
 */
export function resolvePrototypeServeDir(root, slug) {
  if (!slug) return '';
  const listed = listPrototypePackages(root);
  const hit = listed.items.find((i) => i.slug === slug);
  // url 形态没有本地产物（serveDir 为空）—— 它不被伺服，只被点开
  return hit?.serveDir || '';
}

/** @deprecated 旧 Axhub 探活，保留导出以免外部引用报错 */
export async function probeOrigin() {
  return false;
}
