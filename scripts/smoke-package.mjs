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
import { createRequire } from 'node:module';
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
 * 最小可抽取文字的 PDF，不依赖外部工具。
 * 冒烟只验「装包后 anydoc 真能转」，中文码位另在命令行用真实 PDF 验。
 */
function writeSmokePdf(file, text) {
  const escaped = String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = `BT /F1 12 Tf 50 700 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i += 1) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  fs.writeFileSync(file, out, 'latin1');
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

  // 可信发布签 provenance 时，空 / 错的 repository.url 会让 npm 直接 422
  const installedPkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  const repoUrl = typeof installedPkg.repository === 'string'
    ? installedPkg.repository
    : installedPkg.repository?.url;
  if (repoUrl !== 'https://github.com/STArtppt/aispace-kanban') {
    die(
      '包里的 repository.url 不是 GitHub 仓库地址 —— 可信发布会 422',
      JSON.stringify(installedPkg.repository ?? null),
    );
  }
  ok('package.json 带 GitHub repository，provenance 能对上');

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
    'visualization/references',
    'visualization/prototypes',
    '.claude/skills/pm-doc-ingest/SKILL.md',
    '.claude/skills/skill-creator/SKILL.md',
  ];
  const missing = must.filter((rel) => !fs.existsSync(path.join(wsPath, rel)));
  if (missing.length) die(`新工作空间缺文件：${missing.join('、')}`);
  // 原型已经搬进 visualization/，根上不该再铺一个空的 prototypes/（那会让人以为还是老位置）
  if (fs.existsSync(path.join(wsPath, 'prototypes'))) {
    die('新工作空间根上还有 prototypes/ —— 原型的唯一落点是 visualization/prototypes/');
  }
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

  // ── 6c 装包后能转 PDF（专门验 anydoc 被写进发布包依赖，而不是只在本地 node_modules 里）──
  if (!installedPkg.dependencies?.['@firecrawl/anydoc']) {
    die(
      '发布包 dependencies 里没有 @firecrawl/anydoc —— 组包脚本没扫到 createRequire().resolve',
      JSON.stringify(installedPkg.dependencies ?? null),
    );
  }
  const smokePdf = path.join(wsPath, 'input', 'raw', 'smoke-anydoc.pdf');
  writeSmokePdf(smokePdf, 'HelloAnydoc');
  const pdfStarted = await fetch(`${base}/api/projects/${created.id}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'input/raw/smoke-anydoc.pdf' }),
  }).then((r) => r.json());
  if (pdfStarted.status !== 'running' && pdfStarted.status !== 'done') {
    die(`PDF 转换没启动：${pdfStarted.error || JSON.stringify(pdfStarted)}`);
  }
  const pdfDone = await waitFor(async () => {
    const st = await fetch(`${base}/api/projects/${created.id}/ingest`).then((r) => r.json());
    return st.status === 'done' || st.status === 'error' ? st : null;
  }, { timeout: 30000 });
  if (pdfDone.status !== 'done') {
    die(`PDF 转换失败：${pdfDone.message || pdfDone.status}`, pdfDone.log);
  }
  const convertedPdf = path.join(wsPath, 'input', 'converted', 'smoke-anydoc.md');
  if (!fs.existsSync(convertedPdf)) {
    die('PDF 转完没有产物 input/converted/smoke-anydoc.md', pdfDone.log);
  }
  const convertedBody = fs.readFileSync(convertedPdf, 'utf8');
  if (!/converted_by:\s*anydoc/i.test(convertedBody)) {
    die('PDF 产物的 converted_by 不是 anydoc —— 装包后可能退回了兜底', convertedBody.slice(0, 400));
  }
  if (!convertedBody.includes('HelloAnydoc')) {
    die('PDF 产物里找不到写入的正文 HelloAnydoc', convertedBody.slice(0, 400));
  }
  ok('装包后能转 PDF，converted_by=anydoc');

  // ── 7 只读红线：路径穿越必须被挡 ──────────────────────────────────────────
  const traversal = await fetch(`${base}/api/projects/${created.id}/file?path=${encodeURIComponent('../../../etc/passwd')}`);
  if (traversal.status !== 403) die(`路径穿越没被挡住（返回 ${traversal.status}，应该是 403）`);
  ok('工作空间外的路径被挡住了');

  // json 的 MIME 是 application/json，/file 必须仍包成 { content }，不能把文件
  // 自己当成接口响应 —— 否则阅读器 data.content 是 undefined，预览空白。
  const jsonRel = 'output/docs/smoke-probe.json';
  fs.mkdirSync(path.join(wsPath, 'output', 'docs'), { recursive: true });
  fs.writeFileSync(path.join(wsPath, jsonRel), `${JSON.stringify({ hello: 'kanban' }, null, 2)}\n`);
  const jsonFile = await fetch(`${base}/api/projects/${created.id}/file?path=${encodeURIComponent(jsonRel)}`).then(
    (r) => r.json(),
  );
  if (typeof jsonFile.content !== 'string' || !jsonFile.content.includes('"hello"')) {
    die('JSON 文件接口没有返回 content 包装', JSON.stringify(jsonFile));
  }
  ok('JSON 文件走 { content } 包装，不是裸 application/json');

  // ── 7xlsx 工作簿分页与检索（解析只在内存，不写工作空间）────────────────────
  if (!installedPkg.dependencies?.xlsx) {
    die(
      '发布包 dependencies 里没有 xlsx —— 组包脚本没扫到 spreadsheet.mjs 的 import',
      JSON.stringify(installedPkg.dependencies ?? null),
    );
  }
  const requireFromPkg = createRequire(path.join(installed, 'package.json'));
  const XLSX = requireFromPkg('xlsx');
  const xlsxRel = 'output/docs/smoke.xlsx';
  const xlsxAbs = path.join(wsPath, xlsxRel);
  fs.mkdirSync(path.dirname(xlsxAbs), { recursive: true });
  const wb = XLSX.utils.book_new();
  const summary = XLSX.utils.aoa_to_sheet([
    ['名称', '备注'],
    ['alpha', 'hello, world'],
    ['beta', 'other'],
  ]);
  const detail = XLSX.utils.aoa_to_sheet([
    ['项', '值'],
    ['合计', 3],
  ]);
  detail.B2 = { t: 'n', v: 3, f: '1+2', w: '3' };
  XLSX.utils.book_append_sheet(wb, summary, '汇总');
  XLSX.utils.book_append_sheet(wb, detail, '明细');
  XLSX.writeFile(wb, xlsxAbs);
  const xlsxMtimeBefore = fs.statSync(xlsxAbs).mtimeMs;

  const tableDefault = await fetch(
    `${base}/api/projects/${created.id}/table?path=${encodeURIComponent(xlsxRel)}`,
  ).then(async (r) => ({ status: r.status, body: await r.json() }));
  if (tableDefault.status !== 200) {
    die(`/table xlsx 失败：${tableDefault.status}`, JSON.stringify(tableDefault.body));
  }
  if (tableDefault.body.sheet !== '汇总') {
    die(`不带 sheet 应返回第一张表，实际 ${tableDefault.body.sheet}`);
  }
  if (!Array.isArray(tableDefault.body.sheets) || tableDefault.body.sheets.join(',') !== '汇总,明细') {
    die('sheets 对不上', JSON.stringify(tableDefault.body.sheets));
  }
  const commaLine = (tableDefault.body.lines || []).find((l) => l.includes('alpha'));
  if (!commaLine || !commaLine.includes('"hello, world"')) {
    die('带逗号的单元格没有编成 csv 引号字段', JSON.stringify(tableDefault.body.lines));
  }

  const tableDetail = await fetch(
    `${base}/api/projects/${created.id}/table?path=${encodeURIComponent(xlsxRel)}&sheet=${encodeURIComponent('明细')}`,
  ).then((r) => r.json());
  if (tableDetail.sheet !== '明细') die(`指定 sheet 没切过去：${tableDetail.sheet}`);
  const formulaLine = (tableDetail.lines || []).join('\n');
  if (!formulaLine.includes('3')) {
    die('公式缓存值没显示成 3', JSON.stringify(tableDetail.lines));
  }

  const badSheet = await fetch(
    `${base}/api/projects/${created.id}/table?path=${encodeURIComponent(xlsxRel)}&sheet=${encodeURIComponent('不存在')}`,
  );
  const badBody = await badSheet.json();
  if (badSheet.status !== 400) die(`错误 sheet 名应 400，实际 ${badSheet.status}`);
  if (!String(badBody.error || '').includes('汇总') || !String(badBody.error || '').includes('明细')) {
    die('错误 sheet 名的提示没列出可用表', JSON.stringify(badBody));
  }

  const searchHit = await fetch(
    `${base}/api/projects/${created.id}/table-search?path=${encodeURIComponent(xlsxRel)}&q=alpha`,
  ).then((r) => r.json());
  if (!searchHit.rows?.some((row) => row.row === 0 && row.text === commaLine)) {
    die('xlsx 检索命中文本应与 /table 那一行相同', JSON.stringify(searchHit));
  }

  const csvRel = 'output/docs/smoke.csv';
  fs.writeFileSync(path.join(wsPath, csvRel), 'h1,h2\nv1,v2\n');
  const csvWithSheet = await fetch(
    `${base}/api/projects/${created.id}/table?path=${encodeURIComponent(csvRel)}&sheet=${encodeURIComponent('任何值')}`,
  ).then((r) => r.json());
  if (csvWithSheet.sheets) die('csv 带 sheet 参数不应返回 sheets', JSON.stringify(csvWithSheet));
  if (!csvWithSheet.lines?.some((l) => l.includes('v1'))) {
    die('csv 带 sheet 参数被改坏了', JSON.stringify(csvWithSheet));
  }

  const tableEscape = await fetch(
    `${base}/api/projects/${created.id}/table?path=${encodeURIComponent('../../etc/passwd')}`,
  );
  if (tableEscape.status !== 403) die(`/table 路径穿越没被挡住（${tableEscape.status}）`);
  const searchEscape = await fetch(
    `${base}/api/projects/${created.id}/table-search?path=${encodeURIComponent('../../etc/passwd')}&q=x`,
  );
  if (searchEscape.status !== 403) die(`/table-search 路径穿越没被挡住（${searchEscape.status}）`);
  const notTable = await fetch(
    `${base}/api/projects/${created.id}/table?path=${encodeURIComponent('project.yaml')}`,
  );
  if (notTable.status !== 400) die(`非表格 /table 应 400，实际 ${notTable.status}`);
  const badXlsxRel = 'output/docs/bad.xlsx';
  fs.writeFileSync(path.join(wsPath, badXlsxRel), 'not zip');
  const badXlsx = await fetch(
    `${base}/api/projects/${created.id}/table?path=${encodeURIComponent(badXlsxRel)}`,
  ).then(async (r) => ({ status: r.status, body: await r.json() }));
  if (badXlsx.status !== 400) die(`损坏的 xlsx 应 400，实际 ${badXlsx.status}`, JSON.stringify(badXlsx.body));

  const xlsRel = 'output/docs/smoke.xls';
  fs.writeFileSync(path.join(wsPath, xlsRel), 'not-a-real-xls');
  const scanXlsx = await fetch(`${base}/api/projects/${created.id}/scan`).then((r) => r.json());
  const xlsxItem = (scanXlsx.output?.docs || []).find((f) => f.path === xlsxRel);
  if (!xlsxItem || xlsxItem.reader !== 'table') {
    die('扫描没把 xlsx 标成 table', JSON.stringify(xlsxItem));
  }
  const xlsItem = (scanXlsx.output?.docs || []).find((f) => f.path === xlsRel);
  if (!xlsItem || xlsItem.reader !== 'external') {
    die('扫描不该把 .xls 标成 table', JSON.stringify(xlsItem));
  }

  if (fs.statSync(xlsxAbs).mtimeMs !== xlsxMtimeBefore) die('解析 xlsx 改了文件 mtime');
  ok('xlsx /table 与 /table-search 可用，csv 不受 sheet 影响，.xls 仍是 external');

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

  // ── 7b2 批注历史：写看板缓存目录，不写工作空间 ──────────────────────────
  const histFile = 'output/docs/smoke-notes.md';
  const histNote = {
    quote: '原文',
    comment: '改一下',
    structure: '段落',
    start: 0,
    end: 6,
    number: 1,
  };
  const histPosted = await fetch(`${base}/api/projects/${created.id}/note-history`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file: histFile, notes: [histNote] }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  if (histPosted.status !== 200 || !histPosted.body.batches?.length) {
    die(`归档批注失败：${histPosted.status} ${JSON.stringify(histPosted.body)}`);
  }
  const histCache = path.join(fakeHome, '.pmwork', 'dashboard', 'note-history', `${created.id}.json`);
  if (!fs.existsSync(histCache)) die('批注历史没写到 ~/.pmwork/dashboard/note-history/');
  if (fs.existsSync(path.join(wsPath, 'note-history'))) {
    die('批注历史写进了工作空间 —— 只能落看板缓存目录');
  }
  const histListed = await fetch(
    `${base}/api/projects/${created.id}/note-history?file=${encodeURIComponent(histFile)}`,
  ).then((r) => r.json());
  if (histListed.batches?.length !== 1 || histListed.batches[0].notes?.[0]?.comment !== '改一下') {
    die('GET 批注历史对不上刚归档的那一批', JSON.stringify(histListed));
  }
  const histEscape = await fetch(`${base}/api/projects/${created.id}/note-history`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file: '../../../etc/passwd', notes: [histNote] }),
  });
  if (histEscape.status !== 403) {
    die(`批注历史的路径穿越没被挡住（返回 ${histEscape.status}，应该是 403）`);
  }
  const histCleared = await fetch(
    `${base}/api/projects/${created.id}/note-history?file=${encodeURIComponent(histFile)}`,
    { method: 'DELETE' },
  ).then(async (r) => ({ status: r.status, body: await r.json() }));
  if (histCleared.status !== 200 || (histCleared.body.batches || []).length) {
    die(`清空批注历史失败：${histCleared.status} ${JSON.stringify(histCleared.body)}`);
  }
  ok('POST/GET/DELETE /note-history 写看板缓存，越界路径被挡住');

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

  // ── 7d 视觉平面：参考与原型的扫描、伺服隔离与旧位置探测 ────────────────────
  const visRoot = path.join(wsPath, 'visualization');
  const refDir = path.join(visRoot, 'references', 'foo');
  fs.mkdirSync(path.join(refDir, 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(refDir, 'index.html'), '<html><head><title>冒烟参考</title></head><body>ref</body></html>');
  fs.writeFileSync(path.join(refDir, 'screenshots', 'hero.png'), 'not-a-real-png');
  // 散装 .html 直接扔在 references/ 根上：不是一份参考，必须扫不到
  fs.writeFileSync(path.join(visRoot, 'references', 'bar.html'), '<html></html>');
  // 原型：一个 bundle、一条 url、一个既无 index.html 又无 meta.json 的空目录
  const protoBundle = path.join(visRoot, 'prototypes', '冒烟原型');
  fs.mkdirSync(protoBundle, { recursive: true });
  fs.writeFileSync(path.join(protoBundle, 'index.html'), '<html><head><title>冒烟原型</title></head><body>p</body></html>');
  const protoUrl = path.join(visRoot, 'prototypes', '线上版');
  fs.mkdirSync(protoUrl, { recursive: true });
  fs.writeFileSync(
    path.join(protoUrl, 'meta.json'),
    JSON.stringify({ kind: 'url', title: '线上版', target: 'https://example.com/p/abc' }),
  );
  fs.mkdirSync(path.join(visRoot, 'prototypes', '草稿'), { recursive: true });
  // 旧位置：只该被探测成 legacyDir，绝不该被列进清单
  const legacyPkg = path.join(wsPath, 'prototypes', '旧包');
  fs.mkdirSync(legacyPkg, { recursive: true });
  fs.writeFileSync(path.join(legacyPkg, 'index.html'), '<html><head><title>旧包</title></head><body>old</body></html>');

  const visScan = await fetch(`${base}/api/projects/${created.id}/scan`).then((r) => r.json());
  if (!visScan.references) die('扫描没有 references 字段 —— 新前端会以为服务进程是旧的');
  const refKeys = (visScan.references.items || []).map((i) => i.itemKey);
  if (!refKeys.includes('foo')) die('visualization/references/foo/index.html 没被列出', JSON.stringify(refKeys));
  if (refKeys.includes('bar') || refKeys.includes('bar.html')) {
    die('散装的 references/bar.html 被当成参考列出来了', JSON.stringify(refKeys));
  }
  const protoItems = visScan.prototypes?.items || [];
  const protoKeys = protoItems.map((i) => i.itemKey);
  if (!protoKeys.includes('冒烟原型')) die('visualization/prototypes/ 里的 bundle 没被列出', JSON.stringify(protoKeys));
  if (protoKeys.includes('旧包')) die('旧位置 prototypes/ 里的包被列进清单了 —— 那里只该被探测');
  if (protoKeys.includes('草稿')) die('既无 index.html 又无 meta.json 的空目录产生了占位卡片');
  const urlItem = protoItems.find((i) => i.itemKey === '线上版');
  if (!urlItem || urlItem.kind !== 'url' || urlItem.target !== 'https://example.com/p/abc') {
    die('meta.json 记的 kind: url 没被列成 url 原型', JSON.stringify(urlItem));
  }
  if (urlItem.url) die('url 形态的原型不该有看板伺服地址');
  if (visScan.prototypes?.legacyDir !== 'prototypes') {
    die(`根上还有非空 prototypes/ 却没报 legacyDir：${visScan.prototypes?.legacyDir}`);
  }
  ok('视觉平面扫描正确：参考只认子目录 index.html，url 原型成立，旧位置只探测不列出');

  // 伺服：参考与原型的 HTML 都必须落进不透明源（否则页面里的脚本能直接调看板接口）
  const refHtml = await fetch(`${base}/api/projects/${created.id}/ref/foo/index.html`);
  if (refHtml.status !== 200) die(`参考伺服失败：${refHtml.status}`);
  if (!/\bsandbox\b/.test(refHtml.headers.get('content-security-policy') || '')) {
    die(`参考 HTML 没带 CSP sandbox 头：${refHtml.headers.get('content-security-policy')}`);
  }
  if (/allow-same-origin/.test(refHtml.headers.get('content-security-policy') || '')) {
    die('参考 HTML 的 sandbox 给了 allow-same-origin —— 隔离等于没做');
  }
  const protoHtml = await fetch(`${base}/api/projects/${created.id}/proto/${encodeURIComponent('冒烟原型')}/index.html`);
  if (protoHtml.status !== 200) die(`原型伺服失败：${protoHtml.status}`);
  if (!/\bsandbox\b/.test(protoHtml.headers.get('content-security-policy') || '')) {
    die('原型 bundle 的伺服响应没带 CSP sandbox 头');
  }
  const urlServe = await fetch(`${base}/api/projects/${created.id}/proto/${encodeURIComponent('线上版')}/index.html`);
  if (urlServe.status === 200) die('url 形态的原型被看板伺服了 —— 它本地根本没有产物');
  const viewer = await fetch(`${base}/api/projects/${created.id}/ref/foo/view`);
  const viewerBody = await viewer.text();
  if (viewer.status !== 200 || !viewerBody.includes('<iframe')) die(`参考查看器壳页不对：${viewer.status}`);
  if ((viewer.headers.get('content-security-policy') || '').includes('sandbox')) {
    die('查看器壳页自己带了 sandbox —— 它是看板的页面，带了就没法读截图和画灯箱');
  }
  const shot = await fetch(`${base}/api/projects/${created.id}/ref/foo/screenshots/hero.png`);
  if (shot.status !== 200) die(`参考截图读不到：${shot.status}`);
  // 穿越必须整段百分号编码：URL 解析器会先把裸 ../ 规范化掉，那样根本到不了处理函数。
  // 而 %2e%2e%2f… 里带别的字符，不构成「双点段」，会原样送到服务端再由它解码 —— 这才是真实攻击面。
  for (const bad of ['%2e%2e%2fetc%2fpasswd', '%2e%2e%2f%2e%2e%2foutput%2fdocs%2ffoo.md']) {
    const esc = await fetch(`${base}/api/projects/${created.id}/ref/foo/${bad}`);
    if (esc.status !== 403) die(`参考伺服的路径穿越没被挡住（${bad} 返回 ${esc.status}，应该是 403）`);
  }
  // 截图走同一条伺服路径，同样不许越界（从 screenshots/ 往上爬四层就出了这份参考的目录）
  const escShot = await fetch(
    `${base}/api/projects/${created.id}/ref/foo/screenshots/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2foutput%2fdocs%2ffoo.md`,
  );
  if (escShot.status !== 403) die(`参考截图路径的穿越没被挡住（返回 ${escShot.status}，应该是 403）`);
  ok('参考与原型伺服都落进不透明源，查看器壳页可用，路径穿越被挡住');

  // ── 7e 跨站防护：浏览器里任意一个网页都能往 127.0.0.1 POST，环回 ≠ 可信 ────────
  // 覆盖全部五条会写盘 / 起子进程的接口（新的采集 + 既有四条）。
  // 这条要是漏了，恶意网页能用 enctype=text/plain 的表单静默触发本机操作。
  const crossSite = [
    ['POST', '/api/projects'],
    ['POST', '/api/workspaces'],
    [`POST`, `/api/projects/${created.id}/ingest`],
    [`POST`, `/api/projects/${created.id}/ignore`],
    [`POST`, `/api/projects/${created.id}/capture`],
  ];
  for (const [method, endpoint] of crossSite) {
    const res = await fetch(`${base}${endpoint}`, {
      method,
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({}),
    });
    if (res.status !== 403) die(`跨站 ${method} ${endpoint} 没被拒（返回 ${res.status}，应该是 403）`);
  }
  // 没有 Sec-Fetch-Site 但 Origin 不是本机服务：同样要拒
  const foreignOrigin = await fetch(`${base}/api/projects/${created.id}/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ plane: 'reference', url: 'https://example.com/' }),
  });
  if (foreignOrigin.status !== 403) die(`外站 Origin 的采集请求没被拒（${foreignOrigin.status}）`);
  // 只读接口不受这条影响 —— 只读分享本来就要能跨机器访问
  const roCross = await fetch(`${base}/api/projects/${created.id}/scan`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  if (roCross.status !== 200) die(`只读扫描被跨站校验误伤了（${roCross.status}）`);
  ok('五条写接口都拒跨站请求，只读接口不受影响');

  // ── 7f 采集：缺 single-file 时失败且带安装命令，写路径完全由服务端定 ──────────
  // 冒烟机器上通常没有 single-file（它不是看板的依赖，这正是要验的降级面）。
  const capBefore = () => {
    const listDir = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort().join(',') : '(无)');
    return {
      input: listDir(path.join(wsPath, 'input')),
      output: listDir(path.join(wsPath, 'output', 'docs')),
      yaml: fs.existsSync(path.join(wsPath, 'project.yaml'))
        ? fs.readFileSync(path.join(wsPath, 'project.yaml'), 'utf8')
        : '',
    };
  };
  const snapshot = capBefore();
  // references/ 根上本来就躺着模板的 .gitkeep、7d 放的 foo/ 与散装 bar.html ——
  // 「不留半成品」指的是采集失败后一个字节都不新增，所以拿当前列表当基准，
  // 不能硬编码一份目录清单（模板骨架一加文件这里就假红）。
  const refRoot = path.join(visRoot, 'references');
  const refsBefore = fs.readdirSync(refRoot).sort().join(',');

  // 请求体里夹带路径字段：必须被完全忽略，只写服务端自己生成的 slug 目录
  const capStarted = await fetch(`${base}/api/projects/${created.id}/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      plane: 'reference',
      url: 'https://example.com/',
      slug: '../../output/docs',
      path: '../../output/docs',
    }),
  }).then((r) => r.json());
  if (capStarted.status !== 'running') die(`发起采集没返回 running：${JSON.stringify(capStarted)}`);

  const finished = await waitFor(async () => {
    const job = await fetch(`${base}/api/projects/${created.id}/capture`).then((r) => r.json());
    return job.status === 'running' ? null : job;
  }, { timeout: 180000, interval: 1000 });

  const hasSingleFile = finished.status !== 'error';
  if (!hasSingleFile) {
    // 没装 single-file：必须失败、必须给出安装命令、必须不写盘
    if (!String(finished.message).includes('single-file-cli')) {
      die('缺 single-file 的失败说明里没有安装命令', finished.message);
    }
    const after = fs.readdirSync(refRoot).sort();
    if (after.join(',') !== refsBefore) {
      die('采集失败却在 references/ 下留了东西', after.join(','));
    }
    ok('没装 single-file：采集失败、说明带安装命令、不留半成品目录');
  } else {
    // 装了 single-file：产物必须落在服务端生成的 slug 下，绝不在 output/
    if (!String(finished.sourcePath || '').startsWith('visualization/references/')) {
      die(`采集写到了别处：${finished.sourcePath}`, JSON.stringify(finished));
    }
    if (String(finished.sourcePath).includes('..')) die(`slug 里带了穿越片段：${finished.sourcePath}`);
    ok(`装了 single-file：采集落在 ${finished.sourcePath}，请求体里的路径字段被忽略`);
  }

  // 无论成败，input/ output/ project.yaml 都必须一字未动
  const nowSnap = capBefore();
  for (const key of ['input', 'output', 'yaml']) {
    if (nowSnap[key] !== snapshot[key]) die(`采集改动了 ${key} —— 只读红线被打破`, `${snapshot[key]}\n→\n${nowSnap[key]}`);
  }
  ok('采集前后 input/ output/ project.yaml 一字未动');

  // ── 7g 原型 URL 导入：只写 meta.json，绝不留 HTML 副本 ───────────────────────
  const protoJob = await fetch(`${base}/api/projects/${created.id}/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plane: 'prototype', url: 'https://example.com/p/smoke' }),
  }).then((r) => r.json());
  if (protoJob.status !== 'running') die(`发起原型导入没返回 running：${JSON.stringify(protoJob)}`);
  const protoDone = await waitFor(async () => {
    const job = await fetch(`${base}/api/projects/${created.id}/capture`).then((r) => r.json());
    return job.status === 'running' ? null : job;
  }, { timeout: 180000, interval: 1000 });
  if (protoDone.status !== 'done') die(`原型导入没成功（它不该依赖 single-file）：${protoDone.message}`);
  const protoDir = path.join(wsPath, protoDone.sourcePath);
  if (fs.existsSync(path.join(protoDir, 'index.html'))) {
    die('原型 URL 导入把页面本体抓下来了 —— 那种形态本地不该有 HTML 副本');
  }
  const protoMeta = JSON.parse(fs.readFileSync(path.join(protoDir, 'meta.json'), 'utf8'));
  if (protoMeta.kind !== 'url' || protoMeta.target !== 'https://example.com/p/smoke') {
    die('原型 meta.json 形状不对', JSON.stringify(protoMeta));
  }
  if (protoMeta.source !== 'url-capture') die(`原型 meta.json 的 source 不是 url-capture：${protoMeta.source}`);
  ok('原型 URL 导入只写 meta.json（kind:url、target 原样），目录里没有 index.html');

  // ── 7i 采集包接收端：契约校验、越界丢弃、来源放行不外溢 ──────────────────────
  // 扩展硬编码的投递目标就是 POST /capture-package（不在 /api 下）。
  // 这一段全部用合成包，不碰任何真实页面。
  {
    const EXT_ORIGIN = 'chrome-extension://smokeextensionidsmokeextensionid';
    // 接收端没有 projectId，它投进登记表里的**活动工作空间** ——
    // 到这一步活动的已经是后建的那个（7c 建的用户模板工作空间），不是最早那个。
    // 这里就照它真实的落点断言，顺带把「落点写进 location 让用户看得见」一起验了。
    const registry = await fetch(`${base}/api/projects`).then((r) => r.json());
    const target = registry.projects.find((p) => p.id === registry.activeProjectId);
    if (!target) die('登记表里没有活动工作空间，接收端无从判断落点', JSON.stringify(registry));
    const refRoot = path.join(target.root, 'visualization', 'references');
    const listRefs = () => (fs.existsSync(refRoot) ? fs.readdirSync(refRoot).sort().join(',') : '(无)');

    const makePkg = ({ version = 1, files = [], items = [], format = 'annotation-collect.capture-package' } = {}) => {
      const manifest = {
        format,
        version,
        packageId: 'smoke-batch',
        createdAt: '2026-01-01T00:00:00.000Z',
        generator: { name: 'annotation-collect', version: '0.0.0' },
        site: { origin: 'https://internal.example.test', title: '合成采集页' },
        items,
        files: files.map((f) => ({
          path: f.path, role: f.role, mediaType: 'text/html',
          byteLength: Buffer.byteLength(String(f.content), 'utf8'),
        })),
        redaction: { enabled: true, total: 1, byCategory: [{ category: 'token', count: 1 }], restored: 0 },
        missingResources: [],
        notice: '本包经过自动脱敏（模式匹配），必然有漏网。它不构成安全保证，分发前请自己看一遍。',
      };
      return {
        package: {
          manifest,
          files: [
            { path: 'manifest.json', mediaType: 'application/json', content: `${JSON.stringify(manifest, null, 2)}\n` },
            { path: 'summary.md', mediaType: 'text/markdown', content: '# 采集包 · 合成采集页\n\n（合成件）\n' },
            ...files.map((f) => ({ path: f.path, mediaType: 'text/html', content: f.content })),
          ],
        },
        triggeredAt: '2026-01-01T00:01:00.000Z',
      };
    };
    const deliver = (body, headers = {}) => fetch(`${base}/capture-package`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    // (1) 版本比宿主认的高 → 明确拒绝，且不写盘。
    // 扩展拿到非 2xx 才会走 refused-by-host 并**保留批次**；这里要是收下了，用户的批次就被清空了。
    const before = listRefs();
    const tooNew = await deliver(makePkg({
      version: 2,
      files: [{ path: 'payloads/p-1.html', role: 'page-html', content: '<html><title>未来版本</title></html>' }],
    }));
    if (tooNew.status < 400 || tooNew.status >= 500) die(`version:2 的包没被拒（${tooNew.status}）`);
    if (!(await tooNew.json()).error?.includes('v1')) die('拒绝 v2 时没说清宿主只认到哪一版');
    if (listRefs() !== before) die('拒了 v2 却还是写了盘', `${before} → ${listRefs()}`);

    // (2) 不是采集包的任意 JSON → 拒
    const notPkg = await deliver({ package: { manifest: { format: 'something-else', version: 1 } } });
    if (notPkg.status < 400 || notPkg.status >= 500) die(`非采集包的 JSON 没被拒（${notPkg.status}）`);

    // (3) 纯文字批注、一份 HTML 都没有 → 拒，且**绝不自己造 index.html**
    const notesOnly = await deliver(makePkg({
      items: [{ id: 'n1', kind: 'note', note: '只写了字', anchor: {}, files: [] }],
    }));
    if (notesOnly.status < 400 || notesOnly.status >= 500) die(`纯批注的包没被拒（${notesOnly.status}）`);
    if (listRefs() !== before) die('纯批注的包被拒了却还是写了盘', `${before} → ${listRefs()}`);
    ok('接收端：v2 / 非采集包 / 纯批注三种都明确拒绝，一个字节都没落盘');

    // (4) 正常包 + 清单里夹带 ../ 与绝对路径：越界的丢弃，其余照常落
    const okPkg = makePkg({
      items: [{ id: 'p1', kind: 'page-snapshot', note: '这一版的形状是对的', anchor: {}, files: ['payloads/p-1.html'] }],
      files: [
        { path: 'payloads/p-1.html', role: 'page-html', content: '<html><head><title>合成采集页</title></head><body>正文</body></html>' },
        { path: 'payloads/p-2.html', role: 'fragment-html', content: '<p>第二个片段</p>' },
        { path: '../../output/docs/逃逸.html', role: 'fragment-html', content: '<p>不该落盘</p>' },
      ],
    });
    // 来源头用真实实测到的那一组（Origin 是扩展、Sec-Fetch-Site: none、无预检）
    const delivered = await deliver(okPkg, { origin: EXT_ORIGIN, 'sec-fetch-site': 'none' });
    if (delivered.status !== 200) die(`合法采集包没被收下（${delivered.status}）`, await delivered.text());
    const body = await delivered.json();
    if (body.accepted !== true || !body.location || !body.hostItemId) {
      die('成功响应不符合契约 D（accepted/location/hostItemId）', JSON.stringify(body));
    }
    const landed = path.join(refRoot, body.hostItemId);
    for (const f of ['index.html', 'manifest.json', 'summary.md', 'meta.json']) {
      if (!fs.existsSync(path.join(landed, f))) die(`落盘目录里缺 ${f}`, fs.readdirSync(landed).join(','));
    }
    if (!fs.existsSync(path.join(landed, 'payloads', 'p-2.html'))) {
      die('清单里的其余载荷没按相对路径落在同目录');
    }
    for (const root of [wsPath, target.root]) {
      if (fs.existsSync(path.join(root, 'output', 'docs', '逃逸.html'))) {
        die('清单里夹带的 ../ 路径逃出了条目目录 —— 只读红线被打破');
      }
    }
    if (!String(body.location).includes('没落盘')) die('越界条目被丢弃了却没写进响应说明', body.location);
    // location 是给人看的落点，必须点名是哪个工作空间 —— 用户就靠它判断有没有投错
    if (!String(body.location).includes(target.name)) {
      die('响应的 location 没写明投进了哪个工作空间', body.location);
    }
    const inboxMeta = JSON.parse(fs.readFileSync(path.join(landed, 'meta.json'), 'utf8'));
    if (inboxMeta.source !== 'plugin') die(`meta.json 的 source 不是 plugin：${inboxMeta.source}`);
    if (inboxMeta.scrubbed !== true) die('meta.json 没如实记下 scrubbed');
    // 免责声明必须原文照搬 —— 措辞变强等于替对面做了它拒绝做的承诺
    if (inboxMeta.notice !== okPkg.package.manifest.notice) {
      die('包自带的免责声明没有原样保留', inboxMeta.notice);
    }
    // manifest.json / summary.md 原样落，不改写、不重排、不补字段
    const rawManifest = okPkg.package.files.find((f) => f.path === 'manifest.json').content;
    if (fs.readFileSync(path.join(landed, 'manifest.json'), 'utf8') !== rawManifest) {
      die('manifest.json 没有原样落盘');
    }
    ok(`接收端：合法包落在活动工作空间「${target.name}」的 references/${body.hostItemId}/（四件齐全），越界条目被丢弃并写进了说明`);

    // (5) 扫描认得出它，且和别的参考同一形状
    const inboxScan = await fetch(`${base}/api/projects/${target.id}/scan`).then((r) => r.json());
    const hit = (inboxScan.references?.items || []).find((i) => i.itemKey === body.hostItemId);
    if (!hit) die('投进来的包没被参考扫描认出来', JSON.stringify(inboxScan.references));
    if (hit.source !== 'plugin' || !hit.url) die('投进来的条目缺 source/url', JSON.stringify(hit));
    ok('投进来的包进了参考清单，source 为 plugin、有可打开的查看器地址');

    // (6) 来源放行**只对这一条路径**：同一组扩展头打其它写接口必须仍被拒。
    // 实测过：扩展带的是 Sec-Fetch-Site: none —— 那个值本来会从跨站判定里直接漏过去。
    for (const endpoint of [
      '/api/projects',
      '/api/workspaces',
      `/api/projects/${created.id}/ingest`,
      `/api/projects/${created.id}/ignore`,
      `/api/projects/${created.id}/capture`,
    ]) {
      const leaked = await fetch(`${base}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: EXT_ORIGIN, 'sec-fetch-site': 'none' },
        body: JSON.stringify({}),
      });
      if (leaked.status !== 403) die(`扩展来源在 ${endpoint} 上没被拒（${leaked.status}）—— 放行外溢了`);
    }
    // 普通网页跨站打接收端：照拒
    const webCross = await deliver(okPkg, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
    if (webCross.status !== 403) die(`网页跨站投递没被拒（${webCross.status}）`);
    ok('扩展来源只在 /capture-package 放行，其余五条写接口照旧 403；网页跨站投递也被拒');
  }

  // ── 7h 非环回监听时采集 403，工作空间一个字节都不许多 ────────────────────────
  // --host 是给评审只读分享用的，不能变成局域网里的可执行入口。
  {
    const hostPort = await freePort();
    const hostServer = spawn(
      process.execPath,
      [path.join(installed, 'bin', 'cli.mjs'), 'serve', '--no-open', '--host', '0.0.0.0', '--port', String(hostPort)],
      {
        cwd: work,
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    try {
      const hostBase = `http://127.0.0.1:${hostPort}`;
      await waitFor(async () => (await fetch(`${hostBase}/api/health`)).ok);
      const listBefore = fs.readdirSync(path.join(visRoot, 'references')).sort().join(',');
      const denied = await fetch(`${hostBase}/api/projects/${created.id}/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plane: 'reference', url: 'https://example.com/' }),
      });
      if (denied.status !== 403) die(`非环回监听时采集没被拒（${denied.status}，应该是 403）`);
      // 接收端也在这道闸后面 —— 它是个写接口，不能因为「扩展来源放行」就绕过非环回禁写
      const inboxDenied = await fetch(`${hostBase}/capture-package`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'chrome-extension://smokeextensionidsmokeextensionid',
          'sec-fetch-site': 'none',
        },
        body: JSON.stringify({ package: { manifest: {} } }),
      });
      if (inboxDenied.status !== 403) die(`非环回监听时采集包接收端没被拒（${inboxDenied.status}）`);
      // 只读扫描仍要能用，否则只读分享就废了
      const roScan = await fetch(`${hostBase}/api/projects/${created.id}/scan`);
      if (roScan.status !== 200) die(`非环回时只读扫描也被拒了（${roScan.status}）`);
      const listAfter = fs.readdirSync(path.join(visRoot, 'references')).sort().join(',');
      if (listAfter !== listBefore) die('非环回采集被拒了却还是写了盘', `${listBefore} → ${listAfter}`);
      ok('非环回监听：采集与采集包接收端都 403、工作空间没被写入，只读扫描照常');
    } finally {
      hostServer.kill();
    }
  }

  // ── 8 注册表没写到真 HOME ─────────────────────────────────────────────────
  if (!fs.existsSync(path.join(fakeHome, '.pmwork', 'dashboard', 'projects.json'))) {
    die('注册表没写进隔离目录 —— 冒烟可能污染了你自己的看板，检查 HOME 传递');
  }
  ok('注册表写在隔离目录里，没碰你自己的登记信息');

  // ── 9 runtime.json：终端里跑 ingest.py 的人靠它零配置找到 anydoc ────────────
  // 这条断言在乎的是「装包后还写得出、且路径真的能用」——写不出来不会报错，
  // 只会让 agent 在终端里转 PDF 时悄悄退回 MinerU（外发文件），没人看得见。
  const runtimeFile = path.join(fakeHome, '.pmwork', 'dashboard', 'runtime.json');
  if (!fs.existsSync(runtimeFile)) {
    die('看板启动没写 runtime.json —— 终端里跑 scripts/ingest.py 会找不到本地 anydoc');
  }
  const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  for (const key of ['anydocBin', 'node']) {
    if (!runtime[key] || !fs.existsSync(runtime[key])) {
      die(`runtime.json 的 ${key} 指向不存在的路径：${runtime[key] || '(空)'}`, JSON.stringify(runtime));
    }
  }
  ok('runtime.json 已写出，anydocBin / node 都指向真实文件');

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
