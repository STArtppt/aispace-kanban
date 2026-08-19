#!/usr/bin/env python3
"""把 input/raw/ 下的人类文档转换成 AI / IDE 可读的 UTF-8 文本格式。

格式分派
--------
docx/odt/rtf → pandoc（顺带抽图）　　PDF/pptx → MinerU 在线 API（没配 key 时退回 markitdown）
xlsx/xlsm/xls → 每 sheet 一个 csv（自带 OOXML / BIFF8 解析）
html/htm → 可预览单文件原型：拷贝 HTML + 校验 + _manifest.md（不转 md 正文）
纯文本 → 原样拷贝　　图片 → assets/未分类/（附 _manifest.md 记溯源）
**点表**（成百上千个同构小文件）→ 让给 scripts/pointtable.py 汇总成测点主表，本脚本不逐个转

设计原则
--------
1. **零 Python 依赖**：只用标准库 + 外部 CLI（pandoc / markitdown）+ MinerU HTTP 接口。
   xlsx 解析直接读 OOXML，.xls 走自带的 BIFF8 解析器（scripts/xls_reader.py），
   因此不需要 openpyxl / pandas / xlrd，换机器也能跑。
2. **可溯源**：每个产物都带 frontmatter，记录来源路径、sha256、转换工具和时间。
   PM 在做需求分析时必须能把一句结论追回到原始文档，这比转换质量本身更重要。
3. **幂等**：源文件 sha256 没变就跳过，`--force` 强制重转。

用法
----
    python3 scripts/ingest.py                     # 转换 input/raw/ 下所有文件
    python3 scripts/ingest.py --force             # 忽略缓存全部重转
    python3 scripts/ingest.py --dry-run           # 只打印计划
    python3 scripts/ingest.py path/to/a.docx      # 只转指定文件
    python3 scripts/ingest.py --ocr               # 扫描版 PDF，让 MinerU 走 OCR
    python3 scripts/ingest.py --pdf-engine markitdown   # 不想调用在线接口时强制本地转
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import html.parser
import re
import shutil
import subprocess
import sys
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path, PurePosixPath

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mineru  # noqa: E402  与本脚本同目录
from xls_reader import XlsError, read_xls  # noqa: E402  与本脚本同目录

REPO = Path(__file__).resolve().parent.parent
RAW = REPO / "input" / "raw"
CONVERTED = REPO / "input" / "converted"
ASSETS = REPO / "input" / "assets"
# 直接放在 input/raw/ 里的图片没有「所属文档」，统一归到这一堆，看板里就是「未分类」图库
UNSORTED = ASSETS / "未分类"
INDEX = REPO / "input" / "INDEX.md"
# 忽略清单：不进转换、也不在看板上算「待转换」的资料。gitignore 风格，看板同读这一份
IGNOREFILE = REPO / "input" / ".ingestignore"

# 直接原样拷贝的格式：已经是 AI 可读的文本
PASSTHROUGH = {".md", ".markdown", ".csv", ".tsv", ".txt", ".json", ".yaml", ".yml", ".xml"}
# 图片：拷到 assets/，由 Claude 用 Read 工具直接看图
IMAGES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
# 走 pandoc（能抽图，markdown 结构更好）。html/htm 不在这里——它们是可预览原型载体。
PANDOC = {".docx": "docx", ".odt": "odt", ".rtf": "rtf", ".epub": "epub"}
# 走 MinerU 在线 API：版式复杂、表格和公式多，本地工具啃不动
MINERU = {".pdf", ".pptx"}
# 走 markitdown（也是 MinerU 没配 key 时的兜底）
MARKITDOWN = {".pdf", ".pptx", ".msg"}  # .epub 走 pandoc，见上
# 自研 OOXML 解析 → 每个 sheet 一个 csv
SPREADSHEET = {".xlsx", ".xlsm"}
# 老版 Excel：自研 BIFF8 解析（scripts/xls_reader.py）→ 同样每个 sheet 一个 csv
LEGACY_SPREADSHEET = {".xls"}
# 单文件 HTML 原型：保留可预览 HTML + 配套 _manifest.md（校验与摘要）
HTML_PROTOTYPE = {".html", ".htm"}
# 明确不支持的老格式（.xls 不在此列，见 LEGACY_SPREADSHEET）
LEGACY = {".doc": "docx", ".ppt": "pptx", ".wps": "docx", ".et": "xlsx", ".dps": "pptx"}

XLNS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
# 注意这是两个不同的命名空间：.rels 文件里的 <Relationship> 用 package/…，
# 而 workbook.xml 里 <sheet r:id> 的 r 前缀用 officeDocument/…。混用会导致查不到 sheet。
RELNS = "{http://schemas.openxmlformats.org/package/2006/relationships}"
DOCRELNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
# Excel 内置的日期/时间 numFmtId
DATE_FMT_IDS = set(range(14, 23)) | set(range(45, 48)) | {27, 30, 36, 50, 57}


# --------------------------------------------------------------------------- #
# 工具函数
# --------------------------------------------------------------------------- #

def log(msg: str) -> None:
    print(msg, flush=True)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def slugify(name: str) -> str:
    """文件名 → 安全的 slug。保留中文（IDE 和 AI 都能处理），只压掉空格和符号。"""
    name = unicodedata.normalize("NFKC", name)
    name = re.sub(r"[\s_]+", "-", name.strip())
    name = re.sub(r"[^\w一-鿿.-]+", "", name)
    name = re.sub(r"-{2,}", "-", name).strip("-.")
    return name or "untitled"


def has_cli(name: str) -> bool:
    return shutil.which(name) is not None


def is_pointtable(src: Path) -> bool:
    """这个文件是不是该由 scripts/pointtable.py 处理的点表？

    点表是成百上千个同构小文件，逐个转换没有意义（价值在汇总后可检索），
    所以交给专门的 pointtable.py。这里复用它的格式探测，保证两边判断一致。
    """
    try:
        import pointtable
    except ImportError:
        return False
    try:
        return pointtable.detect(src) is not None
    except (OSError, ValueError):
        return False


def frontmatter(source: Path, digest: str, tool: str, extra: dict | None = None) -> str:
    meta = {
        "source": str(source.relative_to(REPO)),
        "source_sha256": digest,
        "converted_by": tool,
        "converted_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    meta.update(extra or {})
    lines = ["---"]
    for key, value in meta.items():
        if isinstance(value, list):
            lines.append(f"{key}:")
            lines.extend(f"  - {item}" for item in value)
        else:
            lines.append(f"{key}: {value}")
    lines += ["---", ""]
    return "\n".join(lines)


def read_recorded_digest(target: Path) -> str | None:
    """从已有产物里读回 source_sha256，用于判断是否需要重转。"""
    probe = target / "_manifest.md" if target.is_dir() else target
    if not probe.is_file():
        return None
    try:
        with probe.open("r", encoding="utf-8") as fh:
            if fh.readline().strip() != "---":
                return None
            for _ in range(30):
                line = fh.readline()
                if not line or line.strip() == "---":
                    return None
                if line.startswith("source_sha256:"):
                    return line.split(":", 1)[1].strip()
    except (OSError, UnicodeDecodeError):
        return None
    return None


# --------------------------------------------------------------------------- #
# xlsx / xlsm → csv（纯标准库读 OOXML）
# --------------------------------------------------------------------------- #

def col_index(cell_ref: str) -> int:
    """'BC12' → 54（0-based 列号）。"""
    idx = 0
    for ch in cell_ref:
        if not ch.isalpha():
            break
        idx = idx * 26 + (ord(ch.upper()) - 64)
    return idx - 1


def load_shared_strings(zf: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    out = []
    for si in root.findall(f"{XLNS}si"):
        # 富文本会被拆成多个 <r><t>，拼回一个字符串
        out.append("".join(t.text or "" for t in si.iter(f"{XLNS}t")))
    return out


def load_date_styles(zf: zipfile.ZipFile) -> set[int]:
    """返回「是日期格式」的 cellXfs 索引集合。"""
    if "xl/styles.xml" not in zf.namelist():
        return set()
    root = ET.fromstring(zf.read("xl/styles.xml"))
    custom_dates = set()
    for fmt in root.iter(f"{XLNS}numFmt"):
        code = (fmt.get("formatCode") or "").lower()
        # 去掉颜色/条件段再判断，避免 [Red] 里的 d 误判
        code = re.sub(r"\[[^\]]*\]|\"[^\"]*\"", "", code)
        if any(ch in code for ch in "ymdhs"):
            custom_dates.add(int(fmt.get("numFmtId")))
    date_styles = set()
    xfs = root.find(f"{XLNS}cellXfs")
    if xfs is None:
        return date_styles
    for i, xf in enumerate(xfs.findall(f"{XLNS}xf")):
        fmt_id = int(xf.get("numFmtId") or 0)
        if fmt_id in DATE_FMT_IDS or fmt_id in custom_dates:
            date_styles.add(i)
    return date_styles


def serial_to_date(serial: float, date1904: bool) -> str:
    epoch = dt.datetime(1904, 1, 1) if date1904 else dt.datetime(1899, 12, 30)
    value = epoch + dt.timedelta(days=serial)
    if abs(serial - round(serial)) < 1e-9 and serial >= 1:
        return value.strftime("%Y-%m-%d")
    return value.strftime("%Y-%m-%d %H:%M:%S")


def sheet_targets(zf: zipfile.ZipFile) -> list[tuple[str, str, bool]]:
    """返回 [(sheet 名, zip 内路径, 是否隐藏)]，保持工作簿里的顺序。"""
    rels = {}
    rel_path = "xl/_rels/workbook.xml.rels"
    if rel_path in zf.namelist():
        for rel in ET.fromstring(zf.read(rel_path)).findall(f"{RELNS}Relationship"):
            target = rel.get("Target", "")
            target = target[1:] if target.startswith("/") else f"xl/{target}"
            rels[rel.get("Id")] = target.replace("xl/xl/", "xl/")
    out = []
    root = ET.fromstring(zf.read("xl/workbook.xml"))
    for sheet in root.iter(f"{XLNS}sheet"):
        rid = sheet.get(f"{DOCRELNS}id") or sheet.get(f"{RELNS}id") or sheet.get("id")
        path = rels.get(rid)
        if path and path in zf.namelist():
            out.append((sheet.get("name") or "sheet", path, sheet.get("state") in ("hidden", "veryHidden")))
    if not out:
        # 兜底：某些生成器的 rel 结构不规范。宁可用 zip 里的 sheet 顺序，也不要静默产出 0 个 sheet。
        for path in sorted(n for n in zf.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)):
            out.append((Path(path).stem, path, False))
    return out


def read_sheet(zf: zipfile.ZipFile, path: str, strings: list[str],
               date_styles: set[int], date1904: bool) -> list[list[str]]:
    root = ET.fromstring(zf.read(path))
    rows: list[list[str]] = []
    for row in root.iter(f"{XLNS}row"):
        cells: list[str] = []
        for cell in row.findall(f"{XLNS}c"):
            ref = cell.get("r") or ""
            pos = col_index(ref) if ref and ref[0].isalpha() else len(cells)
            while len(cells) < pos:
                cells.append("")
            ctype = cell.get("t")
            if ctype == "inlineStr":
                node = cell.find(f"{XLNS}is")
                text = "".join(t.text or "" for t in node.iter(f"{XLNS}t")) if node is not None else ""
            else:
                v = cell.find(f"{XLNS}v")
                raw = v.text if v is not None and v.text is not None else ""
                if ctype == "s":                       # 共享字符串
                    i = int(raw or 0)
                    text = strings[i] if 0 <= i < len(strings) else ""
                elif ctype == "b":                     # 布尔
                    text = "TRUE" if raw == "1" else "FALSE"
                elif ctype == "e":                     # 错误值，如 #REF!
                    text = raw
                elif ctype in (None, "n", "str"):
                    text = raw
                    style = cell.get("s")
                    if ctype in (None, "n") and raw and style and int(style) in date_styles:
                        try:
                            text = serial_to_date(float(raw), date1904)
                        except ValueError:
                            pass
                    elif ctype in (None, "n") and raw:
                        # 12.0 → 12，避免整数被写成浮点污染 csv
                        try:
                            num = float(raw)
                            text = str(int(num)) if num.is_integer() else repr(num)
                        except ValueError:
                            pass
                else:
                    text = raw
            cells.append(text.replace("\r\n", "\n").strip())
        while cells and cells[-1] == "":
            cells.pop()
        rows.append(cells)
    while rows and not any(rows[-1]):
        rows.pop()
    return rows


def read_ooxml_sheets(src: Path) -> list[tuple[str, list[list[str]], bool]]:
    """xlsx / xlsm → [(sheet 名, 行, 是否隐藏)]。"""
    with zipfile.ZipFile(src) as zf:
        strings = load_shared_strings(zf)
        date_styles = load_date_styles(zf)
        wb = ET.fromstring(zf.read("xl/workbook.xml"))
        pr = wb.find(f"{XLNS}workbookPr")
        date1904 = bool(pr is not None and pr.get("date1904") in ("1", "true"))
        return [(name, read_sheet(zf, path, strings, date_styles, date1904), hidden)
                for name, path, hidden in sheet_targets(zf)]


def read_biff_sheets(src: Path) -> list[tuple[str, list[list[str]], bool]]:
    """.xls（Excel 97-2003）→ 同上。BIFF8 解析见 scripts/xls_reader.py。

    该解析器不读样式记录，拿不到「隐藏」标记，统一按不隐藏记。
    """
    return [(sheet.name, sheet.rows, False) for sheet in read_xls(src)]


def convert_spreadsheet(src: Path, digest: str) -> Path:
    """xlsx / xlsm / xls → 目录：每个 sheet 一个 csv + 一份 _manifest.md 导航。"""
    is_legacy = src.suffix.lower() in LEGACY_SPREADSHEET
    # 先解析再清空目标目录：源文件读不动时不要把上一版产物先毁掉
    sheets = read_biff_sheets(src) if is_legacy else read_ooxml_sheets(src)
    tool = "ingest.py (stdlib biff8)" if is_legacy else "ingest.py (stdlib ooxml)"

    out_dir = CONVERTED / slugify(src.stem)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    summary = []
    for name, rows, hidden in sheets:
        csv_name = f"{slugify(name)}.csv"
        with (out_dir / csv_name).open("w", encoding="utf-8-sig", newline="") as fh:
            csv.writer(fh).writerows(rows)
        width = max((len(r) for r in rows), default=0)
        header = rows[0] if rows else []
        summary.append({
            "sheet": name, "file": csv_name, "rows": len(rows),
            "cols": width, "hidden": hidden,
            "header": [c for c in header if c][:12],
        })

    lines = [frontmatter(src, digest, tool,
                         {"kind": "spreadsheet", "sheets": len(summary)})]
    lines.append(f"# {src.stem}\n")
    lines.append(f"来源：`{src.relative_to(REPO)}`，共 {len(summary)} 个 sheet。每个 sheet 一个 CSV。\n")
    lines.append("| Sheet | CSV | 行 | 列 | 表头（前 12 列） |")
    lines.append("| --- | --- | --- | --- | --- |")
    for s in summary:
        tag = " *(隐藏)*" if s["hidden"] else ""
        head = ", ".join(s["header"]) if s["header"] else "—"
        lines.append(f"| {s['sheet']}{tag} | [`{s['file']}`](./{s['file']}) | {s['rows']} | {s['cols']} | {head} |")
    lines.append("")
    (out_dir / "_manifest.md").write_text("\n".join(lines), encoding="utf-8")
    return out_dir


# --------------------------------------------------------------------------- #
# html / htm → 可预览原型目录（HTML 原件 + _manifest.md）
# --------------------------------------------------------------------------- #

def read_html_text(src: Path) -> tuple[str, str]:
    """读 HTML 文本。返回 (text, encoding_label)。优先 UTF-8，再试常见中文编码。"""
    raw = src.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw.decode("utf-8-sig"), "utf-8-sig"
    for enc in ("utf-8", "gb18030", "gbk", "big5", "latin-1"):
        try:
            return raw.decode(enc), enc
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace"), "utf-8-replace"


class _HtmlProbe(html.parser.HTMLParser):
    """轻量扫描：标题、语言、结构、外链与安全相关标记。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title_parts: list[str] = []
        self.in_title = False
        self.lang = ""
        self.has_html = False
        self.has_body = False
        self.has_doctype = False
        self.headings: list[tuple[str, str]] = []
        self.imgs_total = 0
        self.imgs_missing_alt = 0
        self.scripts_inline = 0
        self.scripts_external: list[str] = []
        self.stylesheets_external: list[str] = []
        self.iframes: list[str] = []
        self.forms_external: list[str] = []
        self.base_href = ""
        self.meta_refresh = False
        self.event_handlers = 0
        self.js_urls = 0
        self.file_urls = 0
        self._heading_tag = ""
        self._heading_parts: list[str] = []

    def handle_decl(self, decl: str) -> None:
        if decl.lower().startswith("doctype"):
            self.has_doctype = True

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        ad = {k.lower(): (v or "") for k, v in attrs}
        t = tag.lower()
        if t == "html":
            self.has_html = True
            if ad.get("lang") and not self.lang:
                self.lang = ad["lang"]
        elif t == "body":
            self.has_body = True
        elif t == "title":
            self.in_title = True
        elif t in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self._heading_tag = t
            self._heading_parts = []
        elif t == "img":
            self.imgs_total += 1
            if "alt" not in ad:
                self.imgs_missing_alt += 1
        elif t == "script":
            src = ad.get("src", "").strip()
            if src:
                self.scripts_external.append(src)
            else:
                self.scripts_inline += 1
        elif t == "link" and "stylesheet" in ad.get("rel", "").lower():
            href = ad.get("href", "").strip()
            if href:
                self.stylesheets_external.append(href)
        elif t == "iframe":
            self.iframes.append(ad.get("src", "").strip() or "(无 src)")
        elif t == "form":
            action = ad.get("action", "").strip()
            if action and re.match(r"^(https?:)?//", action, re.I):
                self.forms_external.append(action)
        elif t == "base":
            self.base_href = ad.get("href", "").strip()
        elif t == "meta" and ad.get("http-equiv", "").lower() == "refresh":
            self.meta_refresh = True

        for name, value in ad.items():
            if name.startswith("on") and value:
                self.event_handlers += 1
            if value:
                low = value.strip().lower()
                if low.startswith("javascript:"):
                    self.js_urls += 1
                if low.startswith("file:"):
                    self.file_urls += 1

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if t == "title":
            self.in_title = False
        if t == self._heading_tag and self._heading_tag:
            text = re.sub(r"\s+", " ", "".join(self._heading_parts)).strip()
            if text:
                self.headings.append((self._heading_tag, text[:80]))
            self._heading_tag = ""
            self._heading_parts = []

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(data)
        if self._heading_tag:
            self._heading_parts.append(data)


