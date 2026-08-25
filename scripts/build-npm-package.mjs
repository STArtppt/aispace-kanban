#!/usr/bin/env node
/**
 * 组装可发布的 npm 包，产出在 npm-package/ 暂存目录：
 *
 *   bin/cli.mjs + src/server/ + dist/ + templates/ + 精简 package.json + README.md
 *
 * 为什么不直接把仓库根发出去：
 *   - 根 package.json 的 dependencies 里大半是**前端**依赖（react / papaparse …），
 *     它们已经被 vite 打进 dist/，装包的人不该再下一遍。这里按 src/server 的 import 图
 *     重新算依赖，实际只剩 yaml。
 *   - 根仓库还有 templates/ 之外的一堆源码与配置，装包的人一个都用不上。
 *
 * 目录层级必须原样保留 —— 服务端是按相对路径找东西的
 * （http.mjs 的 DIST = ../../dist，config.mjs 的模板兜底 = ../../templates）。
 *
 * 用法：node scripts/build-npm-package.mjs [--version 0.0.1]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'npm-package');
const PKG_NAME = '@startist/aispace-kanban';
// 可信发布会签 provenance，npm 要求发出去的 repository.url 与签发仓库一字不差
// （https://github.com/STArtppt/aispace-kanban，不含 .git）。不能从 git remote 推断：
// origin 是内网 Gitea，对不上就会 422，字段缺了则被当成空字符串，同样挂。
const REPO_URL = 'https://github.com/STArtppt/aispace-kanban';

function getArg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = getArg('--version') || rootPkg.version;
if (!version || version === '0.0.1') {
  console.warn(`[组包] 警告：使用版本 ${version}；发版请通过 --version <tag> 注入`);
}

// ── 前置检查：dist/ 必须是刚构建的 ────────────────────────────────────────────
// 包里没有前端源码，dist/ 缺了或者过期，装的人打开就是一片空白/旧界面。
if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('[组包] 没有 dist/index.html，先跑 pnpm build');
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, 'templates', 'init_workspace.py'))) {
  console.error('[组包] 没有 templates/init_workspace.py —— 少了它「新建工作空间」就废了');
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, 'templates', 'pm-aispace', 'template.yaml'))) {
  console.error('[组包] 没有 templates/pm-aispace/template.yaml');
  process.exit(1);
}

// ── 清空重建 ─────────────────────────────────────────────────────────────────
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

/**
 * 拷贝时统一丢掉的：系统文件、Python 缓存、本地依赖，还有每个模板目录下的 skills 软链接。
 * skills 是指向 .claude/skills 的软链接，指的还是绝对路径 —— 拷过来在别人机器上是死链，
 * 而且 npm 打包本来就会把软链接丢掉。新建工作空间时由 init_workspace.py 现建，不靠这里带。
 */
const JUNK = new Set(['.DS_Store', '__pycache__', 'node_modules', '.git']);
const bundledTemplates = path.join(ROOT, 'templates');
const copyFilter = (src) => {
  if (JUNK.has(path.basename(src))) return false;
  const rel = path.relative(bundledTemplates, src);
  if (!rel.startsWith('..') && rel !== '') {
    const parts = rel.split(path.sep);
    // templates/<id>/skills —— 软链接，不进包
    if (parts.length === 2 && parts[1] === 'skills') return false;
  }
  return true;
};

for (const dir of ['dist', 'templates']) {
  fs.cpSync(path.join(ROOT, dir), path.join(OUT, dir), { recursive: true, filter: copyFilter });
}

// npm 打包会**无条件**剔除所有叫 .gitignore 的文件（files 字段也救不回来），
// 而这份是要铺进新工作空间的。改名存一份，init_workspace.py 认这个名字。
function renameGitignores(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) renameGitignores(full);
    else if (entry.name === '.gitignore') fs.renameSync(full, path.join(dir, 'gitignore'));
  }
}
renameGitignores(path.join(OUT, 'templates'));
fs.cpSync(path.join(ROOT, 'src', 'server'), path.join(OUT, 'src', 'server'), {
  recursive: true,
  filter: copyFilter,
});
fs.mkdirSync(path.join(OUT, 'bin'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'bin', 'cli.mjs'), path.join(OUT, 'bin', 'cli.mjs'));
fs.chmodSync(path.join(OUT, 'bin', 'cli.mjs'), 0o755);

