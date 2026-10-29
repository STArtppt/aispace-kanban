#!/usr/bin/env node
/**
 * 原始资料整理（templates/pm-aispace/scripts/move_raw.py）的回归：
 * 把合成工作空间拷到临时目录，先预览、再执行，断言原件、产物、台账、忽略规则、各类引用都跟到新路径，
 * 不该动的没动，再用看板的 scanWorkspace 核对「整理前已转的，整理后仍是已转」。
 *
 *     node scripts/check-move-raw.mjs        （pnpm test:raw-move）
 *
 * 为什么要有它：一次整理跨原件、产物、台账、忽略清单和整个 output/，模板 Python 脚本没有静态检查。
 * 语料全部合成，说明见 fixtures/raw-move/README.md。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanWorkspace } from '../src/server/scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'templates', 'pm-aispace', 'scripts');
const FIXTURE = path.join(ROOT, 'fixtures', 'raw-move', 'workspace');

function findPython() {
  for (const [cmd, pre] of [['python3', []], ['python', []], ['py', ['-3']]]) {
    const r = spawnSync(cmd, [...pre, '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && (r.stdout || '').trim() === '3') return [cmd, pre];
  }
  console.error('找不到 Python 3');
  process.exit(1);
}
const [PY, PY_PRE] = findPython();

let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { failed += 1; console.error(`  ✗ ${msg}`); };
const check = (cond, msg, detail = '') => (cond ? ok(msg) : fail(detail ? `${msg}：${detail}` : msg));

const sha16 = (text) => createHash('sha256').update(text.replace(/\r\n?/g, '\n'), 'utf8').digest('hex').slice(0, 16);
const bodyOf = (text) => { const m = /^---\n[\s\S]*?\n---\n/.exec(text); return m ? text.slice(m[0].length) : text; };
const read = (ws, rel) => readFileSync(path.join(ws, rel), 'utf8');
const has = (ws, rel) => existsSync(path.join(ws, rel));

/** 拷语料和模板脚本（move_raw.py 要导入同目录的 ingest / layout / rename_output 等），填好交付稿的摘要占位符 */
function freshWorkspace() {
  const ws = mkdtempSync(path.join(tmpdir(), 'check-move-raw-'));
  cpSync(FIXTURE, ws, { recursive: true });
  mkdirSync(path.join(ws, 'scripts'));
  for (const name of readdirSync(SCRIPTS)) {
    if (name.endsWith('.py')) cpSync(path.join(SCRIPTS, name), path.join(ws, 'scripts', name));
  }
  const rel = 'output/delivery/analysis/需求梳理/v001.md';
  let text = read(ws, rel).replace('__SHA_需求梳理__', sha16(read(ws, 'output/analysis/需求梳理.md')));
  text = text.replace('__BODY__', sha16(bodyOf(text)));
  writeFileSync(path.join(ws, rel), text);
  return ws;
}

function run(ws, ...args) {
  const r = spawnSync(PY, [...PY_PRE, path.join(ws, 'scripts', 'move_raw.py'), ...args, '--json'], {
    // 不写 __pycache__：「预览不改任何文件」按整个工作空间的快照比
    cwd: ws, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  const last = (r.stdout || '').trim().split(/\r?\n/).pop() || '';
  let json = null;
  try { json = JSON.parse(last); } catch { /* 下面按退出码判 */ }
  return { code: r.status, json, err: r.stderr };
}

const preview = (ws, ...args) => run(ws, ...args, '--dry-run');

function organize(ws, ...args) {
  const p = preview(ws, ...args);
  if (p.code !== 0) return p;
  return run(ws, ...args, '--apply', '--expect', p.json.plan);
}

/** 工作空间里全部文件 → 内容（判断「没动过」用；scripts/ 不算） */
function snapshot(dir, base = dir, out = new Map()) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const relp = path.relative(base, abs).split(path.sep).join('/');
    if (relp === 'scripts') continue;
    if (statSync(abs).isDirectory()) snapshot(abs, base, out);
    else out.set(relp, readFileSync(abs, 'utf8'));
  }
  return out;
}
const diffKeys = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));

function rawState(ws, rel) {
  const scan = scanWorkspace({ id: 'check', name: 'check', root: ws });
  const r = scan.input.raw.find((x) => x.path === rel);
  return r ? `${r.state}${r.stale ? '+stale' : ''}` : '不在列表里';
}

// ---------------------------------------------------------------- 预览