def _is_external_url(url: str) -> bool:
    u = url.strip()
    if not u or u.startswith("#") or u.startswith("data:") or u.startswith("blob:"):
        return False
    if u.startswith("//") or re.match(r"^[a-z][a-z0-9+.-]*:", u, re.I):
        # 相对路径不含 scheme；带 scheme 或 // 视为外部/绝对
        if re.match(r"^(https?:)?//", u, re.I):
            return True
        if re.match(r"^(mailto|tel):", u, re.I):
            return False
        return True  # 其它 scheme（含 javascript: 已另计）
    return False


def inspect_html(text: str, src: Path) -> dict:
    """对 HTML 做可访问性 / 安全 / 结构校验，产出供 _manifest 使用的结构化结果。"""
    probe = _HtmlProbe()
    parse_error = ""
    try:
        probe.feed(text)
        probe.close()
    except Exception as exc:  # HTMLParser 极少抛，兜住畸形输入
        parse_error = str(exc)

    title = re.sub(r"\s+", " ", "".join(probe.title_parts)).strip()
    size = src.stat().st_size
    external_scripts = [u for u in probe.scripts_external if _is_external_url(u)]
    local_scripts = [u for u in probe.scripts_external if not _is_external_url(u)]
    external_css = [u for u in probe.stylesheets_external if _is_external_url(u)]

    # 源码级补充：eval / document.write 等（parser 拿不到 script 正文细节时的兜底）
    risky_api = []
    for pat, label in (
        (r"\beval\s*\(", "eval("),
        (r"\bdocument\.write\s*\(", "document.write("),
        (r"\bnew\s+Function\s*\(", "new Function("),
        (r"\.innerHTML\s*=", "innerHTML 赋值"),
    ):
        if re.search(pat, text):
            risky_api.append(label)

    checks: list[dict] = []

    def add(name: str, ok: bool, detail: str, level: str = "info") -> None:
        checks.append({"name": name, "ok": ok, "detail": detail, "level": level})

    # —— 可打开 / 结构 ——
    if parse_error:
        add("可解析", False, f"解析异常：{parse_error}", "error")
    elif not (probe.has_doctype or probe.has_html or probe.has_body or "<" in text):
        add("可解析", False, "几乎不像 HTML（无 doctype/html/body 且无明显标签）", "error")
    else:
        bits = []
        if probe.has_doctype:
            bits.append("doctype")
        if probe.has_html:
            bits.append("<html>")
        if probe.has_body:
            bits.append("<body>")
        add("可解析", True, "、".join(bits) or "含 HTML 标签", "info")

    if size == 0:
        add("体积", False, "空文件", "error")
    elif size > 5 * 1024 * 1024:
        add("体积", False, f"{size // 1024} KB，超过 5MB，预览/分享可能卡顿", "warn")
    else:
        add("体积", True, f"{size} 字节（{size / 1024:.1f} KB）", "info")

    # —— 安全（PM 互传原型场景：标出风险，不拦截入库）——
    if external_scripts:
        sample = "；".join(external_scripts[:3])
        more = f" 等 {len(external_scripts)} 处" if len(external_scripts) > 3 else ""
        add("外链脚本", False, f"加载外部 script：{sample}{more}", "warn")
    else:
        add("外链脚本", True, "无 http(s) 外链 script", "info")

    if external_css:
        add("外链样式", False, f"{len(external_css)} 个外部 stylesheet", "warn")
    else:
        add("外链样式", True, "无外部 stylesheet（或仅相对路径）", "info")

    if probe.iframes:
        add("内嵌 iframe", False, f"{len(probe.iframes)} 个：{', '.join(probe.iframes[:3])}", "warn")
    else:
        add("内嵌 iframe", True, "无", "info")

    if probe.forms_external:
        add("表单外发", False, f"action 指向外部：{'; '.join(probe.forms_external[:2])}", "warn")
    else:
        add("表单外发", True, "无外部 form action", "info")

    if probe.meta_refresh:
        add("自动跳转", False, "存在 meta refresh", "warn")
    else:
        add("自动跳转", True, "无 meta refresh", "info")

    if probe.base_href and _is_external_url(probe.base_href):
        add("base 标签", False, f"base href 指向外部：{probe.base_href}", "warn")
    elif probe.base_href:
        add("base 标签", True, f"base href={probe.base_href}", "info")
    else:
        add("base 标签", True, "未使用", "info")

    if probe.js_urls:
        add("javascript: URL", False, f"{probe.js_urls} 处", "warn")
    else:
        add("javascript: URL", True, "无", "info")

    if probe.file_urls:
        add("file: URL", False, f"{probe.file_urls} 处（换机器会失效）", "warn")
    else:
        add("file: URL", True, "无", "info")

    if risky_api:
        add("高风险 API", False, "、".join(risky_api), "warn")
    else:
        add("高风险 API", True, "未检测到 eval / document.write / new Function / innerHTML 赋值", "info")

    if probe.event_handlers:
        add("内联事件", True, f"{probe.event_handlers} 处 onclick 等（原型常见，知悉即可）", "info")
    else:
        add("内联事件", True, "无", "info")

    # —— 可访问性（轻量）——
    if title:
        add("页面标题", True, title[:120], "info")
    else:
        add("页面标题", False, "缺少 <title>，预览标签页不易辨认", "warn")

    if probe.lang:
        add("语言属性", True, f'html lang="{probe.lang}"', "info")
    else:
        add("语言属性", False, "html 未设 lang，读屏默认语言可能不对", "warn")

    if probe.imgs_total:
        if probe.imgs_missing_alt:
            add(
                "图片 alt",
                False,
                f"{probe.imgs_missing_alt}/{probe.imgs_total} 张图缺少 alt",
                "warn",
            )
        else:
            add("图片 alt", True, f"{probe.imgs_total} 张图均有 alt", "info")
    else:
        add("图片 alt", True, "无 <img>", "info")

    if probe.headings:
        add("标题结构", True, f"{len(probe.headings)} 个 h1–h6", "info")
    else:
        add("标题结构", False, "未找到 h1–h6，结构摘要较弱", "warn")

    hard_fail = any(c["level"] == "error" and not c["ok"] for c in checks)
    soft_warn = any(c["level"] == "warn" and not c["ok"] for c in checks)
    return {
        "title": title,
        "lang": probe.lang,
        "headings": probe.headings[:20],
        "scripts_inline": probe.scripts_inline,
        "scripts_local": len(local_scripts),
        "checks": checks,
        "hard_fail": hard_fail,
        "soft_warn": soft_warn,
        "size": size,
    }


