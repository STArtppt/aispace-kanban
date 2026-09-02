/**
 * 预览窗内检索的匹配内核:纯函数、零依赖、不碰 DOM,语料由调用方喂进来。
 *
 * 为什么自己写而不引 fuse.js:它的模糊靠编辑距离,对中文是逐字符的,
 * 词序颠倒这类场景并不比「分词 + 乱序子串命中」做得好;而分词、全半角归一、
 * 片段切分反正都得自己写。为一个前端本地功能加运行时依赖不划算。
 *
 * 匹配模型:查询按中英分词后,每个词在块文本里**子串命中**即可,
 * 各词允许乱序、不连续地分布;命中词数多的排前,同分看密集度,再看出现位置。
 */

/**
 * 归一:全角 ASCII 区(U+FF01–U+FF5E)折回半角、全角空格折半角、英文折小写。
 * 逐 UTF-16 码元处理,长度严格不变 —— 归一化文本里的下标才能直接当原文下标用,
 * 片段切分靠这一点把命中位置切回原文。非 ASCII 字符(含 CJK)一律原样保留。
 */
export function normalize(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code === 0x3000) {
      code = 0x20;
    } else if (code >= 0xff01 && code <= 0xff5e) {
      code -= 0xfee0;
    }
    if (code >= 0x41 && code <= 0x5a) code += 32;
    out += String.fromCharCode(code);
  }
  return out;
}

function isCjkCode(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // 平假名 + 片假名
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意文字
    (code >= 0xac00 && code <= 0xd7af) || // 谚文
    (code >= 0xf900 && code <= 0xfaff) // CJK 兼容表意文字
  );
}

function isAlnumCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z(归一后其实到不了,兜一手)
    (code >= 0x61 && code <= 0x7a) // a-z
  );
}

/**
 * 分词:连续 CJK 一段、连续字母数字一段,其余一律作分隔。
 * 输入先过 normalize,查询与语料走同一套切法才能对上(全角的「ｔａｓｋｉｄ」
 * 归一成 "taskid" 后才会被切成同一个词)。
 */
export function tokenize(text: string): string[] {
  const normalized = normalize(text);
  const tokens: string[] = [];
  let current = '';
  let currentKind: 'cjk' | 'alnum' | null = null;
  const flush = () => {
    if (current) tokens.push(current);
    current = '';
    currentKind = null;
  };
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    const kind = isCjkCode(code) ? 'cjk' : isAlnumCode(code) ? 'alnum' : null;
    if (kind === null || kind !== currentKind) flush();
    if (kind !== null) {
      currentKind = kind;
      current += normalized[i];
    }
  }
  flush();
  return tokens;
}

/** 结果片段里的一小段;matched = 这是命中词,渲染时加粗 */
export interface SnippetPart {
  text: string;
  matched: boolean;
}

/** 一条命中:块在语料数组里的下标 + 排序依据 + 展示片段 */
export interface SearchHit {
  /** 命中块在传入语料数组里的下标,调用方拿它回查块元素来跳转 */
  index: number;
  /** 命中的查询词个数,主排序 */
  score: number;
  /** 首末命中的跨度,越小越密集,次排序 */
  span: number;
  /** 首次命中位置,同分时越靠前越相关 */
  first: number;
  /** 片段,两端截断处带省略标记 */
  parts: SnippetPart[];
}

export interface SearchResult {
  hits: SearchHit[];
  /** 命中块总数(截断前) */
  total: number;
  /** 命中数超过上限,列表只给了前 limit 条 */
  truncated: boolean;
}

/** 结果条数上限。拍的数,长文档用下来不合适再调(design 已记为待定) */
export const SEARCH_RESULT_LIMIT = 50;

/** 给一个块打分;一个词都不中返回 null */
function scoreBlock(
  text: string,
  tokens: string[],
): { score: number; span: number; first: number } | null {
  const normalized = normalize(text);
  let score = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const token of tokens) {
    const at = normalized.indexOf(token);
    if (at === -1) continue;
    score++;
    if (at < min) min = at;
    const end = at + token.length;
    if (end > max) max = end;
  }
  if (score === 0) return null;
  return { score, span: max - min, first: min };
}

/**
 * 片段开窗大小:命中词前后各留一小段,三百字的段落也压进两三行。
 */
const SNIPPET_WINDOW = 80;

/**
 * 以首处命中为中心开窗,切成 { text, matched }[] 交给渲染。
 * 窗口把命中词切一半时把窗口撑到完整包住它,省略标记只落在未命中的文字上。
 * 命中位置在归一化文本上算,切片在原文上切 —— 两者下标一一对齐(normalize 长度不变)。
 */
export function toSnippetParts(
  text: string,
  tokens: string[],
  window = SNIPPET_WINDOW,
): SnippetPart[] {
  const normalized = normalize(text);
  const ranges: { start: number; end: number }[] = [];
  for (const token of tokens) {
    let from = 0;
    for (;;) {
      const at = normalized.indexOf(token, from);
      if (at === -1) break;
      ranges.push({ start: at, end: at + token.length });
      from = at + token.length;
    }
  }
  if (!ranges.length) return [{ text, matched: false }];

  let first = Number.POSITIVE_INFINITY;
  for (const range of ranges) {
    if (range.start < first) first = range.start;
  }

  // 以首处命中为中心开窗;贴边时整体挪动,窗口尽量吃满
  let start = Math.max(0, first - (window >> 1));
  let end = Math.min(normalized.length, start + window);
  if (end - start < window) start = Math.max(0, end - window);
  for (const range of ranges) {
    if (range.start < end && range.end > end) end = Math.min(normalized.length, range.end);
    if (range.start < start && range.end > start) start = Math.max(0, range.start);
  }

  ranges.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    if (range.end <= start || range.start >= end) continue;
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  const parts: SnippetPart[] = [];
  if (start > 0) parts.push({ text: '…', matched: false });
  let cursor = start;
  for (const range of merged) {
    if (range.start > cursor) parts.push({ text: text.slice(cursor, range.start), matched: false });
    parts.push({ text: text.slice(range.start, range.end), matched: true });
    cursor = range.end;
  }
  if (cursor < end) parts.push({ text: text.slice(cursor, end), matched: false });
  if (end < normalized.length) parts.push({ text: '…', matched: false });
  return parts;
}

/**
 * 检索入口:对一份块语料({ el, text }[] 或纯 { text }[])跑模糊匹配。
 * 排序:命中词数 → 密集度(跨度小在前)→ 首次命中位置 → 块序号(同分保证稳定)。
 * 结果截到 limit,并告知是否截断;空查询返回空结果。
 */
export function searchBlocks(
  blocks: { text: string }[],
  query: string,
  limit = SEARCH_RESULT_LIMIT,
): SearchResult {
  const tokens = [...new Set(tokenize(query))].filter((token) => token.length > 0);
  if (!tokens.length) return { hits: [], total: 0, truncated: false };
  const scored: { index: number; score: number; span: number; first: number }[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const result = scoreBlock(blocks[i].text, tokens);
    if (result) scored.push({ index: i, ...result });
  }
  scored.sort(
    (a, b) => b.score - a.score || a.span - b.span || a.first - b.first || a.index - b.index,
  );
  return {
    total: scored.length,
    truncated: scored.length > limit,
    hits: scored.slice(0, limit).map((entry) => ({
      ...entry,
      parts: toSnippetParts(blocks[entry.index].text, tokens),
    })),
  };
}
