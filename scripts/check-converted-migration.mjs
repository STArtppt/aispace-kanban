#!/usr/bin/env node
/**
 * 转换产物搬家（input/converted → output/converted）的回归：
 * 把合成的旧布局工作空间拷到临时目录，跑模板的 migrate_converted_to_output.py，断言链接可达、
 * 不该动的没动，再用看板的 scanWorkspace 核对新布局与旧前缀引用的别名。
 *
 *     node scripts/check-converted-migration.mjs        （pnpm test:converted-migration）
 *
 * 为什么要有它：迁移脚本一个实例只跑一次，跑坏了就是一批图片断链；模板 Python 脚本没有静态检查。
 * 语料全部合成，说明见 fixtures/converted-migration/README.md。
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanWorkspace } from '../src/server/scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'templates', 'pm-aispace', 'scripts');
const FIXTURE = path.join(ROOT, 'fixtures', 'converted-migration', 'workspace');

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

function freshWorkspace() {
  const ws = mkdtempSync(path.join(tmpdir(), 'check-converted-'));
  cpSync(FIXTURE, ws, { recursive: true });
  // 迁移脚本只依赖同目录的 layout.py
  mkdirSync(path.join(ws, 'scripts'));
  for (const f of ['migrate_converted_to_output.py', 'layout.py']) {
    cpSync(path.join(SCRIPTS, f), path.join(ws, 'scripts', f));
  }
  return ws;
}

function migrate(ws, ...args) {
  const r = spawnSync(PY, [...PY_PRE, path.join(ws, 'scripts', 'migrate_converted_to_output.py'), ...args], {
    // 不写 __pycache__：「预演不改任何文件」按整个工作空间的快照比
    cwd: ws, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** 工作空间里全部文件 → 内容（判断「没动过」用） */
function snapshot(dir, base = dir, out = new Map()) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) snapshot(abs, base, out);
    else out.set(path.relative(base, abs).split(path.sep).join('/'), readFileSync(abs, 'utf8'));
  }
  return out;
}

/** 一份 md 里的相对链接（markdown 与 src/href，跳过围栏代码块）是否都指得到 */
function brokenLinks(file) {
  const text = readFileSync(file, 'utf8');
  const broken = [];
  let fence = false;
  const lines = text.split('\n');
  let inFront = lines[0] === '---';
  lines.forEach((line, i) => {
    if (inFront) {
      if (i > 0 && line === '---') inFront = false;
      const m = /^(payload|preview):\s*(\S.*)$/.exec(line);
      if (m && !existsSync(path.resolve(path.dirname(file), m[2]))) broken.push(m[2]);
      return;
    }
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence) return;
    const targets = [
      ...[...line.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]),
      ...[...line.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]),
    ];
    for (const t of targets) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('#')) continue;
      const p = decodeURIComponent(t.split('#')[0]);
      if (!existsSync(path.resolve(path.dirname(file), p))) broken.push(t);
    }
  });
  return broken;
}

console.log('迁移：预演');
{
  const ws = freshWorkspace();
  const before = snapshot(ws);
  const r = migrate(ws, '--dry-run');
  check(r.code === 0, '--dry-run 退出 0', r.out);
  check(/将改写/.test(r.out) && /将移动/.test(r.out), '--dry-run 打印移动与改写计划');
  const after = snapshot(ws);
  check(before.size === after.size && [...before].every(([k, v]) => after.get(k) === v), '--dry-run 没有改动任何文件');
  rmSync(ws, { recursive: true, force: true });
}