def convert_html(src: Path, digest: str) -> Path:
    """html → 目录：可预览的 .html 原件 + _manifest.md（校验与结构摘要，不把页面转成 md 正文）。"""
    out_dir = CONVERTED / slugify(src.stem)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    ext = src.suffix.lower() if src.suffix.lower() in HTML_PROTOTYPE else ".html"
    html_name = f"{slugify(src.stem)}{ext}"
    html_path = out_dir / html_name
    shutil.copy2(src, html_path)

    text, encoding = read_html_text(src)
    # 统一以 UTF-8 落盘，避免看板预览乱码；保留原件语义
    if encoding not in ("utf-8", "utf-8-sig"):
        html_path.write_text(text, encoding="utf-8")

    report = inspect_html(text, src)
    extra: dict = {
        "kind": "html-prototype",
        "preview": html_name,
        "encoding_read": encoding,
    }
    if report["hard_fail"]:
        extra["warning"] = "HTML 无法可靠打开或内容异常，请人工检查"
    elif report["soft_warn"]:
        extra["warning"] = "校验有告警（外链/无障碍等），预览前请看下方校验表"

    lines = [
        frontmatter(src, digest, "ingest.py (html prototype)", extra).rstrip(),
        "",
        f"# {src.stem}",
        "",
        f"来源：`{src.relative_to(REPO)}`。**单文件 HTML 原型**，不转成 Markdown 正文；",
        f"直接预览请打开同目录 [`{html_name}`](./{html_name})（看板输入区也会按网页预览）。",
        "",
        "## 摘要",
        "",
        f"- **标题**：{report['title'] or '（无 title）'}",
        f"- **体积**：{report['size']} 字节",
        f"- **读取编码**：{encoding}" + (" → 已重写为 UTF-8" if encoding not in ("utf-8", "utf-8-sig") else ""),
        f"- **内联脚本块**：{report['scripts_inline']}；相对路径 script：{report['scripts_local']}",
        f"- **页面语言**：{report['lang'] or '（未声明）'}",
        "",
        "## 校验结果",
        "",
        "| 项 | 结果 | 说明 |",
        "| --- | --- | --- |",
    ]
    for c in report["checks"]:
        mark = "✓" if c["ok"] else ("✗" if c["level"] == "error" else "⚠")
        detail = c["detail"].replace("|", "\\|")
        lines.append(f"| {c['name']} | {mark} | {detail} |")
    lines.append("")

    if report["headings"]:
        lines += ["## 结构线索（供 AI 阅读，非页面全文）", ""]
        for tag, text_h in report["headings"]:
            level = int(tag[1])
            lines.append(f"{'  ' * (level - 1)}- `{tag}` {text_h}")
        lines.append("")
    else:
        lines += [
            "## 结构线索（供 AI 阅读，非页面全文）",
            "",
            "未提取到标题层级。若需分析交互细节，请打开同目录 HTML 预览或向用户确认。",
            "",
        ]

    lines += [
        "## 使用约定",
        "",
        "- 这是 PM 之间传递的**可点击单文件原型**，权威交互以 HTML 预览为准。",
        "- AI 默认读本 `_manifest.md` 做台账与摘要；不要把整页 HTML 当需求正文转写进 PRD。",
        "- 正式可维护原型仍走 `prototypes/`（Axhub Make）；本目录产物只作输入资料。",
        "",
    ]
    (out_dir / "_manifest.md").write_text("\n".join(lines), encoding="utf-8")
    return out_dir


