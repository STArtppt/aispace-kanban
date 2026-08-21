#!/usr/bin/env python3
"""把现场系统导出的**实测数据**（时序数据）归一成一个可 SQL 检索的时序库。

为什么不用 ingest.py / pointtable.py
------------------------------------
`ingest.py` 是「一个源文件 → 一份可读产物」的通用管线，`pointtable.py` 解决的是
「成百上千个同构点表 → 一张可检索的测点主表」。现场实测数据是第三种形态：

    一个几十上百 MB 的导出文件，几十万上百万行，列名是 senid / time / v 这种系统内部字段，
    人读不了、AI 也不能整个读进上下文——但它是**验证需求可行性的唯一硬证据**：
    某个测点现场到底有没有数、多久来一次、有没有断流、值域合不合理。

所以本脚本的产物不是「可读文本」，而是**一个建好索引、并且已经跟测点字典对齐的 sqlite**，
外加一份轻量台账。AI 用 SQL 精确取几十行回来，不必把数据读进上下文。

支持的形态（dialect 靠**表头**识别，不看扩展名）
------------------------------------------------
任何「一行一条测值」的 csv / txt 导出，只要表头里能认出三类列：

    测点标识列   senid / sensorid / pointid / point_code / tagname / 测点编码 …
    时间列       time / ts / datetime / 采集时间 / 时间 …
    数值列       v / value / val / 数值 / 测值 …

状态、质量、类型这些**可选列**认出来就带上，认不出来就留空——现场系统各家不同，
不强求对齐。列名别名收在 ID_ALIASES / TIME_ALIASES / VALUE_ALIASES / OPTIONAL_ALIASES，
遇到新系统在那里加一行即可。

测点字典
--------
实测数据里只有 senid，没有中文名。脚本会自动到 `input/converted/` 找已转换的**测点字典**
（标准化测点表 `测点表point-info.csv`，兜底用「ID + 名称」两列的测点清单），
按 code_sd / code_jk / point_code 多键匹配，把流域、场站、测点名称、单位补齐，
并在 `字典来源` 列里记下这条信息是从哪份字典来的（溯源要求）。
**匹配不上的测点不丢弃、不猜名字**，单独出一份 `未匹配测点.csv`。

产物（写到 input/converted/<数据集名>/）
---------------------------------------
    _manifest.md        轻量台账：规模、时间范围、覆盖率、质量体检、**表结构和 SQL 范例**。
                        看板预览请点这个；AI 要写 SQL 也只需要读这个
    实测数据.sqlite      主产物：测点维表 + 实测事实表 + 日统计 + 视图，建好索引
    测点覆盖清单.csv     一行一个测点：字典信息 + 记录数 + 时间范围 + 值域 + 完整率
    日统计.csv           一行一个测点一天：条数 / 极值 / 均值，用 Excel 就能看趋势
    未匹配测点.csv       字典里查不到的测点（有才生成）——这是要向现场确认的缺口

设计原则
--------
1. **零 Python 依赖**：只用标准库，跟 ingest.py / pointtable.py 一致。
2. **流式处理**：几百万行也不会把内存吃满，逐行累计统计、分批写 sqlite。
3. **只归一，不臆造**：状态码含义、日月顺序这类脚本判不了的事，写进台账的
   「待确认」而不是替客户决定。

用法
----
    python3 scripts/realdata.py                        # 自动发现 input/raw/ 下的现场数据目录
    python3 scripts/realdata.py input/raw/现场数据      # 只处理指定目录（给文件也行，按其所在目录算一个数据集）
    python3 scripts/realdata.py --dry-run              # 只打印识别结果和计划
    python3 scripts/realdata.py --force                # 忽略缓存重建
    python3 scripts/realdata.py --time-format "%m/%d/%Y %H:%M:%S"   # 日月顺序有歧义时手工指定
    python3 scripts/realdata.py --no-sqlite            # 只出 csv 和台账
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import re
import shutil
import sqlite3
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
RAW = REPO / "input" / "raw"
CONVERTED = REPO / "input" / "converted"

# 现场导出常见的载体。xlsx 不在此列：几十万行的时序数据没人用 xlsx 导，
# 真遇到了先让用户另存为 csv，比在这里塞一个 OOXML 流式解析器划算。
DATA_SUFFIXES = {".csv", ".txt", ".tsv"}

# 列别名（按优先级排列，精确匹配小写去空格后的表头）。遇到新系统在这里加。
ID_ALIASES = ("senid", "sensorid", "sensor_id", "pointid", "point_id", "pointcode",
              "point_code", "tagname", "tag_name", "tag", "code_sd", "code_jk",
              "测点id", "测点编码", "测点标识", "点号")
TIME_ALIASES = ("time", "ts", "timestamp", "datetime", "date_time", "tm",
                "recordtime", "record_time", "collecttime", "collect_time",
                "时间", "时标", "采集时间", "记录时间")
VALUE_ALIASES = ("v", "value", "val", "fvalue", "data_value", "数值", "值", "测值")
# 可选列：统一列名 → 源表头别名。认出来就带上，认不出来留空。
OPTIONAL_ALIASES = {
    "状态码": ("s", "status", "state", "状态", "状态码"),
    "质量位": ("flag", "quality", "qflag", "质量", "质量位"),
    "数据类型": ("valuetype", "value_type", "datatype", "data_type", "数据类型"),
    "运行类型": ("rundatatype", "run_data_type", "runtype", "run_type", "运行类型"),
    "更新时间": ("utime", "updatetime", "update_time", "更新时间"),
    "入库时间": ("etl_time", "etltime", "loadtime", "load_time", "入库时间"),
}
OPTIONAL_COLUMNS = list(OPTIONAL_ALIASES)

# 时间格式候选。ISO 类放前面（无歧义）；斜杠类的日月顺序在 sniff_time 里按数据判定。
TIME_FORMATS = (
    "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M", "%Y%m%d%H%M%S",
    "%d/%m/%Y %H:%M:%S", "%m/%d/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%m/%d/%Y %H:%M",
    "%Y-%m-%d", "%Y/%m/%d", "%d/%m/%Y", "%m/%d/%Y",
)
EPOCH_S, EPOCH_MS = "@s", "@ms"        # 纪元秒 / 毫秒，当作两个特殊「格式」

SLASH_DATE = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})")

BATCH = 20000                          # sqlite 分批写入的行数


def log(msg: str) -> None:
    print(msg, flush=True)


def slugify(name: str) -> str:
    name = unicodedata.normalize("NFKC", name)
    name = re.sub(r"[\s_]+", "-", name.strip())
    name = re.sub(r"[^\w一-鿿.-]+", "", name)
    return re.sub(r"-{2,}", "-", name).strip("-.") or "untitled"


def rel(path: Path) -> str:
    return str(path.relative_to(REPO)) if path.is_relative_to(REPO) else str(path)


def sha256_of(paths: list[Path]) -> str:
    """整个数据集的指纹：路径 + 内容。任一文件变了就会变。"""
    h = hashlib.sha256()
    for p in sorted(paths):
        h.update(str(p).encode("utf-8"))
        with p.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
    return h.hexdigest()


def sniff_encoding(path: Path) -> str:
    """现场导出的编码很杂：UTF-8 BOM、UTF-8、GBK 都见过。用前 1MB 判一次。"""
    head = path.read_bytes()[: 1 << 20]
    if head.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    try:
        head.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError:
        return "gb18030"


def guess_delimiter(line: str) -> str:
    return max((",", "\t", ";", "|"), key=line.count)


def norm_header(cell: str) -> str:
    return cell.strip().strip('"').strip().lstrip("﻿").lower()


def pick(header: list[str], aliases: tuple[str, ...]) -> str | None:
    for alias in aliases:
        if alias in header:
            return alias
    return None


# --------------------------------------------------------------------------- #
# 时间解析
# --------------------------------------------------------------------------- #

def parse_time(raw: str, fmt: str) -> dt.datetime | None:
    raw = raw.strip()
    if not raw:
        return None
    try:
        if fmt == EPOCH_S:
            return dt.datetime.fromtimestamp(int(raw))
        if fmt == EPOCH_MS:
            return dt.datetime.fromtimestamp(int(raw) / 1000)
        return dt.datetime.strptime(raw, fmt)
    except (ValueError, OSError, OverflowError):
        return None


def sniff_time(samples: list[str]) -> tuple[str | None, str]:
    """从样本里判定时间格式。返回 (格式, 需要写进台账的提醒)。

    斜杠日期的日月顺序是**数据决定**的：只要出现过 >12 的那一段就是「日」。
    两段都 ≤12 时无法判定——这时不猜，选一个默认值并把歧义写进台账让人确认。
    """
    vals = [s.strip() for s in samples if s and s.strip()]
    if not vals:
        return None, ""
    if all(v.isdigit() for v in vals):
        width = {len(v) for v in vals}
        if width <= {10}:
            return EPOCH_S, ""
        if width <= {13}:
            return EPOCH_MS, ""

    order, note = list(TIME_FORMATS), ""
    firsts = [int(m.group(1)) for m in map(SLASH_DATE.match, vals) if m]
    seconds = [int(m.group(2)) for m in map(SLASH_DATE.match, vals) if m]
    if firsts:
        if max(firsts) > 12:
            order.sort(key=lambda f: "%d/%m" not in f)
        elif max(seconds) > 12:
            order.sort(key=lambda f: "%m/%d" not in f)
        else:
            order.sort(key=lambda f: "%d/%m" not in f)
            note = ("斜杠日期的日/月顺序两段都 ≤12，**无法从数据判定**，"
                    "已按「日/月/年」解析。若现场系统实际导出「月/日/年」，"
                    "请用 `--time-format \"%m/%d/%Y %H:%M:%S\"` 重跑。")
    for fmt in order:
        if all(parse_time(v, fmt) for v in vals):
            return fmt, note
    return None, note


# --------------------------------------------------------------------------- #
# 格式探测
# --------------------------------------------------------------------------- #

def detect(path: Path) -> dict | None:
    """这个文件是不是「一行一条测值」的现场实测数据？是就返回列映射，不是返回 None。

    判据是表头能同时认出**测点标识 + 时间 + 数值**三类列，且时间列**确实解析得出时间**——
    只看列名会把普通报表误判进来。
    """
    if path.suffix.lower() not in DATA_SUFFIXES:
        return None
    try:
        head = path.read_bytes()[: 1 << 16]
    except OSError:
        return None
    try:
        text = head.decode("utf-8-sig" if head.startswith(b"\xef\xbb\xbf") else "utf-8")
    except UnicodeDecodeError:
        text = head.decode("gb18030", "replace")
    lines = text.splitlines()
    if len(lines) < 3:                     # 表头 + 至少一行数据（末行可能被截断，丢掉）
        return None
    delim = guess_delimiter(lines[0])
    rows = list(csv.reader(lines[:-1], delimiter=delim))
    if not rows:
        return None
    header = [norm_header(c) for c in rows[0]]
    id_col, time_col, value_col = (pick(header, ID_ALIASES), pick(header, TIME_ALIASES),
                                   pick(header, VALUE_ALIASES))
    if not (id_col and time_col and value_col):
        return None
    idx = header.index(time_col)
    samples = [r[idx] for r in rows[1:80] if len(r) == len(header)]
    fmt, note = sniff_time(samples)
    if not fmt:
        return None
    optional = {}
    for uniform, aliases in OPTIONAL_ALIASES.items():
        hit = pick(header, aliases)
        if hit and hit not in (id_col, time_col, value_col):
            optional[uniform] = hit
    return {"分隔符": delim, "表头": header, "测点列": id_col, "时间列": time_col,
            "数值列": value_col, "可选列": optional, "时间格式": fmt, "时间提醒": note}


# --------------------------------------------------------------------------- #
# 测点字典：把 senid 翻译成人话
# --------------------------------------------------------------------------- #

DICT_FIELDS = ["测点编码", "测点名称", "测点类型", "单位", "流域",
               "场站编码", "场站名称", "设备编码", "设备名称", "数据来源", "字典来源"]


def _read_csv(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8-sig", errors="replace") as fh:
        return list(csv.DictReader(fh))


def _stations_of(dir_: Path) -> dict[str, str]:
    """同一份标准化表里的场站表：场站编码 → 流域名。"""
    out: dict[str, str] = {}
    for p in dir_.glob("*station-info*.csv"):
        for row in _read_csv(p):
            code = (row.get("code") or "").strip()
            if code:
                out[code] = (row.get("bas_name") or "").strip()
    return out


def load_point_dict() -> tuple[dict[str, dict], list[str]]:
    """扫 input/converted/ 建测点字典索引：多个编码键都指向同一条测点记录。

    优先用标准化测点表（字段最全）；再用「ID + 名称」形态的测点清单兜底，
    只补标准化表没覆盖到的编码。每条都带 `字典来源`，任何一条翻译都能追回出处。
    """
    index: dict[str, dict] = {}
    used: list[str] = []

    for path in sorted(CONVERTED.rglob("*point-info*.csv")):
        rows = _read_csv(path)
        if not rows or "point_code" not in rows[0]:
            continue
        basins = _stations_of(path.parent)
        for row in rows:
            rec = {
                "测点编码": (row.get("point_code") or "").strip(),
                "测点名称": (row.get("point_name") or "").strip(),
                "测点类型": (row.get("point_flag") or "").strip(),
                "单位": (row.get("unit") or "").strip(),
                "流域": basins.get((row.get("sta_code") or "").strip(), ""),
                "场站编码": (row.get("sta_code") or "").strip(),
                "场站名称": (row.get("sta_name") or "").strip(),
                "设备编码": (row.get("dev_code") or "").strip(),
                "设备名称": (row.get("dev_name") or "").strip(),
                "数据来源": (row.get("source") or "").strip(),
                "字典来源": rel(path),
            }
            for key in (row.get("code_sd"), row.get("code_jk"), row.get("point_code")):
                key = (key or "").strip()
                if key:
                    index.setdefault(key, rec)
        used.append(rel(path))

    for path in sorted(CONVERTED.rglob("*.csv")):
        if "point-info" in path.name:
            continue
        try:
            with path.open(newline="", encoding="utf-8-sig", errors="replace") as fh:
                header = [norm_header(c) for c in next(csv.reader(fh), [])]
        except OSError:
            continue
        # 只认「ID + 名称」这种窄表，宽表歧义太大，宁可不认
        if not (2 <= len(header) <= 4):
            continue
        id_col = pick(header, ("id", "测点id", "测点编码", "code", "编码"))
        name_col = pick(header, ("name", "名称", "测点名称", "descr", "描述"))
        if not (id_col and name_col):
            continue
        added = 0
        for row in _read_csv(path):
            row = {norm_header(k): v for k, v in row.items() if k}
            key = (row.get(id_col) or "").strip()
            if not key or key in index:
                continue
            index[key] = dict.fromkeys(DICT_FIELDS, "") | {
                "测点名称": (row.get(name_col) or "").strip(), "字典来源": rel(path)}
            added += 1
        if added:
            used.append(f"{rel(path)}（兜底补 {added} 条）")
    return index, used


# --------------------------------------------------------------------------- #
# 逐行累计：一个测点一个累加器，不把数据留在内存里
# --------------------------------------------------------------------------- #

class PointStat:
    __slots__ = ("n", "first", "last", "vmin", "vmax", "vsum", "nnum", "nonnum",
                 "states", "prev", "gaps", "back", "days")

    def __init__(self) -> None:
        self.n = 0                        # 记录数
        self.first = self.last = None     # 时间范围
        self.vmin = self.vmax = None
        self.vsum = 0.0
        self.nnum = 0                     # 数值可解析的行数
        self.nonnum = 0                   # 非数值 / 空值行数
        self.states: Counter = Counter()
        self.prev = None                  # 上一行时间，用来量采样间隔
        self.gaps: Counter = Counter()
        self.back = 0                     # 时间倒序的行数（导出未按时间排序）
        self.days: dict[str, list] = {}

    def add(self, ts: dt.datetime, day: str, value: float | None, state: str) -> None:
        self.n += 1
        if self.first is None or ts < self.first:
            self.first = ts
        if self.last is None or ts > self.last:
            self.last = ts
        if self.prev is not None:
            delta = int((ts - self.prev).total_seconds())
            if delta > 0:
                self.gaps[delta] += 1
            elif delta < 0:
                self.back += 1
        self.prev = ts
        self.states[state] += 1
        d = self.days.get(day)
        if d is None:
            # [条数, 最小, 最大, 求和, 数值行数, 首值, 末值, 空值数]
            d = self.days[day] = [0, None, None, 0.0, 0, None, None, 0]
            self.days[day] = d
        d[0] += 1
        if value is None:
            self.nonnum += 1
            d[7] += 1
            return
        self.nnum += 1
        self.vsum += value
        self.vmin = value if self.vmin is None else min(self.vmin, value)
        self.vmax = value if self.vmax is None else max(self.vmax, value)
        d[3] += value
        d[4] += 1
        d[1] = value if d[1] is None else min(d[1], value)
        d[2] = value if d[2] is None else max(d[2], value)
        if d[5] is None:
            d[5] = value
        d[6] = value

    @property
    def interval(self) -> int | None:
        """采样间隔取相邻两点间隔的**中位数**。

        不用众数：现场时钟有抖动（299 / 300 / 301 秒各占一片），众数会被抖动切碎；
        也不用均值：断流一次就被大空档带偏。
        """
        if not self.gaps:
            return None
        half, seen = sum(self.gaps.values()) / 2, 0
        for gap in sorted(self.gaps):
            seen += self.gaps[gap]
            if seen >= half:
                return gap
        return None

    @property
    def regularity(self) -> float | None:
        """间隔规律性：落在中位间隔 ±10% 以内的间隔占比。

        定时采集的测点接近 100%；翻斗式雨量、变化上传这类**事件驱动**的测点会很低——
        对它们算「完整率」没有意义，这个比例就是用来把两者区分开的。
        """
        iv = self.interval
        if not iv:
            return None
        tol = max(1, round(iv * 0.1))
        near = sum(n for gap, n in self.gaps.items() if abs(gap - iv) <= tol)
        return round(near * 100 / sum(self.gaps.values()), 1)

    @property
    def expected(self) -> int | None:
        iv = self.interval
        if not iv or self.first is None or self.last is None:
            return None
        return int((self.last - self.first).total_seconds() // iv) + 1


def to_float(raw: str) -> float | None:
    try:
        return float(raw.strip())
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- #
# 主流程：扫一遍文件 → 写 sqlite → 出 csv 和台账
# --------------------------------------------------------------------------- #

FACT_COLUMNS = ["测点ID", "时间", "日期", "数值"] + OPTIONAL_COLUMNS
DIM_COLUMNS = (["测点ID"] + DICT_FIELDS +
               ["记录数", "起始时间", "结束时间", "采样间隔秒", "间隔规律性%", "期望条数", "缺测条数",
                "完整率%", "最小值", "最大值", "平均值", "空值数", "恒定值", "状态码分布"])
DAY_COLUMNS = ["测点ID", "日期", "条数", "最小值", "最大值", "平均值", "首值", "末值", "空值数"]


def scan(files: list[tuple[Path, dict]], conn: sqlite3.Connection | None,
         time_format: str | None) -> tuple[dict[str, PointStat], dict]:
    stats: dict[str, PointStat] = defaultdict(PointStat)
    issues = {"总行数": 0, "时间解析失败": 0, "空测点ID": 0, "文件": [],
              # 可选列的取值分布：只有一种取值的列没必要逐行存 612 万遍，转换后会被裁掉
              "可选列取值": {c: Counter() for c in OPTIONAL_COLUMNS}}
    buffer: list[tuple] = []

    for path, dialect in files:
        fmt = time_format or dialect["时间格式"]
        enc = sniff_encoding(path)
        rows = bad_time = 0
        with path.open(newline="", encoding=enc, errors="replace") as fh:
            reader = csv.reader(fh, delimiter=dialect["分隔符"])
            header = [norm_header(c) for c in next(reader, [])]
            pos = {name: header.index(name) for name in header}
            i_id, i_ts, i_v = (pos[dialect["测点列"]], pos[dialect["时间列"]],
                               pos[dialect["数值列"]])
            i_opt = [(name, pos[src]) for name, src in dialect["可选列"].items()]
            for row in reader:
                if len(row) <= max(i_id, i_ts, i_v):
                    continue
                rows += 1
                pid = row[i_id].strip()
                if not pid:
                    issues["空测点ID"] += 1
                    continue
                ts = parse_time(row[i_ts], fmt)
                if ts is None:
                    bad_time += 1
                    continue
                value = to_float(row[i_v])
                opt = {name: row[j].strip() if j < len(row) else "" for name, j in i_opt}
                for name, val in opt.items():
                    seen = issues["可选列取值"][name]
                    if len(seen) < 64 or val in seen:
                        seen[val] += 1
                day = ts.strftime("%Y-%m-%d")
                stats[pid].add(ts, day, value, opt.get("状态码", ""))
                if conn is not None:
                    buffer.append((pid, ts.strftime("%Y-%m-%d %H:%M:%S"), day, value,
                                   *[opt.get(c, "") for c in OPTIONAL_COLUMNS]))
                    if len(buffer) >= BATCH:
                        insert_fact(conn, buffer)
                        buffer.clear()
        issues["总行数"] += rows
        issues["时间解析失败"] += bad_time
        issues["文件"].append({"路径": rel(path), "行数": rows, "时间解析失败": bad_time,
                               "编码": enc, "时间格式": fmt, "方言": dialect})
    if conn is not None and buffer:
        insert_fact(conn, buffer)
    return stats, issues


def prune_constant_columns(conn: sqlite3.Connection, issues: dict) -> list[tuple[str, str]]:
    """把「全表只有一种取值」的可选列从事实表里裁掉，取值记进元信息。

    现场导出常带一堆恒定不变的系统字段（valuetype 全是 CALC_RT 之类）。
    逐行存几十万遍既占体积又没有信息量——裁掉，但**不丢信息**：
    取值写进 `元信息`，台账里也会说明，需要时仍可追溯。
    """
    dropped = []
    for col in OPTIONAL_COLUMNS:
        seen = issues["可选列取值"][col]
        if len(seen) > 1:
            continue
        value = next(iter(seen), "")            # 源文件没有这一列时 seen 是空的
        conn.execute(f'ALTER TABLE 实测 DROP COLUMN "{col}"')
        dropped.append((col, value if seen else "（源文件无此列）"))
    return dropped


def insert_fact(conn: sqlite3.Connection, rows: list[tuple]) -> None:
    conn.executemany(
        f'INSERT INTO 实测 ({",".join(chr(34) + c + chr(34) for c in FACT_COLUMNS)}) '
        f'VALUES ({",".join("?" * len(FACT_COLUMNS))})', rows)


def build_dim(stats: dict[str, PointStat], pdict: dict[str, dict]) -> list[dict]:
    out = []
    for pid, st in sorted(stats.items()):
        info = pdict.get(pid) or dict.fromkeys(DICT_FIELDS, "")
        # 间隔不规律的测点（事件驱动上传）没有「应该有多少条」这回事，
        # 硬算一个完整率只会被当成缺测误报——留空，让 间隔规律性% 说话
        expected = st.expected if (st.regularity or 0) >= 60 else None
        missing = max(0, expected - st.n) if expected else None
        row = {"测点ID": pid}
        row.update({k: info.get(k, "") for k in DICT_FIELDS})
        row.update({
            "记录数": st.n,
            "起始时间": st.first.strftime("%Y-%m-%d %H:%M:%S") if st.first else "",
            "结束时间": st.last.strftime("%Y-%m-%d %H:%M:%S") if st.last else "",
            "采样间隔秒": st.interval or "",
            "间隔规律性%": st.regularity if st.regularity is not None else "",
            "期望条数": expected if expected else "",
            "缺测条数": missing if missing is not None else "",
            "完整率%": round(st.n * 100 / expected, 1) if expected else "",
            "最小值": st.vmin if st.vmin is not None else "",
            "最大值": st.vmax if st.vmax is not None else "",
            "平均值": round(st.vsum / st.nnum, 4) if st.nnum else "",
            "空值数": st.nonnum,
            "恒定值": 1 if st.nnum and st.vmin == st.vmax else 0,
            "状态码分布": " | ".join(f"{k or '(空)'}:{v}" for k, v in st.states.most_common()),
        })
        out.append(row)
    return out


def build_days(stats: dict[str, PointStat]) -> list[dict]:
    out = []
    for pid, st in sorted(stats.items()):
        for day, d in sorted(st.days.items()):
            out.append({
                "测点ID": pid, "日期": day, "条数": d[0],
                "最小值": d[1] if d[1] is not None else "",
                "最大值": d[2] if d[2] is not None else "",
                "平均值": round(d[3] / d[4], 4) if d[4] else "",
                "首值": d[5] if d[5] is not None else "",
                "末值": d[6] if d[6] is not None else "",
                "空值数": d[7],
            })
    return out


def write_csv(path: Path, columns: list[str], rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=columns)
        w.writeheader()
        w.writerows(rows)


def finish_sqlite(conn: sqlite3.Connection, dim: list[dict], days: list[dict],
                  meta: list[tuple[str, str]], kept: list[str]) -> int:
    cols = ",".join(f'"{c}"' for c in DIM_COLUMNS)
    conn.executemany(f'INSERT INTO 测点 ({cols}) VALUES ({",".join("?" * len(DIM_COLUMNS))})',
                     [[r[c] for c in DIM_COLUMNS] for r in dim])
    cols = ",".join(f'"{c}"' for c in DAY_COLUMNS)
    conn.executemany(f'INSERT INTO 日统计 ({cols}) VALUES ({",".join("?" * len(DAY_COLUMNS))})',
                     [[r[c] for c in DAY_COLUMNS] for r in days])
    conn.executemany("INSERT INTO 元信息 (键, 值) VALUES (?, ?)", meta)

    # 只建两个索引：按测点取序列、按时间横切。「日期」不单独建索引——
    # 它和 (测点ID,时间) 前缀重合，多出来的十几 MB 换不来什么。
    conn.execute('CREATE INDEX idx_实测_测点时间 ON 实测("测点ID", "时间")')
    conn.execute('CREATE INDEX idx_实测_时间 ON 实测("时间")')
    conn.execute('CREATE INDEX idx_测点_场站 ON 测点("场站名称")')
    conn.execute('CREATE INDEX idx_测点_名称 ON 测点("测点名称")')
    conn.execute('CREATE INDEX idx_日统计 ON 日统计("测点ID", "日期")')
    # 视图：AI 直接查视图就能拿到中文名，不用自己写 join
    extra = "".join(f", f.{c}" for c in kept)
    conn.execute(f"""
        CREATE VIEW v_实测 AS
        SELECT d.流域, d.场站名称, d.测点名称, d.测点类型, d.单位,
               f.测点ID, f.时间, f.日期, f.数值{extra}
        FROM 实测 f LEFT JOIN 测点 d ON d.测点ID = f.测点ID
    """)
    conn.execute("""
        CREATE VIEW v_日统计 AS
        SELECT d.流域, d.场站名称, d.测点名称, d.单位,
               s.测点ID, s.日期, s.条数, s.最小值, s.最大值, s.平均值, s.首值, s.末值, s.空值数
        FROM 日统计 s LEFT JOIN 测点 d ON d.测点ID = s.测点ID
    """)
    dupes = conn.execute(
        "SELECT count(*) FROM (SELECT 测点ID, 时间 FROM 实测 GROUP BY 1,2 HAVING count(*) > 1)"
    ).fetchone()[0]
    conn.commit()
    conn.execute("VACUUM")
    conn.close()
    return dupes


# --------------------------------------------------------------------------- #
# 台账
# --------------------------------------------------------------------------- #

def write_manifest(out_dir: Path, name: str, src_dir: Path, digest: str,
                   dim: list[dict], issues: dict, dict_sources: list[str],
                   dupes: int | None, has_db: bool, unmatched: int,
                   dropped: list[tuple[str, str]]) -> None:
    total_rows = issues["总行数"]
    points = len(dim)
    starts = [r["起始时间"] for r in dim if r["起始时间"]]
    ends = [r["结束时间"] for r in dim if r["结束时间"]]
    t0, t1 = (min(starts) if starts else ""), (max(ends) if ends else "")
    notes = sorted({f["方言"]["时间提醒"] for f in issues["文件"] if f["方言"]["时间提醒"]})

    by_station = Counter(r["场站名称"] or ("（字典未标场站）" if r["测点名称"] else "（字典未命中）")
                         for r in dim)
    by_type = Counter(r["测点类型"] or "（未标注）" for r in dim)
    by_interval = Counter(r["采样间隔秒"] or "无法判定" for r in dim)
    const = sum(1 for r in dim if r["恒定值"] == 1)
    regular = [r for r in dim if isinstance(r["间隔规律性%"], float) and r["间隔规律性%"] >= 60]
    irregular = [r for r in dim if isinstance(r["间隔规律性%"], float) and r["间隔规律性%"] < 60]
    low = [r for r in regular if isinstance(r["完整率%"], float) and r["完整率%"] < 95]
    empty = [r for r in dim if r["记录数"] and r["空值数"] == r["记录数"]]
    states = Counter()
    for r in dim:
        for part in (r["状态码分布"] or "").split(" | "):
            if ":" in part:
                k, v = part.rsplit(":", 1)
                states[k] += int(v)

    db_rel = f"{rel(out_dir)}/实测数据.sqlite"
    lines = [
        "---",
        f"source: {rel(src_dir)}",
        "source_is_dir: true",
        f"source_kinds: {', '.join(sorted({Path(f['路径']).suffix for f in issues['文件']}))}",
        f"source_files: {len(issues['文件'])}",
        f"source_sha256: {digest}",
        "converted_by: scripts/realdata.py",
        f"converted_at: {dt.datetime.now().astimezone().isoformat(timespec='seconds')}",
        f"row_count: {total_rows}",
        f"point_count: {points}",
        f"time_start: {t0}",
        f"time_end: {t1}",
        "---",
        "",
        f"# {name} · 现场实测数据台账",
        "",
        f"源目录 `{rel(src_dir)}`，{len(issues['文件'])} 个文件、**{total_rows:,} 行测值**，"
        f"覆盖 **{points:,} 个测点**，时间范围 **{t0} ~ {t1}**。",
        "",
        "> 这是**现场已接入数据库的真实数据**，不是设计文档。它能回答的是"
        "「某个测点现场到底有没有数、多久来一次、值合不合理」——需求可行性的硬证据。",
        "",
        "## 产物怎么用",
        "",
        "| 文件 | 用途 |",
        "| --- | --- |",
    ]
    if has_db:
        lines.append(f"| `实测数据.sqlite` | **主产物**。测点维表 + 实测事实表 + 日统计 + 视图，"
                     f"建好索引。AI 查数一律走 SQL，见下方表结构和范例 |")
    lines += [
        f"| `测点覆盖清单.csv` | 一行一个测点（{points:,} 行）：字典信息 + 记录数 + 时间范围 + 值域 + 完整率 |",
        "| `日统计.csv` | 一行一个测点一天：条数 / 极值 / 均值，用 Excel 就能看趋势 |",
    ]
    if unmatched:
        lines.append(f"| `未匹配测点.csv` | 字典里查不到的 {unmatched} 个测点，**这是要向现场确认的缺口** |")
    lines += ["| `_manifest.md` | 就是本文件，轻量摘要，**预览请点这里** |", "",
              "**不要把原始导出文件或 `实测数据.sqlite` 的事实表整表读进上下文**"
              "（几十万行），用 SQL 取回需要的几十行。", ""]

    if has_db:
        lines += [
            "## 表结构（写 SQL 前看这里就够）", "",
            f"```", f"sqlite3 \"{db_rel}\"", "```", "",
            "| 表 / 视图 | 说明 |",
            "| --- | --- |",
            "| `测点` | 测点维表，一行一个测点。已按测点字典补齐流域 / 场站 / 中文名 / 单位，并带覆盖统计 |",
            f"| `实测` | 事实表，一行一条测值（{total_rows:,} 行）。`时间` 为 `YYYY-MM-DD HH:MM:SS` 文本，可直接比较和排序 |",
            "| `日统计` | 预聚合：一行一个测点一天。看趋势别扫事实表，查这张 |",
            "| `v_实测` | `实测` 左连 `测点` 的视图，**带中文名，日常查询首选** |",
            "| `v_日统计` | `日统计` 左连 `测点` 的视图 |",
            "| `元信息` | 键值对：源文件、指纹、列映射、转换时间等溯源信息 |",
            "",
            "`测点` 表关键列：`测点ID`（即源文件的 "
            f"`{issues['文件'][0]['方言']['测点列']}` 列）、`测点名称`、`测点类型`、`单位`、"
            "`流域`、`场站名称`、`记录数`、`采样间隔秒`（中位数）、`间隔规律性%`、`完整率%`、`最小值`、`最大值`、"
            "`平均值`、`恒定值`、`状态码分布`、`字典来源`。",
            "",
        ]
        if dropped:
            lines += [
                "源文件里**全表只有一种取值**的列没有逐行存（几十万行存同一个值没有信息量），"
                "取值记在 `元信息` 表里：",
                "",
                "| 源列 | 全表取值 |", "| --- | --- |",
            ]
            lines += [f"| `{col}` | {val or '(空)'} |" for col, val in dropped]
            lines.append("")

    lines += ["## 覆盖情况", "", "### 按场站", "", "| 场站 | 测点数 |", "| --- | ---: |"]
    for station, cnt in by_station.most_common():
        lines.append(f"| {station} | {cnt:,} |")
    lines += ["", "### 按测点类型", "", "| 测点类型 | 测点数 |", "| --- | ---: |"]
    for ptype, cnt in by_type.most_common(20):
        lines.append(f"| {ptype} | {cnt:,} |")
    lines += ["", "### 按采样间隔（相邻两点间隔的中位数）", "", "| 间隔 | 测点数 |", "| --- | ---: |"]
    for iv, cnt in sorted(by_interval.items(), key=lambda kv: -kv[1]):
        label = f"{iv} 秒" if isinstance(iv, int) else str(iv)
        if isinstance(iv, int) and iv % 60 == 0:
            label += f"（{iv // 60} 分钟）"
        lines.append(f"| {label} | {cnt:,} |")

    lines += [
        "", "## 数据质量体检", "",
        "| 检查项 | 结果 |", "| --- | --- |",
        f"| 总行数 | {total_rows:,} |",
        f"| 时间解析失败 | {issues['时间解析失败']:,} 行 |",
        f"| 测点 ID 为空 | {issues['空测点ID']:,} 行 |",
    ]
    if dupes is not None:
        lines.append(f"| 同测点同时刻重复 | {dupes:,} 组 |")
    lines += [
        f"| 字典未命中测点 | {unmatched:,} 个 |",
        f"| 字典命中但没写场站 | {sum(1 for r in dim if r['测点名称'] and not r['场站名称']):,} 个"
        "（这些测点在标准化表里没有场站编码，归属需现场确认）|",
        f"| 全程无有效数值的测点 | {len(empty):,} 个 |",
        f"| 全程恒定不变的测点 | {const:,} 个（值域为单点，可能是常数配置或采集卡死，需现场确认）|",
        f"| 定时采集但完整率 < 95% | {len(low):,} 个（间隔规律性 ≥60%，缺的是真缺测）|",
        f"| 间隔不规律的测点 | {len(irregular):,} 个（规律性 <60%，多为雨量这类**事件驱动**测点，"
        "完整率对它们不适用，别当缺测报）|",
        "",
    ]
    if states:
        lines += ["### 状态码分布", "", "| 状态码 | 行数 |", "| --- | ---: |"]
        for k, v in states.most_common(10):
            lines.append(f"| {k} | {v:,} |")
        lines.append("")

    lines += ["## 转换口径与溯源", "", "| 项 | 值 |", "| --- | --- |"]
    for f in issues["文件"]:
        d = f["方言"]
        lines.append(f"| 源文件 | `{f['路径']}`（{f['行数']:,} 行，编码 {f['编码']}）|")
        lines.append(f"| 列映射 | 测点=`{d['测点列']}`、时间=`{d['时间列']}`、数值=`{d['数值列']}`"
                     + (f"，可选列 {'、'.join(f'{k}=`{v}`' for k, v in d['可选列'].items())}"
                        if d["可选列"] else "") + " |")
        lines.append(f"| 时间格式 | `{f['时间格式']}` |")
    lines.append("| 测点字典 | " + "；".join(f"`{s}`" for s in dict_sources or ["（无）"]) + " |")
    lines += [
        "",
        "## 已知局限与待确认（重要）", "",
        "- 脚本只做**格式归一 + 字典对齐**，不做单位换算、不做异常值剔除、不补缺测。"
        "「采样间隔」是相邻两点间隔的中位数、「完整率」是按它推算的期望条数比对出来的，"
        "**都是统计口径，不是现场承诺的采集频率**。",
        "- 先看 `间隔规律性%` 再看 `完整率%`：规律性低于 60% 的测点（雨量站、变化上传的量）"
        "本来就不定时上传，**脚本不给它们算完整率**（`期望条数`/`缺测条数`/`完整率%` 留空），"
        "要判断它们有没有数据问题只能结合业务含义人工看。",
        "- 测点中文名、场站、单位来自 `input/converted/` 里的测点字典（见上表 `字典来源`），"
        "**字典本身的准确性未经现场确认**；引用到正式文档前需要核对。",
        "- 状态码 / 质量位的**取值含义资料里没有说明**，脚本原样保留、不做解释。"
        "把它当筛选条件之前，先向现场确认每个取值的含义（写进 `output/analysis/open-questions.md`）。",
        "- 「恒定值」「完整率低」只是**信号**，不等于数据有问题——可能是该测点本来就不变"
        "（如设计参数），也可能是采集中断。要区分只能问现场。",
    ]
    for note in notes:
        lines.append(f"- {note}")
    lines.append("")

    if has_db:
        lines += [
            "## SQL 范例", "",
            "```bash",
            "# 1. 找测点：某类测点现场有没有数",
            f'sqlite3 "{db_rel}" \\',
            '  "SELECT 测点ID,场站名称,测点名称,单位,记录数,采样间隔秒,\\"完整率%\\"',
            "   FROM 测点 WHERE 测点名称 LIKE '%水位%' ORDER BY 场站名称 LIMIT 30;\"",
            "",
            "# 2. 看某个测点这几天的日变化（别扫事实表）",
            f'sqlite3 "{db_rel}" \\',
            '  "SELECT 日期,条数,最小值,最大值,平均值 FROM v_日统计',
            "   WHERE 测点ID='<测点ID>' ORDER BY 日期;\"",
            "",
            "# 3. 取某测点某天的原始序列",
            f'sqlite3 "{db_rel}" \\',
            '  "SELECT 时间,数值,状态码 FROM 实测',
            "   WHERE 测点ID='<测点ID>' AND 日期='2026-08-15' ORDER BY 时间;\"",
            "",
            "# 4. 断流排查：某测点最长的相邻两点间隔",
            f'sqlite3 "{db_rel}" \\',
            '  "SELECT 时间, (julianday(时间)-julianday(LAG(时间) OVER (ORDER BY 时间)))*86400 AS 间隔秒',
            "   FROM 实测 WHERE 测点ID='<测点ID>' ORDER BY 间隔秒 DESC LIMIT 5;\"",
            "",
            "# 5. 场站级横比：某场站各测点的数据到位情况",
            f'sqlite3 "{db_rel}" \\',
            '  "SELECT 测点名称,记录数,\\"完整率%\\",最小值,最大值 FROM 测点',
            "   WHERE 场站名称 LIKE '%棉花滩%' ORDER BY \\\"完整率%\\\";\"",
            "```",
            "",
        ]
    (out_dir / "_manifest.md").write_text("\n".join(lines), encoding="utf-8")


# --------------------------------------------------------------------------- #
# 编排
# --------------------------------------------------------------------------- #

def collect_realdata_dirs() -> list[Path]:
    """自动发现：input/raw/ 下**直接子目录**里含可识别实测数据文件的，算一个数据集。"""
    found = []
    for child in sorted(RAW.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        for p in child.rglob("*"):
            if p.is_file() and not p.name.startswith(".") and detect(p):
                found.append(child)
                break
    return found


def process(src_dir: Path, force: bool, dry_run: bool, want_sqlite: bool,
            time_format: str | None) -> bool:
    files = []
    for p in sorted(src_dir.rglob("*")):
        if p.is_file() and not p.name.startswith("."):
            d = detect(p)
            if d:
                files.append((p, d))
    if not files:
        log(f"⚠ {rel(src_dir)}：没有识别到实测数据文件（需要表头含 测点/时间/数值 三类列）")
        return False

    size = sum(p.stat().st_size for p, _ in files) / (1 << 20)
    log(f"\n▶ {rel(src_dir)}　{len(files)} 个文件　{size:,.1f} MB")
    for p, d in files:
        log(f"    {p.name}：测点={d['测点列']} 时间={d['时间列']}（{d['时间格式']}）"
            f" 数值={d['数值列']}"
            + (f" 可选={'、'.join(d['可选列'])}" if d["可选列"] else ""))
    if dry_run:
        return False

    digest = sha256_of([p for p, _ in files])
    out_dir = CONVERTED / slugify(src_dir.name)
    manifest = out_dir / "_manifest.md"
    if not force and manifest.is_file():
        for line in manifest.read_text(encoding="utf-8").splitlines()[:14]:
            if line.startswith("source_sha256:") and line.split(":", 1)[1].strip() == digest:
                log("  ✓ 内容未变，跳过（--force 可强制重建）")
                return False

    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    conn = None
    if want_sqlite:
        conn = sqlite3.connect(out_dir / "实测数据.sqlite")
        conn.execute("PRAGMA journal_mode=OFF")
        conn.execute("PRAGMA synchronous=OFF")
        conn.execute(f'CREATE TABLE 实测 ({", ".join(chr(34) + c + chr(34) for c in FACT_COLUMNS)})')
        conn.execute(f'CREATE TABLE 测点 ({", ".join(chr(34) + c + chr(34) for c in DIM_COLUMNS)})')
        conn.execute(f'CREATE TABLE 日统计 ({", ".join(chr(34) + c + chr(34) for c in DAY_COLUMNS)})')
        conn.execute("CREATE TABLE 元信息 (键 TEXT, 值 TEXT)")

    log("  · 扫描中…")
    stats, issues = scan(files, conn, time_format)
    if not stats:
        log("  ⚠ 一行数据都没解析出来，产物未生成")
        if conn:
            conn.close()
        shutil.rmtree(out_dir)
        return False

    pdict, dict_sources = load_point_dict()
    dim = build_dim(stats, pdict)
    days = build_days(stats)
    unmatched = [r for r in dim if not r["测点名称"]]

    write_csv(out_dir / "测点覆盖清单.csv", DIM_COLUMNS, dim)
    write_csv(out_dir / "日统计.csv", DAY_COLUMNS, days)
    if unmatched:
        write_csv(out_dir / "未匹配测点.csv", DIM_COLUMNS, unmatched)

    dupes, dropped = None, []
    if conn is not None:
        dropped = prune_constant_columns(conn, issues)
        meta = [("源目录", rel(src_dir)), ("源文件指纹", digest),
                ("转换脚本", "scripts/realdata.py"),
                ("转换时间", dt.datetime.now().astimezone().isoformat(timespec="seconds")),
                ("总行数", str(issues["总行数"])), ("测点数", str(len(dim))),
                ("测点字典", "；".join(dict_sources))]
        for f in issues["文件"]:
            d = f["方言"]
            meta.append((f"源文件 {Path(f['路径']).name}",
                         f"{f['路径']}｜{f['行数']} 行｜编码 {f['编码']}｜时间格式 {f['时间格式']}"
                         f"｜列映射 测点={d['测点列']},时间={d['时间列']},数值={d['数值列']}"))
        meta += [(f"常量列 {col}", f"{val}（全表恒定，已从事实表裁掉，不逐行存）")
                 for col, val in dropped]
        kept = [c for c in OPTIONAL_COLUMNS if c not in {col for col, _ in dropped}]
        dupes = finish_sqlite(conn, dim, days, meta, kept)

    write_manifest(out_dir, src_dir.name, src_dir, digest, dim, issues, dict_sources,
                   dupes, want_sqlite, len(unmatched), dropped)
    log(f"  ✓ {issues['总行数']:,} 行 / {len(dim):,} 个测点 → {rel(out_dir)}/"
        + (f"　字典未命中 {len(unmatched)} 个" if unmatched else ""))
    return True


def main() -> int:
    ap = argparse.ArgumentParser(
        description="现场实测数据归一：时序导出 → 可 SQL 检索的 sqlite + 覆盖清单 + 台账")
    ap.add_argument("paths", nargs="*",
                    help="数据目录（给文件也行，按其所在目录算一个数据集）；省略则自动发现 input/raw/ 下的数据集")
    ap.add_argument("--force", action="store_true", help="忽略缓存强制重建")
    ap.add_argument("--dry-run", action="store_true", help="只打印识别结果和计划")
    ap.add_argument("--no-sqlite", action="store_true", help="不产出 sqlite，只出 csv 和台账")
    ap.add_argument("--time-format", help='时间格式覆盖，如 "%%m/%%d/%%Y %%H:%%M:%%S"')
    args = ap.parse_args()

    if args.paths:
        dirs = []
        for p in args.paths:
            path = Path(p) if Path(p).is_absolute() else REPO / p
            if path.is_file():
                path = path.parent
            if not path.is_dir():
                log(f"找不到：{p}")
                return 1
            if path not in dirs:
                dirs.append(path)
    else:
        dirs = collect_realdata_dirs()
        if not dirs:
            log("input/raw/ 下没有发现现场实测数据目录。把导出文件放进 input/raw/ 的一个子目录"
                "（如 input/raw/现场数据/）再跑一次。")
            return 0

    CONVERTED.mkdir(parents=True, exist_ok=True)
    changed = sum(process(d, args.force, args.dry_run, not args.no_sqlite, args.time_format)
                  for d in dirs)
    if not args.dry_run:
        log(f"\n完成：{changed} 个数据集有更新。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
