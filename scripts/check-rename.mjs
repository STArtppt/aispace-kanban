#!/usr/bin/env node
/**
 * 产出原稿重命名（templates/pm-aispace/scripts/rename_output.py）的回归：
 * 把合成工作空间拷到临时目录，先预览、再执行，断言文件、交付稿镜像、各类引用都跟到新路径，
 * 不该动的没动，再用看板的 listDelivery 核对「点开新原稿看到的和改名前一样」。
 *
 *     node scripts/check-rename.mjs        （pnpm test:rename）
 *
 * 为什么要有它：改名一次跨十几个文件，链接识别规则要和看板渲染器对齐；模板 Python 脚本没有静态检查。
 * 语料全部合成，说明见 fixtures/rename/README.md。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDelivery } from '../src/server/deai.mjs';
import { docKeyOf } from '../src/server/scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'templates', 'pm-aispace', 'scripts', 'rename_output.py');
const FIXTURE = path.join(ROOT, 'fixtures', 'rename', 'workspace');

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

function read(ws, rel) {
  return readFileSync(path.join(ws, rel), 'utf8');
}

/** 拷语料，把交付稿里的摘要占位符换成真值：改名前「原稿未变更」「没被直接改过」都成立 */
function freshWorkspace() {
  const ws = mkdtempSync(path.join(tmpdir(), 'check-rename-'));
  cpSync(FIXTURE, ws, { recursive: true });
  mkdirSync(path.join(ws, 'scripts'));
  cpSync(SCRIPT, path.join(ws, 'scripts', 'rename_output.py'));
  const shas = {
    __SHA_实施方案__: sha16(read(ws, 'output/docs/实施方案.md')),
    __SHA_分析B__: sha16(read(ws, 'output/analysis/2026-09-01-分析B.md')),
  };
  for (const dir of ['output/delivery/docs/实施方案', 'output/delivery/analysis/2026-09-01-分析B']) {
    for (const name of readdirSync(path.join(ws, dir))) {
      if (!/^v\d{3}\.md$/.test(name)) continue;
      const rel = `${dir}/${name}`;
      let text = read(ws, rel);
      for (const [k, v] of Object.entries(shas)) text = text.replaceAll(k, v);
      text = text.replace('__BODY__', sha16(bodyOf(text)));
      writeFileSync(path.join(ws, rel), text);
    }
  }
  return ws;
}