# --------------------------------------------------------------------------- #
# pandoc / markitdown / 拷贝
# --------------------------------------------------------------------------- #

def convert_pandoc(src: Path, digest: str, fmt: str) -> Path:
    slug = slugify(src.stem)
    target = CONVERTED / f"{slug}.md"
    media_rel = f"input/assets/{slug}"
    cmd = ["pandoc", str(src.relative_to(REPO)), "--from", fmt, "--to", "gfm",
           "--wrap=none", f"--extract-media={media_rel}", "-o", str(target.relative_to(REPO))]
    subprocess.run(cmd, cwd=REPO, check=True, capture_output=True, text=True)
    body = target.read_text(encoding="utf-8")
    # pandoc 写的图片路径是相对仓库根的，改成相对 converted/ 的路径
    body = body.replace(f"input/assets/{slug}/", f"../assets/{slug}/")
    images = sorted(p.name for p in (ASSETS / slug).rglob("*") if p.is_file()) if (ASSETS / slug).exists() else []
    extra = {"kind": "document"}
    if images:
        extra["extracted_images"] = len(images)
    target.write_text(frontmatter(src, digest, "pandoc", extra) + body, encoding="utf-8")
    return target


def convert_markitdown(src: Path, digest: str) -> Path:
    target = CONVERTED / f"{slugify(src.stem)}.md"
    proc = subprocess.run(["markitdown", str(src)], check=True, capture_output=True, text=True)
    body = proc.stdout
    extra = {"kind": "document"}
    # 扫描版 PDF 抽不出文字层，必须提醒，否则后面的分析会基于空内容。
    # 判据是「体积大但没文字」——只看字数会把本来就短的一页纸 PDF 误报。
    if src.suffix.lower() == ".pdf" and len(body.strip()) < 200 and src.stat().st_size > 50_000:
        extra["warning"] = "体积不小却几乎没有文字，可能是扫描版 PDF，需要 OCR 或人工补充"
    target.write_text(frontmatter(src, digest, "markitdown", extra) + body, encoding="utf-8")
    return target


