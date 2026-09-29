#!/usr/bin/env node
/**
 * docx 工具链的回归：在临时工作空间里跑 生成语料 → collect → build → md2docx → collect 反查。
 *
 *     node scripts/check-docx.mjs        （pnpm test:docx）
 *
 * 为什么要有它：templates/pm-aispace/scripts/ 下的 Python 脚本没有任何静态检查，
 * 样式层叠又是「改一处、别处悄悄变」的重灾区（docDefaults、表格样式、beforeLines 的优先级）。
 * 这里断言的是**结果**：关键角色在成品里的实际生效格式、报告里没有正文、生成标记存在、
 * 没有标记的同名文件不会被覆盖。
 *
 * 语料全部合成：fixtures/docx-template/make_messy_docx.py 现生成一份「格式很乱的旧文档」，
 * 固定决定在 fixtures/docx-template/decisions.json。真实客户文档不入库。
 * 本机没有 pandoc 3 时只跳过转换那几段，并如实打印出来，不算失败。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'templates', 'pm-aispace', 'scripts');
const FIXTURES = path.join(ROOT, 'fixtures', 'docx-template');
const SENTINEL = '合成语料哨兵句';

// 返回解释器的绝对路径：「缺 pandoc」那条断言会把子进程的 PATH 换掉，按名字就找不到 Python 了
function findPython() {
  for (const [cmd, pre] of [['python3', []], ['python', []], ['py', ['-3']]]) {
    const r = spawnSync(cmd, [...pre, '-c', 'import sys; print(sys.version_info[0], sys.executable)'], { encoding: 'utf8' });
    const [major, exe] = (r.stdout || '').trim().split(' ');
    if (r.status === 0 && major === '3') return [exe, []];
  }
  console.error('找不到 Python 3');
  process.exit(1);
}
const [PY, PY_PRE] = findPython();

const ws = mkdtempSync(path.join(tmpdir(), 'check-docx-'));
let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { failed += 1; console.error(`  ✗ ${msg}`); };
const check = (cond, msg, detail = '') => (cond ? ok(msg) : fail(detail ? `${msg}：${detail}` : msg));

/** 跑工作空间脚本，返回 { code, result }（result = 最后一行 JSON）。 */
function run(script, args, { input, env } = {}) {
  const r = spawnSync(PY, [...PY_PRE, path.join(ws, 'scripts', script), ...args, '--json'], {
    cwd: ws, input, encoding: 'utf8', env: { ...process.env, ...env },
  });
  const last = (r.stdout || '').trim().split('\n').pop();
  let result = null;
  try { result = JSON.parse(last); } catch { /* 下面按 null 处理 */ }
  if (!result) console.error(r.stdout, r.stderr);
  return { code: r.status, result };
}

/** 用工作空间里的 docxkit 反查一份 docx：每个角色的期望 / 实际格式。 */
function inspect(docx, profilePath) {
  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(ws, 'scripts'))})
from pathlib import Path
from docxkit.spec import merged, effective
from docxkit.verify import verify
from docxkit.ooxml import marker_of
prof = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8')) if sys.argv[2] else None
spec = merged({k: v for k, v in (prof or {}).items() if not k.startswith('_')})
w, d = verify(Path(sys.argv[1]), spec)
print(json.dumps({'warnings': w, 'marker': marker_of(Path(sys.argv[1])),
  'eff': {r: effective(spec, r) for r in ('BodyText', 'Heading1', 'Table')}}, ensure_ascii=False))
