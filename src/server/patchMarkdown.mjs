/**
 * 问题单、记录单、反馈单共用的「只改点名的键 + 原子替换」。
 *
 * 三处写入都是同一条纪律：整份重新序列化会把 AI 写区的写法、注释、键顺序洗掉，
 * 等于改了别人的写区。所以字段级替换和临时文件替换只留这一份。
 * 各模块自己的校验、追加哪一节，仍留在各自文件里 —— 那部分并不相同。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 字段级替换：只动 `updates` 里点名的键，其余行逐字不变。
 * 文件里没有这个键就补在 front-matter 末尾，不重排已有的键。
 *
 * @param {string} text 整份 markdown
 * @param {Record<string, string>} updates 要写入的键。值已经是单行文本
 * @returns {string}
 */
export function setFrontmatterFields(text, updates) {
  const headEnd = text.indexOf('\n') + 1;
  const close = text.indexOf('\n---', 3);
  const head = text.slice(0, headEnd);
  const rest = text.slice(close);
  const lines = text.slice(headEnd, close).split(/\r?\n/);
  const pending = new Map(Object.entries(updates));
  const out = [];

  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([\w.-]+):\s*(.*)$/.exec(lines[i]);
    if (kv && pending.has(kv[1])) {
      out.push(`${kv[1]}: ${pending.get(kv[1])}`.trimEnd());
      pending.delete(kv[1]);
      // 人写区本不该写成列表，但文件是手写的：把这个键的 `- item` 续行一并吃掉，别留孤儿
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) i += 1;
      continue;
    }
    out.push(lines[i]);
  }
  for (const [key, value] of pending) out.push(`${key}: ${value}`.trimEnd());

  return head + out.join('\n') + rest;
}

/**
 * 先写同目录临时文件，再 `rename` 盖回去。失败时删掉临时件，原文件一个字节不动。
 * 不建目录 —— 调用方必须已经确认目标文件存在。
 *
 * @param {string} abs 已存在的目标文件
 * @param {string} text 整份新内容
 */
export function replaceFileAtomic(abs, text) {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, abs);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时件没写成，不用再删
    }
    throw err;
  }
}
