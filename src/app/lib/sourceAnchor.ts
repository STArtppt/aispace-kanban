/**
 * markdown 预览的源码锚点：rehype 插件盖契约 A2 属性，再从选区反推字节区间。
 *
 * 契约 A2（对外协议，属性名不可改）：
 *   data-source-file  = 相对工作空间根的路径
 *   data-source-range = UTF-8 字节区间，左闭右开，写成 `起,止`
 * 两个同时存在才算声明。
 */

export const SOURCE_FILE_ATTR = 'data-source-file';
export const SOURCE_RANGE_ATTR = 'data-source-range';
/** 文本节点外包的 span，用来防止自己再包自己 */
export const SOURCE_TEXT_ATTR = 'data-source-text';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8Len(text: string): number {
  return encoder.encode(text).length;
}

export function charToByte(source: string, charOffset: number): number {
  if (charOffset <= 0) return 0;
  if (charOffset >= source.length) return utf8Len(source);
  return utf8Len(source.slice(0, charOffset));
}

/**
 * char offset → UTF-8 byte offset 的前缀表，`table[i]` = `utf8Len(source.slice(0, i))`。
 *
 * 盖锚点要对每个元素和每个文本节点各算两次偏移；直接调 charToByte 是「切一遍 + 编码一遍
 * 整段正文」，节点数 × 文档长度就成了平方级 —— 80 KB 的产物光这一步就是一秒多的同步阻塞，
 * 切文档时整条主线程僵住。建一次表 O(n)，之后每次换算是一次下标。
 */
export function buildByteIndex(source: string): Uint32Array {
  const table = new Uint32Array(source.length + 1);
  let bytes = 0;
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < source.length) {
      const low = source.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        // 代理对合起来 4 字节；中间那一格按孤儿代理算(TextEncoder 会替换成 U+FFFD 的 3 字节)，
        // 这样每一格都严格等于 utf8Len(slice(0, i))
        table[i + 1] = bytes + 3;
        table[i + 2] = bytes + 4;
        bytes += 4;
        i++;
        continue;
      }
      bytes += 3;
    } else {
      bytes += 3;
    }
    table[i + 1] = bytes;
  }
  return table;
}

export function sliceUtf8(source: string, start: number, end: number): string {
  return decoder.decode(encoder.encode(source).subarray(start, end));
}

export type SourceRange = { start: number; end: number };

/** 从 react-markdown 传到自定义组件的 props 里取出契约 A2，其它字段丢掉。 */
export function pickSourceAttrs(props: Record<string, unknown>): {
  'data-source-file': string;
  'data-source-range': string;
} | undefined {
  const file = props['data-source-file'] ?? props.dataSourceFile;
  const range = props['data-source-range'] ?? props.dataSourceRange;
  if (typeof file !== 'string' || !file || typeof range !== 'string' || !range) return undefined;
  if (!parseSourceRange(range)) return undefined;
  return { 'data-source-file': file, 'data-source-range': range };
}

export function formatSourceRange(range: SourceRange): string {
  return `${range.start},${range.end}`;
}

export function parseSourceRange(value: string | null | undefined): SourceRange | null {
  if (!value) return null;
  const m = /^(\d+),(\d+)$/.exec(value);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end };
}

/** 表格 / 列表的结构性节点：包 span 会生成非法 HTML，被浏览器挪走 */
const STRUCTURAL = new Set([
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'colgroup',
  'col',
  'ul',
  'ol',
  'dl',
  'head',
  'body',
  'html',
]);

/**
 * React 19 不允许这些标签的子节点是文本（含空白）。
 * 转换产物里的裸 HTML 表常带换行缩进，rehype-raw 会保留成 `"\n"`，
 * 开发态会当成 hydration 错误把预览盖成空白。
 */
const TABLE_STRUCTURE = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup']);

const INLINE_MARKS = new Set(['em', 'strong', 'del', 's', 'code', 'a', 'img']);

const BLOCK_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'tr',
  'blockquote',
  'pre',
  'div',
  'table',
]);

type HastPos = { offset?: number };
type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: { start?: HastPos; end?: HastPos };
};

export type SourcePosOptions = {
  file: string;
  /** 交给 markdown 管线的源字符串（可能已剥 frontmatter） */
  source: string;
  /** 该字符串在源文件里的 UTF-8 字节起点 */
  byteOffset?: number;
};

export type StructureHint = '段落' | '表格行' | '列表项' | '跨块';

export type Ancestor = {
  tag: string;
  range: SourceRange | null;
  node: unknown;
};

