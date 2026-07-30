/**
 * 只解析 ingest.py 会写出的那种扁平 YAML frontmatter：
 * `key: value` 和 `key:` + `  - item` 两种形态，不引入 yaml 依赖。
 */
export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { meta: {}, body: text, raw: '' };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: text, raw: '' };
  const raw = text.slice(text.indexOf('\n') + 1, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  const meta = {};
  let listKey = '';
  for (const line of raw.split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      meta[listKey].push(item[1].trim());
      continue;
    }
    const kv = /^([\w.-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value === '') {
      listKey = key;
      meta[key] = [];
    } else {
      listKey = '';
      meta[key] = value.trim();
    }
  }
  return { meta, body, raw };
}

/** 正文里第一个 h1/h2 当标题，没有就返回空。 */
export function firstHeading(body) {
  const m = /^#{1,2}\s+(.+)$/m.exec(body);
  return m ? m[1].trim() : '';
}

/** 中英文混排的篇幅：CJK 按字计，拉丁按词计。 */
export function countWords(body) {
  const text = body.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`|-]/g, ' ');
  const cjk = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
  const latin = (text.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) || []).length;
  return cjk + latin;
}