console.log('预览');
{
  const ws = freshWorkspace();
  const before = snapshot(ws);
  const p = preview(ws, '--source', 'input/raw/批次甲/说明.docx', '--to', '说明-修订');
  check(p.code === 0 && p.json?.ok, '预览成功', p.err);
  check(diffKeys(before, snapshot(ws)).length === 0, '预览不改任何文件');
  check(/^[0-9a-f]{16}$/.test(p.json?.plan || ''), '给出 16 位指纹');
  const files = (p.json?.files || []).map((f) => f.path);
  check(files.includes('input/INDEX.md') && p.json?.indexRows === 1, '台账一行列进预览');
  check(!files.some((f) => /^(\.claude|input\/sources|visualization)\//.test(f)), '排除范围的命中不出现在预览里', files.join('、'));
  check(p.json?.pathMap?.some((m) => m.from === 'output/converted/批次甲/说明.md'), '路径对照里有产物');
}

// ---------------------------------------------------------------- 文件改名

console.log('文件改名');
{
  const ws = freshWorkspace();
  const deliveryBody = bodyOf(read(ws, 'output/delivery/analysis/需求梳理/v001.md'));
  check(rawState(ws, 'input/raw/批次甲/说明.docx') === 'converted', '改名前是「已转」');
  const r = organize(ws, '--source', 'input/raw/批次甲/说明.docx', '--to', '说明-修订');
  check(r.code === 0 && r.json?.ok, '执行成功', r.err);
  check(has(ws, 'input/raw/批次甲/说明-修订.docx') && !has(ws, 'input/raw/批次甲/说明.docx'), '原件改名，留在原目录');
  check(read(ws, 'input/raw/批次甲/说明-修订.docx').startsWith('合成原件：说明'), '原件字节不变');
  const prod = 'output/converted/批次甲/说明-修订.md';
  check(has(ws, prod) && !has(ws, 'output/converted/批次甲/说明.md'), '产物搬到新落点');
  check(read(ws, prod).includes('source: input/raw/批次甲/说明-修订.docx'), '产物 source 跟进');
  check(read(ws, prod).includes('](../../../input/assets/说明/img1.png)'), '同目录改名，图片链接原样能用');
  check(has(ws, 'input/assets/说明/img1.png'), 'input/assets/ 的图片留在原地');
  const index = read(ws, 'input/INDEX.md');
  check(index.includes('| `input/raw/批次甲/说明-修订.docx` | richdoc | [`../output/converted/批次甲/说明-修订.md`](../output/converted/批次甲/说明-修订.md) |'),
    '台账行改为新原件与新产物');
  check(index.includes('批次甲的说明是权威版本。'), '人工批注里不带链接的句子原样保留');
  check(index.includes('[说明原件](./raw/批次甲/说明-修订.docx)'), '人工批注里的链接跟进');
  const doc = read(ws, 'output/analysis/需求梳理.md');
  check(doc.includes('[说明原件](../../input/raw/批次甲/说明-修订.docx)'), '原稿里指向原件的相对链接跟进');
  check(doc.includes('[转换产物](../converted/批次甲/说明-修订.md)') && doc.includes('`output/converted/批次甲/说明-修订.md`'),
    '原稿里指向产物的相对链接与根路径都跟进');
  check(doc.includes('[[../converted/批次甲/说明-修订|说明产物]]'), 'wikilink 跟进（省略 .md 的写法保留）');
  check(doc.includes('代码块里的链接不改：[x](../../input/raw/批次甲/说明.docx)'), '代码块里的链接不改');
  const v1 = read(ws, 'output/delivery/analysis/需求梳理/v001.md');
  check(v1.includes(`source_sha: ${sha16(doc)}`), '原稿内容变了，交付稿 source_sha 换新');
  check(bodyOf(v1) === deliveryBody, '交付稿正文一字不改');
  check(read(ws, 'output/docx-template/客户模板/profile.json').includes('"source": "input/raw/批次甲/说明-修订.docx"')
    && read(ws, 'output/docx-template/客户模板/profile.json').includes('取自 input/raw/批次甲/说明.docx 的样式'),
  'docx 模板 JSON 只改整个值等于旧路径的');
  check(read(ws, 'output/records/I0001.md').includes('历史条目提到 `input/raw/批次甲/说明.docx`'), '记录状态流水不改写');
  check(read(ws, 'project.yaml').includes('contract: input/raw/批次甲/说明-修订.docx'), 'project.yaml 跟进');
  check(read(ws, '.claude/rules/notes.md').includes('批次甲/说明.docx') && read(ws, 'input/sources/db.yaml').includes('批次甲/说明.docx'),
    '.claude/ 与 input/sources/ 不改');
  check(read(ws, 'output/delivery/converted/批次甲/说明/说明.docx') === 'docx 占位，不改\n'
    && !has(ws, 'output/delivery/converted/批次甲/说明-修订'), 'Word 成品不搬不改');
  check(rawState(ws, 'input/raw/批次甲/说明-修订.docx') === 'converted', '整理后仍是「已转」，不报原件已改');
}

// ---------------------------------------------------------------- 字面忽略规则（带方括号）

console.log('忽略规则');
{
  const ws = freshWorkspace();
  check(rawState(ws, 'input/raw/资料[终版].docx') === 'ignored', '改名前是「忽略」');
  const r = organize(ws, '--source', 'input/raw/资料[终版].docx', '--to', '资料[定稿]');
  check(r.code === 0, '文件名带方括号也能改名', r.err);
  check(read(ws, 'input/.ingestignore').split('\n').includes('raw/资料[定稿].docx'), '字面规则跟着改');
  check(rawState(ws, 'input/raw/资料[定稿].docx') === 'ignored', '改名后仍是「忽略」');
}

// ---------------------------------------------------------------- 目录移动

console.log('目录移动');
{
  const ws = freshWorkspace();
  const p = preview(ws, '--source', 'input/raw/批次甲', '--into', 'input/raw/归档');
  check(p.code === 0, '预览成功', p.err);
  check(p.json?.ignore?.wildcard?.includes('raw/批次甲/*.pdf'), '通配符规则单独列进预览');
  const r = run(ws, '--source', 'input/raw/批次甲', '--into', 'input/raw/归档', '--apply', '--expect', p.json?.plan || '');
  check(r.code === 0, '执行成功', r.err);
  check(has(ws, 'input/raw/归档/批次甲/说明.docx') && has(ws, 'input/raw/归档/批次甲/附件.pdf') && !has(ws, 'input/raw/批次甲'),
    '目录连同文件一起移动');
  const prod = 'output/converted/归档/批次甲/说明.md';
  check(has(ws, prod) && !has(ws, 'output/converted/批次甲'), '镜像目录一起搬');
  check(read(ws, prod).includes('](../../../../input/assets/说明/img1.png)')
    && read(ws, prod).includes('src="../../../../input/assets/说明/img1.png"'), '换了深度，图片链接按新位置重算');
  check(read(ws, 'input/.ingestignore').split('\n').includes('raw/批次甲/*.pdf'), '通配符规则不改');
  check(read(ws, 'input/assets/未分类/_manifest.md').includes('  - input/raw/归档/批次甲/草图.png'), '未分类图片清单里的原件路径跟进');
  check(read(ws, 'input/INDEX.md').includes('[`../output/converted/归档/批次甲/说明.md`](../output/converted/归档/批次甲/说明.md)'),
    '台账产物链接换了深度也跟进');
  check(rawState(ws, 'input/raw/归档/批次甲/说明.docx') === 'converted', '整理后仍是「已转」');
  check(rawState(ws, 'input/raw/归档/批次甲/草图.png') === 'converted', '图片仍算已入库');
}

// ---------------------------------------------------------------- 点表与现场数据

console.log('点表与现场数据');
{
  const ws = freshWorkspace();
  const before = snapshot(ws);
  check(rawState(ws, 'input/raw/测点表/甲站.txt') === 'converted', '点表文件整理前是「已转」');
  const single = organize(ws, '--source', 'input/raw/测点表/甲站.txt', '--to', '甲站-新');
  check(single.code === 4 && single.json?.kind === 'pointtable', '点表单个文件改名被拒', single.err);
  const into = organize(ws, '--source', 'input/raw/测点表', '--into', 'input/raw/归档');
  check(into.code === 4 && /原地改名/.test(into.json?.error || ''), '点表集移进子目录被拒', into.err);
  check(diffKeys(before, snapshot(ws)).length === 0, '被拒时磁盘不变');
  const ren = organize(ws, '--source', 'input/raw/测点表', '--to', '测点表-二期');
  check(ren.code === 0, '点表集原地改名成功', ren.err);
  const m = 'output/converted/测点表-二期/_manifest_测点表-二期批量处理.md';
  check(has(ws, m) && has(ws, 'output/converted/测点表-二期/MergedObject/测点主表.csv'), '合并摘要与 MergedObject/ 到新镜像位置');
  check(read(ws, m).includes('source: input/raw/测点表-二期\n'), '摘要 source 跟进');
  check(read(ws, 'input/INDEX.md').includes('| `input/raw/测点表-二期/` | 点表 ×2 | [`../output/converted/测点表-二期/_manifest_测点表-二期批量处理.md`]'),
    '台账点表集那一行跟进');
  check(rawState(ws, 'input/raw/测点表-二期/甲站.txt') === 'converted', '点表文件仍是「已转」');

  const rd = organize(ws, '--source', 'input/raw/现场数据/实时.csv', '--into', 'input/raw/归档');
  check(rd.code === 0, '现场数据文件单独移动成功', rd.err);
  const rm = 'output/converted/归档/_manifest_实时.md';
  check(has(ws, rm) && has(ws, 'output/converted/归档/SplittingObject/实时/实测数据.sqlite'), '摘要与正文目录一起搬');
  check(read(ws, rm).includes('payload: SplittingObject/实时') && read(ws, rm).includes('](./SplittingObject/实时)'), 'payload 与正文链接仍对');
  check(rawState(ws, 'input/raw/归档/实时.csv') === 'converted', '现场数据仍是「已转」');
}

// ---------------------------------------------------------------- 拒绝与降级

console.log('拒绝');
{
  const ws = freshWorkspace();
  const before = snapshot(ws);
  const clash = organize(ws, '--source', 'input/raw/批次甲/说明.docx', '--into', 'input/raw/冲突');
  check(clash.code === 2 && clash.json?.kind === 'conflict', '落点已存在退出 2', clash.err);
  const both = run(ws, '--source', 'input/raw/批次甲/说明.docx', '--to', 'x', '--into', 'input/raw/归档', '--dry-run');
  check(both.code === 4, '同时改名又换目录退出 4');
  const out = run(ws, '--source', 'input/raw/批次甲/说明.docx', '--into', 'output/analysis', '--dry-run');
  check(out.code === 4, '不能移出 input/raw/');
  const self = run(ws, '--source', 'input/raw/批次甲', '--into', 'input/raw/批次甲', '--dry-run');
  check(self.code === 4, '不能移进自己');
  for (const name of ['', '.隐藏', '尾巴.', ' 前空格', 'a/b', '..', 'x'.repeat(201)]) {
    const r = run(ws, '--source', 'input/raw/批次甲/说明.docx', '--to', name, '--dry-run');
    check(r.code === 4, `非法名字「${name.slice(0, 12)}」退出 4`);
  }
  check(diffKeys(before, snapshot(ws)).length === 0, '以上都不改磁盘');

  const p = preview(ws, '--source', 'input/raw/批次甲/说明.docx', '--to', '说明-修订');
  writeFileSync(path.join(ws, 'input/raw/批次甲/说明.docx'), '合成原件：预览之后被改过\n');
  const stale = run(ws, '--source', 'input/raw/批次甲/说明.docx', '--to', '说明-修订', '--apply', '--expect', p.json.plan);
  check(stale.code === 3 && has(ws, 'input/raw/批次甲/说明.docx'), '预览后原件被改：退出 3，不落盘', stale.err);

  const pd = preview(ws, '--source', 'input/raw/批次甲', '--into', 'input/raw/归档');
  writeFileSync(path.join(ws, 'input/raw/批次甲/新放进来.txt'), '合成\n');
  const staleDir = run(ws, '--source', 'input/raw/批次甲', '--into', 'input/raw/归档', '--apply', '--expect', pd.json.plan);
  check(staleDir.code === 3 && has(ws, 'input/raw/批次甲/说明.docx') && !has(ws, 'input/raw/归档/批次甲'),
    '预览后目录里多了文件：退出 3，目录留在原处', staleDir.err);

  // 大小写不敏感的文件系统上落点就是自己；大小写敏感的系统上这只是一次普通改名，同样应当成功
  const cs = organize(ws, '--source', 'input/raw/readme.docx', '--to', 'README');
  check(cs.code === 0 && has(ws, 'input/raw/README.docx'), '只改大小写放行', cs.err);
  check(read(ws, 'output/converted/README.md').includes('source: input/raw/README.docx'), '只改大小写，产物也跟着');
}

console.log('产物还在旧位置');
{
  const ws = freshWorkspace();
  renameSync(path.join(ws, 'output/converted'), path.join(ws, 'input/converted'));
  const before = snapshot(ws);
  const r = run(ws, '--source', 'input/raw/批次甲/说明.docx', '--to', '说明-修订', '--dry-run');
  check(r.code === 4 && r.json?.kind === 'legacy-converted', '拒绝并说明先迁移', r.err);
  check(diffKeys(before, snapshot(ws)).length === 0 && has(ws, 'input/raw/批次甲/说明.docx'), '不改名、不改任何文件');
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