export type TextLeaf = {
  text: string;
  range: SourceRange | null;
  ancestors: Ancestor[];
  /** 浏览器里对应的文本节点；HAST 测试没有 */
  domNode?: Text;
};

export type AnchorOk = {
  ok: true;
  start: number;
  end: number;
  quote: string;
  structure: StructureHint;
};

export type AnchorFail = {
  ok: false;
  reason: 'empty' | 'unsupported';
};

export type AnchorResult = AnchorOk | AnchorFail;

function rangeFromPosition(node: HastNode, index: Uint32Array, byteOffset: number): SourceRange | null {
  const startOff = node.position?.start?.offset;
  const endOff = node.position?.end?.offset;
  if (startOff == null || endOff == null) return null;
  // 位置越界(理论上不该有)时钳到表尾，行为与原先 charToByte 的两头夹取一致
  const last = index.length - 1;
  const start = byteOffset + index[Math.max(0, Math.min(startOff, last))];
  const end = byteOffset + index[Math.max(0, Math.min(endOff, last))];
  if (end < start) return null;
  return { start, end };
}

function isTextWrapper(node: HastNode): boolean {
  return (
    node.type === 'element' &&
    node.tagName === 'span' &&
    (node.properties?.dataSourceText === '1' || node.properties?.['data-source-text'] === '1')
  );
}

function stamp(node: HastNode, file: string, range: SourceRange, extra?: Record<string, unknown>) {
  node.properties = {
    ...node.properties,
    dataSourceFile: file,
    dataSourceRange: formatSourceRange(range),
    ...extra,
  };
}

function shouldWrapText(parent: HastNode, child: HastNode): boolean {
  if (child.type !== 'text') return false;
  if (!child.value || !/\S/.test(child.value)) return false;
  if (child.position?.start?.offset == null || child.position?.end?.offset == null) return false;
  if (parent.type !== 'element') return false;
  const tag = parent.tagName || '';
  if (STRUCTURAL.has(tag)) return false;
  if (isTextWrapper(parent)) return false;
  return true;
}

function wrapText(child: HastNode, file: string, index: Uint32Array, byteOffset: number): HastNode {
  const range = rangeFromPosition(child, index, byteOffset);
  const span: HastNode = {
    type: 'element',
    tagName: 'span',
    properties: { dataSourceText: '1' },
    children: [child],
    position: child.position,
  };
  if (range) stamp(span, file, range, { dataSourceText: '1' });
  return span;
}

function walk(node: HastNode, file: string, index: Uint32Array, byteOffset: number) {
  if (node.type === 'element' && !isTextWrapper(node)) {
    const range = rangeFromPosition(node, index, byteOffset);
    if (range) stamp(node, file, range);
  }
  if (!node.children) return;
  const next: HastNode[] = [];
  for (const child of node.children) {
    if (shouldWrapText(node, child)) {
      next.push(wrapText(child, file, index, byteOffset));
    } else {
      walk(child, file, index, byteOffset);
      next.push(child);
    }
  }
  node.children = next;
}

function stripTableWhitespace(node: HastNode) {
  if (!node.children) return;
  if (node.type === 'element' && TABLE_STRUCTURE.has(node.tagName || '')) {
    node.children = node.children.filter(
      (child) => child.type !== 'text' || (child.value != null && /\S/.test(child.value)),
    );
  }
  for (const child of node.children) stripTableWhitespace(child);
}

/** rehype 插件：清掉表格结构里的空白文本节点。必须接在 rehype-raw 后面。 */
export function rehypeStripTableWhitespace() {
  return (tree: HastNode) => {
    stripTableWhitespace(tree);
  };
}

/** rehype 插件：`[rehypeSourcePos, { file, source, byteOffset }]` */
export function rehypeSourcePos(options: SourcePosOptions) {
  const file = options.file;
  const source = options.source;
  const byteOffset = options.byteOffset ?? 0;
  return (tree: HastNode) => {
    if (!file) return;
    // 前缀表跟着这一次调用建，不跨文档缓存：source 变了表就作废
    walk(tree, file, buildByteIndex(source), byteOffset);
  };
}

export function a2FromProps(props: Record<string, unknown> | null | undefined): {
  file: string;
  range: SourceRange;
} | null {
  if (!props) return null;
  const fileRaw = props.dataSourceFile ?? props[SOURCE_FILE_ATTR];
  const rangeRaw = props.dataSourceRange ?? props[SOURCE_RANGE_ATTR];
  if (typeof fileRaw !== 'string' || !fileRaw) return null;
  const range = parseSourceRange(typeof rangeRaw === 'string' ? rangeRaw : null);
  if (!range) return null;
  return { file: fileRaw, range };
}

