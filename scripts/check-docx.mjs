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
 * 加 --front 再生成带封面、签署页、版本表、目录的两种变体；
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

/** 读 docx 里的一个部件（node 没有标准库 zip，借 Python 的 zipfile）。 */
function zipText(docx, part = 'word/document.xml') {
  return execFileSync(PY, [...PY_PRE, '-c',
    'import sys, zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))', docx, part],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
/**
 * docx 里正文与页眉页脚的全部段落文字：每段把所有 run 的文字拼起来（页眉文字常被拆成多个 run，
 * 按 XML 原样搜会漏掉，11.8 自查就是这样漏的）。「不含原文」一律在这上面搜。
 */
function paraTexts(docx) {
  const code = `
import html, json, re, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
out = {}
for n in z.namelist():
    if re.match(r"word/(.*-)?(document|header|footer)[^/]*\\.xml$", n):
        paras, cur = [], []
        for m in re.finditer(r"<w:t(?:\\s[^>]*)?>([^<]*)</w:t>|</w:p>", z.read(n).decode("utf-8")):
            if m.group(0) == "</w:p>":
                paras.append("".join(cur)); cur = []
            else:
                cur.append(html.unescape(m.group(1)))
        out[n] = paras
print(json.dumps(out, ensure_ascii=False))
`;
  return JSON.parse(execFileSync(PY, [...PY_PRE, '-c', code, docx], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}
const flat = (docx) => Object.values(paraTexts(docx)).flat();
const headerParas = (docx) => Object.entries(paraTexts(docx)).filter(([n]) => /header|footer/.test(n)).flatMap(([, p]) => p);
const sectCount = (xml) => (xml.match(/<w:sectPr\b/g) || []).length;
/** 某段文字前面最近的一个字号（半磅）：用来断言封面字段替换后字号没变。 */
function sizeBefore(xml, text) {
  const at = xml.indexOf(text);
  if (at < 0) return null;
  const all = [...xml.slice(0, at).matchAll(/<w:sz w:val="(\d+)"/g)];
  return all.length ? all[all.length - 1][1] : null;
}

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

    console.log('格式过滤器');
    const log = r.result.log || [];
    check(log.some((l) => l.includes('标题上移一级')) && log.some((l) => /剥离手写编号 6 处/.test(l)),
      '开头唯一的 # 取作文档标题、剥离手写编号', log.join('；'));
    check(log.some((l) => /批注块：4 个/.test(l)) && !zipText(path.join(docs, 'a.docx')).includes('[!'),
      '四种批注块转成提示框，成品里搜不到 [!类型]');
    check(log.some((l) => /解除段中加粗 1 处/.test(l)), '只解除句中加粗，段首标签与列表标签保留', log.join('；'));
    r = run('md2docx.py', ['output/docs/a.md', '--template', '@base', '--overwrite', '--keep-bold']);
    check(r.code === 0 && !(r.result.log || []).some((l) => l.includes('解除段中加粗')), '--keep-bold 时不解除加粗');
    writeFileSync(path.join(docs, 'multi.md'), '# 一\n\n正文。\n\n# 二\n\n# 三\n');
    r = run('md2docx.py', ['output/docs/multi.md', '--template', '@base']);
    check(r.code === 0 && (r.result.warnings || []).some((w) => w.includes('有 3 个一级标题')), '多个 # 时不平移并提醒');

    console.log('表格文字与列表');
    // 11.8 第二轮：客户把列表簇采成 Compact（14pt、首行缩进 2 字、两端对齐），pandoc 给单元格也套 Compact，表格被一起放大
    const compactDec = JSON.parse(decisions);
    compactDec.clusters.c1 = { role: 'Compact' };
    run('docx_template.py', ['collect', 'input/raw/旧文档.docx', '--name', '紧凑']);
    r = run('docx_template.py', ['build', '--name', '紧凑', '--source', 'input/raw/旧文档.docx', '--decisions', '-'],
      { input: JSON.stringify(compactDec) });
    check(r.code === 0 && (r.result.warnings || []).length === 0, 'Compact 带正文格式时样张反查仍无 warnings',
      JSON.stringify(r.result?.warnings));
    r = run('md2docx.py', ['output/docs/a.md', '--template', '紧凑', '--overwrite']);
    const cxml = zipText(path.join(docs, 'a.docx'));
    const cstyles = zipText(path.join(docs, 'a.docx'), 'word/styles.xml');
    const styleOf = (name) => (cstyles.match(new RegExp(`<w:style\\b[^>]*>\\s*<w:name w:val="${name}"\\s*/>.*?</w:style>`, 's')) || [''])[0];
    const tt = styleOf('Table Text');
    const ttId = (tt.match(/w:styleId="([^"]+)"/) || [])[1];
    const cellStyles = [...cxml.matchAll(/<w:tbl>.*?<\/w:tbl>/gs)].flatMap((m) => [...m[0].matchAll(/<w:pStyle w:val="([^"]+)"/g)].map((x) => x[1]));
    check(ttId && cellStyles.length > 0 && cellStyles.every((s) => s === ttId), '表格单元格段落全部改用 Table Text',
      [...new Set(cellStyles)].join(','));
    check(/<w:sz w:val="21"/.test(tt) && /<w:jc w:val="center"/.test(tt) && /w:firstLineChars="0"/.test(tt),
      'Table Text 五号、居中、无首行缩进', tt);
    check((r.result.log || []).some((l) => l.startsWith('表格文字：')), 'log 写明表格文字替换数');
    const cnum = zipText(path.join(docs, 'a.docx'), 'word/numbering.xml');
    const listAbs = [...cnum.matchAll(/<w:abstractNum\b.*?<\/w:abstractNum>/gs)].map((m) => m[0]).filter((b) => !b.includes('<w:pStyle'));
    check(listAbs.length > 0 && listAbs.every((b) => !/w:hanging="[1-9]/.test(b) && b.includes('w:firstLineChars="200"')
      && b.includes('<w:suff w:val="space"/>')), '列表编号没有悬挂缩进：首行缩进、编号后接空格');
    check(/w:leftChars="0"/.test(styleOf('提示框')), '提示框没有左缩进');
  }

  console.log('前置区');
  const FRONT_SENTINEL = '前置哨兵';
  const frontDec = JSON.parse(decisions).front;
  const fsrc = path.join(ws, 'input', 'raw', '带封面.docx');
  execFileSync(PY, [...PY_PRE, path.join(FIXTURES, 'make_messy_docx.py'), fsrc, '--front', 'textbox']);
  const fdir = path.join(ws, 'output', 'docx-template', '前置');
  r = run('docx_template.py', ['collect', 'input/raw/带封面.docx', '--name', '前置']);
  check(r.code === 0 && r.result?.ok, 'collect 带前置区的来源成功', JSON.stringify(r.result));
  const fReportText = readFileSync(path.join(fdir, 'collect', 'report.json'), 'utf8');
  const fr = JSON.parse(fReportText).front;
  check(!fReportText.includes(FRONT_SENTINEL)
    && !readFileSync(path.join(fdir, 'collect', 'paragraphs.jsonl'), 'utf8').includes(FRONT_SENTINEL),
  '报告不含封面、签署页、版本表、目录的原文');
  check(fr && fr.sections.length === 4 && fr.hasToc, '识别出四节前置区与目录域', JSON.stringify(fr?.sections));
  const titleField = fr?.fields.find((f) => f.guess === 'title');
  check(titleField?.inTextbox && titleField.occurrences === 2, '文本框标题与兼容回退副本归为一个字段', JSON.stringify(titleField));
  check(['date', 'client', 'vendor', 'doctype'].every((g) => fr?.fields.some((f) => f.guess === g)), '封面角色都猜到了');
  check(fr?.tables[0]?.defaultRule === 'keepLabels' && fr?.tables[1]?.defaultRule === 'keepHeader',
    '签署页默认保留标签、版本表默认保留表头行', JSON.stringify(fr?.tables));
  const [fDoctype, fTitle, fCont] = fr?.fields || [];
  check(fDoctype?.guess === 'doctype' && fDoctype.size === 26 && fTitle?.guess === 'title' && fTitle.size === 22
    && fCont?.guess === 'clear', '字号最大的是文档类型、次一号的是标题，标题续行猜作「清空」', JSON.stringify(fr?.fields.slice(0, 3)));
  check(fDoctype?.headerHits === 1 && fTitle?.headerHits === 0, '字段带 headerHits（正文页眉里同文 1 处，拆成多个 run 也认）');
  check(fr?.fields.find((f) => f.guess === 'date')?.dateFormat === 'YYYY年M月', '日期字段给出形态标记 dateFormat');
  check(fr?.tables[0]?.rows === 1 && fr.tables[0].cols === 6 && fr.tables[0].captionRows === 0,
    '一行三组签字标签：标签不在首列也判为标签表', JSON.stringify(fr?.tables[0]));
  check(fr?.tables[1]?.captionRows === 1 && fr.tables[1].headerLike, '版本表：数出顶部合并标题行，表头看其后第一行（首列短编号不再误判为标签表）',
    JSON.stringify(fr?.tables[1]));
  check(!JSON.parse(fReportText).clusters.some((c) => c.fmt.size === 22), '前置区段落不参与格式聚类');

  r = run('docx_template.py', ['build', '--name', '前置', '--source', 'input/raw/带封面.docx', '--decisions', '-'],
    { input: JSON.stringify({ front: { ...frontDec, fields: { f99: 'title' } } }) });
  check(r.code === 2 && r.result?.kind === 'bad-decisions', '前置区决定里有报告没有的字段时拒绝');
  r = run('docx_template.py', ['build', '--name', '前置', '--source', 'input/raw/带封面.docx', '--decisions', '-'],
    { input: JSON.stringify({ front: frontDec }) });
  check(r.code === 0 && existsSync(path.join(fdir, 'front.docx')), '生成模板时写出 front.docx', JSON.stringify(r.result));
  const fdoc = zipText(path.join(fdir, 'front.docx'));
  const fflat = flat(path.join(fdir, 'front.docx'));
  check(!fflat.some((t) => t.includes(FRONT_SENTINEL)) && fdoc.includes('{{title}}') && fdoc.includes('{{client}}')
    && fdoc.includes('{{doctype}}'),
  'front.docx 里只有占位符，没有封面、签署页、版本表、目录项的原文（按段拼接 run 后再搜）');
  check((fdoc.match(/<w:sz w:val="44"\/>/g) || []).length === 4 && fflat.filter((t) => t === '{{title}}').length === 2,
    '「清空」的标题续行：段落与字号还在、文字删掉，文本框回退副本里同样');
  check(['编写(签字)：', '审核(签字)：', '批准(签字)：'].every((l) => fflat.includes(l)) && fflat.filter((t) => t === '日期：').length === 3,
    '签署页：三组标签和「日期：」都在，签名与日期的值清空');
  check(fflat.includes('文件版本记录') && fflat.includes('版本说明') && !fflat.some((t) => ['A', 'B', 'C'].includes(t)),
    '版本表：合并标题行与表头保留，样例记录（含首列 A、B、C）清空');
  const refHeader = headerParas(path.join(fdir, 'reference.docx'));
  check(refHeader.includes('合成单位页眉　{{doctype}}') && !refHeader.some((t) => t.includes(FRONT_SENTINEL)),
    'reference.docx 正文页眉：与文档类型同文的部分写成 {{doctype}}，前面的单位名原样', refHeader.join(' | '));
  check(/<w:b\/><\/w:rPr><w:t[^>]*>\{\{doctype\}\}/.test(zipText(path.join(fdir, 'reference.docx'), 'word/header1.xml')),
    '页眉占位符保住原文首个 run 的格式（加粗）');
  check((r.result.log || []).some((l) => l.includes('正文页眉页脚：文档类型 1 处')), 'build 的 log 写明页眉页脚替换处数', (r.result.log || []).join('；'));
  check(fdoc.includes('2025年6月') && fdoc.includes('签署页'), '「保持原样」的段落与模板文字原样保留');
  check(sectCount(fdoc) === fr.sections.length, 'front.docx 的分节数与前置区一致');
  const zipNames = (docx) => execFileSync(PY, [...PY_PRE, '-c',
    'import sys, zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', docx], { encoding: 'utf8' }).trim().split('\n');
  const fnames = zipNames(path.join(fdir, 'front.docx'));
  check(new Set(fnames).size === fnames.length, 'front.docx 里没有重复的 zip 条目（原件自带 custom.xml 时）', fnames.join(' '));
  const fprof = JSON.parse(readFileSync(path.join(fdir, 'profile.json'), 'utf8'));
  check(fprof.front?.fields?.f6 === 'keep' && fprof.front?.tables?.t2 === 'keepHeader' && fprof.front?.sections?.s1 === '封面'
    && fprof.front?.fields?.f3 === 'clear' && !fprof.front.dateFormat,
    'profile.json 带 front 段（字段映射、表格清空规则、分节名）');
  check(readFileSync(path.join(fdir, 'spec.md'), 'utf8').includes('封面字段从哪里取值'), 'spec.md 写明封面字段从哪里取值');
  check(inspect(path.join(fdir, 'front.docx'), null).marker, 'front.docx 带生成标记');

  if (hasPandoc) {
    check((r.result.warnings || []).length === 0, '带前置区的样张反查无 warnings', (r.result.warnings || []).join('；'));
    check(sectCount(zipText(path.join(fdir, 'sample.docx'))) === fr.sections.length + 1, '样张 = 前置区 + 正文');

    const docs = path.join(ws, 'output', 'docs');
    writeFileSync(path.join(ws, 'project.yaml'), 'identity:\n  项目名称: null\n  甲方: 合成甲方单位\n  承建方: null\n');
    cpSync(path.join(SCRIPTS, 'docxkit', 'sample.md'), path.join(docs, 'b.md'));
    r = run('md2docx.py', ['output/docs/b.md', '--template', '前置']);
    check(r.code === 0 && r.result?.ok, '按带前置区的模板转换成功', JSON.stringify(r.result));
    const out = zipText(path.join(docs, 'b.docx'));
    check(sectCount(out) === fr.sections.length + 1, '成品分节数 = 前置区分节数 + 1', String(sectCount(out)));
    check(!out.includes('{{') && out.includes('样张：示例系统需求说明') && out.includes('合成甲方单位'),
      '封面字段已替换（标题取文档标题，客户单位取 project.yaml）');
    check(sizeBefore(out, '样张：示例系统需求说明') === sizeBefore(fdoc, '{{title}}') && sizeBefore(fdoc, '{{title}}') === '44',
      '封面标题替换后字号不变（22pt）');
    check(!flat(path.join(docs, 'b.docx')).some((t) => t.includes(FRONT_SENTINEL)) && out.includes('TOC \\o'),
      '成品（含页眉页脚，按段拼接 run）里没有模板样例原文，目录保留为域');
    check(headerParas(path.join(docs, 'b.docx')).includes('合成单位页眉　【待填：文档类型】'), '正文页眉的文档类型取不到值时同样写「待填」');
    check((r.result.log || []).some((l) => l.includes('project.yaml')), 'log 注明字段取值来源', (r.result.log || []).join('；'));
    check((r.result.warnings || []).some((w) => w.includes('【待填：编制单位】')), '取不到值的字段写「待填」并给 warning');
    check(zipText(path.join(docs, 'b.docx'), 'word/settings.xml').includes('<w:updateFields w:val="true"/>'), '成品打开时提示更新域');

    writeFileSync(path.join(docs, 'c.md'), '---\nclient: 前置覆盖单位\n---\n\n# 合成标题\n\n## 章节\n\n正文。\n');
    r = run('md2docx.py', ['output/docs/c.md', '--template', '前置']);
    const outC = zipText(path.join(docs, 'c.docx'));
    check(r.code === 0 && outC.includes('前置覆盖单位') && !outC.includes('合成甲方单位'), 'md front-matter 优先于 project.yaml');
    writeFileSync(path.join(docs, 'e.md'), '# 合成项目 · 需求调研实施方案\n\n## 章节\n\n正文。\n');
    r = run('md2docx.py', ['output/docs/e.md', '--template', '前置']);
    const eflat = flat(path.join(docs, 'e.docx'));
    check(r.code === 0 && eflat.includes('合成项目') && headerParas(path.join(docs, 'e.docx')).includes('合成单位页眉　需求调研实施方案')
      && eflat.includes('需求调研实施方案') && (r.result.log || []).some((l) => l.includes('文档类型 ← 文档标题后缀（正文页眉页脚 1 处同步替换）'))
      && !(r.result.warnings || []).some((w) => w.includes('文档类型')),
    '`# X · 类型`：拆成标题与文档类型，正文页眉同步替换，没有「待填」', (r.result.log || []).join('；'));
    writeFileSync(path.join(docs, 'f.md'), '---\ntitle: 合成覆盖标题\n---\n\n# 合成项目 · 需求调研实施方案\n\n## 章节\n\n正文。\n');
    r = run('md2docx.py', ['output/docs/f.md', '--template', '前置']);
    check(r.code === 0 && flat(path.join(docs, 'f.docx')).includes('合成覆盖标题')
      && (r.result.warnings || []).some((w) => w.includes('文档类型')), 'front-matter 写了 title 时标题不拆');
    rmSync(path.join(ws, 'project.yaml'));
    writeFileSync(path.join(docs, 'd.md'), '# 合成标题\n\n## 章节\n\n正文。\n');
    r = run('md2docx.py', ['output/docs/d.md', '--template', '前置']);
    check(r.code === 0 && (r.result.warnings || []).some((w) => w.includes('客户单位')), '没有 project.yaml 时客户单位走占位并提醒');
  }

  const tsrc = path.join(ws, 'input', 'raw', '表格封面.docx');
  execFileSync(PY, [...PY_PRE, path.join(FIXTURES, 'make_messy_docx.py'), tsrc, '--front', 'table']);
  r = run('docx_template.py', ['collect', 'input/raw/表格封面.docx', '--name', '表格封面']);
  const tfr = JSON.parse(readFileSync(path.join(ws, 'output', 'docx-template', '表格封面', 'collect', 'report.json'), 'utf8')).front;
  check(tfr?.fields.some((f) => f.guess === 'title' && !f.inTextbox) && tfr.tables.length === 2,
    '表格排版的封面：表格里的段落按字段处理，不进表格清单', JSON.stringify(tfr?.fields));
  r = run('docx_template.py', ['build', '--name', '表格封面', '--source', 'input/raw/表格封面.docx']);
  const tdoc = zipText(path.join(ws, 'output', 'docx-template', '表格封面', 'front.docx'));
  check(r.code === 0 && !flat(path.join(ws, 'output', 'docx-template', '表格封面', 'front.docx')).some((t) => t.includes(FRONT_SENTINEL))
    && sectCount(tdoc) === 4, '不包 sdt 的目录：清掉样例目录项，分节符保住');
  const tprof = JSON.parse(readFileSync(path.join(ws, 'output', 'docx-template', '表格封面', 'profile.json'), 'utf8'));
  check(tprof.front?.dateFormat === 'YYYY年MM月', 'profile.json 记下日期的写法（形态标记）', JSON.stringify(tprof.front));
  if (hasPandoc) {
    const docs = path.join(ws, 'output', 'docs');
    writeFileSync(path.join(docs, 'g.md'), '# 合成标题\n\n## 章节\n\n正文。\n');
    r = run('md2docx.py', ['output/docs/g.md', '--template', '表格封面']);
    const now = new Date();
    const want = `${now.getFullYear()}年${String(now.getMonth() + 1).padStart(2, '0')}月`;
    check(r.code === 0 && flat(path.join(docs, 'g.docx')).includes(want), `日期按模板写法写成「${want}」`);
  }

  r = run('docx_template.py', ['build', '--name', '前置', '--source', 'input/raw/带封面.docx', '--decisions', '-', '--regenerate'],
    { input: '{"front": {"disabled": true}}' });
  const noFrontProfile = JSON.parse(readFileSync(path.join(fdir, 'profile.json'), 'utf8'));
  check(r.code === 0 && !existsSync(path.join(fdir, 'front.docx')) && !noFrontProfile.front, '「不要前置区」时不写 front.docx，profile 里没有 front');
} finally {
  rmSync(ws, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n${failed} 项断言失败`);
  process.exit(1);
}
console.log('\n全部通过');
