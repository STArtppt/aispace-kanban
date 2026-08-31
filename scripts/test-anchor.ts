/**
 * 锚点验收：把源码切片重新跑同一条渲染管线取纯文本，再和选区比对。
 * 不许用正则把 markdown 近似成纯文本（见 annotate-to-agent-loop design 决策 9）。
 *
 *   pnpm test:anchor
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAnnotationPrompt } from '../src/app/lib/annotationPrompt.ts';
import {
  a2FromProps,
  anchorFromLeaves,
  countTextWrapperSpans,
  findQuoteRange,
  hastLeaves,
  rehypeSourcePos,
  renderedText,
  sliceUtf8,
  type AnchorOk,
} from '../src/app/lib/sourceAnchor.ts';

const FILE = 'output/方案.md';
const remarkPlugins = [[remarkGfm, { singleTilde: false }]] as const;

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
};

function capturePlugin(box: { tree: HastNode | null }) {
  return (tree: HastNode) => {
    box.tree = tree;
  };
}

function renderPipeline(source: string, withPos: boolean, box?: { tree: HastNode | null }): string {
  const rehypePlugins: unknown[] = [rehypeRaw];
  if (withPos) {
    rehypePlugins.push([rehypeSourcePos, { file: FILE, source, byteOffset: 0 }]);
  }
  if (box) rehypePlugins.push(() => capturePlugin(box));
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: remarkPlugins as never,
        rehypePlugins: rehypePlugins as never,
      },
      source,
    ),
  );
}

function htmlToPlain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|pre|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // React 转义撇号写的是十六进制 &#x27;,不是十进制 &#39; —— 只认十进制的话,
    // 带撇号的片段(spawn('open', ...))重渲染后就成了字面 &#x27;,对不回渲染文本
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 按空行扩到块边界：表格行 / 列表项单独切片经常解不成原结构（design 决策 9）。 */
function sliceAtBlock(source: string, start: number, end: number): string {
  const startChar = sliceUtf8(source, 0, start).length;
  const endChar = sliceUtf8(source, 0, end).length;
  const fromRaw = source.lastIndexOf('\n\n', startChar);
  const from = fromRaw < 0 ? 0 : fromRaw + 2;
  const toRaw = source.indexOf('\n\n', endChar);
  const to = toRaw < 0 ? source.length : toRaw;
  return source.slice(from, to);
}

function covers(hay: string, needle: string): boolean {
  if (!needle) return false;
  if (normalize(hay).includes(normalize(needle))) return true;
  // 表格单元格等：渲染文本把格子拼在一起，切片重渲染会在格子间留下空白
  return hay.replace(/\s+/g, '').includes(needle.replace(/\s+/g, ''));
}

/** 判定器：切片再走同一条管线。 */
function sliceCoversQuote(source: string, anchor: AnchorOk): boolean {
  const needle = anchor.quote;
  if (!needle.trim()) return false;
  const slice = sliceUtf8(source, anchor.start, anchor.end);
  if (covers(slice, needle)) return true;
  if (covers(htmlToPlain(renderPipeline(slice, false)), needle)) return true;
  const block = sliceAtBlock(source, anchor.start, anchor.end);
  return covers(htmlToPlain(renderPipeline(block, false)), needle);
}

