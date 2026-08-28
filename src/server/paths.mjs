/**
 * 路径闸门 —— **不变量 2 的唯一载体**。
 *
 * `resolveInside` 原本是 `http.mjs` 的模块内私有函数。采集(`capture.mjs`)也要用它,
 * 提到这里是为了**只存在一份**:复制出来的第二份迟早会跟这份漂,
 * 而它挡的是「工作空间外的任意路径」这一类问题,漂了就是安全洞。
 *
 * 新增任何接收路径参数的接口 / 写入函数,第一件事就是过它。
 */
import path from 'node:path';

/**
 * 把相对路径解回工作空间内的绝对路径,挡掉 `../` 穿越。
 * @param {string} root 工作空间根
 * @param {string} relPath 相对路径(允许空,等于根本身)
 * @returns {string} 绝对路径
 * @throws {Error & { statusCode: number }} 越界时抛 403
 */
export function resolveInside(root, relPath) {
  const abs = path.resolve(root, relPath || '');
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    const err = new Error('路径超出工作空间范围');
    err.statusCode = 403;
    throw err;
  }
  return abs;
}
