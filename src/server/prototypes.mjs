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
 * **原型工作区同步过来的镜像目录会被聚合**（见 scanPrototypes 的 linked / groupedInto）：
 * 目录里有 SYNC.md 就认作「已接入」，同级 `<目录名>-html.zip` 与指向同一在线链接的
 * 手工卡片并进它。同步脚本是原型工作区的 standards/workspace-sync.mjs，布局约定以那边为准。
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

/** 同步镜像里脚本拥有的资料目录，按界面分组顺序排列 */
const LINKED_DOC_GROUPS = [
  ['spec', 'spec'],
  ['docs', 'docs'],
  ['annotations', 'annotations'],
  ['comments', 'comments'],
];
/** 单个原型的资料上限：超出只截断列表，不影响聚合 */
const LINKED_DOC_LIMIT = 500;

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

function isFile(abs) {
  try {
    return fs.statSync(abs).isFile();
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
 * 判断两条在线链接是不是同一份原型：只比 origin + pathname，丢掉 hash 与查询串。
 * **口径与同步脚本的 normalizeUrl 一致**（它据此提示「看板会有重复卡片」），两边不同就会
 * 出现脚本说重复、看板却没合并的情况。
 */
function normalizeUrl(u) {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`;
  } catch {
    return '';
  }
}

/** 合法的时间串原样返回，否则返回 ''。SYNC.md 里缺值写的是「—」 */
function validTime(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  return Number.isNaN(Date.parse(value)) ? '' : value.trim();
}

/**
 * 解析同步脚本写的 SYNC.md 表格。那是给人读的文件，这里只按**行标签**取值，
 * 对应 workspace-sync.mjs（验证于 @axhub/make 0.6.21 时期的脚本）的这几行：
 *   | 源仓库提交 | … |   | 本地最近改动 | ISO |   | 同步时间 | ISO |   | 离线 HTML 包 | … |
 * 行标签改了就取不到值，状态格退化成「—」，聚合与资料列表照常。
 * @returns {{ commit?: string, localChangedAt?: string, syncedAt?: string, offlineStale?: boolean }}
 */
function readSyncMd(dirAbs) {
  let text;
  try {
    text = fs.readFileSync(path.join(dirAbs, 'SYNC.md'), 'utf8');
  } catch {
    return {};
  }
  /** @type {Record<string, string>} */
  const rows = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|\s*$/);
    if (m) rows[m[1]] = m[2];
  }
  const out = {};
  const commit = (rows['源仓库提交'] || '').replace(/`/g, '').trim();
  if (commit && commit !== '—') out.commit = commit;
  const localChangedAt = validTime(rows['本地最近改动']);
  if (localChangedAt) out.localChangedAt = localChangedAt;
  const syncedAt = validTime(rows['同步时间']);
  if (syncedAt) out.syncedAt = syncedAt;
  // 导出失败时脚本写「为旧包，本次未更新：原因」或「无，本次未更新：原因」
  if ((rows['离线 HTML 包'] || '').includes('本次未更新')) out.offlineStale = true;
  return out;
}

/** 递归列 .md，返回相对 base 的 POSIX 路径。只 readdir，不读正文 */
function walkMd(base, rel = '', acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(base, rel), { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const ent of entries) {
    if (acc.length >= LINKED_DOC_LIMIT) break;
    if (ent.name.startsWith('.')) continue;
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walkMd(base, childRel, acc);
    else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) acc.push(childRel);
  }
  return acc;
}

/**
 * 列出镜像目录里可阅读的资料 md（JSON 原件不列，脚本已渲染出对应的汇总 md）。
 * 显示名只做字符串处理，不读正文取标题：一次扫描多读十几份文件没有必要。
 * @returns {Array<{ path: string, group: 'spec'|'docs'|'annotations'|'comments'|'sync', label: string }>}
 */
