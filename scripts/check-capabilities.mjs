#!/usr/bin/env node
/**
 * 写入边界的静态把关(`pnpm test:capabilities`):纯扫描、不起服务。
 *
 * 服务端没有类型检查也没有测试,漏一道闸以前只能靠人眼。这里查五件事,任一命中即非 0 退出并给出文件:行:
 *   1. fs 写调用与起子进程只出现在注册表(`src/server/capabilities.mjs`)登记的承载模块里;
 *   2. 承载模块里的删除调用(rm / unlink)必须带 `// capability: tmp-cleanup` 标注 —— 看板不做真删除;
 *   3. http.mjs 每个非 GET 分支都调了 `guardCapability`(分支起始 8 行内),例外须带 `// capability: no-write` 标注;
 *   4. 每个 `guardCapability(req, res, '<标识>'` 的标识都已登记;
 *   5. 注册表里 `scope: 'workspace'` 的标识与 AGENTS.md 能力清单一一对应。
 *
 * 正则扫描,抓不到经变量间接调用的 fs 方法(design D5 的已知局限);范围靠"写盘只出现在承载模块"兜住。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'server');
const AGENTS = path.join(ROOT, 'AGENTS.md');

const { CAPABILITIES } = await import(pathToFileURL(path.join(SERVER, 'capabilities.mjs')).href);

const FS_WRITE = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'rename', 'renameSync',
  'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync',
  'rm', 'rmSync', 'rmdir', 'rmdirSync', 'unlink', 'unlinkSync', 'createWriteStream',
  'symlink', 'symlinkSync', 'link', 'linkSync', 'truncate', 'truncateSync',
];
const FS_DELETE = new Set(['rm', 'rmSync', 'rmdir', 'rmdirSync', 'unlink', 'unlinkSync']);
const CHILD = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
const CHILD_MODULES = new Set(['child_process', 'node:child_process']);
const GUARD_WINDOW = 8;

const errors = [];
const fail = (file, line, msg) => errors.push(`${path.relative(ROOT, file)}:${line}  ${msg}`);

const isComment = (line) => /^\s*(\*|\/\/|\/\*)/.test(line);

/**
 * 从 import 语句里找出 fs / child_process 的本地名字:
 * 默认 / 命名空间导入记成对象(`fs.writeFileSync(`),具名导入记成函数(`spawn(`,含 as 别名)。
 */
function importedNames(text, modules, wanted) {
  const objects = new Set();
  const funcs = new Map(); // 本地名 → 原名
  const re = /import\s+([^;]+?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(re)) {
    if (!modules.has(m[2])) continue;
    const clause = m[1];
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) {
      for (const part of named[1].split(',')) {
        const [orig, alias] = part.trim().split(/\s+as\s+/);
        if (!orig) continue;
        if (orig === 'promises') objects.add(alias || orig);
        else if (wanted.includes(orig)) funcs.set(alias || orig, orig);
      }
    }
    const rest = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
    const ns = /\*\s+as\s+(\w+)/.exec(rest);
    if (ns) objects.add(ns[1]);
    else if (/^\w+$/.test(rest)) objects.add(rest);
  }
  return { objects, funcs };
}

/** 一行里命中的调用(原名列表)。 */
function callsIn(line, { objects, funcs }, wanted) {
  const hits = [];
  for (const obj of objects) {
    const re = new RegExp(`\\b${obj}\\.(${wanted.join('|')})\\s*\\(`, 'g');
    for (const m of line.matchAll(re)) hits.push(m[1]);
  }
  for (const [local, orig] of funcs) {
    const re = new RegExp(`(?<![.\\w])${local}\\s*\\(`);
    if (re.test(line)) hits.push(orig);
  }
  return hits;
}

// ── 注册表本身 ─────────────────────────────────────────────────────────
const carriers = new Map(); // 模块 → 能力标识[]
for (const [id, cap] of Object.entries(CAPABILITIES)) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) fail(path.join(SERVER, 'capabilities.mjs'), 1, `能力标识不是 kebab-case:${id}`);
  for (const mod of cap.modules) {
    if (!fs.existsSync(path.join(SERVER, mod))) fail(path.join(SERVER, 'capabilities.mjs'), 1, `能力 ${id} 的承载模块不存在:${mod}`);
    carriers.set(mod, [...(carriers.get(mod) || []), id]);
  }
}