export function a2FromElement(el: Element | null | undefined): { file: string; range: SourceRange } | null {
  if (!el) return null;
  const file = el.getAttribute(SOURCE_FILE_ATTR);
  const range = parseSourceRange(el.getAttribute(SOURCE_RANGE_ATTR));
  if (!file || !range) return null;
  return { file, range };
}

/**
 * 文本长度（UTF-8 字节）和区间长度对得上，才能按字符线性映射；
 * 对不上说明中间有标记或转义，退到节点边界。
 */
export function mapCharOffsetToByte(text: string, range: SourceRange, charOffset: number): number {
  const clamped = Math.max(0, Math.min(charOffset, text.length));
  const textBytes = utf8Len(text);
  const rangeBytes = range.end - range.start;
  if (textBytes === rangeBytes) {
    return range.start + utf8Len(text.slice(0, clamped));
  }
  return clamped <= 0 ? range.start : range.end;
}

export function byteToCharOffset(text: string, range: SourceRange, bytePos: number): number {
  const textBytes = utf8Len(text);
  const rangeBytes = range.end - range.start;
  if (textBytes !== rangeBytes) {
    return bytePos <= range.start ? 0 : text.length;
  }
  const rel = Math.max(0, bytePos - range.start);
  let bytes = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    if (cp == null) break;
    const ch = String.fromCodePoint(cp);
    // 单字符宽度直接按码点算；这里每字符起一次 TextEncoder 太贵，且这条循环在画高亮时按叶子重复走
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + size > rel) return i;
    bytes += size;
    i += ch.length;
  }
  return text.length;
}

function isInlineMark(tag: string, ancestorsFromHere: Ancestor[]): boolean {
  // 围栏代码块也是 <pre><code>，不能当行内标记向外扩，否则一点选区会吞掉整块
  if (tag === 'code') return !ancestorsFromHere.some((a) => a.tag === 'pre');
  return INLINE_MARKS.has(tag);
}

function expandInlineMarks(point: number, ancestors: Ancestor[]): SourceRange {
  let start = point;
  let end = point;
  for (let i = 0; i < ancestors.length; i++) {
    const ancestor = ancestors[i];
    if (!ancestor.range || !isInlineMark(ancestor.tag, ancestors.slice(i))) continue;
    start = Math.min(start, ancestor.range.start);
    end = Math.max(end, ancestor.range.end);
  }
  return { start, end };
}

function nearestRange(ancestors: Ancestor[]): SourceRange | null {
  for (const ancestor of ancestors) {
    if (ancestor.range) return ancestor.range;
  }
  return null;
}

export function inferStructure(startAncestors: Ancestor[], endAncestors: Ancestor[]): StructureHint {
  const startBlock = startAncestors.find((a) => BLOCK_TAGS.has(a.tag));
  const endBlock = endAncestors.find((a) => BLOCK_TAGS.has(a.tag));
  if (startBlock && endBlock && startBlock.node !== endBlock.node) return '跨块';
  if (startAncestors.some((a) => a.tag === 'tr')) return '表格行';
  if (startAncestors.some((a) => a.tag === 'li')) return '列表项';
  return '段落';
}

function pointFromLeaf(
  leaf: TextLeaf,
  charOffset: number,
  side: 'start' | 'end',
): { byte: number; ancestors: Ancestor[] } | null {
  if (leaf.range) {
    const textBytes = utf8Len(leaf.text);
    const rangeBytes = leaf.range.end - leaf.range.start;
    if (textBytes === rangeBytes) {
      return {
        byte: mapCharOffsetToByte(leaf.text, leaf.range, charOffset),
        ancestors: leaf.ancestors,
      };
    }
    // 对不上（代码块合成文本、行内代码含反引号等）：不能按字符切，整段纳入
    return { byte: side === 'start' ? leaf.range.start : leaf.range.end, ancestors: leaf.ancestors };
  }
  const fallback = nearestRange(leaf.ancestors);
  if (!fallback) return null;
  return { byte: side === 'start' ? fallback.start : fallback.end, ancestors: leaf.ancestors };
}