def write_mineru_result(src: Path, digest: str, res: "mineru.Result", model_version: str) -> Path:
    """把 MinerU 返回的 markdown 和图片落盘，图片链接改写成相对 converted/ 的路径。"""
    slug = slugify(src.stem)
    target = CONVERTED / f"{slug}.md"
    body = res.markdown or ""

    if res.images:
        img_dir = ASSETS / slug
        img_dir.mkdir(parents=True, exist_ok=True)
        for name, blob in res.images.items():
            (img_dir / name).write_bytes(blob)
        body = mineru.rewrite_image_links(body, f"../assets/{slug}")

    extra = {"kind": "document", "mineru_model": model_version}
    if res.images:
        extra["extracted_images"] = len(res.images)
    if len(body.strip()) < 200 and src.stat().st_size > 50_000:
        extra["warning"] = "体积不小却几乎没有文字，可能是扫描版且 OCR 也没识别出内容，需要人工补充"
    target.write_text(frontmatter(src, digest, f"mineru v4 ({model_version})", extra) + body, encoding="utf-8")
    return target


def convert_passthrough(src: Path, digest: str) -> Path:
    ext = src.suffix.lower()
    if ext in {".md", ".markdown", ".txt"}:
        # 文本型文档统一输出为 .md，方便看板识别为已转换；同时保留来源信息 frontmatter
        target = CONVERTED / f"{slugify(src.stem)}.md"
        body = src.read_text(encoding="utf-8", errors="replace")
        target.write_text(frontmatter(src, digest, "copy", {"kind": "document"}) + body, encoding="utf-8")
    else:
        # csv/json 等结构化文件不能加 frontmatter，否则会破坏解析
        target = CONVERTED / f"{slugify(src.stem)}{ext}"
        shutil.copy2(src, target)
    return target


