/**
 * 读一份 .docx 的生成标记（docProps/custom.xml 里的 `aispace-docx-generator`）。只读。
 *
 * 为什么服务端也要读：转换前「同名文件能不能覆盖」必须服务端与脚本各校验一次（不变量 1 第九条第 ⑥ 款），
 * 扫描时也要把它告诉前端，弹窗才知道该给「覆盖」勾选还是直接拒绝。
 * Node 没有内置 zip 解析，这里只实现需要的那一点：找中央目录 → 定位一个条目 → inflate。
 * 不是完整的 zip 实现（不支持 zip64、加密），遇到读不了的一律当「没有标记」—— 宁可拒绝覆盖。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

// 与工作空间 scripts/docxkit/ooxml.py 的 MARKER 同名，改一边要改另一边
export const DOCX_MARKER = 'aispace-docx-generator';
const PART = 'docProps/custom.xml';
const MAX_BYTES = 200 * 1024 * 1024;

function readEntry(buf, wanted) {
  // End of central directory：从尾部往前找签名（注释最长 65535 字节）
  const floor = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      if (buf.readUInt32LE(localAt) !== 0x04034b50) return null;
      const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
      const data = buf.subarray(dataAt, dataAt + compSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/**
 * @param {string} abs .docx 的绝对路径（调用方已过 resolveInside）
 * @returns {string | null} 标记里的工具链版本；没有标记、读不了一律 null
 */
export function readDocxMarker(abs) {
  try {
    const stats = fs.statSync(abs);
    if (!stats.isFile() || stats.size > MAX_BYTES) return null;
    const xml = readEntry(fs.readFileSync(abs), PART)?.toString('utf8');
    if (!xml) return null;
    const m = xml.match(new RegExp(`name="${DOCX_MARKER}"[^>]*>\\s*<vt:lpwstr>([^<]*)</vt:lpwstr>`));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
