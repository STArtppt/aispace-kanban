/**
 * 从 prototypes/.axhub/ 里读 Axhub Make 客户端的原型清单。
 * 约定来自 Axhub Make 本体：
 *   .axhub/make/make.json            客户端标记
 *   .axhub/make/sidebar-tree.json    人工整理过的原型树（标题在这）
 *   .axhub/make/entries.json         构建产物清单（兜底，无标题）
 *   .axhub/make/.dev-server-info.json 运行中的开发服务 host/port
 * 链接形态 <origin>/prototypes/<name>，和 Axhub Make 服务端一致。
 */
import fs from 'node:fs';
import path from 'node:path';

function readJson(abs) {
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

function flattenTree(nodes, out = []) {
  for (const node of nodes || []) {
    if (node.kind === 'folder') {
      flattenTree(node.children, out);
    } else if (node.itemKey) {
      out.push({ itemKey: node.itemKey, title: node.title || node.itemKey });
    }
  }
  return out;
}

export function scanPrototypes(root) {
  const dir = path.join(root, 'prototypes');
  const makeDir = path.join(dir, '.axhub', 'make');
  const result = {
    clientReady: fs.existsSync(path.join(makeDir, 'make.json')),
    serverRunning: false,
    origin: '',
    items: [],
    note: '',
  };

  if (!fs.existsSync(dir)) {
    result.note = '工作空间里没有 prototypes/ 目录';
    return result;
  }
  if (!result.clientReady) {
    result.note = '还没在 Axhub Make 里把项目指向这个目录，原型客户端尚未构建';
    return result;
  }

  const info = readJson(path.join(makeDir, '.dev-server-info.json'));
  if (info?.port) {
    result.origin = `http://${info.host || 'localhost'}:${info.port}`;
    result.serverStartedAt = info.timestamp || '';
  }

  const tree = readJson(path.join(makeDir, 'sidebar-tree.json'));
  let items = tree ? flattenTree(tree.prototypes) : [];
  if (!items.length) {
    const entries = readJson(path.join(makeDir, 'entries.json'));
    items = Object.keys(entries?.items || {})
      .filter((key) => key.startsWith('prototypes/'))
      .map((key) => ({ itemKey: key, title: key.replace(/^prototypes\//, '') }));
  }

  result.items = items.map((item) => ({
    ...item,
    url: result.origin ? `${result.origin}/${item.itemKey}` : '',
  }));
  result.updatedAt = tree?.updatedAt || '';
  if (!result.origin) result.note = 'Axhub Make 服务当前没在运行，链接暂不可用';
  return result;
}

/** 探活：dev-server-info 可能是上次留下的陈旧记录，真开页面前先确认端口活着。 */
export async function probeOrigin(origin) {
  if (!origin) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    const res = await fetch(origin, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}