function run(ws, ...args) {
  const r = spawnSync(PY, [...PY_PRE, path.join(ws, 'scripts', 'rename_output.py'), ...args, '--json'], {
    // 不写 __pycache__：「预览不改任何文件」按整个工作空间的快照比
    cwd: ws, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  const last = (r.stdout || '').trim().split(/\r?\n/).pop() || '';
  let json = null;
  try { json = JSON.parse(last); } catch { /* 下面按退出码判 */ }
  return { code: r.status, json, err: r.stderr };
}

function preview(ws, source, to) {
  return run(ws, '--source', source, '--to', to, '--dry-run');
}

function rename(ws, source, to) {
  const p = preview(ws, source, to);
  if (p.code !== 0) return p;
  return run(ws, '--source', source, '--to', to, '--apply', '--expect', p.json.plan);
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

function sameSnapshot(a, b, ignore = () => false) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => !ignore(k) && a.get(k) !== b.get(k));
}

// ---------------------------------------------------------------- 预览

console.log('预览');
{
  const ws = freshWorkspace();
  const before = snapshot(ws);
  const p = preview(ws, 'output/docs/实施方案.md', '01实施方案');
  check(p.code === 0 && p.json?.ok, '预览成功', p.err);
  check(sameSnapshot(before, snapshot(ws)).length === 0, '预览不改任何文件');
  check(/^[0-9a-f]{16}$/.test(p.json?.plan || ''), '给出 16 位指纹');
  const files = new Map((p.json?.files || []).map((f) => [f.path, f]));
  check(p.json?.links > 0 && p.json?.linkFiles > 0, `报出 ${p.json?.linkFiles} 个文件中的 ${p.json?.links} 处链接`);
  check(files.get('output/records/I0004.md')?.flow === true, '清单里标出记录的改名留痕');
  check(files.get('output/delivery/analysis/2026-09-01-分析B/v001.md')?.sourceSha === true, '清单里标出 source_sha 跟进');
  check(files.get('output/delivery/docs/实施方案/v001.md')?.links === 1, '交付稿只数 front-matter 的 source 一处（正文命中不列）');
  check(!files.has('AGENTS.md') && ![...files.keys()].some((k) => /^(input|visualization|\.claude|output\/converted)\//.test(k)),
    '排除范围里的命中不出现在清单');
  rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 拒绝的情形

console.log('拒绝');
{
  const ws = freshWorkspace();
  const before = snapshot(ws);
  for (const bad of ['a/b', '..x', '.x', 'a\\b', 'a|b', '一次归档', '实施方案', '']) {
    const r = preview(ws, 'output/docs/实施方案.md', bad);
    check(r.code === 2 && r.json?.kind === 'invalid', `新名字「${bad}」退出码 2`, `${r.code} ${r.json?.kind}`);
  }
  for (const src of ['input/raw/说明.md', 'output/converted/摘录.md', 'output/docs/../docs/实施方案.md',
    'output/delivery/docs/实施方案/v001.md', 'output/docs/一次归档/README.md']) {
    const r = preview(ws, src, 'x');
    check(r.code === 2, `来源 ${src} 被拒`, String(r.code));
  }
  const c = preview(ws, 'output/docs/实施方案.md', '同目录');
  check(c.code === 2 && c.json?.kind === 'conflict', '新名字已被占用：退出码 2、kind=conflict', `${c.code} ${c.json?.kind}`);
  mkdirSync(path.join(ws, 'output/delivery/docs/占用'), { recursive: true });
  const c2 = preview(ws, 'output/docs/实施方案.md', '占用');
  check(c2.code === 2 && c2.json?.kind === 'conflict', '新镜像目录已存在：冲突');
  rmSync(path.join(ws, 'output/delivery/docs/占用'), { recursive: true });

  const wrong = run(ws, '--source', 'output/docs/实施方案.md', '--to', '01实施方案', '--apply', '--expect', '0000000000000000');
  check(wrong.code === 3 && wrong.json?.kind === 'stale', '指纹不符：退出码 3');

  const p = preview(ws, 'output/docs/实施方案.md', '01实施方案');
  writeFileSync(path.join(ws, 'output/questions/Q0001.md'), `${read(ws, 'output/questions/Q0001.md')}\n补了一句。\n`);
  const after = snapshot(ws);
  const stale = run(ws, '--source', 'output/docs/实施方案.md', '--to', '01实施方案', '--apply', '--expect', p.json.plan);
  check(stale.code === 3, '预览之后引用文件被改：退出码 3');
  check(sameSnapshot(after, snapshot(ws)).length === 0, '拒绝时磁盘无变化');
  check(sameSnapshot(before, after, (k) => k === 'output/questions/Q0001.md').length === 0, '各类拒绝都没动别的文件');
  rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 执行

console.log('执行');
{
  const ws = freshWorkspace();
  const before = snapshot(ws);
  const oldKey = docKeyOf('output/docs/实施方案.md');
  const deliveryBefore = listDelivery(ws, oldKey);
  const bBefore = listDelivery(ws, docKeyOf('output/analysis/2026-09-01-分析B.md'));

  const r = rename(ws, 'output/docs/实施方案.md', '01实施方案');
  check(r.code === 0 && r.json?.ok, '执行成功', r.err);
  check(!existsSync(path.join(ws, 'output/docs/实施方案.md')) && existsSync(path.join(ws, 'output/docs/01实施方案.md')), '原稿改名');
  check(read(ws, 'output/docs/01实施方案.md') === before.get('output/docs/实施方案.md'), '原稿内容一个字节不变');
  const mirror = 'output/delivery/docs/01实施方案';
  check(!existsSync(path.join(ws, 'output/delivery/docs/实施方案')) && existsSync(path.join(ws, mirror)), '镜像目录改名');
  check(existsSync(path.join(ws, `${mirror}/01实施方案.docx`)) && !existsSync(path.join(ws, `${mirror}/实施方案.docx`)), '镜像里的 <基名>.docx 改名');
  check(['v001.md', 'v002.md', 'v002.docx', '定稿.md', '定稿.assets/img1.png', '实施方案-202609011200.docx']
    .every((f) => existsSync(path.join(ws, `${mirror}/${f}`))), '镜像里其余文件名字不变');
  check(readdirSync(ws, { recursive: true }).every((f) => !String(f).includes('.rename-')), '不留临时文件');

  // 交付稿：front-matter 跟进，正文不动
  for (const v of ['v001', 'v002']) {
    const text = read(ws, `${mirror}/${v}.md`);
    const old = before.get(`output/delivery/docs/实施方案/${v}.md`);
    check(/^source: output\/docs\/01实施方案\.md$/m.test(text), `${v} 的 source 跟进`);
    check(bodyOf(text) === bodyOf(old), `${v} 正文一个字不改（含正文里的旧路径与 wikilink）`);
  }
  const final = read(ws, `${mirror}/定稿.md`);
  check(final.includes('source: output/docs/01实施方案.md') && final.includes(`docx: ${mirror}/实施方案-202609011200.docx`),
    '定稿 source / docx 跟进（docx 只换目录名）');

  // 记录、批注、问题
  const rec = read(ws, 'output/records/I0004.md');
  check(/^target: output\/docs\/01实施方案\.md$/m.test(rec), '记录 target 跟进');
  check(/^status: revising$/m.test(rec), '记录 status 不变');
  check(rec.includes('建立记录，初稿 output/docs/实施方案.md 完成。'), '状态流水里的历史条目不改写');
  check(/### \d{4}-\d{2}-\d{2} · revising\n\n改名：`output\/docs\/实施方案\.md` → `output\/docs\/01实施方案\.md`/.test(rec),
    '状态流水末尾追加改名留痕');
  const notes = read(ws, 'output/records/notes/I0004.md');
  check(notes.includes(`- 对象：${mirror}/v002.md`) && notes.includes('- 对象：output/docs/01实施方案.md'), '批注 `- 对象：` 两种都跟进');
  const q = read(ws, 'output/questions/Q0001.md');
  check(q.includes('source: output/docs/01实施方案.md') && q.includes('  - output/docs/01实施方案.md#范围'), '问题 source / flows_to#锚点 跟进');
  check(read(ws, 'project.yaml').includes('  - output/docs/01实施方案.md'), 'project.yaml 跟进');

  // 正文链接
  const b = read(ws, 'output/analysis/2026-09-01-分析B.md');
  for (const s of ['[方案](../docs/01实施方案.md#范围)', '[方案](<../docs/01实施方案.md>)', '[[../docs/01实施方案#范围|方案]]',
    '[[output/docs/01实施方案]]', '`output/docs/01实施方案.md`', `\`${mirror}/v002.md\``]) {
    check(b.includes(s), `改写为 ${s}`);
  }
  check(b.includes('https://example.com/output/docs/实施方案.md') && b.includes('实施方案的范围很大'), '外链与同名词语不动');
  const same = read(ws, 'output/docs/同目录.md');
  for (const s of ['[[01实施方案]]', '[[01实施方案.md|方案正文]]', '![[01实施方案]]']) check(same.includes(s), `同目录 wikilink 改写为 ${s}`);
  check(same.includes('实施方案要在九月前评审') && same.includes('output/docs/实施方案.mdx') && same.includes('output/docs/实施方案.md.bak')
    && same.includes('[[实施方案二期]]'), '同名词语、相似路径不误改');
  check(read(ws, 'output/docs/子目录/x.md').includes('[方案](../01实施方案.md)'), '子目录相对链接跟进');

  // 排除范围一个字节不变
  for (const k of ['AGENTS.md', '.claude/rules/history.md', 'input/raw/说明.md', 'output/converted/摘录.md', 'visualization/prototypes/demo/index.md']) {
    check(read(ws, k) === before.get(k), `${k} 不动`);
  }

  // 看板视角：点开新原稿看到的和改名前一样
  const after = listDelivery(ws, docKeyOf('output/docs/01实施方案.md'));
  check(after.versions.length === deliveryBefore.versions.length && after.versions.length === 2, '新原稿看得到全部交付稿版本');
  check(after.versions.every((v) => !v.sourceChanged && !v.directlyEdited), '交付稿不误报「原稿已变更」「被直接改过」');
  check(after.final?.docx?.path === `${mirror}/实施方案-202609011200.docx`, '定稿仍认得出所用 Word');
  check(after.recordId === 'I0004' && after.versions[1].pendingNotes === deliveryBefore.versions[1].pendingNotes, '批注仍挂在交付稿上');
  check(after.sourceDocx?.path === `${mirror}/01实施方案.docx`, '原稿的 Word 成品跟过去');

  const bAfter = listDelivery(ws, docKeyOf('output/analysis/2026-09-01-分析B.md'));
  check(!bBefore.versions[0].sourceChanged && !bAfter.versions[0].sourceChanged, '其他原稿 B 的交付稿 v001 不误报已变更（source_sha 跟进）');
  check(bAfter.versions[1].sourceChanged && read(ws, 'output/delivery/analysis/2026-09-01-分析B/v002.md').includes('source_sha: 1111111111111111'),
    '本来就对不上的 v002 source_sha 不动');

  // 改回原名：除了记录多出的两条留痕，整个工作空间回到改名前
  const back = rename(ws, 'output/docs/01实施方案.md', '实施方案');
  check(back.code === 0, '改回原名成功', back.err);
  const diff = sameSnapshot(before, snapshot(ws), (k) => k === 'output/records/I0004.md');
  check(diff.length === 0, '改回原名后其余文件与改名前逐字节一致', diff.join(', '));
  check((read(ws, 'output/records/I0004.md').match(/改名：/g) || []).length === 2, '记录里留下两条改名留痕');
  rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 子目录、已归档、非 .md、缺小节

console.log('子目录 / 已归档 / 非 .md');
{
  const ws = freshWorkspace();
  const recordsBefore = readdirSync(path.join(ws, 'output/records')).sort().join(',');

  const n = rename(ws, 'output/docs/子目录/x.md', 'y');
  check(n.code === 0 && existsSync(path.join(ws, 'output/docs/子目录/y.md')), '子目录里的文件原地改名', n.err);
  const rec = read(ws, 'output/records/I0006.md');
  check(/^target: output\/docs\/子目录\/y\.md$/m.test(rec) && /\n## 状态流水\n\n### \d{4}-\d{2}-\d{2} · draft\n\n改名：/.test(rec),
    '记录缺「## 状态流水」时补上这一节再留痕');

  const a = rename(ws, 'output/docs/一次归档/旧稿.md', '旧稿-第一版');
  check(a.code === 0 && existsSync(path.join(ws, 'output/docs/一次归档/旧稿-第一版.md')), '已归档项在归档目录内改名', a.err);
  check(read(ws, 'output/docs/一次归档/README.md').includes('`output/docs/一次归档/旧稿-第一版.md`'), '归档清单里的落点跟进');

  const c = rename(ws, 'output/docs/附件.csv', '01附件');
  check(c.code === 0 && existsSync(path.join(ws, 'output/docs/01附件.csv')), '非 .md 文件改名（扩展名不变）', c.err);
  check(read(ws, 'output/docs/实施方案.md').includes('[附件](01附件.csv)') && read(ws, 'output/docs/同目录.md').includes('`output/docs/01附件.csv`'),
    '指向非 .md 文件的链接跟进');
  check(readdirSync(path.join(ws, 'output/records')).sort().join(',') === recordsBefore, '没有记录的原稿改名不新建记录');
  rmSync(ws, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n${failed} 项未通过`);
  process.exit(1);
}
console.log('\n全部通过');