console.log('迁移：执行');
{
  const ws = freshWorkspace();
  const before = snapshot(ws);
  const r = migrate(ws);
  check(r.code === 0, '执行退出 0（含自检）', r.out);
  check(!existsSync(path.join(ws, 'input/converted')), 'input/converted/ 已不在');
  const doc = path.join(ws, 'output/converted/需求调研/方案 (终版).md');
  const manifest = path.join(ws, 'output/converted/表格/_manifest_台账.md');
  check(existsSync(doc) && existsSync(manifest), '产物到了 output/converted/');
  check(existsSync(path.join(ws, 'output/converted/_sources/仓库库/_manifest_仓库库.md')), '_sources/ 随目录一起搬');
  check(brokenLinks(doc).length === 0, '正文链接（图片两种写法、互链、原件）全部可达', brokenLinks(doc).join(', '));
  check(brokenLinks(manifest).length === 0, '摘要的 payload 与表格链接可达', brokenLinks(manifest).join(', '));
  const body = readFileSync(doc, 'utf8');
  check(body.includes('../../../input/assets/方案%20%28终版%29/image0.png'), '图片链接跨目录指回 input/assets/ 且保持转义');
  check(body.includes('](https://example.com/a.md)') && body.includes('](#方案合成)'), '外链与页内锚点不动');
  check(body.includes('](../../assets/不该改.png)'), '代码块里的链接不动');
  check(body.includes('source: input/raw/需求调研/方案 (终版).txt'), 'frontmatter 的 source 不动');
  const after = snapshot(ws);
  check(after.get('output/analysis/现状.md') === before.get('output/analysis/现状.md'), 'output/analysis/ 一个字节没变');
  check(after.get('input/assets/方案 (终版)/image0.png') === before.get('input/assets/方案 (终版)/image0.png'), 'input/assets/ 没动');
  const index = after.get('input/INDEX.md') || '';
  check(index.includes('[`../output/converted/表格/_manifest_台账.md`](../output/converted/表格/_manifest_台账.md)'), '台账表格改成 ../output/converted/…');
  check(index.split('## 人工批注')[1] === before.get('input/INDEX.md').split('## 人工批注')[1], '台账人工批注区不动');
  check(brokenLinks(path.join(ws, 'input/INDEX.md')).filter((t) => !t.startsWith('./converted/')).length === 0, '台账表格里的产物链接可达');

  const scan = scanWorkspace({ id: 't', name: 't', root: ws });
  check(scan.input.layout === 'output' && !scan.input.convertedLeftover, '看板扫描认出新布局、无残留');
  const item = scan.input.converted.find((c) => c.path === 'output/converted/需求调研/方案 (终版).md');
  check(Boolean(item?.docKey), '新布局的单文件 .md 有 docKey');
  check(item?.referencedBy?.includes('output/analysis/现状.md'), '旧前缀引用仍算「被引用」');
  check(scan.input.raw.find((r) => r.path.endsWith('方案 (终版).txt'))?.state === 'converted', '原始资料标「已转」');

  console.log('迁移：回滚');
  const back = migrate(ws, '--reverse');
  check(back.code === 0, '--reverse 退出 0', back.out);
  const old = path.join(ws, 'input/converted/需求调研/方案 (终版).md');
  check(existsSync(old) && brokenLinks(old).length === 0, '回滚后链接仍可达', existsSync(old) ? brokenLinks(old).join(', ') : '文件不在');
  check(readFileSync(old, 'utf8') === before.get('input/converted/需求调研/方案 (终版).md'), '回滚后正文与迁移前一致');
  check(readFileSync(path.join(ws, 'input/INDEX.md'), 'utf8') === before.get('input/INDEX.md'), '回滚后台账与迁移前一致');
  rmSync(ws, { recursive: true, force: true });
}

console.log('迁移：目标非空');
{
  const ws = freshWorkspace();
  mkdirSync(path.join(ws, 'output/converted'), { recursive: true });
  writeFileSync(path.join(ws, 'output/converted/别人先放的.md'), '# 合成\n');
  const r = migrate(ws);
  check(r.code !== 0, '目标非空时拒绝并非零退出', r.out);
  check(existsSync(path.join(ws, 'input/converted/需求调研/方案 (终版).md')), '拒绝时源目录原样保留');
  const scan = scanWorkspace({ id: 't', name: 't', root: ws });
  check(scan.input.layout === 'output' && scan.input.convertedLeftover === true, '两处都有东西时看板标残留');
  rmSync(ws, { recursive: true, force: true });
}

console.log('迁移：旧布局与空目录');
{
  const ws = freshWorkspace();
  const scan = scanWorkspace({ id: 't', name: 't', root: ws });
  check(scan.input.layout === 'input' && scan.input.converted.length === 2, '没迁移的工作空间按旧布局列出产物');
  // 有人先建了个空的 output/converted/：不能把旧产物整栏藏掉
  mkdirSync(path.join(ws, 'output/converted'), { recursive: true });
  writeFileSync(path.join(ws, 'output/converted/.gitkeep'), '');
  const scan2 = scanWorkspace({ id: 't', name: 't', root: ws });
  check(scan2.input.layout === 'input' && scan2.input.converted.length === 2, '空的 output/converted/ 不抢旧产物');
  const r = migrate(ws);
  check(r.code === 0 && existsSync(path.join(ws, 'output/converted/需求调研/方案 (终版).md')), '目标只有占位文件时照常迁移', r.out);
  rmSync(ws, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
