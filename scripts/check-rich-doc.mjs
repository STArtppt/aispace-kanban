#!/usr/bin/env node
/**
 * 富文档转换的回归基线：拿 fixtures/rich-doc/ 里的合成件跑 anydoc_writer.mjs，
 * 比对下面写死的期望统计。
 *
 * 为什么要有它：templates/pm-aispace/scripts/ 下的转换脚本**没有任何静态检查也没有测试**，
 * 而 @firecrawl/anydoc 是 0.x，文档模型没有语义化保证——升级后 Writer 静默少吐内容
 * 是最难发现的一类退化。这个脚本就是那道闸。
 *
 *     node scripts/check-rich-doc.mjs
 *
 * 合成件怎么来的：fixtures/rich-doc/source.md 与 merged.html 经 pandoc 生成（见同目录 README）。
 * **只提交合成件**，真实客户资料不入库。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITER = path.join(ROOT, 'templates', 'pm-aispace', 'scripts', 'anydoc_writer.mjs');
const FIXTURES = path.join(ROOT, 'fixtures', 'rich-doc');
const MODULE = path.join(ROOT, 'node_modules', '@firecrawl', 'anydoc', 'index.js');

/**
 * 期望值。改动 Writer 导致这里对不上时，先想清楚是**修好了**还是**弄坏了**再改数字。
 *   headings 少了 / images 少了 —— 一律当成退化，不要顺手改期望。
 */
const EXPECTED = [
  { file: 'sample.docx', headings: 6, tables: 1, images: 1, imageLinks: 1 },
  { file: 'sample.odt', headings: 5, tables: 1, images: 1, imageLinks: 1 },
  { file: 'sample.rtf', headings: 5, tables: 1, images: 1, imageLinks: 1 },
  { file: 'sample.epub', headings: 7, tables: 1, images: 1, imageLinks: 1 },
  { file: 'merged.docx', headings: 1, tables: 2, images: 0, imageLinks: 0 },
];

function convert(file, extra = []) {
  const out = mkdtempSync(path.join(tmpdir(), 'rich-doc-'));
  try {
    const md = execFileSync('node', [
      WRITER, path.join(FIXTURES, file),
      '--anydoc-module', MODULE,
      '--assets-dir', out,
      '--link-prefix', 'assets/',
      ...extra,
    ], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).toString();
    const images = existsSync(out) ? readdirSync(out).length : 0;
    return { md, images };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const count = (md, re) => (md.match(re) ?? []).length;

let failed = 0;
const fail = (file, msg) => { failed += 1; console.error(`  ✗ ${file}: ${msg}`); };

if (!existsSync(MODULE)) {
  console.error(`找不到 anydoc 的 API 入口：${MODULE}\n先跑 pnpm install。`);
  process.exit(2);
}

for (const want of EXPECTED) {
  const { md, images } = convert(want.file);
  const got = {
    headings: count(md, /^#{1,6} /gm),
    tables: count(md, /^\|( --- \|)+$/gm),
    images,
    imageLinks: count(md, /!\[[^\]]*\]\([^)]+\)/g),
  };
  for (const key of Object.keys(want).filter((k) => k !== 'file')) {
    if (got[key] !== want[key]) fail(want.file, `${key} 期望 ${want[key]}，实际 ${got[key]}`);
  }
  // 产物必须是干净 GFM：裸 HTML 是本仓一直在甩的历史包袱，一个都不许回来
  // （表格单元格里的 <br> 除外——GFM 表达格内换行只有这一种写法）
  const raw = md.replace(/<br>/g, '');
  for (const tag of ['<img', '<div', '<span', '<figure', '<table']) {
    if (raw.includes(tag)) fail(want.file, `产物里出现裸 HTML ${tag}`);
  }
  // RTF / 码页兜底出问题时，中文会变成「标?题?」这种残缺
  if (/[一-鿿]\?/.test(md)) fail(want.file, '中文里出现问号残缺，检查编码处理');
  if (!failed) console.log(`  ✓ ${want.file}  标题 ${got.headings} · 表格 ${got.tables} · 图片 ${got.images}`);
}

// 跨行列的两种降级策略都要能跑，且 fill 一定比 blank 长（origin 内容被复制进被覆盖格）
const blank = convert('merged.docx').md;
const fill = convert('merged.docx', ['--span=fill']).md;
if (!(fill.length > blank.length)) fail('merged.docx', '--span=fill 没有把 origin 内容填进被覆盖格');
else console.log(`  ✓ merged.docx  --span=blank/fill 两种降级都生效`);

if (failed) {
  console.error(`\n${failed} 项不通过。`);
  process.exit(1);
}
console.log('\n全部通过。');