def convert_image(src: Path, digest: str) -> Path:
    """图片没有文本产物，原样拷进 assets/未分类/；溯源记在同目录 _manifest.md。"""
    UNSORTED.mkdir(parents=True, exist_ok=True)
    target = UNSORTED / f"{slugify(src.stem)}{src.suffix.lower()}"
    shutil.copy2(src, target)
    # 老版本把图拷在 assets/ 根下。同名且内容与源文件一致，就是那份旧拷贝——
    # 留着会让同一张图在图库里出现两遍，所以只在能证明是旧拷贝时才删。
    legacy = ASSETS / target.name
    if legacy.is_file() and legacy.stat().st_size == src.stat().st_size and sha256(legacy) == digest:
        legacy.unlink()
    return target


def read_manifest_sources(manifest: Path) -> list[str]:
    """读回 _manifest.md frontmatter 里的 sources 列表（只认 `sources:` + `  - 路径`）。"""
    if not manifest.is_file():
        return []
    try:
        text = manifest.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    if not text.startswith("---"):
        return []
    end = text.find("\n---", 3)
    if end == -1:
        return []
    out, in_list = [], False
    for line in text[: end].splitlines():
        if line.startswith("sources:"):
            in_list = True
            continue
        if in_list:
            item = re.match(r"\s+-\s+(.*)$", line)
            if item:
                out.append(item.group(1).strip())
                continue
            in_list = False
    return out


def write_assets_manifest(records: list[dict]) -> None:
    """记下「哪些原始图片已经拷进 assets/未分类/」。

    图片没有 .md 产物，看板只看 converted/ 的话会把它们永远算成「待转换」——
    文件明明已经入库，界面还在催人转换。这份清单就是给看板认账用的。
    只跑了部分文件时不能把别人的记录冲掉，所以与已有清单取并集；
    源文件已经不在了的记录顺手清掉，免得清单越攒越脏。
    """
    manifest = UNSORTED / "_manifest.md"
    fresh = [r["source"] for r in records if r["kind"] == "image" and r["target"]]
    sources = sorted({*read_manifest_sources(manifest), *fresh})
    sources = [s for s in sources if (REPO / s).is_file()]
    if not sources:
        return
    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    lines = [
        "---",
        "kind: assets",
        "group: 未分类",
        "converted_by: copy",
        f"converted_at: {now}",
        "sources:",
        *(f"  - {s}" for s in sources),
        "---",
        "",
        "# 未分类图片",
        "",
        "直接放在 `input/raw/` 里的图片（不属于任何文档）拷到本目录。",
        "**不要手改本文件**，重跑 `scripts/ingest.py` 会覆盖。",
        "",
        "| 原始文件 | 图片 |",
        "| --- | --- |",
    ]
    for s in sources:
        name = f"{slugify(Path(s).stem)}{Path(s).suffix.lower()}"
        lines.append(f"| `{s}` | [`{name}`](./{name}) |")
    lines.append("")
    UNSORTED.mkdir(parents=True, exist_ok=True)
    manifest.write_text("\n".join(lines), encoding="utf-8")


# --------------------------------------------------------------------------- #
# 调度
# --------------------------------------------------------------------------- #

def resolve_pdf_engine(requested: str) -> str:
    """决定 PDF / PPTX 用哪个引擎。auto：配了 key 就用 MinerU，否则退回 markitdown。"""
    if requested == "mineru":
        return "mineru"
    if requested == "markitdown":
        return "markitdown"
    return "mineru" if mineru.available() else "markitdown"


def plan(files: list[Path], pdf_engine: str) -> list[tuple[Path, str, Path]]:
    """→ [(源文件, 处理方式, 目标路径)]"""
    out = []
    for src in files:
        ext = src.suffix.lower()
        slug = slugify(src.stem)
        if is_pointtable(src):
            # 点表由 scripts/pointtable.py 汇总成测点主表，这里让路：
            # 否则几百个同构点表会各自转出一个 csv 目录，分段型 .txt 还会被当纯文本拷进 converted/。
            out.append((src, "pointtable", Path()))
        elif ext in SPREADSHEET or ext in LEGACY_SPREADSHEET:
            out.append((src, "spreadsheet", CONVERTED / slug))
        elif ext in HTML_PROTOTYPE:
            out.append((src, "html", CONVERTED / slug))
        elif ext in PANDOC:
            out.append((src, "pandoc", CONVERTED / f"{slug}.md"))
        elif ext in MINERU and pdf_engine == "mineru":
            out.append((src, "mineru", CONVERTED / f"{slug}.md"))
        elif ext in MARKITDOWN:
            out.append((src, "markitdown", CONVERTED / f"{slug}.md"))
        elif ext in PASSTHROUGH:
            # .txt 实际输出为 .md，其余纯文本保留原扩展名
            out.append((src, "copy", CONVERTED / f"{slug}.md" if ext == ".txt" else CONVERTED / f"{slug}{ext}"))
        elif ext in IMAGES:
            out.append((src, "image", UNSORTED / f"{slug}{ext}"))
        elif ext in LEGACY:
            out.append((src, "legacy", Path()))
        else:
            out.append((src, "skip", Path()))
    return out


def load_ignore(extra: list[str] | None = None) -> list[str]:
    """读 input/.ingestignore。gitignore 风格：一行一个模式，# 开头是注释，空行忽略。

    看板 src/server/scan.mjs 读的是同一份文件，两边规则必须一致，改这里记得同步那边。
    """
    patterns = []
    if IGNOREFILE.exists():
        for line in IGNOREFILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                patterns.append(line.rstrip("/"))
    patterns.extend(p.strip().rstrip("/") for p in (extra or []) if p.strip())
    return patterns


