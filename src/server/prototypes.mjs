/**
 * 扫描 prototypes/ 里的 Axhub Make「导出 HTML」包。
 *
 * 约定（故意做得很简单）：
 *   - 子目录根上有 index.html → 一个可预览原型
 *   - prototypes/ 根上直接有 index.html → 也算一个
 *   - .zip 包（根上有 index.html）→ 自动解压到 ~/.pmwork/dashboard/proto-cache/
 *     不写回工作空间（看板只读红线）
 *
 * 看板自己伺服这些静态文件，不依赖 Axhub Make 开发服务。
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.mjs';

const SKIP_DIR = new Set(['.git', 'node_modules', '.axhub', '.agents', '.claude', 'dist', 'src', 'scripts', 'rules', 'vite-plugins']);
const CACHE_ROOT = path.join(CONFIG_DIR, 'proto-cache');

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

/**
 * 列出 prototypes/ 下可展示的 HTML 包（不产出 url，url 由 projectId 拼）。
 * @returns {{ items: Array, note: string, updatedAt: string }}
 */
export function listPrototypePackages(root) {
  const dir = path.join(root, 'prototypes');
  const result = { items: [], note: '', updatedAt: '' };

  if (!fs.existsSync(dir)) {
    result.note = '工作空间里没有 prototypes/ 目录';
    return result;
  }

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    result.note = '读不到 prototypes/ 目录';
    return result;
  }

  /** @type {Map<string, { slug: string, title: string, kind: 'folder'|'zip', serveDir: string, sourcePath: string, mtime: string }>} */
  const bySlug = new Map();
  let newest = 0;

  // 根上直接放 index.html（解压后整包就在 prototypes/ 里）
  if (hasIndexHtml(dir)) {
    const indexAbs = path.join(dir, 'index.html');
    const st = fs.statSync(indexAbs);
    newest = Math.max(newest, st.mtimeMs);
    bySlug.set('__root__', {
      slug: '__root__',
      title: readTitle(indexAbs) || '原型',
      kind: 'folder',
      serveDir: dir,
      sourcePath: 'prototypes',
      mtime: st.mtime.toISOString(),
    });
  }

  for (const ent of entries) {
    const name = ent.name;
    if (name.startsWith('.') || SKIP_DIR.has(name)) continue;
    const abs = path.join(dir, name);

    if (ent.isDirectory()) {
      if (!hasIndexHtml(abs)) continue;
      const indexAbs = path.join(abs, 'index.html');
      const st = fs.statSync(indexAbs);
      newest = Math.max(newest, st.mtimeMs);
      // 同名 zip 与文件夹并存时，文件夹优先
      bySlug.set(name, {
        slug: name,
        title: readTitle(indexAbs) || name,
        kind: 'folder',
        serveDir: abs,
        sourcePath: `prototypes/${name}`,
        mtime: st.mtime.toISOString(),
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
      kind: 'zip',
      serveDir: extracted.dir,
      sourcePath: `prototypes/${name}`,
      mtime: st.mtime.toISOString(),
    });
  }

  result.items = [...bySlug.values()].sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  if (newest) result.updatedAt = new Date(newest).toISOString();
  if (!result.items.length && !result.note) {
    result.note =
      'prototypes/ 里还没有可预览的 HTML 包。把 axhub-make 导出的 zip 或解压后的文件夹（根目录含 index.html）放进来即可。';
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
  const items = listed.items.map((item) => ({
    itemKey: item.slug,
    title: item.title,
    // 相对看板服务根路径；新窗口打开时浏览器会以当前 host 解析
    url: idSeg ? `/api/projects/${idSeg}/proto/${encodeURIComponent(item.slug)}/index.html` : '',
    kind: item.kind,
    sourcePath: item.sourcePath,
    mtime: item.mtime,
  }));

  return {
    clientReady: items.length > 0,
    // 静态包由看板自己伺服，不再依赖外部 Axhub 开发服务
    serverRunning: items.length > 0,
    origin: '',
    items,
    note: listed.note,
    updatedAt: listed.updatedAt,
  };
}

/**
 * 把 slug 解析成可伺服的绝对目录（文件夹在工作空间内，zip 在缓存里）。
 * @returns {string} 包根目录；找不到返回 ''
 */
export function resolvePrototypeServeDir(root, slug) {
  if (!slug) return '';
  const listed = listPrototypePackages(root);
  const hit = listed.items.find((i) => i.slug === slug);
  return hit?.serveDir || '';
}

/** @deprecated 旧 Axhub 探活，保留导出以免外部引用报错 */
export async function probeOrigin() {
  return false;
}
