/**
 * markdown 里的 URL：哪些不能当工作空间相对路径去拼 /file，
 * 以及过大的 data: URI 怎么在进解析管线前抽走。
 *
 * 网页转换产物会把整段动态 WebP 写成 `![](data:image/webp;base64,…几 MB…)`。
 * micromark 要扫完这个地址，React 再把同样长的字符串写进 img.src，点开预览就会
 * 卡 1–2 秒，图还往往裂开（被错包成 `/file?path=data%3A…`）。
 */

/** 超过这个长度的 data URI 抽成 blob:，小图标继续内联。 */
export const DATA_URI_HOIST_THRESHOLD = 8 * 1024;

/**
 * 这些已经是浏览器能用的地址，再丢给 `api.fileUrl` 会变成
 * `/file?path=data%3A…` 这种几 MB 的假路径。
 */
export function shouldPassthroughUrl(url: string): boolean {
  return /^(https?:|data:|blob:|mailto:|#)/i.test(url);
}

export type HoistResult = {
  text: string;
  /** 把解析后的字符偏移映射回原文。没抽过就是 undefined。 */
  mapToOriginal: ((offset: number) => number) | undefined;
  replaced: number;
};

type DataUriMatch = {
  start: number;
  end: number;
  mime: string;
  isBase64: boolean;
  payload: string;
};

type RewriteSpan = {
  rewrittenStart: number;
  rewrittenEnd: number;
  originalStart: number;
  originalEnd: number;
};

/** 同内容复用同一个 blob URL，避免 StrictMode 双调每次都新建。 */
const blobUrlCache = new Map<string, string>();

/**
 * 把超过阈值的 `data:` 换成短的 blob: URL，让 markdown 管线不再扫几 MB 的 base64。
 *
 * `createUrl` 只给测试注入假地址；浏览器里默认走 `URL.createObjectURL`。
 * 建不了 blob 就原样留下（解析仍会慢，但行为与改前一致）。
 */
export function hoistLargeDataUris(
  markdown: string,
  options?: {
    threshold?: number;
    createUrl?: (match: { mime: string; payload: string; isBase64: boolean }) => string | null;
  },
): HoistResult {
  const threshold = options?.threshold ?? DATA_URI_HOIST_THRESHOLD;
  const createUrl = options?.createUrl ?? createBlobUrl;
  const matches = findLargeDataUris(markdown, threshold);
  if (!matches.length) return { text: markdown, mapToOriginal: undefined, replaced: 0 };

  const replacements: { start: number; end: number; url: string }[] = [];
  for (const match of matches) {
    const url = createUrl({ mime: match.mime, payload: match.payload, isBase64: match.isBase64 });
    if (!url) continue;
    replacements.push({ start: match.start, end: match.end, url });
  }
  if (!replacements.length) return { text: markdown, mapToOriginal: undefined, replaced: 0 };

  return rewriteWithMap(markdown, replacements);
}

function findLargeDataUris(markdown: string, threshold: number): DataUriMatch[] {
  const found: DataUriMatch[] = [];
  // data:<type>/<subtype>[;param=value]*[;base64],<payload>
  const header =
    /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)((?:;[a-zA-Z0-9.+-]+=[^;,]+)*)?(;base64)?,/gi;
  let headerMatch: RegExpExecArray | null;
  while ((headerMatch = header.exec(markdown))) {
    const start = headerMatch.index;
    const payloadStart = header.lastIndex;
    const isBase64 = Boolean(headerMatch[3]);
    const end = isBase64 ? scanBase64Payload(markdown, payloadStart) : scanDelimitedPayload(markdown, payloadStart);
    if (end - start < threshold) continue;
    const mime = headerMatch[1] + (headerMatch[2] || '');
    found.push({
      start,
      end,
      mime,
      isBase64,
      payload: markdown.slice(payloadStart, end),
    });
    header.lastIndex = end;
  }
  return found;
}

function scanBase64Payload(source: string, from: number): number {
  let i = from;
  while (i < source.length) {
    const c = source.charCodeAt(i);
    const ok =
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) ||
      c === 43 ||
      c === 47 ||
      c === 61 ||
      c === 10 ||
      c === 13 ||
      c === 9 ||
      c === 32;
    if (!ok) break;
    i += 1;
  }
  return i;
}

function scanDelimitedPayload(source: string, from: number): number {
  let i = from;
  while (i < source.length) {
    const c = source.charCodeAt(i);
    if (c === 41 || c === 34 || c === 39 || c === 62 || c === 32 || c === 10 || c === 13 || c === 9 || c === 60) {
      break;
    }
    i += 1;
  }
  return i;
}

function rewriteWithMap(
  markdown: string,
  replacements: { start: number; end: number; url: string }[],
): HoistResult {
  let out = '';
  let cursor = 0;
  const spans: RewriteSpan[] = [];
  for (const item of replacements) {
    out += markdown.slice(cursor, item.start);
    const rewrittenStart = out.length;
    out += item.url;
    spans.push({
      rewrittenStart,
      rewrittenEnd: out.length,
      originalStart: item.start,
      originalEnd: item.end,
    });
    cursor = item.end;
  }
  out += markdown.slice(cursor);

  return {
    text: out,
    mapToOriginal: (offset: number) => mapRewrittenToOriginal(offset, spans),
    replaced: replacements.length,
  };
}

function mapRewrittenToOriginal(offset: number, spans: RewriteSpan[]): number {
  if (offset <= 0) return 0;
  let delta = 0;
  for (const span of spans) {
    if (offset < span.rewrittenStart) return offset + delta;
    const origLen = span.originalEnd - span.originalStart;
    const rewLen = span.rewrittenEnd - span.rewrittenStart;
    if (offset <= span.rewrittenEnd) {
      if (rewLen <= 0) return span.originalStart;
      const t = (offset - span.rewrittenStart) / rewLen;
      return span.originalStart + Math.round(t * origLen);
    }
    delta += origLen - rewLen;
  }
  return offset + delta;
}

function createBlobUrl(match: { mime: string; payload: string; isBase64: boolean }): string | null {
  if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return null;
  }
  const key = `${match.mime}|${match.isBase64 ? 'b64' : 'raw'}|${match.payload.length}|${match.payload.slice(0, 32)}|${match.payload.slice(-16)}`;
  const cached = blobUrlCache.get(key);
  if (cached) return cached;
  let blob: Blob;
  try {
    blob = match.isBase64
      ? base64ToBlob(match.payload, match.mime)
      : new Blob([decodeURIComponent(match.payload.replace(/\s+/g, ''))], { type: match.mime || 'application/octet-stream' });
  } catch {
    return null;
  }
  const url = URL.createObjectURL(blob);
  blobUrlCache.set(key, url);
  return url;
}

function base64ToBlob(payload: string, mime: string): Blob {
  const compact = payload.replace(/\s+/g, '');
  const binary = atob(compact);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}