function pipelineLeaves(source: string): { leaves: ReturnType<typeof hastLeaves>; tree: HastNode; spans: number } {
  const box: { tree: HastNode | null } = { tree: null };
  renderPipeline(source, true, box);
  if (!box.tree) throw new Error('rehype 插件没有拿到 HAST');
  return {
    leaves: hastLeaves(box.tree),
    tree: box.tree,
    spans: countTextWrapperSpans(box.tree),
  };
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function hastText(node: HastNode): string {
  if (node.type === 'text') return node.value || '';
  return (node.children || []).map(hastText).join('');
}

/**
 * 元素拾取会产出的那些锚点：区间是元素自己声明的那一段，引用是它的可见文字。
 * 走 HAST 而不是 DOM —— 这个脚本不起浏览器，而两边读的是同一份属性。
 */
function elementAnchors(tree: HastNode): { tag: string; anchor: AnchorOk }[] {
  const found: { tag: string; anchor: AnchorOk }[] = [];
  function visit(node: HastNode) {
    if (node.type === 'element' && node.properties?.dataSourceText !== '1') {
      const declared = a2FromProps(node.properties);
      const quote = hastText(node).replace(/\s+/g, ' ').trim();
      if (declared && quote) {
        found.push({
          tag: node.tagName || '?',
          anchor: { ok: true, ...declared.range, quote, structure: '段落' },
        });
      }
    }
    for (const child of node.children || []) visit(child);
  }
  visit(tree);
  return found;
}

const FIXTURE = [
  '这是一段纯文本中间有几个字可以选。',
  '',
  '这里有**强调文本**和`行内代码`还有[一个链接](https://example.com/path)。',
  '',
  '| 列一 | 列二 |',
  '| --- | --- |',
  '| 单元格甲 | 单元格乙 |',
  '',
  '<div>裸 HTML 段落</div>',
  '',
  '- 列表项甲',
  '- 列表项乙',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '跨块的第一段。',
  '',
  '跨块的第二段。',
  '',
].join('\n');

type Case = {
  name: string;
  quote: string;
  sourceMustInclude?: string;
};

const CASES: Case[] = [
  { name: '纯文本', quote: '几个字' },
  { name: '跨强调', quote: '有强调文', sourceMustInclude: '**强调文本**' },
  { name: '跨行内代码', quote: '和行内', sourceMustInclude: '`行内代码`' },
  { name: '跨链接', quote: '有一个链', sourceMustInclude: '[一个链接](https://example.com/path)' },
  { name: '表格单元格', quote: '单元格甲' },
  { name: '跨单元格', quote: '格甲单元格乙' },
  { name: '裸 HTML', quote: '裸 HTML' },
  { name: '列表项', quote: '列表项甲' },
  { name: '跨列表项', quote: '项甲\n列表项乙' },
  { name: '代码块', quote: 'const x = 1;' },
  { name: '跨块', quote: '第一段。\n跨块的第二' },
];

function runCases(source: string, cases: Case[]): void {
  const { leaves } = pipelineLeaves(source);
  const hay = renderedText(leaves);
  for (const item of cases) {
    const found = findQuoteRange(hay, item.quote);
    assert(found, `[${item.name}] 渲染文本里找不到「${item.quote}」\n渲染：${JSON.stringify(hay)}`);
    const result = anchorFromLeaves(leaves, found.start, found.end, item.quote);
    assert(result.ok, `[${item.name}] 锚点失败：${result.ok ? '' : result.reason}`);
    assert(sliceCoversQuote(source, result), `[${item.name}] 切片重渲染盖不住选区\n区间 ${result.start},${result.end}\n切片：${JSON.stringify(sliceUtf8(source, result.start, result.end))}`);
    if (item.sourceMustInclude) {
      const slice = sliceUtf8(source, result.start, result.end);
      assert(
        slice.includes(item.sourceMustInclude),
        `[${item.name}] 切片应包含完整标记 ${JSON.stringify(item.sourceMustInclude)}，实际：${JSON.stringify(slice)}`,
      );
    }
    console.log(`  ok  ${item.name}  →  ${result.start},${result.end}  (${result.structure})`);
  }
}

function randInt(max: number): number {
  return Math.floor(Math.random() * max);
}

function stress(source: string, rounds: number): { ok: number; unsupported: number; empty: number } {
  const { leaves } = pipelineLeaves(source);
  const hay = renderedText(leaves);
  let ok = 0;
  let unsupported = 0;
  let empty = 0;
  const errors: string[] = [];
  for (let i = 0; i < rounds; i++) {
    if (hay.length < 4) break;
    // 真实划选通常是几十个字，不是从文档头拖到尾
    const a = randInt(Math.max(1, hay.length - 2));
    const b = Math.min(hay.length, a + 1 + randInt(48));
    const quote = hay.slice(a, b);
    const result = anchorFromLeaves(leaves, a, b, quote);
    if (!result.ok) {
      if (result.reason === 'empty') empty += 1;
      else unsupported += 1;
      continue;
    }
    if (!sliceCoversQuote(source, result)) {
      errors.push(
        `选区 ${JSON.stringify(quote.slice(0, 40))} → ${result.start},${result.end} 切片 ${JSON.stringify(sliceUtf8(source, result.start, result.end).slice(0, 80))}`,
      );
      continue;
    }
    ok += 1;
  }
  if (errors.length) {
    throw new Error(`压测出现 ${errors.length} 次真实锚点错误，例：\n${errors.slice(0, 5).join('\n')}`);
  }
  return { ok, unsupported, empty };
}

function main() {
  console.log('1. 契约 A2 属性');
  const sample = '一段**粗体**文字。';
  const html = renderPipeline(sample, true);
  assert(html.includes('data-source-file="output/方案.md"'), `缺 data-source-file：${html}`);
  assert(/data-source-range="\d+,\d+"/.test(html), `缺 data-source-range：${html}`);
  console.log('  ok  元素上同时有 data-source-file 与 data-source-range');

  console.log('2. 十一种选区');
  runCases(FIXTURE, CASES);

  console.log('3. 元素拾取：每个带区间的元素');
  const picked = elementAnchors(pipelineLeaves(FIXTURE).tree);
  assert(picked.length > 0, '一个带区间的元素都没有');
  for (const { tag, anchor } of picked) {
    assert(
      sliceCoversQuote(FIXTURE, anchor),
      `[<${tag}>] 切片重渲染盖不住这块的可见文字\n区间 ${anchor.start},${anchor.end}\n切片：${JSON.stringify(sliceUtf8(FIXTURE, anchor.start, anchor.end))}\n文字：${JSON.stringify(anchor.quote)}`,
    );
  }
  console.log(`  ok  ${picked.length} 个元素，切出来的源码都盖得住自己的可见文字`);

  const here = dirname(fileURLToPath(import.meta.url));
  const agents = readFileSync(join(here, '..', 'AGENTS.md'), 'utf8');
  console.log('4. AGENTS.md 随机选区压测');
  const t0 = performance.now();
  const stats = stress(agents, 300);
  const t1 = performance.now();
  console.log(`  ok  300 次：命中 ${stats.ok} / 空选区 ${stats.empty} / 暂不支持 ${stats.unsupported}  (${(t1 - t0).toFixed(0)}ms)`);

  console.log('5. 包 span 的渲染开销');
  const once = pipelineLeaves(agents);
  console.log(`  AGENTS.md：${once.spans} 个文本 span，源 ${agents.length} 字`);
  const long = (agents + '\n\n').repeat(8);
  const start = performance.now();
  const { spans } = pipelineLeaves(long);
  const elapsed = performance.now() - start;
  console.log(`  8 倍约 ${long.length} 字 / ${spans} 个 span，管线 ${elapsed.toFixed(0)}ms`);
  if (elapsed > 250) {
    console.warn('  十万字量级会到几百毫秒，已记进 design Risks；日常产出文档远小于这个量级。');
  } else {
    console.log('  ok  未超出可感范围');
  }

  console.log('6. 提示词倒序');
  const prompt = buildAnnotationPrompt('output/方案.md', [
    { start: 10, end: 20, quote: '前面', comment: '改前面', structure: '段落' },
    { start: 80, end: 90, quote: '后面', comment: '改后面', structure: '段落' },
  ]);
  assert(prompt.indexOf('改后面') < prompt.indexOf('改前面'), '应按区间倒序，先写后面的批注');
  assert(prompt.includes('output/方案.md'), '要带文件路径');
  assert(prompt.includes('UTF-8 字节 80,90'), '要带源码区间');
  console.log('  ok  后段批注排在前面');

  console.log('\n全部通过');
}

main();
