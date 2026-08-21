#!/usr/bin/env python3
"""把电力监控系统的**点表**批量归一成一张可检索的测点主表。

为什么不用 ingest.py
--------------------
`ingest.py` 是「一个源文件 → 一份可读产物」的通用管线。点表不一样：它天然是
**成百上千个同构小文件**，价值不在于逐个可读，而在于**汇总后能按测点检索**——
「棉花滩所有水位相关测点是哪些」这种问题，翻 572 个 csv 没法回答。
所以本脚本的产物是一张主表 + 一个 sqlite 索引，而不是一堆平行文件。

支持的点表形态（parser 可插拔，见 PARSERS）
-------------------------------------------
- `hydro_xls`  表格型：.xls / .xlsx，首行表头 + 数据行，设备层级来自**目录路径**。
               典型来源：南瑞水电集控系统导出（模拟量 / 开关量 / SOE量 / 温度量）。
- `scada_ini`  分段型：.txt，`[RTU]` / `[遥信]` / `[遥测]` / `[遥控]` 分段，
               逗号分隔数据行，编码 GBK 与 UTF-8 混杂。典型来源：风电 / 光伏集中监控。

产物（写到 input/converted/<点表集名>/）
---------------------------------------
    _manifest.md      轻量台账：规模、分布、字段说明、已知局限。**看板预览请点这个**
    测点主表.csv      全量测点，统一 18 列，含溯源列（源文件 + 源行号）
    分册/<厂站>.csv   按厂站拆分，单个文件小，适合预览和发给对方核对
    测点.sqlite       建好索引，供 Agent 做 SQL 精确检索，不必把表读进上下文

设计原则
--------
1. **零 Python 依赖**：.xls 走自带的 scripts/xls_reader.py，.xlsx 走标准库 zipfile+ET。
   跟 ingest.py 一样，换台机器不用 pip 就能跑。
2. **只归一，不臆造**：脚本负责把各种格式摊平成统一列，不做设备树绑定、
   不生成测点编码——那些是各厂站一份的业务规则，属于工程侧实施范畴（见 _manifest.md）。
3. **可溯源**：每行都带源文件路径和行号，任何一条结论都能追回原始文件。

用法
----
    python3 scripts/pointtable.py                          # 自动发现 input/raw/ 下的点表目录
    python3 scripts/pointtable.py input/raw/集控点表        # 只处理指定目录
    python3 scripts/pointtable.py --dry-run                # 只打印计划
    python3 scripts/pointtable.py --force                  # 忽略缓存重建
    python3 scripts/pointtable.py --no-sqlite              # 不产出 sqlite
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
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from layout import (  # noqa: E402  input/ 的共用约定，三个转换脚本共用一份
    MERGE_DIR, add_ignore_flags, ignore_patterns, is_ignored, md_link,
    merge_paths, safe_component,
)
from xls_reader import XlsError, read_xls  # noqa: E402  与本脚本同目录

REPO = Path(__file__).resolve().parent.parent
RAW = REPO / "input" / "raw"
CONVERTED = REPO / "input" / "converted"

XLNS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

# 统一测点 schema。顺序即 csv 列序，改动请同步 _manifest.md 的字段说明。
COLUMNS = [
    "厂站", "设备分区", "设备名", "点类型", "测点描述",
    "测点地址", "点号", "节点别名", "设备型号",
    "信号下限", "信号上限", "量程下限", "量程上限", "系数A", "系数B",
    "是否备用", "源文件", "源行号",
]

# 表格型点表的表头别名 → 统一列名。不同厂家导出的列名略有出入，在这里收敛。
HEADER_ALIAS = {
    "实际测点地址": "测点地址", "测点地址": "测点地址", "地址": "测点地址",
    "描述": "测点描述", "测点名称": "测点描述", "点名": "测点描述", "名称": "测点描述",
    "点号": "点号", "序号": "点号",
    "节点别名": "节点别名", "别名": "节点别名",
    "低信号": "信号下限", "高信号": "信号上限",
    "低量程": "量程下限", "高量程": "量程上限",
    "系数A": "系数A", "系数B": "系数B",
    "设备型号": "设备型号", "型号": "设备型号",
}

# 「备用」占位点：设备侧预留的空测点，不承载业务含义，标记出来供分析时过滤
SPARE_RE = re.compile(r"备用|预留|未使用|spare", re.I)


def log(msg: str) -> None:
    print(msg, flush=True)


def sha256_of(paths: list[Path]) -> str:
    """整个点表集的指纹：路径 + 内容，任一文件变了就会变。"""
    h = hashlib.sha256()
    for p in sorted(paths):
        h.update(str(p).encode("utf-8"))
        h.update(p.read_bytes())
    return h.hexdigest()


def decode_text(data: bytes) -> str:
    """点表 txt 的编码很杂：UTF-8 BOM、UTF-8、GBK 混在同一个目录里。"""
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", "replace")
    for enc in ("utf-8", "gb18030"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("gb18030", "replace")


def has_cjk(text: str) -> bool:
    return any("一" <= ch <= "鿿" for ch in text)


# --------------------------------------------------------------------------- #
# xlsx 读取（标准库；.xls 走 xls_reader）
# --------------------------------------------------------------------------- #

def _col_index(ref: str) -> int:
    n = 0
    for ch in ref:
        if not ch.isalpha():
            break
        n = n * 26 + (ord(ch.upper()) - 64)
    return n - 1


def read_xlsx(path: Path) -> list[tuple[str, list[list[str]]]]:
    """返回 [(sheet 名, 行数据)]。够点表用的最小实现。"""
    out = []
    with zipfile.ZipFile(path) as zf:
        strings: list[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in root.iter(f"{XLNS}si"):
                strings.append("".join(t.text or "" for t in si.iter(f"{XLNS}t")))
        names = {}
        try:
            wb = ET.fromstring(zf.read("xl/workbook.xml"))
            for i, sh in enumerate(wb.iter(f"{XLNS}sheet"), 1):
                names[f"xl/worksheets/sheet{i}.xml"] = sh.get("name") or f"sheet{i}"
        except KeyError:
            pass
        for member in sorted(n for n in zf.namelist()
                             if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)):
            root = ET.fromstring(zf.read(member))
            rows: list[list[str]] = []
            for row in root.iter(f"{XLNS}row"):
                cells: list[str] = []
                for cell in row.findall(f"{XLNS}c"):
                    ref = cell.get("r") or ""
                    pos = _col_index(ref) if ref and ref[0].isalpha() else len(cells)
                    while len(cells) < pos:
                        cells.append("")
                    if cell.get("t") == "inlineStr":
                        node = cell.find(f"{XLNS}is")
                        text = "".join(t.text or "" for t in node.iter(f"{XLNS}t")) if node is not None else ""
                    else:
                        v = cell.find(f"{XLNS}v")
                        raw = v.text or "" if v is not None else ""
                        if cell.get("t") == "s":
                            i = int(raw or 0)
                            text = strings[i] if 0 <= i < len(strings) else ""
                        else:
                            text = raw
                            try:
                                num = float(raw)
                                text = str(int(num)) if num.is_integer() else repr(num)
                            except ValueError:
                                pass
                    cells.append(text.strip())
                rows.append(cells)
            while rows and not any(rows[-1]):
                rows.pop()
            out.append((names.get(member, Path(member).stem), rows))
    return out


# --------------------------------------------------------------------------- #
# parser：表格型（水电集控）
# --------------------------------------------------------------------------- #

def parse_hydro_table(path: Path, root: Path) -> list[dict]:
    """表格型点表：首行表头，其余是测点。设备层级从**目录路径**还原。

    典型路径 `集控点表/龙岩集控中心/数据库/棉花滩1#机组/模拟量.xls`：
    厂站=龙岩集控中心，设备分区=棉花滩1#机组，点类型=模拟量（取自文件名）。
    """
    try:
        sheets = ([(s.name, s.rows) for s in read_xls(path)] if path.suffix.lower() == ".xls"
                  else read_xlsx(path))
    except (XlsError, zipfile.BadZipFile, ET.ParseError) as exc:
        log(f"  ⚠ 跳过 {path.relative_to(root)}：{exc}")
        return []

    rel = path.relative_to(root)
    parts = list(rel.parts[:-1])
    # 「数据库」这类纯容器目录不携带业务含义，去掉后层级更干净
    parts = [p for p in parts if p not in ("数据库", "点表", "database")]
    station = parts[0] if parts else root.name
    zone = "/".join(parts[1:]) if len(parts) > 1 else ""
    point_type = path.stem

    records: list[dict] = []
    for _, rows in sheets:
        if len(rows) < 2:
            continue
        header = [HEADER_ALIAS.get(h.strip(), "") for h in rows[0]]
        for lineno, row in enumerate(rows[1:], start=2):
            if not any(v.strip() for v in row):
                continue
            rec = {c: "" for c in COLUMNS}
            rec.update({"厂站": station, "设备分区": zone, "点类型": point_type,
                        "源文件": str(rel), "源行号": lineno})
            for i, col in enumerate(header):
                if col and i < len(row):
                    rec[col] = row[i]
            if not rec["测点描述"]:
                continue
            rec["是否备用"] = "是" if SPARE_RE.search(rec["测点描述"]) else ""
            records.append(rec)
    return records


# --------------------------------------------------------------------------- #
# parser：分段型（风电 / 光伏集中监控）
# --------------------------------------------------------------------------- #

SECTION_RE = re.compile(r"^\[(.+?)\]\s*$")

def parse_scada_ini(path: Path, root: Path) -> list[dict]:
    """分段型点表：`[RTU]` 段给厂站描述，`[遥信]`/`[遥测]` 等段给测点。

    字段位置各厂站不同（风机文件第 3 字段才是测点名，升压站第 2 字段就是），
    所以这里用**内容启发式**而不是写死列号：
      - 第 1 字段恒为通信 ID
      - 测点描述 = ID 之后第一个含中文、且不像设备路径的字段
      - 设备路径 = 形如 `#1光伏区/#1方阵/箱变` 的字段（以 # 开头且含 /）
      - 设备名 = 描述之后的中文字段；都没有时，按 `_` 从描述里切前缀

    刻意**不做**设备树绑定 / 间隔匹配 / 测点编码生成：那些依赖每个厂站一份的
    业务规则表（见同目录 `*-测点解析规则.md`），属于工程侧数据接入范畴。
    本脚本保留原始行，让这类规则可以随时基于主表另行推导。
    """
    text = decode_text(path.read_bytes())
    rel = path.relative_to(root)
    station_desc, section = "", ""
    records: list[dict] = []

    for lineno, line in enumerate(text.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        m = SECTION_RE.match(line)
        if m:
            section = m.group(1).strip()
            continue
        if section.upper() == "RTU":
            fields = [f.strip() for f in line.split(",")]
            if len(fields) >= 2:
                station_desc = fields[1]
            continue
        if not section or line.startswith(("BASE=", "base=")):
            continue

        fields = [f.strip() for f in line.split(",")]
        if len(fields) < 2 or not fields[0]:
            continue

        path_field = next((f for f in fields[1:] if f.startswith("#") and "/" in f), "")
        cjk = [(i, f) for i, f in enumerate(fields) if i and has_cjk(f) and f != path_field]
        if not cjk:
            continue
        desc = cjk[0][1]
        device_idx, device = cjk[1] if len(cjk) > 1 else (None, "")
        if not device and not path_field and "_" in desc:
            device = desc.split("_", 1)[0]
        # 型号紧跟在设备名之后（风机第 5 字段、光伏第 6 字段）。
        # 不能简单地「取第一个 ASCII 字段」——那会命中设备名之前的简单编号（如 XBYX01）。
        model = ""
        if device_idx is not None:
            model = next((f for f in fields[device_idx + 1:]
                          if f and not has_cjk(f) and f != path_field
                          and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9\-]{2,}", f)
                          and not f.isdigit()), "")

        rec = {c: "" for c in COLUMNS}
        rec.update({
            "厂站": rel.parts[0] if len(rel.parts) > 1 else root.name,
            "设备分区": path_field or station_desc or path.stem,
            "设备名": device,
            "点类型": section,
            "测点描述": desc,
            "测点地址": fields[0],
            "设备型号": model,
            "是否备用": "是" if SPARE_RE.search(desc) else "",
            "源文件": str(rel),
            "源行号": lineno,
        })
        records.append(rec)
    return records


# 格式探测顺序：先看扩展名，.txt 再嗅探是否有分段头
PARSERS = [
    ("hydro_xls", {".xls", ".xlsx", ".xlsm"}, parse_hydro_table),
    ("scada_ini", {".txt"}, parse_scada_ini),
]


def looks_like_point_table(path: Path) -> bool:
    """表格文件的表头是不是点表？

    光看扩展名不够：`input/raw/` 下的普通 xlsx（指标体系、层级对应表）也是表格，
    误判会让它们既进不了点表主表、又被 ingest.py 让走，两边都漏。
    判据是表头必须同时有「描述」和「地址/点号」两类列——这是点表区别于一般报表的特征。
    """
    try:
        sheets = ([(s.name, s.rows) for s in read_xls(path)] if path.suffix.lower() == ".xls"
                  else read_xlsx(path))
    except (XlsError, zipfile.BadZipFile, ET.ParseError, OSError):
        return False
    for _, rows in sheets:
        if not rows:
            continue
        mapped = {HEADER_ALIAS.get(h.strip(), "") for h in rows[0]}
        if "测点描述" in mapped and mapped & {"测点地址", "点号"}:
            return True
    return False


def detect(path: Path) -> str | None:
    suffix = path.suffix.lower()
    for name, suffixes, _ in PARSERS:
        if suffix not in suffixes:
            continue
        if name == "scada_ini":
            lines = decode_text(path.read_bytes()[:4096]).splitlines()
            if not lines or not SECTION_RE.match(lines[0].strip()):
                return None                                   # 普通 txt，交给 ingest.py
        elif not looks_like_point_table(path):
            return None                                       # 普通表格，交给 ingest.py
        return name
    return None


def parser_for(name: str):
    return next(fn for n, _, fn in PARSERS if n == name)


# --------------------------------------------------------------------------- #
# 产物
# --------------------------------------------------------------------------- #

def write_outputs(name: str, records: list[dict], src_dir: Path,
                  digest: str, stats: dict, want_sqlite: bool) -> Path:
    """正文写进镜像目录的 `MergedObject/`，摘要写在镜像目录里。返回摘要路径。"""
    manifest_path, out_dir = merge_paths(src_dir)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    (out_dir / "分册").mkdir(parents=True)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)

    master = out_dir / "测点主表.csv"
    with master.open("w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(records)

    by_station: dict[str, list[dict]] = defaultdict(list)
    for r in records:
        by_station[r["厂站"] or "未分类"].append(r)
    for station, rows in sorted(by_station.items()):
        with (out_dir / "分册" / f"{safe_component(station)}.csv").open(
                "w", encoding="utf-8-sig", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=COLUMNS)
            w.writeheader()
            w.writerows(rows)

    db_path = out_dir / "测点.sqlite"
    if want_sqlite:
        conn = sqlite3.connect(db_path)
        cols = ", ".join(f'"{c}"' for c in COLUMNS)
        conn.execute(f'CREATE TABLE 测点 ({cols})')
        conn.executemany(
            f'INSERT INTO 测点 ({cols}) VALUES ({",".join("?" * len(COLUMNS))})',
            [[r[c] for c in COLUMNS] for r in records])
        for col in ("厂站", "点类型", "设备分区", "是否备用"):
            conn.execute(f'CREATE INDEX idx_{safe_component(col)} ON 测点("{col}")')
        conn.commit()
        conn.close()

    write_manifest(manifest_path, name, src_dir, digest, stats, by_station,
                   master, db_path if want_sqlite else None)
    return manifest_path


def write_manifest(manifest_path: Path, name: str, src_dir: Path, digest: str, stats: dict,
                   by_station: dict, master: Path, db_path: Path | None) -> None:
    total = stats["总数"]
    spare = stats["备用"]
    # source 是**目录**（几百个源文件汇总成一份产物），跟 ingest.py 的一对一不同。
    # 看板据此判断「待转换」，所以还要声明消费了哪些扩展名——否则要么源文件一直挂在
    # 待转换列表里，要么整个目录被一刀切标成已处理，把 .bak 这类真没处理的文件也藏掉。
    lines = [
        "---",
        f"source: {src_dir.relative_to(REPO)}",
        f"source_is_dir: true",
        f"source_kinds: {', '.join(sorted(stats['扩展名']))}",
        f"source_files: {stats['文件数']}",
        f"source_sha256: {digest}",
        # 正文目录，相对本摘要所在目录写。ingest.py 靠它判断产物完不完整，看板靠它把
        # 摘要和正文认成同一份产物。
        f"payload: {MERGE_DIR}",
        "converted_by: scripts/pointtable.py",
        f"converted_at: {dt.datetime.now().astimezone().isoformat(timespec='seconds')}",
        f"point_count: {total}",
        "---",
        "",
        f"# {name} · 测点台账",
        "",
        f"源目录 `{src_dir.relative_to(REPO)}`，共 **{stats['文件数']} 个文件**，"
        f"解析出 **{total:,} 个测点**（其中备用占位 {spare:,} 个，"
        f"有效约 {total - spare:,} 个）。",
        "",
        "## 产物怎么用",
        "",
        "| 文件 | 用途 |",
        "| --- | --- |",
        f"| `{MERGE_DIR}/测点主表.csv` | 全量 {total:,} 行。**体积较大，看板里别直接点开**，用 Excel 打开或按需下载 |",
        f"| `{MERGE_DIR}/分册/*.csv` | 按厂站拆分，单个文件小，适合预览、也适合单独发给某厂站的对接人核对 |",
    ]
    if db_path:
        lines.append(f"| `{MERGE_DIR}/测点.sqlite` | 供 AI 做 SQL 精确检索，不占对话上下文。见下方示例 |")
    lines += [f"| `{manifest_path.name}` | 就是本文件，轻量摘要，**预览请点这里** |", "",
              f"正文都在同目录的 [`{MERGE_DIR}/`]({md_link('./' + MERGE_DIR)}) 下"
              "（整个目录的几百个点表汇总成这一份，所以套一层 MergedObject）。", ""]

    lines += ["## 规模分布", "", "### 按厂站", "", "| 厂站 | 测点数 | 其中备用 |", "| --- | ---: | ---: |"]
    for station, rows in sorted(by_station.items(), key=lambda kv: -len(kv[1])):
        sp = sum(1 for r in rows if r["是否备用"])
        lines.append(f"| {station} | {len(rows):,} | {sp:,} |")

    lines += ["", "### 按点类型", "", "| 点类型 | 测点数 |", "| --- | ---: |"]
    for ptype, cnt in stats["点类型"].most_common():
        lines.append(f"| {ptype} | {cnt:,} |")

    lines += [
        "", "## 字段说明", "",
        "| 列 | 含义 |", "| --- | --- |",
        "| 厂站 | 集控中心 / 电站 / 场站，来自源目录第一层 |",
        "| 设备分区 | 机组、开关站、公用系统等，来自目录层级或点表内的设备路径字段 |",
        "| 设备名 | 分段型点表里的具体设备（如「1号风机」）；表格型点表通常为空 |",
        "| 点类型 | 表格型取自文件名（模拟量/开关量/SOE量/温度量/开出量）；分段型取自段标识（遥信/遥测/遥控/遥调） |",
        "| 测点描述 | **主检索字段**，测点中文名 |",
        "| 测点地址 | 表格型为「实际测点地址」；分段型为通信 ID |",
        "| 信号下限/上限、量程下限/上限、系数A/B | 模拟量的工程量转换参数，开关量为空 |",
        "| 是否备用 | 描述里含「备用/预留/未使用」的占位点，分析时通常应排除 |",
        "| 源文件、源行号 | **溯源**：任何一条测点都能追回原始文件的具体行 |",
        "",
        "## 已知局限（重要）", "",
        "- 本脚本只做**格式归一**，不做设备树绑定、间隔匹配、测点编码生成。"
        "那些依赖每个厂站一份的业务规则表，属于工程侧数据接入范畴，不是需求分析的输入。",
        "- 分段型点表的「设备名」由内容启发式推断（中文字段位置、`_` 前缀），"
        "**属于推断，不是资料写明的事实**；写进正式文档前需要按 `*-测点解析规则.md` 核对。",
        "- 「是否备用」按关键词判断，可能有漏判。",
        "",
    ]
    if db_path:
        lines += [
            "## SQL 检索示例", "",
            "```bash",
            f'sqlite3 "{db_path.relative_to(REPO)}" \\',
            '  "SELECT 厂站,设备分区,测点描述,测点地址 FROM 测点',
            "   WHERE 测点描述 LIKE '%水位%' AND 是否备用='' LIMIT 20;\"",
            "```",
            "",
        ]
    manifest_path.write_text("\n".join(lines), encoding="utf-8")


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #

def collect_pointtable_dirs(patterns: list[str]) -> list[Path]:
    """自动发现：input/raw/ 下**直接子目录**中含可识别点表文件的，算一个点表集。

    忽略清单在这里格外要紧：探测要逐个读文件头，客户一次交来的上千份存量资料全扫一遍
    要好几分钟。整个目录被忽略时直接跳过，连走都不走进去。
    """
    found = []
    for child in sorted(RAW.iterdir()):
        if not child.is_dir() or child.name.startswith(".") or is_ignored(child, patterns):
            continue
        for p in child.rglob("*"):
            if (p.is_file() and not p.name.startswith(".")
                    and not is_ignored(p, patterns) and detect(p)):
                found.append(child)
                break
    return found


def process(src_dir: Path, patterns: list[str], force: bool, dry_run: bool,
            want_sqlite: bool) -> bool:
    files = [p for p in sorted(src_dir.rglob("*"))
             if p.is_file() and not p.name.startswith(".") and not is_ignored(p, patterns)]
    targets = [(p, detect(p)) for p in files]
    targets = [(p, k) for p, k in targets if k]
    if not targets:
        log(f"⚠ {src_dir.relative_to(REPO)}：没有识别到点表文件")
        return False

    kinds = Counter(k for _, k in targets)
    log(f"\n▶ {src_dir.relative_to(REPO)}　{len(targets)} 个点表文件　"
        f"({', '.join(f'{k}×{v}' for k, v in kinds.items())})")
    if dry_run:
        return False

    digest = sha256_of([p for p, _ in targets])
    manifest, payload = merge_paths(src_dir)
    if not force and manifest.is_file() and payload.is_dir():
        for line in manifest.read_text(encoding="utf-8").splitlines()[:10]:
            if line.startswith("source_sha256:") and line.split(":", 1)[1].strip() == digest:
                log("  ✓ 内容未变，跳过（--force 可强制重建）")
                return False

    records: list[dict] = []
    for p, kind in targets:
        records.extend(parser_for(kind)(p, src_dir))
    if not records:
        log("  ⚠ 一条测点都没解析出来，产物未生成")
        return False

    stats = {
        "文件数": len(targets),
        "总数": len(records),
        "备用": sum(1 for r in records if r["是否备用"]),
        "点类型": Counter(r["点类型"] for r in records),
        "扩展名": {p.suffix.lower() for p, _ in targets},
    }
    out = write_outputs(src_dir.name, records, src_dir, digest, stats, want_sqlite)
    log(f"  ✓ {stats['总数']:,} 个测点（备用 {stats['备用']:,}）→ {out.relative_to(REPO)}")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="点表批量归一：多格式点表 → 统一测点主表 + sqlite 索引")
    ap.add_argument("paths", nargs="*", help="点表目录；省略则自动发现 input/raw/ 下的点表集")
    ap.add_argument("--force", action="store_true", help="忽略缓存强制重建")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划，不写产物")
    ap.add_argument("--no-sqlite", action="store_true", help="不产出 sqlite 索引")
    add_ignore_flags(ap)
    args = ap.parse_args()
    patterns = ignore_patterns(args)

    if args.paths:
        dirs = [Path(p) if Path(p).is_absolute() else REPO / p for p in args.paths]
        missing = [d for d in dirs if not d.is_dir()]
        if missing:
            log("找不到目录：" + "、".join(str(d) for d in missing))
            return 1
    else:
        dirs = collect_pointtable_dirs(patterns)
        if not dirs:
            log("input/raw/ 下没有发现点表目录。把点表放进去（支持 .xls/.xlsx 表格型、"
                "[RTU]/[遥信] 分段型 .txt）再跑一次。")
            return 0

    CONVERTED.mkdir(parents=True, exist_ok=True)
    changed = sum(process(d, patterns, args.force, args.dry_run, not args.no_sqlite)
                  for d in dirs)
    if not args.dry_run:
        log(f"\n完成：{changed} 个点表集有更新。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
