#!/usr/bin/env node
/**
 * 把组好的 npm 包在一个**干净目录**里装起来跑一遍，验证装包的人拿到的是能用的东西。
 *
 *   node scripts/smoke-package.mjs [包.tgz]      # 不给就用 npm-package/*.tgz
 *
 * 为什么非要这一步：typecheck 只看 src/app，build 只管前端，两道闸全绿也照样可能
 * 发出一个「装上就白屏」的包 —— dist/ 忘了构建、服务端引了 devDependency、
 * 模板里的文件被 npm 打包规则吃掉，这些只有真装一遍才看得见。
 *
 * 注册表隔离：服务把登记信息写在 ~/.pmwork/dashboard/projects.json，
 * 所以这里给子进程换一个假 HOME，别把冒烟用的工作空间塞进你自己的看板。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_DIR = path.join(ROOT, 'npm-package');
const IS_WIN = process.platform === 'win32';

let step = 0;
function ok(msg) {
  step += 1;
  console.log(`  ✓ ${step}. ${msg}`);
}
function die(msg, detail) {
  console.error(`\n  ✗ 冒烟失败：${msg}`);
  if (detail) console.error(`\n${detail}\n`);
  process.exit(1);
}

/**
 * 跑一条命令，失败就带上输出退出。
 * Windows 上 npm 是 npm.cmd，不走 shell 找不到；而一旦走了 shell，Node 就不再替你加引号，
 * 带空格的路径（`C:\Users\某某\My Documents\...`）会被拆成两个参数，所以这里自己包一层。
 */
function sh(cmd, args, cwd) {
  const safe = IS_WIN ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
  const r = spawnSync(cmd, safe, { cwd, encoding: 'utf8', shell: IS_WIN });
  if (r.status !== 0) die(`${cmd} ${args.join(' ')} 退出码 ${r.status}`, `${r.stdout || ''}${r.stderr || ''}`);
  return r;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, { timeout = 20000, interval = 300 } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw lastErr || new Error('等待超时');
}

// ── 找包 ─────────────────────────────────────────────────────────────────────
let tgz = process.argv[2];
if (!tgz) {
  const found = fs.existsSync(PKG_DIR)
    ? fs.readdirSync(PKG_DIR).filter((f) => f.endsWith('.tgz')).sort()
    : [];
  if (!found.length) die('没找到 .tgz。先跑 pnpm build:npm，再 cd npm-package && npm pack');
  tgz = path.join(PKG_DIR, found[found.length - 1]);
}
tgz = path.resolve(tgz);
if (!fs.existsSync(tgz)) die(`包不存在：${tgz}`);

