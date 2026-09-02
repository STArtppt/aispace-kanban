/**
 * 关键词归一与分词 —— **前端与服务端共用的唯一一份**。
 *
 * 为什么单开 `src/shared/`:表格整表检索的判定在服务端(`src/server/http.mjs` 的 `scanCsv`),
 * 结果片段的加粗在前端(`src/app/lib/fuzzySearch.ts`)。两侧切词口径必须一致,
 * 否则会出现「服务端判定这行命中、前端却一个词都加不了粗」,或者「全角关键词在数据页
 * 搜得到、在摘要页搜不到」—— 这类偏差没有类型检查兜底,只能靠"只有一份实现"来杜绝。
 *
 * **这个目录的边界:只放两侧共用的纯函数。** 不碰 DOM、不碰 Node API、零依赖。
 * 带 IO 的东西留在各自平面(见 AGENTS.md 第 3 节)。
 */

/**
 * 归一:全角 ASCII 区(U+FF01–U+FF5E)折回半角、全角空格折半角、英文折小写。
 * 逐 UTF-16 码元处理,长度严格不变 —— 归一化文本里的下标才能直接当原文下标用,
 * 片段切分靠这一点把命中位置切回原文。非 ASCII 字符(含 CJK)一律原样保留。
 *
 * @param {string} text
 * @returns {string}
 */
export function normalize(text) {
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

/**
 * @param {number} code
 * @returns {boolean}
 */
function isCjkCode(code) {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // 平假名 + 片假名
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意文字
    (code >= 0xac00 && code <= 0xd7af) || // 谚文
    (code >= 0xf900 && code <= 0xfaff) // CJK 兼容表意文字
  );
}

/**
 * @param {number} code
 * @returns {boolean}
 */
function isAlnumCode(code) {
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
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const normalized = normalize(text);
  /** @type {string[]} */
  const tokens = [];
  let current = '';
  /** @type {'cjk' | 'alnum' | null} */
  let currentKind = null;
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

/**
 * 查询串 → 去重后的关键词数组。空白与纯标点切出来是空数组,
 * 调用方据此判断"这次检索什么都不用做"(服务端凭它避免白扫一遍大文件)。
 *
 * @param {string} query
 * @returns {string[]}
 */
export function queryTokens(query) {
  return [...new Set(tokenize(query))].filter((token) => token.length > 0);
}

/**
 * 一行/一段文本是否**包含全部**关键词(整表检索的判定口径)。
 * 与预览窗内"命中一部分也进结果、按命中词数排序"的模糊匹配不同 ——
 * 差异是有意的,理由见 openspec 的 table-full-scan-search/design.md D2。
 *
 * @param {string} text 原始文本(未归一)
 * @param {string[]} tokens 已经过 queryTokens 的关键词
 * @returns {boolean}
 */
export function matchesAllTokens(text, tokens) {
  if (!tokens.length) return false;
  const normalized = normalize(text);
  for (const token of tokens) {
    if (!normalized.includes(token)) return false;
  }
  return true;
}
