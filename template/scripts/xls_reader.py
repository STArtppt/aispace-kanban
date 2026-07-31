#!/usr/bin/env python3
"""纯标准库的 .xls（BIFF8 / Excel 97-2003）只读解析器。

为什么要自己写
--------------
`scripts/ingest.py` 的设计原则是**零 Python 依赖**（见其模块注释），换台机器不用 pip
就能跑。但 .xls 是 OLE2 复合文档 + BIFF 二进制记录流，标准库没有现成解析器，而
Homebrew / 系统 Python 往往是 externally-managed（PEP 668），`pip install xlrd`
会直接被拒。为了让点表处理脚本在任何机器上开箱即用，这里实现一个够用的子集。

覆盖范围
--------
- OLE2(CFB) 容器：FAT / MiniFAT 链表、目录项、Workbook 流提取
- BIFF8 记录：BOUNDSHEET(工作表清单)、SST/CONTINUE(共享字符串)、
  LABELSST / LABEL / RSTRING(文本)、NUMBER / RK / MULRK(数值)、
  BLANK / MULBLANK(空)、FORMULA + STRING(公式的缓存结果)
- 输出统一为字符串，数值按「整数不带小数点」规则格式化，与 ingest.py 的 csv 口径一致

不覆盖
------
公式重算、样式 / 日期格式推断、图表、宏。点表是纯数据导出，用不到这些。
需要完整能力时请用 xlrd（本模块的行为已按 xlrd 逐文件比对过）。
"""

from __future__ import annotations

import struct
from pathlib import Path

# --------------------------------------------------------------------------- #
# OLE2 (Compound File Binary) 容器
# --------------------------------------------------------------------------- #

OLE_SIGNATURE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
FREESECT = 0xFFFFFFFF
ENDOFCHAIN = 0xFFFFFFFE


class XlsError(Exception):
    """不是合法的 .xls，或用到了本模块不支持的结构。"""


