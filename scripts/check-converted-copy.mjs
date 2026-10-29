#!/usr/bin/env node
/**
 * 转换产物复制到产出（templates/pm-aispace/scripts/copy_converted.py）的回归：
 * 把合成工作空间拷到临时目录，先预览、再执行，断言落点保留子目录、链接按新位置重算、
 * front-matter 留痕、冲突不覆盖、不合法来源被拒，转换产物根一个字节都不变。
 *
 *     node scripts/check-converted-copy.mjs        （pnpm test:converted-copy）
 *
 * 为什么要有它：模板 Python 脚本没有静态检查；它是看板第十二条写入例外背后真正写盘的那一方。
 * 语料全部合成，说明见 fixtures/converted-copy/README.md。
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docKeyOf, findDocByKey } from '../src/server/scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'templates', 'pm-aispace', 'scripts');
const FIXTURE = path.join(ROOT, 'fixtures', 'converted-copy', 'workspace');
const SRC = 'output/converted/资料A/子目录/说明.md';
const APPENDIX = 'output/converted/资料A/子目录/附录.md';

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

const read = (ws, rel) => readFileSync(path.join(ws, rel), 'utf8');

function freshWorkspace() {
  const ws = mkdtempSync(path.join(tmpdir(), 'check-converted-copy-'));
  cpSync(FIXTURE, ws, { recursive: true });
  mkdirSync(path.join(ws, 'scripts'));
  for (const name of ['copy_converted.py', 'layout.py']) cpSync(path.join(SCRIPTS, name), path.join(ws, 'scripts', name));
  // 图片不入库：运行时放两个占位文件，链接重算只看文件在不在
  mkdirSync(path.join(ws, 'input', 'assets', '说明'), { recursive: true });
  for (const name of ['p1.png', 'p2.png']) writeFileSync(path.join(ws, 'input', 'assets', '说明', name), 'placeholder');
  return ws;
}

function run(ws, source, to, mode) {
  const r = spawnSync(PY, [...PY_PRE, path.join(ws, 'scripts', 'copy_converted.py'), '--source', source, '--to', to, mode, '--json'], {
    // 不写 __pycache__：「预览不改任何文件」按整个工作空间的快照比
    cwd: ws, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  const last = (r.stdout || '').trim().split(/\r?\n/).pop() || '';
  let json = null;
  try { json = JSON.parse(last); } catch { /* 下面按退出码判 */ }
  return { code: r.status, json, err: r.stderr };
}

/** 目录下所有文件（含隐藏文件）的 相对路径 → 内容 */
function snapshot(dir, base = dir, out = new Map()) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) snapshot(abs, base, out);
    else out.set(path.relative(base, abs).split(path.sep).join('/'), readFileSync(abs, 'latin1'));
  }
  return out;
}