export function anchorFromLeaves(
  leaves: TextLeaf[],
  startIndex: number,
  endIndex: number,
  quote: string,
): AnchorResult {
  const trimmed = quote.trim();
  if (!trimmed || startIndex === endIndex) return { ok: false, reason: 'empty' };

  let from = startIndex;
  let to = endIndex;
  if (from > to) {
    const tmp = from;
    from = to;
    to = tmp;
  }

  const start = locateLeaf(leaves, from, 'start');
  const end = locateLeaf(leaves, to, 'end');
  if (!start || !end) return { ok: false, reason: 'unsupported' };

  const startPoint = pointFromLeaf(start.leaf, start.offset, 'start');
  const endPoint = pointFromLeaf(end.leaf, end.offset, 'end');
  if (!startPoint || !endPoint) return { ok: false, reason: 'unsupported' };

  const startExpanded = expandInlineMarks(startPoint.byte, startPoint.ancestors);
  const endExpanded = expandInlineMarks(endPoint.byte, endPoint.ancestors);
  const startByte = Math.min(startExpanded.start, endExpanded.start);
  const endByte = Math.max(startExpanded.end, endExpanded.end);
  if (endByte <= startByte) return { ok: false, reason: 'unsupported' };

  return {
    ok: true,
    start: startByte,
    end: endByte,
    quote,
    structure: inferStructure(startPoint.ancestors, endPoint.ancestors),
  };
}

function locateLeaf(
  leaves: TextLeaf[],
  charOffset: number,
  side: 'start' | 'end',
): { leaf: TextLeaf; offset: number } | null {
  if (!leaves.length) return null;
  let acc = 0;
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i];
    const len = leaf.text.length;
    const next = acc + len;
    if (side === 'start') {
      if (charOffset < next || (charOffset === next && i === leaves.length - 1)) {
        return { leaf, offset: Math.min(len, Math.max(0, charOffset - acc)) };
      }
    } else if (charOffset <= next) {
      return { leaf, offset: Math.min(len, Math.max(0, charOffset - acc)) };
    }
    acc = next;
  }
  const last = leaves[leaves.length - 1];
  return { leaf: last, offset: last.text.length };
}

/** 从 HAST 收集叶子：文本节点挂最近祖先的 A2 区间（文本外包 span 优先）。 */
export function hastLeaves(tree: HastNode): TextLeaf[] {
  const leaves: TextLeaf[] = [];

  function visit(node: HastNode, ancestors: Ancestor[]) {
    if (node.type === 'text') {
      const parentRange = ancestors[0]?.range ?? null;
      leaves.push({
        text: node.value || '',
        range: parentRange,
        ancestors,
      });
      return;
    }
    if (node.type === 'element' && node.tagName) {
      const declared = a2FromProps(node.properties);
      const self: Ancestor = { tag: node.tagName, range: declared?.range ?? null, node };
      const next = [self, ...ancestors];
      for (const child of node.children || []) visit(child, next);
      return;
    }
    for (const child of node.children || []) visit(child, ancestors);
  }

  visit(tree, []);
  return leaves;
}

export function countTextWrapperSpans(tree: HastNode): number {
  let n = 0;
  function visit(node: HastNode) {
    if (isTextWrapper(node)) n += 1;
    for (const child of node.children || []) visit(child);
  }
  visit(tree);
  return n;
}

export function renderedText(leaves: TextLeaf[]): string {
  return leaves.map((leaf) => leaf.text).join('');
}

export function findQuoteRange(haystack: string, quote: string): { start: number; end: number } | null {
  const start = haystack.indexOf(quote);
  if (start < 0) return null;
  return { start, end: start + quote.length };
}

function ancestorsFromElement(el: Element, root: Element): Ancestor[] {
  const list: Ancestor[] = [];
  let cur: Element | null = el;
  while (cur && (root === cur || root.contains(cur))) {
    const declared = a2FromElement(cur);
    list.push({ tag: cur.tagName.toLowerCase(), range: declared?.range ?? null, node: cur });
    if (cur === root) break;
    cur = cur.parentElement;
  }
  return list;
}

export function collectLeavesFromDom(root: Element): TextLeaf[] {
  const leaves: TextLeaf[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    const parent = textNode.parentElement;
    if (parent && root.contains(parent)) {
      leaves.push({
        text: textNode.textContent || '',
        range: a2FromElement(parent)?.range ?? null,
        ancestors: ancestorsFromElement(parent, root),
        domNode: textNode,
      });
    }
    node = walker.nextNode();
  }
  return leaves;
}