class _Ole2:
    """最小可用的 OLE2 读取器：只为把某个流（如 Workbook）完整取出来。"""

    def __init__(self, data: bytes) -> None:
        if len(data) < 512 or data[:8] != OLE_SIGNATURE:
            raise XlsError("不是 OLE2 复合文档（.xls）")
        self.data = data
        self.sector_size = 1 << struct.unpack_from("<H", data, 0x1E)[0]
        self.mini_sector_size = 1 << struct.unpack_from("<H", data, 0x20)[0]
        self.mini_cutoff = struct.unpack_from("<I", data, 0x38)[0]
        first_dir = struct.unpack_from("<I", data, 0x30)[0]
        first_mini_fat = struct.unpack_from("<I", data, 0x3C)[0]
        first_difat = struct.unpack_from("<I", data, 0x44)[0]
        num_difat = struct.unpack_from("<I", data, 0x48)[0]

        self.fat = self._load_fat(first_difat, num_difat)
        self.mini_fat = self._load_chain_as_ints(first_mini_fat)
        self.dir_entries = self._load_directory(first_dir)

    # -- 扇区寻址 ---------------------------------------------------------- #

    def _sector(self, index: int) -> bytes:
        start = 512 + index * self.sector_size
        chunk = self.data[start:start + self.sector_size]
        if len(chunk) < self.sector_size:
            # 末扇区可能被截断，补零比抛错更稳（点表文件偶有尾部不对齐）
            chunk += b"\x00" * (self.sector_size - len(chunk))
        return chunk

    def _load_fat(self, first_difat: int, num_difat: int) -> list[int]:
        # DIFAT 前 109 项直接放在文件头里，超出部分才走 DIFAT 扇区链
        difat = list(struct.unpack_from("<109I", self.data, 0x4C))
        sector = first_difat
        seen = set()
        for _ in range(num_difat):
            if sector in (ENDOFCHAIN, FREESECT) or sector in seen:
                break
            seen.add(sector)
            raw = self._sector(sector)
            per = self.sector_size // 4
            entries = list(struct.unpack_from(f"<{per}I", raw, 0))
            difat.extend(entries[:-1])
            sector = entries[-1]

        fat: list[int] = []
        per = self.sector_size // 4
        for sec in difat:
            if sec in (FREESECT, ENDOFCHAIN):
                continue
            fat.extend(struct.unpack_from(f"<{per}I", self._sector(sec), 0))
        return fat

    def _chain(self, start: int) -> list[int]:
        """顺着 FAT 走出一条扇区链。带环检测，坏文件不会把我们挂死。"""
        out: list[int] = []
        seen: set[int] = set()
        sector = start
        while sector not in (ENDOFCHAIN, FREESECT) and sector < len(self.fat):
            if sector in seen:
                break
            seen.add(sector)
            out.append(sector)
            sector = self.fat[sector]
        return out

    def _load_chain_as_ints(self, start: int) -> list[int]:
        per = self.sector_size // 4
        out: list[int] = []
        for sec in self._chain(start):
            out.extend(struct.unpack_from(f"<{per}I", self._sector(sec), 0))
        return out

    def _read_stream_normal(self, start: int, size: int) -> bytes:
        buf = b"".join(self._sector(s) for s in self._chain(start))
        return buf[:size] if size else buf

    # -- 目录 -------------------------------------------------------------- #

    def _load_directory(self, first_dir: int) -> list[dict]:
        raw = b"".join(self._sector(s) for s in self._chain(first_dir))
        entries = []
        for off in range(0, len(raw) - 127, 128):
            name_len = struct.unpack_from("<H", raw, off + 64)[0]
            name = ""
            if 2 <= name_len <= 64:
                name = raw[off:off + name_len - 2].decode("utf-16-le", "replace")
            entries.append({
                "name": name,
                "type": raw[off + 66],                                  # 2=流 5=根
                "start": struct.unpack_from("<I", raw, off + 116)[0],
                "size": struct.unpack_from("<Q", raw, off + 120)[0],
            })
        return entries

    def _mini_stream(self) -> bytes:
        for e in self.dir_entries:
            if e["type"] == 5:                                          # 根条目携带 mini stream
                return self._read_stream_normal(e["start"], e["size"])
        return b""

    def read_stream(self, *names: str) -> bytes:
        """按名字取流，返回第一个命中的。小于 mini_cutoff 的走 MiniFAT。"""
        wanted = {n.lower() for n in names}
        for e in self.dir_entries:
            if e["type"] != 2 or e["name"].lower() not in wanted:
                continue
            size = e["size"]
            if size >= self.mini_cutoff:
                return self._read_stream_normal(e["start"], size)
            mini = self._mini_stream()
            out = bytearray()
            sector, seen = e["start"], set()
            while sector not in (ENDOFCHAIN, FREESECT) and sector < len(self.mini_fat):
                if sector in seen:
                    break
                seen.add(sector)
                pos = sector * self.mini_sector_size
                out += mini[pos:pos + self.mini_sector_size]
                sector = self.mini_fat[sector]
            return bytes(out[:size])
        raise XlsError(f"找不到流：{'/'.join(names)}")


# --------------------------------------------------------------------------- #
# BIFF8 记录流
# --------------------------------------------------------------------------- #

BOF, EOF_REC, BOUNDSHEET = 0x0809, 0x000A, 0x0085
SST, CONTINUE = 0x00FC, 0x003C
LABELSST, LABEL, RSTRING = 0x00FD, 0x0204, 0x00D6
NUMBER, RK, MULRK = 0x0203, 0x027E, 0x00BD
BLANK, MULBLANK = 0x0201, 0x00BE
FORMULA, STRING = 0x0006, 0x0207
DIMENSIONS = 0x0200


def _records(stream: bytes):
    """把 BIFF 流切成 (记录号, 数据) 序列，CONTINUE 单独产出由调用方处理。"""
    pos, n = 0, len(stream)
    while pos + 4 <= n:
        code, length = struct.unpack_from("<HH", stream, pos)
        pos += 4
        if pos + length > n:                                            # 尾部被截断
            break
        yield code, stream[pos:pos + length]
        pos += length


def _decode_rk(value: int) -> float:
    """RK 是 Excel 为省空间设计的 30 位压缩数值。"""
    cents = value & 0x01
    if value & 0x02:                                                    # 整数：高 30 位有符号
        num = float(value >> 2 if value < 0x80000000 else (value >> 2) - 0x40000000)
    else:                                                               # 浮点：高 30 位是 double 的高位
        num = struct.unpack("<d", struct.pack("<Q", (value & 0xFFFFFFFC) << 32))[0]
    return num / 100.0 if cents else num


def _fmt_number(num: float) -> str:
    """跟 ingest.py 的 csv 口径一致：整数不带 .0，避免污染表格。"""
    if num != num or num in (float("inf"), float("-inf")):
        return ""
    return str(int(num)) if float(num).is_integer() else repr(num)