function listLinkedDocs(dirAbs, slug) {
  const base = `${PROTOTYPES_REL}/${slug}`;
  const docs = [];
  for (const [dirName, group] of LINKED_DOC_GROUPS) {
    const files = walkMd(path.join(dirAbs, dirName)).sort((a, b) => {
      // 主规格排在最前，其余按路径
      if (a === 'spec.md') return -1;
      if (b === 'spec.md') return 1;
      return a.localeCompare(b, 'zh');
    });
    // 同一页面目录下有几份 md：只有一份时显示页面名，多份时再带文件名
    /** @type {Map<string, number>} */
    const perPage = new Map();
    if (group === 'spec') {
      for (const f of files) {
        const m = f.match(/^pages\/(.+)\/[^/]+$/);
        if (m) perPage.set(m[1], (perPage.get(m[1]) || 0) + 1);
      }
    }
    for (const f of files) {
      const stem = f.split('/').pop().replace(/\.md$/i, '');
      let label = stem;
      if (group === 'spec' && f === 'spec.md') label = '主规格';
      else if (group === 'spec') {
        const m = f.match(/^pages\/(.+)\/[^/]+$/);
        if (m) label = perPage.get(m[1]) > 1 ? `${m[1]} · ${stem}` : m[1];
      }
      docs.push({ path: `${base}/${dirName}/${f}`, group, label });
    }
  }
  if (isFile(path.join(dirAbs, 'SYNC.md'))) {
    docs.push({ path: `${base}/SYNC.md`, group: 'sync', label: '同步清单' });
  }
  return docs;
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

  /** @type {Map<string, { slug: string, title: string, form: 'bundle'|'url', kind: 'folder'|'zip'|'url', serveDir: string, target: string, cover: string, sourcePath: string, mtime: string, size?: number, synced?: boolean, dirAbs?: string, publishedAt?: string, publishTarget?: string }>} */
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
      // 没有 index.html 但 meta.json 记着 kind: url → 云端发布的原型。
      // 有 SYNC.md 的同步镜像即使还没发布过（脚本不写 meta.json）也要入表，否则资料看不到
      const meta = readMeta(abs);
      const isUrlMeta = Boolean(meta && meta.kind === 'url');
      const synced = isFile(path.join(abs, 'SYNC.md'));
      if (!isUrlMeta && !synced) continue; // 两者都没有：不是一份原型，直接忽略
      let mtime = '';
      try {
        const st = fs.statSync(path.join(abs, synced ? 'SYNC.md' : 'meta.json'));
        newest = Math.max(newest, st.mtimeMs);
        mtime = st.mtime.toISOString();
      } catch {
        /* 读不到时间不影响这条原型 */
      }
      const cover = isFile(path.join(abs, 'cover.png')) ? 'cover.png' : ''; // 没有封面就走窗框占位
      bySlug.set(name, {
        slug: name,
        title: (isUrlMeta && typeof meta.title === 'string' && meta.title.trim()) || name,
        form: 'url',
        kind: 'url',
        serveDir: '',
        // 非法地址照样带出去，让前端把卡片标成不可点击并说明原因
        target: isUrlMeta && typeof meta.target === 'string' ? meta.target : '',
        cover,
        sourcePath: `${PROTOTYPES_REL}/${name}`,
        mtime,
        synced,
        dirAbs: abs,
        publishedAt: isUrlMeta ? validTime(meta.publishedAt) : '',
        publishTarget: isUrlMeta && typeof meta.publishTarget === 'string' ? meta.publishTarget : '',
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
      size: st.size,
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
  const baseOf = (slug) => (idSeg ? `/api/projects/${idSeg}/proto/${encodeURIComponent(slug)}` : '');
  const items = listed.items.map((item) => {
    const base = baseOf(item.slug);
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

  aggregateLinked(listed.items, items, baseOf);

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
 * 把同步镜像聚合成一份原型：挂 linked，给被并入的 zip / 重复卡片挂 groupedInto。
 * **被并入的条目不从 items 删除** —— 旧前端不认 groupedInto，删了离线包卡片就凭空消失。
 * 两份都带 SYNC.md 的镜像各自成组，不互相合并。
 */
function aggregateLinked(listedItems, items, baseOf) {
  const outByKey = new Map(items.map((i) => [i.itemKey, i]));
  const listedByKey = new Map(listedItems.map((i) => [i.slug, i]));

  for (const mirror of listedItems) {
    if (!mirror.synced) continue;
    const out = outByKey.get(mirror.slug);
    if (!out) continue;

    const linked = {};
    const sync = readSyncMd(mirror.dirAbs);

    const zip = listedByKey.get(`${mirror.slug}-html`);
    if (zip && zip.kind === 'zip') {
      linked.offline = {
        url: `${baseOf(zip.slug)}/index.html`,
        sourcePath: zip.sourcePath,
        mtime: zip.mtime,
        ...(typeof zip.size === 'number' ? { size: zip.size } : {}),
      };
      outByKey.get(zip.slug).groupedInto = mirror.slug;
    }

    if (mirror.target) {
      linked.online = {
        target: isOpenableTarget(mirror.target) ? mirror.target : '',
        ...(mirror.publishedAt ? { publishedAt: mirror.publishedAt } : {}),
        ...(mirror.publishTarget ? { publishTarget: mirror.publishTarget } : {}),
      };
      // 两个时间都合法才下结论，缺一个就不标 —— 宁可不提示，也不误报
      if (sync.localChangedAt && mirror.publishedAt
        && Date.parse(sync.localChangedAt) > Date.parse(mirror.publishedAt)) {
        sync.onlineStale = true;
      }

      const key = normalizeUrl(mirror.target);
      const duplicates = [];
      for (const other of listedItems) {
        if (other === mirror || other.synced || other.form !== 'url') continue;
        if (!key || normalizeUrl(other.target) !== key) continue;
        const otherOut = outByKey.get(other.slug);
        if (!otherOut || otherOut.groupedInto) continue;
        otherOut.groupedInto = mirror.slug;
        duplicates.push(other.sourcePath);
        // 手工录入时截过封面、镜像自己却没有：借用它，免得合并后反而丢了封面
        if (!out.cover && otherOut.cover) out.cover = otherOut.cover;
      }
      if (duplicates.length) linked.duplicates = duplicates;
    }

    if (Object.keys(sync).length) linked.sync = sync;
    linked.docs = listLinkedDocs(mirror.dirAbs, mirror.slug);
    out.linked = linked;
  }
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

/**
 * url 形态唯一可伺服的本地文件是封面 cover.png。
 * slug 必须命中扫描清单里的目录名，拼出来的路径不可能跑出 visualization/prototypes/。
 * @returns {string} 封面绝对路径；不是 url 形态或没有封面返回 ''
 */
export function resolvePrototypeCover(root, slug) {
  if (!slug) return '';
  const hit = listPrototypePackages(root).items.find((i) => i.slug === slug);
  if (!hit || hit.form !== 'url' || !hit.cover || !hit.dirAbs) return '';
  return path.join(hit.dirAbs, hit.cover);
}

/** @deprecated 旧 Axhub 探活，保留导出以免外部引用报错 */
export async function probeOrigin() {
  return false;
}