def is_ignored(src: Path, patterns: list[str]) -> bool:
    """相对 input/ 的路径匹配上任一模式就忽略；目录模式命中其下所有文件。"""
    if not patterns:
        return False
    try:
        rel = src.resolve().relative_to(RAW.parent).as_posix()
    except ValueError:
        return False
    for pat in patterns:
        # 目录前缀命中（写 raw/客户版 就等于 raw/客户版/** 全部）
        if rel == pat or rel.startswith(pat + "/"):
            return True
        # 通配符：整路径匹配，或只对文件名匹配（写 *.bak 不必带路径）
        if PurePosixPath(rel).match(pat) or PurePosixPath(src.name).match(pat):
            return True
    return False


def collect(paths: list[str], ignore: list[str] | None = None) -> tuple[list[Path], list[Path]]:
    """返回 (要处理的文件, 被忽略的文件)。忽略的单独返回，好让调用方报个数。"""
    if paths:
        files = []
        for p in paths:
            path = Path(p).resolve()
            files.extend(sorted(f for f in path.rglob("*") if f.is_file()) if path.is_dir() else [path])
    else:
        files = sorted(f for f in RAW.rglob("*") if f.is_file())
    files = [f for f in files if not f.name.startswith(".") and f.name != ".gitkeep"]
    patterns = ignore or []
    kept = [f for f in files if not is_ignored(f, patterns)]
    dropped = [f for f in files if is_ignored(f, patterns)]
    return kept, dropped


ROW_RE = re.compile(r"^\|\s*`([^`]+)`\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$")


def read_index_rows() -> dict[str, dict]:
    """把 INDEX.md 已有的表格读回来，按 source 索引。

    只跑子目录时（ingest.py input/raw/某目录）本次 records 只覆盖该目录，
    不读回旧行就会把其他条目从台账里抹掉——那等于丢了溯源。
    """
    if not INDEX.exists():
        return {}
    rows = {}
    for line in INDEX.read_text(encoding="utf-8").splitlines():
        if line.startswith("## 人工批注"):
            break
        m = ROW_RE.match(line)
        if not m:
            continue
        source, kind, target, status = m.groups()
        if source == "原始文件":          # 表头
            continue
        # 产物列写的是 markdown 链接，取回裸路径
        link = re.match(r"\[`([^`]+)`\]", target)
        rows[source] = {"source": source, "kind": kind,
                        "target": link.group(1) if link else "", "status": status}
    return rows