def _unicode_string(buf: bytes, pos: int, cont: list[bytes], ci: list[int]):
    """读一个 BIFF8 XLUnicodeString。

    最难的地方在于 SST 可能跨 CONTINUE 记录，且**每段续记录会重新给一个 grbit 字节**
    来声明后半截是压缩(8位)还是非压缩(16位)。这里把续段拼接逻辑显式写出来。
    """
    def ensure(need: int):
        nonlocal buf, pos
        while pos + need > len(buf) and ci[0] < len(cont):
            buf = buf[pos:] + cont[ci[0]]
            ci[0] += 1
            pos = 0
        return buf, pos

    buf, pos = ensure(3)
    if pos + 3 > len(buf):
        return "", buf, len(buf)
    nchars = struct.unpack_from("<H", buf, pos)[0]
    flags = buf[pos + 2]
    pos += 3
    rich = struct.unpack_from("<H", buf, pos)[0] if flags & 0x08 else 0
    pos += 2 if flags & 0x08 else 0
    ext = struct.unpack_from("<I", buf, pos)[0] if flags & 0x04 else 0
    pos += 4 if flags & 0x04 else 0

    chars: list[str] = []
    wide = bool(flags & 0x01)
    remaining = nchars
    while remaining > 0:
        width = 2 if wide else 1
        avail = (len(buf) - pos) // width
        take = min(remaining, avail)
        if take > 0:
            seg = buf[pos:pos + take * width]
            chars.append(seg.decode("utf-16-le" if wide else "cp1252", "replace"))
            pos += take * width
            remaining -= take
        if remaining > 0:
            if ci[0] >= len(cont):
                break
            # 续记录：首字节是新的 grbit，只指示宽度
            nxt = cont[ci[0]]
            ci[0] += 1
            wide = bool(nxt[0] & 0x01) if nxt else wide
            buf, pos = nxt, 1
    # 跳过富文本格式与远东扩展信息
    skip = rich * 4 + ext
    while skip > 0:
        avail = len(buf) - pos
        if skip <= avail:
            pos += skip
            skip = 0
        elif ci[0] < len(cont):
            skip -= avail
            buf, pos = cont[ci[0]], 0
            ci[0] += 1
        else:
            pos = len(buf)
            break
    return "".join(chars), buf, pos


def _parse_sst(payload: bytes, continues: list[bytes]) -> list[str]:
    if len(payload) < 8:
        return []
    unique = struct.unpack_from("<I", payload, 4)[0]
    out: list[str] = []
    buf, pos, ci = payload, 8, [0]
    for _ in range(unique):
        if pos >= len(buf) and ci[0] >= len(continues):
            break
        text, buf, pos = _unicode_string(buf, pos, continues, ci)
        out.append(text)
    return out


def _short_string(data: bytes, off: int) -> str:
    """BOUNDSHEET 里的工作表名：1 字节长度 + 1 字节 grbit。"""
    n = data[off]
    flags = data[off + 1]
    if flags & 0x01:
        return data[off + 2:off + 2 + n * 2].decode("utf-16-le", "replace")
    return data[off + 2:off + 2 + n].decode("cp1252", "replace")


class Sheet:
    __slots__ = ("name", "rows")

    def __init__(self, name: str, rows: list[list[str]]) -> None:
        self.name = name
        self.rows = rows

    @property
    def nrows(self) -> int:
        return len(self.rows)

    @property
    def ncols(self) -> int:
        return max((len(r) for r in self.rows), default=0)