// ── 依赖：扫 bin/ 与 src/server/ 的裸 import，只留真用得上的 ──────────────────
const IMPORT_RE = /(?:import|export)\s+[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (full.endsWith('.mjs') || full.endsWith('.js')) acc.push(full);
  }
  return acc;
}

const used = new Set();
for (const file of [...walk(path.join(OUT, 'src', 'server')), path.join(OUT, 'bin', 'cli.mjs')]) {
  const code = fs.readFileSync(file, 'utf8');
  for (const m of code.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2] || m[3];
    if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
    used.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
  }
}

const dependencies = {};
const unknown = [];
for (const name of [...used].sort()) {
  if (rootPkg.dependencies?.[name]) dependencies[name] = rootPkg.dependencies[name];
  else unknown.push(name);
}
if (unknown.length) {
  // 服务端引了个不在 dependencies 里的包 —— 发出去必然 ERR_MODULE_NOT_FOUND，直接拦下
  console.error(`[组包] 这些包被服务端引用但不在 dependencies 里：${unknown.join('、')}`);
  process.exit(1);
}
console.log(`[组包] 运行时依赖：${Object.keys(dependencies).join('、') || '（无）'}`);

// ── 精简 package.json ────────────────────────────────────────────────────────
const pkg = {
  name: PKG_NAME,
  version,
  description: rootPkg.description,
  type: 'module',
  bin: { 'aispace-kanban': 'bin/cli.mjs' },
  // 20 是硬下限：Linux 上 fs.watch 的递归监听（SSE 自动刷新）从 20 才有
  engines: { node: '>=20' },
  files: ['bin', 'src', 'dist', 'templates', 'README.md'],
  dependencies,
  keywords: ['kanban', 'dashboard', 'workspace', 'markdown', 'local-first', 'pm'],
  repository: { type: 'git', url: REPO_URL },
  publishConfig: { access: 'public' },
  license: rootPkg.license || 'MIT',
};
fs.writeFileSync(path.join(OUT, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

// ── npm 包首页的 README（跟仓库 README 不是一份：这里只讲装完怎么用）───────────
fs.writeFileSync(
  path.join(OUT, 'README.md'),
  `# aispace-kanban

与 AI 反复对话做知识工作的**本地只读看板**。一条命令在本机起服务，浏览器里看每个工作空间的
概览、输入资料、产出文档和原型入口。资料不上传、不进云端，**不会往工作空间里写任何文件**。

调研、方案、数据分析、内容创作、项目接手 -- 只要「资料进来 -> 和 AI 反复对话 -> 文档出去」，
都落在同一套结构上。

## 起服务

\`\`\`bash
npx -y ${PKG_NAME}@latest
\`\`\`

浏览器会自动打开 <http://localhost:7788>。第一次用点界面上的「添加工作空间」指一个目录，
或者用命令登记：

\`\`\`bash
npx -y ${PKG_NAME}@latest add ~/work/某个工作空间
npx -y ${PKG_NAME}@latest list
\`\`\`

登记信息存在 \`~/.pmwork/dashboard/projects.json\`（Windows 在 \`%USERPROFILE%\\.pmwork\\\`）。
「移出看板」只删登记信息，本地目录和文件一个都不动。

## 什么算一个「工作空间」

有 \`input/\` 和 \`output/\` 两个目录的普通文件夹：\`input/\` 放丢进来的原始资料和转换产物，
\`output/\` 放分析、成稿、决策记录。\`mkdir -p 我的调研/{input,output}\` 就能加进看板，
不需要装模板、不需要跑脚本。要一套开箱即用的骨架（含批量转换脚本和 AI 技能），
用界面上的「新建」。

## 选项

| 选项 | 说明 |
| --- | --- |
| \`--port <n>\` | 端口，默认 7788（被占用时自动往上顺延至多 10 个） |
| \`--host <addr>\` | 监听地址，默认 127.0.0.1（只有本机能连） |
| \`--no-open\` | 不自动打开浏览器 |

## 要求

- Node.js ≥ 20（macOS / Windows / Linux 都能跑）
- 只有「新建工作空间」这一个功能要 Python 3；不用这个功能可以不装。

更多说明见项目主页。
`,
);

console.log(`[组包] 完成 → ${OUT}（版本 ${version}）`);
console.log('下一步：cd npm-package && npm pack，然后在别的目录 npx ./路径/startist-aispace-kanban-*.tgz 冒烟');