console.log(`\n  冒烟对象：${tgz}\n`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-smoke-'));
const fakeHome = path.join(work, 'home');
const wsPath = path.join(work, '冒烟工作空间');
fs.mkdirSync(fakeHome, { recursive: true });

let server = null;
let failed = false;

try {
  // ── 1 装包 ────────────────────────────────────────────────────────────────
  sh('npm', ['init', '-y'], work);
  sh('npm', ['install', tgz, '--no-audit', '--no-fund'], work);
  const installed = path.join(work, 'node_modules', '@startist', 'aispace-kanban');
  if (!fs.existsSync(path.join(installed, 'dist', 'index.html'))) {
    die('装完没有 dist/index.html —— 组包前忘了 pnpm build？');
  }
  ok('干净目录装包成功，dist/ 在包里');

  // ── 2 起服务 ──────────────────────────────────────────────────────────────
  const port = await freePort();
  server = spawn(process.execPath, [path.join(installed, 'bin', 'cli.mjs'), 'serve', '--no-open', '--port', String(port)], {
    cwd: work,
    // 假 HOME：注册表写进临时目录，不碰你自己的 ~/.pmwork
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (c) => { log += c; });
  server.stderr.on('data', (c) => { log += c; });
  server.on('exit', (code) => {
    if (code !== null && code !== 0 && !failed) die(`服务自己退了（退出码 ${code}）`, log);
  });

  const base = `http://127.0.0.1:${port}`;
  const health = await waitFor(async () => {
    const res = await fetch(`${base}/api/health`);
    return res.ok ? res.json() : null;
  }).catch(() => die('服务起不来', log));
  if (!health.ok) die('/api/health 返回不对', JSON.stringify(health));
  ok(`服务起来了，platform=${health.platform}${health.version ? ` version=${health.version}` : ''}`);

  // ── 3 前端真的伺服出去了 ──────────────────────────────────────────────────
  const html = await (await fetch(`${base}/`)).text();
  const asset = html.match(/assets\/[\w.-]+\.js/);
  if (!asset) die('首页里没有 assets/*.js —— dist/ 不完整', html.slice(0, 400));
  const assetRes = await fetch(`${base}/${asset[0]}`);
  if (!assetRes.ok) die(`前端资源拿不到：${asset[0]}（${assetRes.status}）`);
  ok('首页和前端资源都能取到');

  // ── 3b 模板列表（多模板扫描，缺了选择器就空）────────────────────────────
  const listed = await fetch(`${base}/api/templates`).then((r) => r.json());
  if (!Array.isArray(listed.templates) || !listed.templates.some((t) => t.id === 'pm-aispace')) {
    die('GET /api/templates 没有 pm-aispace', JSON.stringify(listed));
  }
  if (!listed.createPrompt || !String(listed.createPrompt).includes(listed.userRoot || '')) {
    die('创建模板提示词没有代入 userRoot', String(listed.createPrompt || '').slice(0, 200));
  }
  ok(`模板列表含 pm-aispace（共 ${listed.templates.length} 份）`);

  // ── 4 新建工作空间（串起 Python + 模板 + 注册表，最容易在打包后崩的一条链）──
  const created = await fetch(`${base}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '冒烟工作空间', path: wsPath }),
  }).then((r) => r.json());
  if (!created.id) {
    const hint = String(created.error || '').includes('Python')
      ? '\n  （这台机器没有 Python 3。新建工作空间要靠模板的 init_workspace.py。）'
      : '';
    die(`新建工作空间失败：${created.error}${hint}`);
  }
  ok(`新建工作空间成功：${created.id}`);

  // ── 5 铺出来的骨架是不是完整的（npm 会吃掉 .gitignore 和软链接）───────────
  const must = [
    'project.yaml',
    'AGENTS.md',
    '.gitignore',
    'input/raw/.gitkeep',
    'input/.ingestignore',
    '.claude/skills/pm-doc-ingest/SKILL.md',
    '.claude/skills/skill-creator/SKILL.md',
  ];
  const missing = must.filter((rel) => !fs.existsSync(path.join(wsPath, rel)));
  if (missing.length) die(`新工作空间缺文件：${missing.join('、')}`);
  const skills = path.join(wsPath, 'skills');
  if (!fs.existsSync(path.join(skills, 'pm-doc-ingest', 'SKILL.md'))) {
    die('新工作空间的 skills/ 用不了（AGENTS.md 里的技能链接全指向它）');
  }
  ok(`骨架完整，skills/ 可用（${fs.lstatSync(skills).isSymbolicLink() ? '软链接' : '复制的实体目录'}）`);

  // ── 6 扫描结果 ────────────────────────────────────────────────────────────
  const scan = await fetch(`${base}/api/projects/${created.id}/scan`).then((r) => r.json());
  if (scan.available === false) die(`扫描说工作空间不可用：${(scan.unavailableReasons || []).join('、')}`);
  if (!scan.meta?.exists) die('扫描没读到 project.yaml');
  if (!scan.input?.canIngest) die('扫描没标 canIngest —— 模板工作空间应有 scripts/ingest.py');
  ok('扫描正常，读到了 project.yaml，canIngest=true');

  // ── 6b 看板触发转换（立刻返回 + 无 raw 时脚本秒退）────────────────────────
  const started = await fetch(`${base}/api/projects/${created.id}/ingest`, { method: 'POST' }).then((r) => r.json());
  if (started.status !== 'running' && started.status !== 'done') {
    die(`触发转换失败：${started.error || JSON.stringify(started)}`);
  }
  const ingestDone = await waitFor(async () => {
    const st = await fetch(`${base}/api/projects/${created.id}/ingest`).then((r) => r.json());
    return st.status === 'done' || st.status === 'error' ? st : null;
  }, { timeout: 30000 });
  if (ingestDone.status !== 'done') {
    die(`转换没有成功结束：${ingestDone.message || ingestDone.status}`, ingestDone.log);
  }
  ok('POST /ingest 能跑完（空 raw 秒退）');

  // ── 7 只读红线：路径穿越必须被挡 ──────────────────────────────────────────
  const traversal = await fetch(`${base}/api/projects/${created.id}/file?path=${encodeURIComponent('../../../etc/passwd')}`);
  if (traversal.status !== 403) die(`路径穿越没被挡住（返回 ${traversal.status}，应该是 403）`);
  ok('工作空间外的路径被挡住了');

  const ingestEscape = await fetch(`${base}/api/projects/${created.id}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '../../../etc/passwd' }),
  });
  if (ingestEscape.status !== 403) {
    die(`单文件转换的路径穿越没被挡住（返回 ${ingestEscape.status}，应该是 403）`);
  }
  const ingestOutside = await fetch(`${base}/api/projects/${created.id}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'output/docs/foo.md' }),
  });
  if (ingestOutside.status !== 400) {
    die(`input/raw/ 以外的路径没被拒（返回 ${ingestOutside.status}，应该是 400）`);
  }
  ok('单文件转换只认 input/raw/，越界路径被挡住');

  // ── 7b 看板忽略资料：写 input/.ingestignore，从待转换里拿掉 ────────────────
  const rawFile = path.join(wsPath, 'input', 'raw', '忽略我.txt');
  fs.writeFileSync(rawFile, 'x');
  const beforeIgnore = await fetch(`${base}/api/projects/${created.id}/scan`).then((r) => r.json());
  if (!beforeIgnore.input?.pending?.some((f) => f.path === 'input/raw/忽略我.txt')) {
    die('刚放进 raw 的文件没出现在待转换里', JSON.stringify(beforeIgnore.input?.pending));
  }
  const ignored = await fetch(`${base}/api/projects/${created.id}/ignore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'input/raw/忽略我.txt' }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  if (ignored.status !== 200 || ignored.body.pattern !== 'raw/忽略我.txt') {
    die(`忽略失败：${ignored.status} ${JSON.stringify(ignored.body)}`);
  }
  const ignoreText = fs.readFileSync(path.join(wsPath, 'input', '.ingestignore'), 'utf8');
  if (!ignoreText.split(/\r?\n/).includes('raw/忽略我.txt')) {
    die('忽略后 .ingestignore 里没有对应行', ignoreText);
  }
  const afterIgnore = await fetch(`${base}/api/projects/${created.id}/scan`).then((r) => r.json());
  if (afterIgnore.input?.pending?.some((f) => f.path === 'input/raw/忽略我.txt')) {
    die('忽略后文件还在待转换里');
  }
  if (!afterIgnore.input?.stats?.ignored) die('忽略后 stats.ignored 还是 0');
  ok('POST /ignore 能写入 .ingestignore，扫描不再把它算待转换');

  const ignoreEscape = await fetch(`${base}/api/projects/${created.id}/ignore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '../../../etc/passwd' }),
  });
  if (ignoreEscape.status !== 403) {
    die(`忽略的路径穿越没被挡住（返回 ${ignoreEscape.status}，应该是 403）`);
  }
  const ignoreOutside = await fetch(`${base}/api/projects/${created.id}/ignore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'output/docs/foo.md' }),
  });
  if (ignoreOutside.status !== 400) {
    die(`input/raw/ 以外的路径没被拒（返回 ${ignoreOutside.status}，应该是 400）`);
  }
  ok('忽略只认 input/raw/，越界路径被挡住');

  // ── 7c 用户自建模板：丢进 ~/.pmwork/templates 立刻能被扫到，并能拿来新建 ──
  const userTpl = path.join(fakeHome, '.pmwork', 'templates', 'smoke-role');
  fs.mkdirSync(path.join(userTpl, '.claude', 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(userTpl, 'template.yaml'),
    'id: smoke-role\nname: 冒烟角色模板\ndescription: 冒烟用的最小模板\n',
  );
  fs.writeFileSync(path.join(userTpl, 'AGENTS.md'), '# 冒烟角色\n');
  fs.writeFileSync(path.join(userTpl, 'project.yaml'), 'workspace:\n  name: null\n  created_at: null\n');
  const listedUser = await fetch(`${base}/api/templates`).then((r) => r.json());
  if (!listedUser.templates?.some((t) => t.id === 'smoke-role' && t.builtin === false)) {
    die('用户自建模板没出现在列表里', JSON.stringify(listedUser.templates));
  }
  const userWs = path.join(work, '用户模板工作空间');
  const createdUser = await fetch(`${base}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '用户模板工作空间', path: userWs, template: 'smoke-role' }),
  }).then((r) => r.json());
  if (!createdUser.id) die(`用用户模板新建失败：${createdUser.error}`);
  if (!fs.existsSync(path.join(userWs, '.claude', 'skills', 'skill-creator', 'SKILL.md'))) {
    die('用户模板漏了 skill-creator，共享 init 没有补上');
  }
  if (!fs.existsSync(path.join(userWs, 'input', 'raw')) || !fs.existsSync(path.join(userWs, 'output'))) {
    die('用户模板铺出来缺 input/ 或 output/');
  }
  ok('用户自建模板能被扫到，新建后带 skill-creator');

  // ── 8 注册表没写到真 HOME ─────────────────────────────────────────────────
  if (!fs.existsSync(path.join(fakeHome, '.pmwork', 'dashboard', 'projects.json'))) {
    die('注册表没写进隔离目录 —— 冒烟可能污染了你自己的看板，检查 HOME 传递');
  }
  ok('注册表写在隔离目录里，没碰你自己的登记信息');

  console.log('\n  冒烟全过。这个包可以发。\n');
} catch (err) {
  failed = true;
  die('冒烟过程中出错', err?.stack || String(err));
} finally {
  server?.kill();
  // 临时目录留不留都行，删掉省得堆垃圾；删不掉（Windows 上文件还被占着）就算了
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch { /* 留在临时目录里，系统自己会清 */ }
}