// ── 1 / 2:fs 写与子进程只在承载模块里;删除必须带标注 ─────────────────
const annotations = [];
const serverFiles = fs.readdirSync(SERVER).filter((f) => f.endsWith('.mjs')).sort();
for (const name of serverFiles) {
  const file = path.join(SERVER, name);
  const text = fs.readFileSync(file, 'utf8');
  const fsNames = importedNames(text, FS_MODULES, FS_WRITE);
  const childNames = importedNames(text, CHILD_MODULES, CHILD);
  const isCarrier = carriers.has(name);
  text.split('\n').forEach((line, i) => {
    if (isComment(line)) return;
    const writes = callsIn(line, fsNames, FS_WRITE);
    const spawns = callsIn(line, childNames, CHILD);
    if (!isCarrier && writes.length) fail(file, i + 1, `注册表之外的模块里有 fs 写调用(${writes.join('、')}),先在 capabilities.mjs 登记能力`);
    if (!isCarrier && spawns.length) fail(file, i + 1, `注册表之外的模块里起子进程(${spawns.join('、')}),先在 capabilities.mjs 登记能力`);
    if (writes.some((w) => FS_DELETE.has(w))) {
      if (/\/\/\s*capability:\s*tmp-cleanup\b/.test(line)) annotations.push(`${path.relative(ROOT, file)}:${i + 1}`);
      else fail(file, i + 1, '删除调用没有 `// capability: tmp-cleanup` 标注 —— 看板不做真删除,只清本次操作自己建的临时文件 / 缓存');
    }
  });
}

// ── 3 / 4:非 GET 分支都过闸,标识都已登记 ──────────────────────────────
const routeCount = new Map();
for (const name of serverFiles) {
  const file = path.join(SERVER, name);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    for (const m of line.matchAll(/guardCapability\(\s*req\s*,\s*res\s*,\s*'([^']+)'/g)) {
      if (!Object.hasOwn(CAPABILITIES, m[1])) fail(file, i + 1, `guardCapability 用了未登记的能力标识:${m[1]}`);
      routeCount.set(m[1], (routeCount.get(m[1]) || 0) + 1);
    }
  });
}
{
  const file = path.join(SERVER, 'http.mjs');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    if (!/req\.method\s*[!=]==\s*'(POST|PUT|PATCH|DELETE)'/.test(line)) return;
    if (/\/\/\s*capability:\s*no-write\b/.test(line)) return;
    const window = lines.slice(i, i + GUARD_WINDOW).join('\n');
    if (!window.includes('guardCapability(')) fail(file, i + 1, `非 GET 分支在 ${GUARD_WINDOW} 行内没有调用 guardCapability`);
  });
}

// ── 5:注册表与 AGENTS.md 能力清单一一对应 ───────────────────────────────
{
  const text = fs.readFileSync(AGENTS, 'utf8');
  const begin = text.indexOf('<!-- capabilities:begin -->');
  const end = text.indexOf('<!-- capabilities:end -->');
  if (begin < 0 || end < begin) {
    fail(AGENTS, 1, '找不到能力清单表格的标记 <!-- capabilities:begin --> / <!-- capabilities:end -->');
  } else {
    const beginLine = text.slice(0, begin).split('\n').length;
    const listed = new Map();
    text.slice(begin, end).split('\n').forEach((line, i) => {
      const m = /^\|\s*`([a-z0-9-]+)`\s*\|/.exec(line);
      if (m) listed.set(m[1], beginLine + i);
    });
    const registered = Object.entries(CAPABILITIES).filter(([, c]) => c.scope === 'workspace').map(([id]) => id);
    for (const id of registered) {
      if (!listed.has(id)) fail(AGENTS, beginLine, `能力清单缺少注册表里的工作空间能力:${id}`);
    }
    for (const [id, line] of listed) {
      if (!registered.includes(id)) fail(AGENTS, line, `能力清单里的 ${id} 不在注册表的工作空间能力里`);
    }
  }
}

// ── 输出 ─────────────────────────────────────────────────────────────
if (errors.length) {
  console.error(`✗ 写入边界检查发现 ${errors.length} 处问题:\n`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

console.log('✓ 写入边界检查通过\n');
for (const scope of ['workspace', 'local']) {
  console.log(scope === 'workspace' ? '写工作空间的能力:' : '只动本机状态的能力:');
  for (const [id, cap] of Object.entries(CAPABILITIES)) {
    if (cap.scope !== scope) continue;
    const routes = routeCount.get(id) || 0;
    const flag = cap.deviation ? '  [偏离]' : '';
    console.log(`  ${id.padEnd(26)} ${cap.executor.padEnd(6)} 路由 ${routes}  ${cap.modules.join(', ')}${flag}`);
  }
  console.log('');
}
console.log(`tmp-cleanup 标注 ${annotations.length} 处:`);
for (const a of annotations) console.log(`  ${a}`);