def write_index(records: list[dict], ignored: list[Path] | None = None) -> None:
    now = dt.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M")
    # 旧行打底，本次跑到的覆盖掉，没跑到的原样留着
    merged = read_index_rows()
    for r in records:
        merged[r["source"]] = r
    # 源文件已经不在了的旧行清掉，免得台账里挂着幽灵条目
    for source in list(merged):
        if not source.endswith("/") and not (REPO / source).exists():
            del merged[source]
    records = list(merged.values())
    lines = [
        "# 资料台账 INDEX",
        "",
        f"由 `scripts/ingest.py` 于 {now} 生成。**不要手改本文件的表格**，重跑脚本会覆盖；",
        "要补充人工判断（是否权威版本、责任人、遗留疑问）请写在下方「人工批注」区。",
        "",
        "| 原始文件 | 类型 | 产物 | 状态 |",
        "| --- | --- | --- | --- |",
    ]
    for r in sorted(records, key=lambda x: x["source"]):
        target = f"[`{r['target']}`](./{r['target']})" if r["target"] else "—"
        lines.append(f"| `{r['source']}` | {r['kind']} | {target} | {r['status']} |")
    if ignored:
        # 忽略的资料不逐份列（可能上千份），按顶层目录汇总一行，让人知道它们还在
        groups: dict[str, int] = {}
        for f in ignored:
            rel = f.relative_to(REPO) if f.is_relative_to(REPO) else f
            top = "/".join(rel.parts[:3]) if len(rel.parts) > 3 else str(rel)
            groups[top] = groups.get(top, 0) + 1
        lines += ["", f"> 另有 {len(ignored)} 份资料按 `input/.ingestignore` 忽略，不计入待转换："]
        for top, n in sorted(groups.items()):
            lines.append(f"> - `{top}/` {n} 份")
    lines += [
        "",
        "## 人工批注",
        "",
        "- 权威版本：",
        "- 资料缺口：",
        "- 待澄清问题：",
        "",
    ]
    existing = INDEX.read_text(encoding="utf-8") if INDEX.exists() else ""
    if "## 人工批注" in existing:
        # 保住人工写的内容，只替换生成的表格部分
        keep = existing.split("## 人工批注", 1)[1]
        lines = lines[: lines.index("## 人工批注")] + ["## 人工批注", keep.lstrip("\n")]
    INDEX.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="把 input/raw/ 的文档转换成 AI 可读格式")
    ap.add_argument("paths", nargs="*", help="指定文件或目录，默认整个 input/raw/")
    ap.add_argument("--force", action="store_true", help="忽略 sha256 缓存，全部重转")
    ap.add_argument("--ignore", action="append", metavar="模式", default=[],
                    help="临时追加忽略模式（可多次）。常驻规则写进 input/.ingestignore")
    ap.add_argument("--no-ignore", action="store_true",
                    help="本次不应用 input/.ingestignore，把被忽略的也一起转")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划，不写文件")
    ap.add_argument("--pdf-engine", choices=["auto", "mineru", "markitdown"], default="auto",
                    help="PDF / PPTX 用哪个引擎。auto=配了 MINERU_API_KEY 就用 MinerU，否则 markitdown")
    ap.add_argument("--ocr", action="store_true", help="MinerU 强制 OCR（扫描版 PDF 需要）")
    ap.add_argument("--language", default="ch", help="MinerU 识别语言，默认 ch（中英混排）")
    ap.add_argument("--model-version", default="pipeline", choices=["pipeline", "vlm", "MinerU-HTML"],
                    help="MinerU 模型。pipeline 稳、vlm 对复杂版式更好")
    ap.add_argument("--mineru-timeout", type=int, default=mineru.POLL_TIMEOUT,
                    help=f"MinerU 单批轮询上限秒数，默认 {mineru.POLL_TIMEOUT}")
    args = ap.parse_args()

    CONVERTED.mkdir(parents=True, exist_ok=True)
    ASSETS.mkdir(parents=True, exist_ok=True)

    patterns = [] if args.no_ignore else load_ignore(args.ignore)
    files, ignored = collect(args.paths, patterns)
    if ignored:
        log(f"· 按 input/.ingestignore 忽略 {len(ignored)} 份（不计入待转换，加 --no-ignore 可强制转）")
    if not files:
        log("input/raw/ 里没有文件。把 docx / pdf / xlsx / pptx 放进去再跑一次。")
        return 0

    engine = resolve_pdf_engine(args.pdf_engine)
    if args.pdf_engine == "auto" and engine == "markitdown" and any(f.suffix.lower() in MINERU for f in files):
        log(f"提示：没配 {mineru.ENV_KEY}，PDF / PPTX 退回 markitdown（版式和表格还原会差一些）。")
        log("      要用 MinerU：复制 .env.example 为 .env 并填 token（https://mineru.net/apiManage）。")

    tasks = plan(files, engine)
    if args.dry_run:
        for src, how, target in tasks:
            dest = target.relative_to(REPO) if target != Path() else "—"
            log(f"  {how:12} {src.relative_to(REPO)}  →  {dest}")
        return 0

    records: list[dict] = []
    failures = 0
    deferred: list[tuple[Path, str, Path]] = []   # MinerU 的任务攒起来一批提交
    pointtable_dirs: dict[str, int] = {}          # 点表按目录汇总，不逐个刷屏
    for src, how, target in tasks:
        rel = src.relative_to(REPO) if src.is_relative_to(REPO) else src
        if how == "pointtable":
            top = rel.parts[2] if len(rel.parts) > 2 else rel.name   # input/raw/<点表集>/...
            pointtable_dirs[top] = pointtable_dirs.get(top, 0) + 1
            continue
        if how == "legacy":
            log(f"⚠ 跳过 {rel}：老格式不受支持，请先另存为 .{LEGACY[src.suffix.lower()]}")
            records.append({"source": str(rel), "kind": src.suffix.lstrip("."), "target": "",
                            "status": f"⚠ 需另存为 .{LEGACY[src.suffix.lower()]}"})
            continue
        if how == "skip":
            log(f"· 跳过 {rel}：未识别的格式 {src.suffix}")
            records.append({"source": str(rel), "kind": src.suffix.lstrip("."), "target": "", "status": "· 未处理"})
            continue

        digest = sha256(src)
        if not args.force and target.exists() and read_recorded_digest(target) == digest:
            log(f"= 未变化 {rel}")
            records.append({"source": str(rel), "kind": how,
                            "target": str(target.relative_to(CONVERTED.parent)), "status": "✓ 已转换"})
            continue

        if how == "mineru":
            # 攒到最后一起提交：轮询是按 batch 的，合成一批只等一轮
            deferred.append((src, digest, target))
            continue

        try:
            if how == "spreadsheet":
                out = convert_spreadsheet(src, digest)
            elif how == "html":
                out = convert_html(src, digest)
            elif how == "pandoc":
                if not has_cli("pandoc"):
                    raise RuntimeError("缺少 pandoc，请先 `brew install pandoc`")
                out = convert_pandoc(src, digest, PANDOC[src.suffix.lower()])
            elif how == "markitdown":
                if not has_cli("markitdown"):
                    raise RuntimeError("缺少 markitdown，请先 `pip install 'markitdown[all]'`")
                out = convert_markitdown(src, digest)
            elif how == "image":
                out = convert_image(src, digest)
            else:
                out = convert_passthrough(src, digest)
        except (subprocess.CalledProcessError, RuntimeError, zipfile.BadZipFile, ET.ParseError,
                XlsError, OSError) as exc:
            detail = exc.stderr.strip().splitlines()[-1] if isinstance(exc, subprocess.CalledProcessError) and exc.stderr else exc
            log(f"✗ 失败 {rel}：{detail}")
            records.append({"source": str(rel), "kind": how, "target": "", "status": "✗ 转换失败"})
            failures += 1
            continue

        log(f"✓ {rel}  →  {out.relative_to(REPO)}")
        records.append({"source": str(rel), "kind": how,
                        "target": str(out.relative_to(CONVERTED.parent)), "status": "✓ 已转换"})

    if deferred:
        log(f"\nMinerU：{len(deferred)} 个文件走在线解析")
        srcs = [src for src, _, _ in deferred]
        try:
            results = mineru.parse_batch(
                srcs, is_ocr=args.ocr, language=args.language,
                model_version=args.model_version, timeout=args.mineru_timeout, log=log,
            )
        except mineru.MineruError as exc:
            # 整批失败（缺 key、鉴权、超配额）。逐条记进台账，不要静默丢掉这些文件
            log(f"✗ MinerU 整批失败：{exc}")
            for src, _, _ in deferred:
                rel = src.relative_to(REPO) if src.is_relative_to(REPO) else src
                records.append({"source": str(rel), "kind": "mineru", "target": "", "status": "✗ MinerU 失败"})
            failures += len(deferred)
            results = {}

        for src, digest, _ in deferred:
            rel = src.relative_to(REPO) if src.is_relative_to(REPO) else src
            res = results.get(src.name)
            if res is None:
                continue          # 整批失败的分支已经记过账了
            if res.markdown is None:
                log(f"✗ 失败 {rel}：{res.err}")
                records.append({"source": str(rel), "kind": "mineru", "target": "", "status": "✗ MinerU 失败"})
                failures += 1
                continue
            out = write_mineru_result(src, digest, res, args.model_version)
            img = f"，{len(res.images)} 张图" if res.images else ""
            log(f"✓ {rel}  →  {out.relative_to(REPO)}{img}")
            records.append({"source": str(rel), "kind": "mineru",
                            "target": str(out.relative_to(CONVERTED.parent)), "status": "✓ 已转换"})

    for name, count in sorted(pointtable_dirs.items()):
        converted = CONVERTED / slugify(name)
        done = (converted / "_manifest.md").is_file()
        log(f"· 点表 input/raw/{name}/：{count} 个文件交给 scripts/pointtable.py"
            + ("" if done else "（尚未处理，请运行 python3 scripts/pointtable.py）"))
        records.append({
            "source": f"input/raw/{name}/", "kind": f"点表 ×{count}",
            "target": f"converted/{slugify(name)}/_manifest.md" if done else "",
            "status": "✓ 已汇总为测点主表" if done else "⚠ 待运行 pointtable.py",
        })

    write_assets_manifest(records)
    write_index(records, ignored)
    log(f"\n台账已更新：{INDEX.relative_to(REPO)}")
    if failures:
        log(f"有 {failures} 个文件转换失败，见上方日志。")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