def read_xls(path: str | Path) -> list[Sheet]:
    """读取 .xls，返回工作表列表。每个单元格都是字符串（空单元格为 ""）。"""
    data = Path(path).read_bytes()
    workbook = _Ole2(data).read_stream("Workbook", "Book")

    # 第一遍：SST + 工作表清单。SST 后面紧跟的 CONTINUE 属于它。
    sst: list[str] = []
    boundsheets: list[tuple[int, str]] = []
    pending_sst: bytes | None = None
    continues: list[bytes] = []
    for code, payload in _records(workbook):
        if code == SST:
            if pending_sst is not None:
                sst = _parse_sst(pending_sst, continues)
            pending_sst, continues = payload, []
        elif code == CONTINUE and pending_sst is not None:
            continues.append(payload)
        elif code == BOUNDSHEET:
            pos = struct.unpack_from("<I", payload, 0)[0]
            boundsheets.append((pos, _short_string(payload, 6)))
            if pending_sst is not None:
                sst = _parse_sst(pending_sst, continues)
                pending_sst, continues = None, []
        elif code in (LABELSST, RK, MULRK, NUMBER, BLANK, MULBLANK, LABEL, FORMULA):
            if pending_sst is not None:
                sst = _parse_sst(pending_sst, continues)
                pending_sst, continues = None, []
    if pending_sst is not None:
        sst = _parse_sst(pending_sst, continues)

    if not boundsheets:
        raise XlsError("没找到任何工作表（BOUNDSHEET 记录缺失）")

    # 第二遍：按 BOUNDSHEET 记录的流偏移，逐表读单元格
    sheets: list[Sheet] = []
    for start, name in boundsheets:
        cells: dict[tuple[int, int], str] = {}
        max_row = max_col = -1

        def put(r: int, c: int, v: str) -> None:
            nonlocal max_row, max_col
            # 与 ingest.py 的 csv 口径一致：统一换行、去首尾空白
            cells[(r, c)] = v.replace("\r\n", "\n").strip()
            if r > max_row:
                max_row = r
            if c > max_col:
                max_col = c

        last_cell: tuple[int, int] | None = None
        for code, payload in _records(workbook[start:]):
            if code == EOF_REC:
                break
            try:
                if code == LABELSST:
                    r, c, _, idx = struct.unpack_from("<HHHI", payload, 0)
                    put(r, c, sst[idx] if 0 <= idx < len(sst) else "")
                elif code in (LABEL, RSTRING):
                    r, c = struct.unpack_from("<HH", payload, 0)
                    nchars = struct.unpack_from("<H", payload, 6)[0]
                    flags = payload[8]
                    raw = payload[9:9 + nchars * (2 if flags & 0x01 else 1)]
                    put(r, c, raw.decode("utf-16-le" if flags & 0x01 else "cp1252", "replace"))
                elif code == RK:
                    r, c, _, v = struct.unpack_from("<HHHI", payload, 0)
                    put(r, c, _fmt_number(_decode_rk(v)))
                elif code == MULRK:
                    r, c0 = struct.unpack_from("<HH", payload, 0)
                    count = (len(payload) - 6) // 6
                    for i in range(count):
                        v = struct.unpack_from("<I", payload, 4 + i * 6 + 2)[0]
                        put(r, c0 + i, _fmt_number(_decode_rk(v)))
                elif code == NUMBER:
                    r, c, _, v = struct.unpack_from("<HHHd", payload, 0)
                    put(r, c, _fmt_number(v))
                elif code == BLANK:
                    r, c = struct.unpack_from("<HH", payload, 0)
                    put(r, c, "")
                elif code == MULBLANK:
                    r, c0 = struct.unpack_from("<HH", payload, 0)
                    for i in range((len(payload) - 6) // 2):
                        put(r, c0 + i, "")
                elif code == FORMULA:
                    # 公式：数值结果直接在记录里；字符串结果在紧随的 STRING 记录
                    r, c = struct.unpack_from("<HH", payload, 0)
                    if payload[12:14] == b"\xff\xff" and payload[6] == 0x00:
                        last_cell = (r, c)                              # 等 STRING
                    else:
                        v = struct.unpack_from("<d", payload, 6)[0]
                        put(r, c, _fmt_number(v))
                        last_cell = None
                elif code == STRING and last_cell is not None:
                    nchars = struct.unpack_from("<H", payload, 0)[0]
                    flags = payload[2]
                    raw = payload[3:3 + nchars * (2 if flags & 0x01 else 1)]
                    put(*last_cell, raw.decode("utf-16-le" if flags & 0x01 else "cp1252", "replace"))
                    last_cell = None
            except (struct.error, IndexError):
                continue                                                # 单条坏记录不该毁掉整表

        rows = [[cells.get((r, c), "") for c in range(max_col + 1)] for r in range(max_row + 1)]
        while rows and not any(v.strip() for v in rows[-1]):
            rows.pop()
        sheets.append(Sheet(name, rows))
    return sheets


if __name__ == "__main__":
    import sys
    for arg in sys.argv[1:]:
        for sh in read_xls(arg):
            print(f"[{sh.name}] {sh.nrows} 行 x {sh.ncols} 列")
            for row in sh.rows[:5]:
                print("   ", [c[:20] for c in row[:10]])