function sameSnapshot(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

const hiddenTmp = (dir) => [...snapshot(dir).keys()].filter((p) => /(^|\/)\.[^/]*\.copy-[^/]*\.tmp$/.test(p));

// ---------------------------------------------------------------- 1. 预览
console.log('预览');
{
  const ws = freshWorkspace();
  const before = snapshot(ws);
  const r = run(ws, SRC, 'docs', '--dry-run');
  check(r.code === 0 && r.json?.ok, '预览退出 0', r.err);
  check(r.json?.target === 'output/docs/资料A/子目录/说明.md', '落点保留子目录', r.json?.target);
  check(r.json?.conflict === false, '没有冲突');
  // 附录.md 与 ./附录.md#第二节 两处要重算；指向 input/assets 的两张图同深度不用改
  check(r.json?.rewrittenLinks === 2, '要重算 2 处链接', String(r.json?.rewrittenLinks));
  check(sameSnapshot(before, snapshot(ws)), '预览不改任何文件');
  rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 2. 执行
console.log('执行');
{
  const ws = freshWorkspace();
  const convertedBefore = snapshot(path.join(ws, 'output', 'converted'));
  const assetsBefore = snapshot(path.join(ws, 'input', 'assets'));
  const r = run(ws, SRC, 'docs', '--apply');
  check(r.code === 0 && r.json?.ok, '执行退出 0', r.err);
  const dst = 'output/docs/资料A/子目录/说明.md';
  check(existsSync(path.join(ws, dst)), '复制件在落点');
  const text = existsSync(path.join(ws, dst)) ? read(ws, dst) : '';
  check(text.includes(`copied_from: ${SRC}\n`), 'front-matter 有 copied_from');
  check(/\ncopied_at: \d{4}-\d{2}-\d{2}T/.test(text), 'front-matter 有 copied_at');
  check(text.includes('source: input/raw/资料A/子目录/说明.docx\n') && text.includes('source_sha256: 0000'), 'source / source_sha256 保留');
  check(/^---\n[\s\S]*?converted_by: synthetic\ncopied_from:/.test(text), '留痕追加在原有字段之后、同一段 front-matter 里');
  check(text.includes('![图一](../../../../input/assets/说明/p1.png)'), 'Markdown 图片在新位置照样指到原图，写法不变');
  check(text.includes('<img src="../../../../input/assets/说明/p2.png"'), '<img> 图片写法不变');
  check(text.includes('[附录](../../../converted/资料A/子目录/附录.md)'), '同目录产物链接按新位置重算');
  check(text.includes('[附录第二节](../../../converted/资料A/子目录/附录.md#第二节)'), '带锚点的链接重算后锚点保留');
  check(text.includes('[示例站](https://example.com/a.md)'), '外链不改');
  check(text.includes('[本页锚点](#第二节)'), '锚点不改');
  check(text.includes('[不存在的文件](不存在.md)'), '指向不存在文件的链接不改');
  check(text.includes('代码块里的 ![不改](附录.md) 原样保留'), '代码块里的链接不改');
  check(sameSnapshot(convertedBefore, snapshot(path.join(ws, 'output', 'converted'))), '转换产物根一个字节都不变');
  check(sameSnapshot(assetsBefore, snapshot(path.join(ws, 'input', 'assets'))), 'input/assets 没多出文件');
  check(hiddenTmp(path.join(ws, 'output')).length === 0, '没有残留临时文件');

  // 看板反查：复制件不该进 converted-md 的范围，原件的键照样查得到
  check(findDocByKey(ws, 'converted-md', docKeyOf(SRC)) === SRC, '原件的 docKey 照样反查得到');
  check(findDocByKey(ws, 'converted-md', docKeyOf(dst)) === null, '复制件不在转换产物 docKey 范围里');

  // 冲突：再复制一次
  const kept = read(ws, dst);
  const again = run(ws, SRC, 'docs', '--apply');
  check(again.code === 2 && again.json?.kind === 'conflict', '落点已存在时退出码 2、kind=conflict', `${again.code} ${again.json?.kind}`);
  check(read(ws, dst) === kept, '冲突时已有文件不变');
  check(hiddenTmp(path.join(ws, 'output')).length === 0, '冲突后没有残留临时文件');
  const pre = run(ws, SRC, 'docs', '--dry-run');
  check(pre.code === 0 && pre.json?.conflict === true && pre.json?.conflictPath === dst, '预览标出冲突与已存在的路径', JSON.stringify(pre.json));

  // 没有 front-matter 的来源 → 决策记录
  const r2 = run(ws, APPENDIX, 'decisions', '--apply');
  check(r2.code === 0, '没有 front-matter 的来源也能复制', r2.err);
  const t2 = read(ws, 'output/decisions/资料A/子目录/附录.md');
  check(t2.startsWith(`---\ncopied_from: ${APPENDIX}\ncopied_at: `) && t2.includes('\n---\n\n# 合成附录'), '新建一段 front-matter');
  check(t2.includes('[回到说明](../../../converted/资料A/子目录/说明.md)'), '附录里的回链也重算');
  rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 3. 中间目录被同名文件占着
console.log('中间目录被占');
{
  const ws = freshWorkspace();
  writeFileSync(path.join(ws, 'output', 'analysis', '资料A'), 'not a dir');
  const pre = run(ws, SRC, 'analysis', '--dry-run');
  check(pre.json?.conflict === true && pre.json?.conflictPath === 'output/analysis/资料A', '预览标出占位的文件', JSON.stringify(pre.json));
  const r = run(ws, SRC, 'analysis', '--apply');
  check(r.code === 2 && r.json?.kind === 'conflict', '执行退出码 2', `${r.code}`);
  check(read(ws, 'output/analysis/资料A') === 'not a dir', '占位文件不变');
  rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 4. 不合法的来源与组
console.log('拒绝');
{
  const ws = freshWorkspace();
  const before = snapshot(ws);
  const cases = [
    ['output/converted/资料A/子目录/_manifest_表.md', 'docs', '摘要'],
    ['output/converted/资料A/子目录/SplittingObject/表/正文.md', 'docs', 'SplittingObject 里的正文'],
    ['output/converted/资料A/子目录/数据.csv', 'docs', '非 .md'],
    ['output/docs/.gitkeep', 'docs', '转换产物根外的文件'],
    ['output/converted/../converted/资料A/子目录/说明.md', 'docs', '带 .. 的路径'],
    ['output/converted/资料A/子目录/不存在.md', 'docs', '不存在的文件'],
    [SRC, 'delivery', '组名不合法'],
    [SRC, 'converted', '组名是 converted'],
  ];
  for (const [source, to, label] of cases) {
    const r = run(ws, source, to, '--apply');
    check(r.code === 1 && r.json?.ok === false, `${label}：退出码 1`, `${r.code} ${r.json?.error || r.err}`);
  }
  check(sameSnapshot(before, snapshot(ws)), '被拒时不写盘');
  rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 5. 旧布局 input/converted/
console.log('旧布局');
{
  const ws = freshWorkspace();
  mkdirSync(path.join(ws, 'input', 'converted'), { recursive: true });
  renameSync(path.join(ws, 'output', 'converted', '资料A'), path.join(ws, 'input', 'converted', '资料A'));
  const legacy = 'input/converted/资料A/子目录/说明.md';
  const refused = run(ws, SRC, 'docs', '--dry-run');
  check(refused.code === 1, '旧布局下 output/converted 的路径不认');
  const r = run(ws, legacy, 'docs', '--apply');
  check(r.code === 0 && r.json?.target === 'output/docs/资料A/子目录/说明.md', '旧布局来源落到同一个落点', r.err);
  const text = read(ws, 'output/docs/资料A/子目录/说明.md');
  check(text.includes('[附录](../../../../input/converted/资料A/子目录/附录.md)'), '链接指回旧布局的原件');
  check(text.includes(`copied_from: ${legacy}\n`), 'copied_from 写旧布局路径');
  check(statSync(path.join(ws, 'input', 'converted', '资料A', '子目录', '说明.md')).isFile(), '原件还在');
  rmSync(ws, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n${failed} 项没通过`);
  process.exit(1);
}
console.log('\n全部通过');