function normalizeDomPoint(node: Node, offset: number): { node: Node; offset: number } {
  if (node.nodeType === Node.TEXT_NODE) return { node, offset };
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as Element;
    if (offset < el.childNodes.length) {
      let child: Node | null = el.childNodes[offset];
      while (child && child.nodeType === Node.ELEMENT_NODE && child.firstChild) {
        child = child.firstChild;
      }
      return { node: child ?? el, offset: 0 };
    }
    let last: Node | null = el;
    while (last && last.nodeType === Node.ELEMENT_NODE && last.lastChild) {
      last = last.lastChild;
    }
    const len = last?.nodeType === Node.TEXT_NODE ? (last.textContent || '').length : 0;
    return { node: last ?? el, offset: len };
  }
  return { node, offset };
}

function leafForDomNode(leaves: TextLeaf[], node: Node): TextLeaf | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return leaves.find((leaf) => leaf.domNode === node) ?? null;
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as Element;
    return (
      leaves.find((leaf) => leaf.domNode && el.contains(leaf.domNode)) ??
      null
    );
  }
  return null;
}

export function anchorFromDomSelection(root: Element, selection: Selection | null): AnchorResult {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return { ok: false, reason: 'empty' };
  }
  const quote = selection.toString();
  if (!quote.trim()) return { ok: false, reason: 'empty' };

  const range = selection.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;
  if (ancestor !== root && !root.contains(ancestor)) return { ok: false, reason: 'empty' };

  const leaves = collectLeavesFromDom(root);
  const startPoint = normalizeDomPoint(range.startContainer, range.startOffset);
  const endPoint = normalizeDomPoint(range.endContainer, range.endOffset);
  const startLeaf = leafForDomNode(leaves, startPoint.node);
  const endLeaf = leafForDomNode(leaves, endPoint.node);
  if (!startLeaf || !endLeaf) return { ok: false, reason: 'unsupported' };

  let startChar = 0;
  let endChar = 0;
  let acc = 0;
  for (const leaf of leaves) {
    if (leaf === startLeaf) startChar = acc + (startLeaf.domNode === startPoint.node ? startPoint.offset : 0);
    if (leaf === endLeaf) {
      endChar = acc + (endLeaf.domNode === endPoint.node ? endPoint.offset : leaf.text.length);
    }
    acc += leaf.text.length;
  }

  return anchorFromLeaves(leaves, startChar, endChar, quote);
}

/**
 * 把一条批注的字节区间还原成 DOM Range，用来画高亮。
 *
 * `leaves` 可以由调用方预先算好复用：一次 collectLeavesFromDom 要走遍正文所有文本节点、
 * 还要逐个向上收 ancestors，按批注条数重复调就是「条数 × 全文 DOM」。
 */
export function domRangeFromBytes(
  root: Element,
  start: number,
  end: number,
  leaves: TextLeaf[] = collectLeavesFromDom(root),
): Range | null {
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  for (const leaf of leaves) {
    if (!leaf.domNode || !leaf.range) continue;
    if (leaf.range.end <= start || leaf.range.start >= end) continue;
    const from = Math.max(start, leaf.range.start);
    const to = Math.min(end, leaf.range.end);
    const fromChar = byteToCharOffset(leaf.text, leaf.range, from);
    const toChar = byteToCharOffset(leaf.text, leaf.range, to);
    if (!startNode) {
      startNode = leaf.domNode;
      startOffset = fromChar;
    }
    endNode = leaf.domNode;
    endOffset = toChar;
  }

  if (!startNode || !endNode) return null;
  const range = root.ownerDocument.createRange();
  try {
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
  } catch {
    return null;
  }
  return range;
}

/**
 * 元素拾取的锚点：直接用这个元素自己声明的 A2 区间。
 *
 * 与选区锚点（`anchorFromDomSelection`）互为补充：选区精确到字符但要人先划一遍，
 * 拾取一点就是一整块、切出来的源码天然是完整的语法单元（段落 / 表格行 / 列表项）。
 * 元素自己没声明区间时（裸 HTML 片段里的节点）退到最近的、声明过的祖先，
 * 与选区那条路上的兜底同一套规则。
 */
export function anchorFromElement(root: Element, el: Element): AnchorResult {
  if (el === root || !root.contains(el)) return { ok: false, reason: 'unsupported' };
  const ancestors = ancestorsFromElement(el, root);
  const range = a2FromElement(el)?.range ?? nearestRange(ancestors);
  if (!range || range.end <= range.start) return { ok: false, reason: 'unsupported' };
  // 引用给的是渲染后的可见文字：换行与缩进在提示词里没有意义，压成单空格
  const quote = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (!quote) return { ok: false, reason: 'empty' };
  return {
    ok: true,
    start: range.start,
    end: range.end,
    quote,
    structure: inferStructure(ancestors, ancestors),
  };
}