`;
  const out = execFileSync(PY, [...PY_PRE, '-c', code, docx, profilePath || ''], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

try {
  // 临时工作空间：只拷工具链，模拟新建工作空间里的 scripts/
  mkdirSync(path.join(ws, 'scripts'), { recursive: true });
  for (const f of ['docx_template.py', 'md2docx.py']) cpSync(path.join(SCRIPTS, f), path.join(ws, 'scripts', f));
  cpSync(path.join(SCRIPTS, 'docxkit'), path.join(ws, 'scripts', 'docxkit'), {
    recursive: true, filter: (src) => !src.includes('__pycache__'),
  });
  mkdirSync(path.join(ws, 'input', 'raw'), { recursive: true });
  mkdirSync(path.join(ws, 'output', 'docs'), { recursive: true });
  const src = path.join(ws, 'input', 'raw', '旧文档.docx');
  execFileSync(PY, [...PY_PRE, path.join(FIXTURES, 'make_messy_docx.py'), src]);

  const pandoc = spawnSync('pandoc', ['--version'], { encoding: 'utf8' });
  const hasPandoc = pandoc.status === 0 && Number((pandoc.stdout.match(/pandoc(?:\.exe)?\s+(\d+)/) || [])[1]) >= 3;
  console.log(hasPandoc ? `pandoc：${pandoc.stdout.split('\n')[0]}` : 'pandoc：未找到 3 以上版本，跳过转换相关断言');

  console.log('采集');
  const tdir = path.join(ws, 'output', 'docx-template', '回归');
  let r = run('docx_template.py', ['collect', 'input/raw/旧文档.docx', '--name', '回归']);
  check(r.code === 0 && r.result?.ok, 'collect 成功', JSON.stringify(r.result));
  const reportText = readFileSync(path.join(tdir, 'collect', 'report.json'), 'utf8');
  const report = JSON.parse(reportText);
  check(!reportText.includes(SENTINEL), 'report.json 不含正文');
  check(!readFileSync(path.join(tdir, 'collect', 'paragraphs.jsonl'), 'utf8').includes(SENTINEL), 'paragraphs.jsonl 不含正文');
  check(report.styles.total === 100 && report.styles.unused > 80, '识别出大量无效样式', JSON.stringify(report.styles));
  const h1 = report.clusters.find((c) => c.suggestedRole === 'Heading1');
  check(h1 && h1.fmt.size === 14 && h1.styleDefined?.size === 22 && h1.mismatch.includes('size'),
    '一级标题以实际显示 14pt 为准，并标出样式定义 22pt 不一致', JSON.stringify(h1?.fmt));
  check(report.clusters.some((c) => c.pseudoHeading), '识别出伪标题');
  const lines = report.clusters.filter((c) => c.suggestedRole === 'BodyText').map((c) => `${c.fmt.line}:${c.count}`);
  check(lines.includes('1:18') && lines.includes('1.5:9'), '正文两种行距都采到（单倍 18 段 / 1.5 倍 9 段）', lines.join(' '));
  check(report.tables.total === 3 && Object.keys(report.tables.borderKinds).length === 3, '三种表格边框');

  r = run('docx_template.py', ['collect', 'input/raw/旧文档.docx', '--name', '回归']);
  check(r.code === 3 && r.result?.kind === 'name-taken', '重名且没有 --regenerate 时退出码 3');
  r = run('docx_template.py', ['collect', 'input/raw/旧文档.docx', '--name', '../越界']);
  check(r.code === 2 && r.result?.kind === 'bad-name', '非法模板名退出码 2');

  console.log('生成模板');
  const decisions = readFileSync(path.join(FIXTURES, 'decisions.json'), 'utf8');
  r = run('docx_template.py', ['build', '--name', '回归', '--source', 'input/raw/旧文档.docx', '--decisions', '-'],
    { input: '{"clusters": {"c1": {"role": "BodyText"}}, "sourcePath": "x"}' });
  check(r.code === 2 && r.result?.kind === 'bad-decisions', '决定里带路径类字段时拒绝');
  r = run('docx_template.py', ['build', '--name', '回归', '--source', 'input/raw/旧文档.docx', '--decisions', '-'], { input: decisions });
  check(r.code === 0 && r.result?.ok, 'build 成功', JSON.stringify(r.result));
  for (const f of ['profile.json', 'reference.docx', 'spec.md']) check(existsSync(path.join(tdir, f)), `写出 ${f}`);
  const profilePath = path.join(tdir, 'profile.json');
  const refInfo = inspect(path.join(tdir, 'reference.docx'), profilePath);
  check(refInfo.marker, 'reference.docx 带生成标记');
  check(refInfo.eff.BodyText.size === 14 && refInfo.eff.BodyText.line === 1.5,
    '正文 14pt、行距按决定取 1.5 倍（默认会取段数多的单倍）', JSON.stringify(refInfo.eff.BodyText));
  check(refInfo.eff.Table.size === 10.5, '表格文字 10.5pt 压过正文 14pt', JSON.stringify(refInfo.eff.Table));
  check(refInfo.eff.Heading1.eastAsia === '仿宋_GB2312' && refInfo.eff.Heading1.size === 14, '一级标题沿用客户实际格式');
  const specMd = readFileSync(path.join(tdir, 'spec.md'), 'utf8');
  check(specMd.includes('由通用规范补齐') && /Source Code.*由通用规范补齐/.test(specMd), 'spec.md 标出由通用规范补齐的角色');
  if (hasPandoc) {
    check(existsSync(path.join(tdir, 'sample.docx')), '写出 sample.docx');
    check((r.result.warnings || []).length === 0, '样张反查无 warnings', (r.result.warnings || []).join('；'));
  } else {
    check((r.result.warnings || []).some((w) => w.includes('跳过样张')), '没有 pandoc 时跳过样张并说明');
  }
  r = run('docx_template.py', ['build', '--name', '回归', '--source', 'input/raw/旧文档.docx']);
  check(r.code === 3, '已生成的模板不带 --regenerate 不覆盖');

  const noPandoc = { PANDOC_BIN: path.join(ws, 'no-pandoc'), PATH: path.dirname(process.execPath) };
  run('docx_template.py', ['collect', 'input/raw/旧文档.docx', '--name', '无pandoc']);
  r = run('docx_template.py', ['build', '--name', '无pandoc', '--source', 'input/raw/旧文档.docx'], { env: noPandoc });
  const npDir = path.join(ws, 'output', 'docx-template', '无pandoc');
  check(r.code === 0 && existsSync(path.join(npDir, 'reference.docx')) && !existsSync(path.join(npDir, 'sample.docx'))
    && (r.result.warnings || []).some((w) => w.includes('跳过样张')), '缺 pandoc 时照常生成模板，只跳过样张并说明');

  console.log('转换');
  const docs = path.join(ws, 'output', 'docs');
  cpSync(path.join(SCRIPTS, 'docxkit', 'sample.md'), path.join(docs, 'a.md'));
  cpSync(path.join(SCRIPTS, 'docxkit', 'diagram.png'), path.join(docs, 'diagram.png'));
  writeFileSync(path.join(docs, 'hand.md'), '# 合成\n\n正文。\n');
  cpSync(src, path.join(docs, 'hand.docx'));
  const handHash = sha(path.join(docs, 'hand.docx'));
  r = run('md2docx.py', ['output/docs/hand.md', '--template', '回归', '--overwrite']);
  check(r.code === 3 && r.result?.kind === 'not-generated' && sha(path.join(docs, 'hand.docx')) === handHash,
    '没有生成标记的同名文件：加 --overwrite 也拒绝，原文件不变');

  r = run('md2docx.py', ['output/docs/a.md', '--template', '@base'], { env: noPandoc });
  check(r.code === 4 && r.result?.kind === 'no-pandoc' && !existsSync(path.join(docs, 'a.docx')),
    '缺 pandoc：退出码 4，不生成半成品');

  if (hasPandoc) {
    r = run('md2docx.py', ['output/docs/a.md', '--template', '回归']);
    check(r.code === 0 && r.result?.ok, '按客户模板转换成功', JSON.stringify(r.result));
    const out = inspect(path.join(docs, 'a.docx'), profilePath);
    check(out.marker, '成品带生成标记');
    check(out.warnings.length === 0, '成品各角色格式与规范一致', out.warnings.join('；'));
    r = run('md2docx.py', ['output/docs/a.md', '--template', '回归']);
    check(r.code === 3 && r.result?.kind === 'exists', '成品已存在、不带 --overwrite 时拒绝');
    r = run('md2docx.py', ['output/docs/a.md', '--template', '@base', '--overwrite']);
    check(r.code === 0 && r.result?.overwritten, '带生成标记的成品可以覆盖');
    const base = inspect(path.join(docs, 'a.docx'), null);
    check(base.warnings.length === 0, '通用规范成品各角色格式与规范一致', base.warnings.join('；'));
    check(base.eff.BodyText.size === 12, '通用规范正文 12pt');
  }
} finally {
  rmSync(ws, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n${failed} 项断言失败`);
  process.exit(1);
}
console.log('\n全部通过');
