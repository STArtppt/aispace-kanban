/**
 * 扫描 visualization/references/ 里收下来的参考页。
 *
 * 约定（和原型同构，故意做得很简单）：
 *   - 一份参考 = 一个子目录，判定条件**只有一条**：目录根上有 index.html
 *     （用户手工另存一份自包含 HTML 摆进来就能被认出来，不必先学会写 meta.json）
 *   - meta.json 可选：缺了 / 坏了都退回 manual + 从 <title> 取标题，条目不消失
 *   - screenshots/{hero,full,mobile}.png 可选，缺了卡片走窗框占位
 *
 * 本模块**只读**：不往工作空间写任何东西。往里放参考的路
 * （贴 URL 采集、浏览器插件投递、收件箱刷新 spawn `web_ingest.py --inbox`）在别的模块里。
 */
import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIR = new Set(['.git', 'node_modules', '.agents', '.claude', 'dist']);
/** 截图固定这三张，扁平放在 screenshots/ 下，不做子层 */
const SHOT_KINDS = ['hero', 'full', 'mobile'];
const SOURCES = new Set(['manual', 'url-capture', 'plugin']);

export const REFERENCES_DIR = path.join('visualization', 'references');

function readTitle(indexAbs) {
  try {
    const head = fs.readFileSync(indexAbs, 'utf8').slice(0, 8000);
    const m = head.match(/<title[^>]*>([^<]*)<\/title>/i);
    return m?.[1]?.trim() || '';
  } catch {
    return '';
  }
}

function hasIndexHtml(dir) {
  try {
    return fs.statSync(path.join(dir, 'index.html')).isFile();
  } catch {
    return false;
  }
}

/** meta.json 缺失 / 坏掉 / 不是对象都退回同一套缺省值 —— 条目不许因此消失。 */
function readMeta(dirAbs) {
  try {
    const raw = fs.readFileSync(path.join(dirAbs, 'meta.json'), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return data;
  } catch {
    return {};
  }
}

/** 只认实际存在的那几张，返回 { hero: 'screenshots/hero.png', ... } */
function listScreenshots(dirAbs) {
  const found = {};
  for (const kind of SHOT_KINDS) {
    const rel = `screenshots/${kind}.png`;
    try {
      if (fs.statSync(path.join(dirAbs, 'screenshots', `${kind}.png`)).isFile()) found[kind] = rel;
    } catch {
      /* 没有这张就没有 */
    }
  }
  return found;
}

function hasWebIngestScript(root) {
  try {
    return fs.existsSync(path.join(root, 'scripts', 'web_ingest.py'));
  } catch {
    return false;
  }
}

/**
 * 列出 visualization/references/ 下可展示的参考（不产出 url，url 由 projectId 拼）。
 * 目录不存在或读不到时降级成空清单 + note，不抛。
 * pending / canInbox 读失败同样降级，不让扫描接口 500。
 * @returns {{ items: Array, note: string, updatedAt: string, pending: number, canInbox: boolean }}
 */
export function listReferences(root) {
  const dir = path.join(root, REFERENCES_DIR);
  const result = { items: [], note: '', updatedAt: '', pending: 0, canInbox: hasWebIngestScript(root) };

  if (!fs.existsSync(dir)) {
    result.note = '工作空间里还没有 visualization/references/ 目录';
    return result;
  }

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    result.note = '读不到 visualization/references/ 目录';
    result.pending = 0;
    result.canInbox = false;
    return result;
  }

  const items = [];
  let newest = 0;
  let pending = 0;

  for (const ent of entries) {
    const name = ent.name;
    // 散装的 某页.html 直接躺在这里 → 不是一份参考，不进 items，计入 pending 等收件箱收走
    if (!ent.isDirectory()) {
      const ext = path.extname(name).toLowerCase();
      if (!name.startsWith('.') && (ext === '.html' || ext === '.htm')) pending += 1;
      continue;
    }
    if (name.startsWith('.') || SKIP_DIR.has(name)) continue;
    const abs = path.join(dir, name);
    if (!hasIndexHtml(abs)) continue;

    const indexAbs = path.join(abs, 'index.html');
    let mtime = '';
    try {
      const st = fs.statSync(indexAbs);
      newest = Math.max(newest, st.mtimeMs);
      mtime = st.mtime.toISOString();
    } catch {
      /* 读不到时间不影响这条参考 */
    }

    const meta = readMeta(abs);
    const shots = listScreenshots(abs);
    const source = typeof meta.source === 'string' && SOURCES.has(meta.source) ? meta.source : 'manual';

    items.push({
      slug: name,
      title: (typeof meta.title === 'string' && meta.title.trim()) || readTitle(indexAbs) || name,
      sourceUrl: typeof meta.sourceUrl === 'string' ? meta.sourceUrl : '',
      source,
      // 只是告知这页有没有经过脱敏，不是安全保证
      scrubbed: meta.scrubbed === true,
      capturedAt: typeof meta.capturedAt === 'string' ? meta.capturedAt : '',
      sourcePath: `${REFERENCES_DIR.split(path.sep).join('/')}/${name}`,
      mtime,
      screenshots: shots,
    });
  }

  result.items = items.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  result.pending = pending;
  if (newest) result.updatedAt = new Date(newest).toISOString();
  if (!result.items.length && !result.note) {
    result.note =
      'visualization/references/ 里还没有参考页。一份参考是一个目录，入口叫 index.html —— '
      + '把自包含的 HTML 放成 visualization/references/<名字>/index.html 即可。'
      + '也可以把散装 .html 丢在根上，点刷新入库。';
  }
  return result;
}

/**
 * 给 scan / 独立接口用的完整结构（含可点击 url，指向查看器壳页）。
 * @returns {{ items: Array, note: string, updatedAt: string, pending: number, canInbox: boolean }}
 */
export function scanReferences(root, projectId = '') {
  const listed = listReferences(root);
  const idSeg = projectId ? encodeURIComponent(projectId) : '';
  const items = listed.items.map((item) => {
    const base = idSeg ? `/api/projects/${idSeg}/ref/${encodeURIComponent(item.slug)}` : '';
    const screenshots = {};
    for (const [kind, rel] of Object.entries(item.screenshots)) {
      if (base) screenshots[kind] = `${base}/${rel}`;
    }
    return {
      itemKey: item.slug,
      title: item.title,
      // 点卡片打开的是**看板自己的查看器壳页**，不是被隔离的那份 HTML
      url: base ? `${base}/view` : '',
      sourceUrl: item.sourceUrl,
      source: item.source,
      scrubbed: item.scrubbed,
      capturedAt: item.capturedAt,
      sourcePath: item.sourcePath,
      mtime: item.mtime,
      // 卡片封面用 hero，没有就落回窗框占位
      cover: screenshots.hero || '',
      screenshots,
    };
  });

  return {
    items,
    note: listed.note,
    updatedAt: listed.updatedAt,
    pending: listed.pending,
    canInbox: listed.canInbox,
  };
}

/**
 * 把 slug 解析成可伺服的绝对目录（永远在工作空间内的 visualization/references/ 下）。
 * @returns {string} 参考目录；找不到返回 ''
 */
export function resolveReferenceDir(root, slug) {
  if (!slug) return '';
  const listed = listReferences(root);
  const hit = listed.items.find((i) => i.slug === slug);
  return hit ? path.join(root, REFERENCES_DIR, hit.slug) : '';
}
