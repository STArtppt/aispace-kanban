"""前置区：正文之前的封面、签署页、版本跟踪表、目录。模板既是样式源，也是骨架源（design D1）。

三步，同一套块切分贯穿始终（采集与生成必须数出同样的字段编号）：

1. **识别**（`analyze`，collect 调用）：正文起点之前的分节。报告只出结构与角色标签，不出文字 ——
   角色猜测（标题 / 客户单位 / 编制单位 / 日期 / 文档类型）在脚本内部按字号、位置、日期格式得出。
2. **切出**（`build_front`，build 调用）：连同图片、页眉页脚、样式、编号切成 `front.docx`；
   映射成字段的段落写占位符 `{{title}}`（原文不留），表格按清空规则清掉样例数据，目录只留 TOC 域和一行占位。
3. **装配**（`assemble`，md2docx 调用）：把前置区插到 pandoc 输出前，重排 r:id、部件名、样式 ID；
   填字段（`fill_values` 决定取值顺序，design D4）；settings.xml 设打开时更新域。

几条和 build.py 一样的老规矩：改 XML 一律在原始字符串上做局部替换，读才用 ET（见 ooxml.py 文件头）。
踩坑记录见同目录 README.md「前置区」一节。
"""

from __future__ import annotations

import datetime as dt
import hashlib
import html
import json
import posixpath
import re
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

from .collect import Styles, describe, dominant_run_rpr, load_theme_fonts, merge_p, ppr_props
from .ooxml import NS, Package, q, wval

ROLES = ("title", "client", "vendor", "date", "doctype")
FIELD_CHOICES = ROLES + ("keep",)
TABLE_RULES = ("keepHeader", "keepLabels", "keepHeaderAndLabels", "keepAll")
ROLE_LABEL = {"title": "标题", "client": "客户单位", "vendor": "编制单位", "date": "日期", "doctype": "文档类型"}
TOC_PLACEHOLDER = "目录：用 Word 打开后右键此处，选择「更新域」"

# ---------- 字符串层面的元素定位 ----------
BLOCK_RE = re.compile(r"<(/?)w:(p|tbl|sdt)\b[^>]*?(/?)>")
T_RE = re.compile(r"<w:t(?:\s[^>]*)?>([^<]*)</w:t>")
FLD_RE = re.compile(r'<w:fldChar\b[^>]*?w:fldCharType="(begin|separate|end)"[^>]*?/?>')
TOC_INSTR = re.compile(r"<w:instrText\b[^>]*>\s*TOC\b")
# 段落开始标签（不含自闭合的 <w:p/>，也不会误中 <w:pPr>）
P_OPEN = re.compile(r"<w:p(?:\s[^>]*[^/])?>")
LABEL_RE = re.compile(r"^\s*([^：:\s]{1,10}\s*[：:])\s*\S")
DATE_RE = re.compile(r"^\s*(\d{4}\s*年\s*\d{1,2}\s*月(\s*\d{1,2}\s*日)?|[〇○零一二三四五六七八九]{4}\s*年.{1,3}月(.{1,3}日)?"
                     r"|\d{4}[-./]\d{1,2}([-./]\d{1,2})?)\s*$")
ORG_RE = re.compile(r"(公司|集团|局|院|中心|委员会|厅|部|所|大学|学院|银行|单位|政府)$")
DOCTYPE_RE = re.compile(r"(方案|报告|说明书|规格说明|设计|手册|计划|建议书|白皮书|稿|说明)([（(].{0,8}[)）])?$")
CLIENT_HINT = re.compile(r"建设|委托|甲方|客户|业主|使用|采购")
VENDOR_HINT = re.compile(r"编制|承建|承担|供应|服务|乙方|实施|提交|编写")


def spans(s: str, tag: str) -> list[tuple[int, int]]:
    """`<w:tag>` 元素（含嵌套）在字符串里的 [起, 止) 区间，按起点排序。"""
    pat = re.compile(r"<(/?)w:%s\b[^>]*?(/?)>" % tag)
    stack, out = [], []
    for m in pat.finditer(s):
        if m.group(1):
            if stack:
                out.append((stack.pop(), m.end()))
        elif m.group(2):
            out.append((m.start(), m.end()))
        else:
            stack.append(m.start())
    return sorted(out)


def top_blocks(inner: str) -> list[tuple[str, int, int]]:
    """body 下的顶层块（p / tbl / sdt）：(种类, 起, 止)。块之间的书签等零碎内容不算块，原样留在原处。"""
    blocks, depth, start, kind = [], 0, 0, ""
    for m in BLOCK_RE.finditer(inner):
        closing, tag, selfclose = m.groups()
        if closing:
            depth -= 1
            if depth == 0:
                blocks.append((kind, start, m.end()))
        elif selfclose:
            if depth == 0:
                blocks.append((tag, m.start(), m.end()))
        else:
            if depth == 0:
                start, kind = m.start(), tag
            depth += 1
    return blocks


def body_bounds(doc: str) -> tuple[int, int]:
    m = re.search(r"<w:body\b[^>]*>", doc)
    return m.end(), doc.rindex("</w:body>")


def inside(span, others) -> bool:
    s, e = span
    return any(a <= s and e <= b and (a, b) != (s, e) for a, b in others)


def norm_text(raw: str) -> str:
    return re.sub(r"\s+", "", html.unescape(raw))


def digest(text: str) -> str:
    # 只在脚本内部用来归并文本框与兼容回退副本，不写进报告
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


# ---------- 识别 ----------
class _Doc:
    """一份 docx 的正文切分：原文、body 区间、顶层块、前置区边界。采集与生成共用。"""

    def __init__(self, pkg: Package):
        self.pkg = pkg
        self.doc = pkg.text("word/document.xml")
        self.open_tag = re.search(r"<w:document\b[^>]*>", self.doc).group(0)
        self.b0, self.b1 = body_bounds(self.doc)
        self.inner = self.doc[self.b0:self.b1]
        self.blocks = top_blocks(self.inner)
        self.styles = Styles(ET.fromstring(pkg.files["word/styles.xml"])) if "word/styles.xml" in pkg.files else None
        try:
            import io
            import zipfile

            buf = io.BytesIO(pkg.to_bytes())
            self.theme = load_theme_fonts(zipfile.ZipFile(buf))
        except Exception:  # noqa: BLE001 —— 主题字体只影响报告里的字体名，读不到不致命
            self.theme = {}
        self.boundary = self._boundary()

    def block_str(self, i: int) -> str:
        _, s, e = self.blocks[i]
        return self.inner[s:e]

    def parse(self, frag: str):
        return ET.fromstring(self.open_tag + frag + "</w:document>")[0]

    def _is_heading(self, i: int) -> bool:
        kind, _, _ = self.blocks[i]
        if kind != "p" or self.styles is None:
            return False
        el = self.parse(self.block_str(i))
        if not "".join(t.text or "" for t in el.iter(q("w:t"))).strip():
            return False
        ppr = el.find("w:pPr", NS)
        sid = (wval(ppr.find("w:pStyle", NS)) if ppr is not None else None) or self.styles.default_para
        p_eff = merge_p(self.styles.resolved(sid)[0], ppr_props(ppr))
        lvl = p_eff.get("outlineLvl")
        return lvl is not None and lvl.isdigit() and int(lvl) < 9

    def is_break(self, i: int) -> bool:
        return self.blocks[i][0] == "p" and "<w:sectPr" in self.block_str(i)

    def _boundary(self) -> int:
        """前置区 = 正文第一个标题段之前的所有分节，或第一个目录域之后的第一个分节符之前，取靠后者。"""
        n = len(self.blocks)
        first_h = next((i for i in range(n) if self._is_heading(i)), n)
        b1 = 0
        for i in range(first_h):
            if self.is_break(i):
                b1 = i + 1
        b2 = 0
        toc_i = next((i for i in range(n) if TOC_INSTR.search(self.block_str(i))), None)
        # 目录标题常套 heading 1，它就是「第一个标题」：目录紧跟在它后面时仍算前置区
        if toc_i is not None and toc_i <= first_h + 2:
            b2 = next((j + 1 for j in range(toc_i, n) if self.is_break(j)), 0)
        b = max(b1, b2)
        return b if 0 < b < n else 0

    def front_str(self) -> str:
        """前置区原文：从 body 开头到最后一个前置块结束（含块之间的书签等零碎）。"""
        return self.inner[:self.blocks[self.boundary - 1][2]] if self.boundary else ""


def _toc_range(front: str) -> tuple[int, int] | None:
    """目录域在前置区字符串里的 [起, 止)：从 begin 所在段到 end 所在段。认不出返回 None。"""
    m = TOC_INSTR.search(front)
    if not m:
        return None
    begins = [x for x in FLD_RE.finditer(front, 0, m.start()) if x.group(1) == "begin"]
    if not begins:
        return None
    b = begins[-1]
    depth, end = 0, None
    for x in FLD_RE.finditer(front, b.start()):
        if x.group(1) == "begin":
            depth += 1
        elif x.group(1) == "end":
            depth -= 1
            if depth == 0:
                end = x
                break
    if end is None:
        return None
    p_start = [x.start() for x in P_OPEN.finditer(front, 0, b.start())]
    close = front.find("</w:p>", end.end())
    if not p_start or close < 0:
        return None
    return p_start[-1], close + len("</w:p>")


class _Front:
    """前置区的字段、表格、分节。坐标全部是前置区字符串里的位置。"""

    def __init__(self, d: _Doc):
        self.d = d
        self.s = d.front_str()
        s = self.s
        self.p_spans = spans(s, "p")
        self.tbl_spans = spans(s, "tbl")
        self.txbx_spans = spans(s, "txbxContent")
        self.toc = _toc_range(s)
        sdt_toc = [(a, b) for a, b in spans(s, "sdt")
                   if "Table of Contents" in s[a:b] or TOC_INSTR.search(s[a:b])]
        self.excluded = list(sdt_toc) + ([self.toc] if self.toc else [])
        # 分节：每个带 sectPr 的顶层段结束一节
        self.sec_ends = [d.blocks[i][2] for i in range(d.boundary) if d.is_break(i)]
        # 表格排版的封面：第一节里含大字号段落的表格只是用来排版，里面的段落按字段处理，不进表格清单
        top = [sp for sp in self.tbl_spans if not inside(sp, self.tbl_spans)]
        self.layout = [sp for sp in top if self.section_of(sp[0]) == 0 and any(
            (self._fmt(self.d.parse(self.s[a:b]))["size"] or 0) >= 16
            for a, b in self.p_spans if sp[0] < a and b <= sp[1])]
        self.fields = self._fields()
        self.tables = self._tables()

    def section_of(self, pos: int) -> int:
        return next((k for k, e in enumerate(self.sec_ends) if pos < e), len(self.sec_ends) - 1)

    def block_of(self, pos: int) -> int:
        return next((i for i in range(self.d.boundary) if self.d.blocks[i][1] <= pos < self.d.blocks[i][2]), -1)

    def own_ts(self, span) -> list[re.Match]:
        """段落自己的 w:t（不含嵌在它文本框里的段落）。"""
        a, b = span
        kids = [x for x in self.p_spans if a < x[0] and x[1] <= b and x != span]
        return [m for m in T_RE.finditer(self.s, a, b) if not any(k0 <= m.start() < k1 for k0, k1 in kids)]

    def _style_name(self, el) -> str:
        ppr = el.find("w:pPr", NS)
        sid = wval(ppr.find("w:pStyle", NS)) if ppr is not None else None
        return (self.d.styles.name(sid) or "").lower() if (sid and self.d.styles) else ""

    def _fields(self) -> list[dict]:
        groups: dict[tuple, dict] = {}
        order = []
        for span in self.p_spans:
            in_table = [t for t in self.tbl_spans if t[0] < span[0] and span[1] <= t[1]]
            if any(not any(l[0] <= t[0] and t[1] <= l[1] for l in self.layout) for t in in_table) \
                    or any(a <= span[0] < b for a, b in self.excluded):
                continue
            ts = self.own_ts(span)
            text = norm_text("".join(m.group(1) for m in ts))
            if not text:
                continue
            key = (self.block_of(span[0]), digest(text))
            if key not in groups:
                el = self.d.parse(self.s[span[0]:span[1]])
                if re.match(r"toc( heading|\s*\d)", self._style_name(el)):
                    continue
                groups[key] = {"spans": [], "text": text, "el": el, "pos": span[0]}
                order.append(key)
            groups[key]["spans"].append(span)
        out = []
        per_section: dict[int, int] = {}
        for n, key in enumerate(order, 1):
            g = groups[key]
            sec = self.section_of(g["pos"])
            per_section[sec] = per_section.get(sec, 0) + 1
            fmt = self._fmt(g["el"])
            out.append({
                "id": f"f{n}", "section": sec, "order": per_section[sec], "chars": len(g["text"]),
                "inTextbox": any(inside(sp, self.txbx_spans) for sp in g["spans"]),
                "occurrences": len(g["spans"]), "size": fmt["size"], "bold": fmt["bold"], "jc": fmt["jc"],
                "labeled": bool(LABEL_RE.match(g["text"])),
                "_spans": g["spans"], "_text": g["text"],
            })
        _guess_roles(out)
        return out

    def _fmt(self, el) -> dict:
        st = self.d.styles
        if st is None:
            return {"size": None, "bold": False, "jc": "left"}
        ppr = el.find("w:pPr", NS)
        sid = (wval(ppr.find("w:pStyle", NS)) if ppr is not None else None) or st.default_para
        sp, sr = st.resolved(sid)
        f = describe(merge_p(sp, ppr_props(ppr)), dominant_run_rpr(el, st, sr), self.d.theme)
        return {"size": f["size"], "bold": f["bold"], "jc": f["jc"]}

    def _tables(self) -> list[dict]:
        out = []
        top = [sp for sp in self.tbl_spans if not inside(sp, self.tbl_spans) and sp not in self.layout
               and not any(a <= sp[0] < b for a, b in self.excluded)]
        for n, sp in enumerate(top, 1):
            cells = self.cells(sp)
            rows = max((r for r, _, _ in cells), default=-1) + 1
            cols = max((c for _, c, _ in cells), default=-1) + 1
            text = {(r, c): norm_text("".join(m.group(1) for m in T_RE.finditer(self.s, a, b)))
                    for r, c, (a, b) in cells}
            first_row = [text.get((0, c), "") for c in range(cols)]
            row0 = "".join(self.s[a:b] for r, _, (a, b) in cells if r == 0)
            header_like = (rows >= 2 and cols >= 1 and all(first_row) and all(len(t) <= 12 for t in first_row)
                           and (rows >= 3 or "<w:b/>" in row0 or "<w:shd" in row0))
            col0 = [text.get((r, 0), "") for r in range(rows)]
            filled = [t for t in col0 if t]
            label_col = (cols >= 2 and rows >= 2 and len(filled) >= 0.8 * rows
                         and sum(len(t) for t in filled) / max(len(filled), 1) <= 8
                         and sum(1 for t in col0[1:] if re.search(r"\d", t)) <= (rows - 1) * 0.2)
            rule = "keepLabels" if label_col else ("keepHeader" if header_like else "keepAll")
            out.append({"id": f"t{n}", "section": self.section_of(sp[0]), "rows": rows, "cols": cols,
                        "headerLike": header_like, "labelColumn": label_col, "defaultRule": rule, "_span": sp})
        return out

    def cells(self, tbl_span) -> list[tuple[int, int, tuple[int, int]]]:
        """表格直属的单元格：(行, 列, 区间)。嵌套表格里的单元格不算。"""
        a, b = tbl_span
        nested = [sp for sp in self.tbl_spans if a < sp[0] and sp[1] <= b]
        rows = [sp for sp in spans(self.s[a:b], "tr")]
        rows = [(x + a, y + a) for x, y in rows]
        rows = [r for r in rows if not inside(r, nested)]
        tcs = [(x + a, y + a) for x, y in spans(self.s[a:b], "tc")]
        tcs = [c for c in tcs if not inside(c, nested)]
        out = []
        for ri, (r0, r1) in enumerate(rows):
            for ci, c in enumerate([c for c in tcs if r0 <= c[0] and c[1] <= r1]):
                out.append((ri, ci, c))
        return out

    def sections(self) -> list[dict]:
        out = []
        for k in range(len(self.sec_ends)):
            lo = self.sec_ends[k - 1] if k else 0
            hi = self.sec_ends[k]
            fs = [f for f in self.fields if f["section"] == k]
            ts = [t for t in self.tables if t["section"] == k]
            has_toc = any(lo <= a < hi for a, _ in self.excluded)
            if any(f["guess"] == "title" for f in fs):
                guess = "cover"
            elif has_toc:
                guess = "toc"
            elif any(t["labelColumn"] for t in ts):
                guess = "signoff"
            elif any(t["headerLike"] for t in ts):
                guess = "revisions"
            else:
                guess = "other"
            seg = self.s[lo:hi]
            out.append({"id": f"s{k + 1}", "index": k, "guess": guess, "paragraphs": len(fs),
                        "tables": [t["id"] for t in ts], "hasToc": has_toc,
                        "hasImage": "<w:drawing" in seg or "<w:pict" in seg})
        return out


def _guess_roles(fields: list[dict]) -> None:
    """角色猜测：只在第一节（封面）里猜，每个角色至多一个。判据只看字号、位置、格式形态。"""
    for f in fields:
        f["guess"] = None
    cover = [f for f in fields if f["section"] == 0]

    def value_of(f):
        m = LABEL_RE.match(f["_text"])
        return f["_text"][m.end(1):] if m else f["_text"]

    for f in cover:
        if DATE_RE.match(value_of(f)):
            f["guess"] = "date"
            break
    rest = [f for f in cover if f["guess"] is None]
    big = [f for f in rest if (f["size"] or 0) >= 16 and f["chars"] >= 4]
    if big:
        max(big, key=lambda f: (f["size"], -f["order"]))["guess"] = "title"
    orgs = [f for f in cover if f["guess"] is None and ORG_RE.search(value_of(f))]
    taken = set()
    for f in orgs:
        label = LABEL_RE.match(f["_text"])
        lab = label.group(1) if label else ""
        role = "client" if CLIENT_HINT.search(lab) else ("vendor" if VENDOR_HINT.search(lab) else None)
        if role and role not in taken:
            f["guess"] = role
            taken.add(role)
    loose = [f for f in orgs if f["guess"] is None]
    if len(loose) == 1 and "vendor" not in taken:
        loose[0]["guess"] = "vendor"
    elif len(loose) >= 2:
        if "client" not in taken:
            loose[0]["guess"] = "client"
        if "vendor" not in taken:
            loose[-1]["guess"] = "vendor"
    for f in cover:
        if f["guess"] is None and f["chars"] <= 15 and DOCTYPE_RE.search(value_of(f)):
            f["guess"] = "doctype"
            break


def _public(items: list[dict]) -> list[dict]:
    return [{k: v for k, v in x.items() if not k.startswith("_")} for x in items]


def analyze(pkg: Package) -> dict | None:
    """采集报告的 `front` 段；没有前置区返回 None。只含结构与角色标签，不含任何文字。"""
    d = _Doc(pkg)
    if not d.boundary:
        return None
    fr = _Front(d)
    report = {
        "blocks": d.boundary,
        "hasToc": bool(fr.excluded),
        "sections": fr.sections(),
        "fields": _public(fr.fields),
        "tables": _public(fr.tables),
    }
    report["sig"] = _sig(report)
    return report


def _sig(report: dict) -> str:
    """结构指纹：生成时重新切分，对不上说明来源文档在采集之后改过。"""
    shape = [report["blocks"], [(f["id"], f["section"], f["chars"]) for f in report["fields"]],
             [(t["id"], t["rows"], t["cols"]) for t in report["tables"]]]
    return hashlib.sha256(json.dumps(shape).encode()).hexdigest()[:12]


# ---------- 切出 front.docx ----------
STRUCTURAL = ("/styles", "/numbering", "/settings", "/fontTable", "/theme", "/webSettings", "/footnotes", "/endnotes")
RID_RE = re.compile(r'\br:(id|embed|link|pict|href|dm|lo|qs|cs)="([^"]+)"')


def _set_ts(s: str, ts: list[re.Match], texts: list[str], edits: list) -> None:
    for m, t in zip(ts, texts):
        edits.append((m.start(), m.end(), f'<w:t xml:space="preserve">{escape(t)}</w:t>'))


def _field_edits(fr: _Front, field: dict, role: str, edits: list) -> None:
    ph = "{{%s}}" % role
    for span in field["_spans"]:
        ts = fr.own_ts(span)
        raw = [html.unescape(m.group(1)) for m in ts]
        full = "".join(raw)
        lab = LABEL_RE.match(full)
        if not lab:
            _set_ts(fr.s, ts, [ph] + [""] * (len(ts) - 1), edits)
            continue
        cut, cum, out, placed = lab.end(1), 0, [], False
        for t in raw:
            if placed:
                out.append("")
            elif cum + len(t) >= cut:
                out.append(t[:cut - cum] + ph)
                placed = True
            else:
                out.append(t)
            cum += len(t)
        _set_ts(fr.s, ts, out, edits)


def _clear_cell(cell: str) -> str:
    # 签署页里可能嵌着手写签名的扫描图：一起清掉
    cell = re.sub(r"<w:drawing>.*?</w:drawing>|<w:pict>.*?</w:pict>", "", cell, flags=re.S)
    return T_RE.sub("<w:t></w:t>", cell)


def _table_edits(fr: _Front, table: dict, rule: str, edits: list) -> int:
    if rule == "keepAll":
        return 0
    n = 0
    for r, c, (a, b) in fr.cells(table["_span"]):
        keep = ((rule == "keepHeader" and r == 0) or (rule == "keepLabels" and c == 0)
                or (rule == "keepHeaderAndLabels" and (r == 0 or c == 0)))
        if not keep:
            new = _clear_cell(fr.s[a:b])
            if new != fr.s[a:b]:
                edits.append((a, b, new))
                n += 1
    return n


def collapse_toc(s: str) -> tuple[str, bool]:
    """目录只留域代码：begin + 指令 + separate，一行占位文字，end。样例目录项（带模板原文的标题）全部删掉。
    end 所在段若是分节符段（带 sectPr），保留它的段落属性，免得把目录那一节的分节丢了。"""
    rng = _toc_range(s)
    if not rng:
        return s, False
    a, b = rng
    seg = s[a:b]
    instr = TOC_INSTR.search(seg)
    begin = [x for x in FLD_RE.finditer(seg, 0, instr.start()) if x.group(1) == "begin"][-1]
    depth, sep, end = 0, None, None
    for x in FLD_RE.finditer(seg, begin.start()):
        t = x.group(1)
        if t == "begin":
            depth += 1
        elif t == "end":
            depth -= 1
            if depth == 0:
                end = x
                break
        elif t == "separate" and depth == 1 and sep is None:
            sep = x
    if sep is None or end is None:
        return s, False
    head = seg[:seg.find("</w:r>", sep.end()) + len("</w:r>")]
    placeholder = f'<w:r><w:t xml:space="preserve">{TOC_PLACEHOLDER}</w:t></w:r>'
    end_run = '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    end_p = [x.start() for x in P_OPEN.finditer(seg, 0, end.start())][-1]
    if end_p == 0:
        new = head + placeholder + end_run
    else:
        m = re.match(r"<w:p\b[^>]*>(\s*<w:pPr>.*?</w:pPr>)?", seg[end_p:], re.S)
        new = head + placeholder + "</w:p>" + m.group(0) + end_run
    return s[:a] + new + s[b:], True


def build_front(pkg: Package, report_front: dict, dec: dict) -> tuple[Package, list[str]]:
    """按决定切出前置区骨架。返回 (front 包, 日志)。不写盘。"""
    d = _Doc(pkg)
    if not d.boundary:
        raise ValueError("来源文档里认不出前置区（采集之后改过？请回到第 ② 步重新分析）")
    fr = _Front(d)
    if _sig({"blocks": d.boundary, "fields": fr.fields, "tables": fr.tables}) != report_front.get("sig"):
        raise ValueError("来源文档的前置区与采集报告对不上（采集之后改过？请回到第 ② 步重新分析）")
    edits: list = []
    roles = dec.get("fields") or {}
    mapped = []
    for f in fr.fields:
        role = roles.get(f["id"], f["guess"] or "keep")
        if role != "keep":
            _field_edits(fr, f, role, edits)
            mapped.append(role)
    rules = dec.get("tables") or {}
    cleared = 0
    for t in fr.tables:
        cleared += _table_edits(fr, t, rules.get(t["id"], t["defaultRule"]), edits)
    s = fr.s
    for a, b, new in sorted(edits, key=lambda e: -e[0]):
        s = s[:a] + new + s[b:]
    s, toc = collapse_toc(s)
    # 最后一节的分节属性挪到 body 末尾，front.docx 自己也是一份能单独打开、预览的文档
    at = s.rfind("<w:sectPr")
    close = s.find("</w:sectPr>", at) + len("</w:sectPr>")
    sect = s[at:close]
    s = s[:at] + s[close:]
    doc = d.doc[:d.b0] + s + sect + d.doc[d.b1:]
    out = Package(dict(pkg.files), list(pkg.order))
    out.set_text("word/document.xml", doc)
    _prune(out)
    log = [f"前置区：{len(fr.sec_ends)} 节，字段 {len(mapped)} 个写成占位符"
           + (f"（{'、'.join(ROLE_LABEL[r] for r in mapped)}）" if mapped else "")
           + f"，清空样例单元格 {cleared} 个" + ("，目录保留为域" if toc else "")]
    return out, log


def _resolve(owner: str, target: str) -> str:
    if target.startswith("/"):
        return target[1:]
    return posixpath.normpath(posixpath.join(posixpath.dirname(owner), target))


def _rels_of(part: str) -> str:
    return posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels")


def _prune(pkg: Package) -> None:
    """只留前置区用得到的部件：正文引用的关系 + 结构部件；批注、词汇表、customXml、原文档属性一律去掉。"""
    doc = pkg.text("word/document.xml")
    used = {m.group(2) for m in RID_RE.finditer(doc)}
    rels_part = "word/_rels/document.xml.rels"

    def keep(m):
        rel = m.group(0)
        rid = re.search(r'Id="([^"]+)"', rel).group(1)
        typ = re.search(r'Type="([^"]+)"', rel).group(1)
        return rel if rid in used or typ.endswith(STRUCTURAL) else ""

    pkg.set_text(rels_part, re.sub(r"<Relationship\b[^>]*/>", keep, pkg.text(rels_part)))
    # 脚注 / 尾注只留分隔符：普通脚注是样例正文
    for part, tag in (("word/footnotes.xml", "footnote"), ("word/endnotes.xml", "endnote")):
        if part in pkg.files:
            pkg.set_text(part, re.sub(r"<w:%s\b(?![^>]*w:type=)[^>]*>.*?</w:%s>" % (tag, tag), "", pkg.text(part), flags=re.S))
    if "word/settings.xml" in pkg.files:
        st = pkg.text("word/settings.xml")
        st = re.sub(r"<w:attachedTemplate\b[^>]*/>|<w:docVars>.*?</w:docVars>", "", st, flags=re.S)
        pkg.set_text("word/settings.xml", st)
        pkg.remove("word/_rels/settings.xml.rels")
    pkg.set_text("_rels/.rels", (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="word/document.xml"/></Relationships>'))
    # 从包根沿关系走一遍，走不到的部件删掉
    reach, todo = set(), ["word/document.xml"]
    while todo:
        part = todo.pop()
        if part in reach or part not in pkg.files:
            continue
        reach.add(part)
        rp = _rels_of(part)
        if rp in pkg.files:
            reach.add(rp)
            for m in re.finditer(r"<Relationship\b[^>]*/>", pkg.text(rp)):
                if 'TargetMode="External"' in m.group(0):
                    continue
                todo.append(_resolve(part, re.search(r'Target="([^"]+)"', m.group(0)).group(1)))
    for name in list(pkg.files):
        if name not in reach and name not in ("[Content_Types].xml", "_rels/.rels"):
            pkg.remove(name)
    ct = pkg.text("[Content_Types].xml")
    ct = re.sub(r'<Override PartName="/([^"]+)"[^>]*/>', lambda m: m.group(0) if m.group(1) in pkg.files else "", ct)
    pkg.set_text("[Content_Types].xml", ct)


# ---------- 取值 ----------
def read_front_matter(md_text: str) -> dict:
    """md 的扁平 front-matter（只认 `key: value`）。"""
    m = re.match(r"^---\s*\n(.*?)\n---\s*(\n|$)", md_text, re.S)
    out = {}
    if not m:
        return out
    for line in m.group(1).splitlines():
        k, sep, v = line.partition(":")
        if sep and k.strip() and not k.startswith(" "):
            v = v.strip().strip("'\"")
            if v:
                out[k.strip()] = v
    return out


def read_identity(ws) -> dict:
    """project.yaml 里 identity 下的平铺键（只读甲方 / 承建方要用的那一层；不引 PyYAML）。"""
    for name in ("project.yaml", "project.yml"):
        try:
            lines = (ws / name).read_text(encoding="utf-8").splitlines()
            break
        except OSError:
            lines = None
    if not lines:
        return {}
    out, inside_id = {}, False
    for line in lines:
        if re.match(r"^\S", line):
            inside_id = line.split("#")[0].strip() == "identity:"
            continue
        m = re.match(r"^  (\S[^:]*):\s*(.*)$", line) if inside_id else None
        if m:
            v = re.sub(r"\s+#.*$", "", m.group(2)).strip().strip("'\"")
            if v and v not in ("null", "~"):
                out[m.group(1).strip()] = v
    return out


def fill_values(fm: dict, doc_title: str | None, identity: dict, today: dt.date) -> dict:
    """字段值与来源：md front-matter → 文档标题（title）→ project.yaml（client / vendor）→ 当天（date）。"""
    out = {}
    for role in ROLES:
        if fm.get(role):
            out[role] = (fm[role], "front-matter")
    if "title" not in out and doc_title:
        out["title"] = (doc_title, "文档标题")
    for role, key in (("client", "甲方"), ("vendor", "承建方")):
        if role not in out and identity.get(key):
            out[role] = (identity[key], f"project.yaml 的 identity.{key}")
    if "date" not in out:
        out["date"] = (f"{today.year}年{today.month}月", "转换当天")
    return out


# ---------- 装配 ----------
def roles_in(front_pkg: Package) -> list[str]:
    doc = front_pkg.text("word/document.xml")
    return [r for r in ROLES if "{{%s}}" % r in doc]


def _style_blocks(styles: str) -> dict[str, str]:
    return {re.search(r'w:styleId="([^"]+)"', b).group(1): b for b in re.findall(r"<w:style\b.*?</w:style>", styles, re.S)}


def _style_name(block: str) -> str:
    m = re.search(r'<w:name w:val="([^"]+)"', block)
    return m.group(1).lower() if m else ""


def assemble(out: Package, front: Package, values: dict) -> tuple[list[str], list[str]]:
    """把前置区装到 pandoc 成品前面。values：角色 → (值, 来源)。返回 (log, warnings)。"""
    log, warnings = [], []
    fdoc = front.text("word/document.xml")
    f0, f1 = body_bounds(fdoc)
    content = fdoc[f0:f1]
    at = content.rfind("<w:sectPr")
    sect = content[at:]
    content = content[:at]
    # 分节属性回到前置区最后一段（前置区最后一个分节符保留，它的页眉页脚属于前置区）
    blocks = top_blocks(content)
    _, ls, le = blocks[-1]
    last = content[ls:le]
    if last.endswith("/>") and last.count("<") == 1:
        last = last[:-2] + f"><w:pPr>{sect}</w:pPr></w:p>"
    else:
        m = re.match(r"<w:p\b[^>]*>\s*<w:pPr>", last)
        if m:
            i = last.find("</w:pPr>")
            last = last[:i] + sect + last[i:]
        else:
            m = re.match(r"<w:p\b[^>]*>", last)
            last = last[:m.end()] + f"<w:pPr>{sect}</w:pPr>" + last[m.end():]
    content = content[:ls] + last + content[le:]

    # 字段
    missing = []
    for role in ROLES:
        ph = "{{%s}}" % role
        if ph not in content:
            continue
        if role in values:
            v, src = values[role]
            content = content.replace(ph, escape(v))
            log.append(f"封面字段：{ROLE_LABEL[role]} ← {src}")
        else:
            content = content.replace(ph, f"【待填：{ROLE_LABEL[role]}】")
            missing.append(ROLE_LABEL[role])
    for m in missing:
        warnings.append(f"封面「{m}」没有取到值，成品里显示「【待填：{m}】」，发出前请补上")

    # 关系与部件
    frels = front.text("word/_rels/document.xml.rels")
    orels_part = "word/_rels/document.xml.rels"
    orels = out.text(orels_part)
    ct = out.text("[Content_Types].xml")
    fct = front.text("[Content_Types].xml")
    taken = set(re.findall(r'Id="([^"]+)"', orels))
    rel_by_id = {re.search(r'Id="([^"]+)"', r).group(1): r for r in re.findall(r"<Relationship\b[^>]*/>", frels)}
    part_map: dict[str, str] = {}
    copied: list[str] = []

    def new_name(part: str) -> str:
        d, b = posixpath.split(part)
        n, cand = 0, posixpath.join(d, "front-" + b)
        while cand in out.files:
            n += 1
            cand = posixpath.join(d, f"front{n}-" + b)
        return cand

    def copy_part(part: str) -> str:
        nonlocal ct
        if part in part_map:
            return part_map[part]
        if part not in front.files:  # 关系指向不存在的部件（原件本来就坏着）：照原样留着引用
            part_map[part] = part
            return part
        dst = new_name(part)
        part_map[part] = dst
        out.files[dst] = front.files[part]
        out.order.append(dst)
        copied.append(dst)
        m = re.search(r'<Override PartName="/%s" ContentType="([^"]+)"' % re.escape(part), fct)
        if m:
            ct = ct.replace("</Types>", f'<Override PartName="/{dst}" ContentType="{m.group(1)}"/></Types>')
        ext = part.rsplit(".", 1)[-1].lower()
        if f'Extension="{ext}"' not in ct.replace("Extension='", 'Extension="'):
            dm = re.search(r'<Default Extension="%s" ContentType="([^"]+)"' % re.escape(ext), fct, re.I)
            if dm:
                ct = ct.replace("</Types>", f'<Default Extension="{ext}" ContentType="{dm.group(1)}"/></Types>')
        rp = _rels_of(part)
        if rp in front.files:
            def retarget(rm):
                rel = rm.group(0)
                if 'TargetMode="External"' in rel:
                    return rel
                t = re.search(r'Target="([^"]+)"', rel).group(1)
                nd = copy_part(_resolve(part, t))
                return rel.replace(f'Target="{t}"', f'Target="{posixpath.relpath(nd, posixpath.dirname(dst))}"')
            out.set_text(_rels_of(dst), re.sub(r"<Relationship\b[^>]*/>", retarget, front.text(rp)))
        return dst

    rid_map: dict[str, str] = {}
    n = 0
    for rid in dict.fromkeys(m.group(2) for m in RID_RE.finditer(content)):
        rel = rel_by_id.get(rid)
        if rel is None:
            continue
        n += 1
        while f"rIdF{n}" in taken:
            n += 1
        new = f"rIdF{n}"
        taken.add(new)
        rid_map[rid] = new
        rel = rel.replace(f'Id="{rid}"', f'Id="{new}"')
        if 'TargetMode="External"' not in rel:
            t = re.search(r'Target="([^"]+)"', rel).group(1)
            nd = copy_part(_resolve("word/document.xml", t))
            rel = rel.replace(f'Target="{t}"', f'Target="{posixpath.relpath(nd, "word")}"')
        orels = orels.replace("</Relationships>", rel + "</Relationships>")
    content = RID_RE.sub(lambda m: f'r:{m.group(1)}="{rid_map.get(m.group(2), m.group(2))}"', content)
    out.set_text(orels_part, orels)

    # 样式：按显示名对齐；成品里没有的连同 basedOn 链补进去，ID 撞了就改名
    fstyles = _style_blocks(front.text("word/styles.xml"))
    ostyles_x = out.text("word/styles.xml")
    ostyles = _style_blocks(ostyles_x)
    oname = {_style_name(b): sid for sid, b in ostyles.items()}
    texts = [content] + [out.text(p) for p in copied if p.endswith(".xml")]
    used = {m.group(1) for t in texts for m in re.finditer(r'<w:(?:pStyle|rStyle|tblStyle) w:val="([^"]+)"', t)}
    todo, closure = list(used), []
    while todo:
        sid = todo.pop()
        if sid in closure or sid not in fstyles:
            continue
        closure.append(sid)
        todo += re.findall(r'<w:(?:basedOn|link|next) w:val="([^"]+)"', fstyles[sid])
    smap, added = {}, []
    for sid in closure:
        name = _style_name(fstyles[sid])
        if name in oname:
            smap[sid] = oname[name]
        else:
            new, k = sid, 0
            while new in ostyles or new in smap.values():
                k += 1
                new = f"F{k}{sid}"
            smap[sid] = new
            added.append(sid)

    def restyle(t: str) -> str:
        return re.sub(r'(<w:(?:pStyle|rStyle|tblStyle|basedOn|link|next) w:val=")([^"]+)(")',
                      lambda m: m.group(1) + smap.get(m.group(2), m.group(2)) + m.group(3), t)

    content = restyle(content)
    for p in copied:
        if p.endswith(".xml") and "/_rels/" not in p:
            out.set_text(p, restyle(out.text(p)))
    new_blocks = "".join(restyle(re.sub(r'w:styleId="[^"]+"', f'w:styleId="{smap[s]}"', fstyles[s], count=1))
                         .replace(' w:default="1"', "") for s in added)
    # 编号：前置区（含随它带入的样式）用到的编号定义换一套不冲突的 id 补进去
    content, new_blocks = _merge_numbering(out, front, content, new_blocks)
    out.set_text("word/styles.xml", ostyles_x.replace("</w:styles>", new_blocks + "</w:styles>"))

    # 绘图对象 id 挪开，免得和正文图片撞号
    content = re.sub(r'(<wp:docPr\b[^>]*?\bid=")(\d+)(")', lambda m: f"{m.group(1)}{int(m.group(2)) + 10000}{m.group(3)}", content)

    # 正文前插入；根元素补上前置区用到的命名空间声明
    odoc = out.text("word/document.xml")
    o0, _ = body_bounds(odoc)
    odoc = odoc[:o0] + content + odoc[o0:]
    fopen = re.search(r"<w:document\b[^>]*>", fdoc).group(0)
    oopen = re.search(r"<w:document\b[^>]*>", odoc).group(0)
    extra = [m.group(0) for m in re.finditer(r'\sxmlns:(\w+)="[^"]*"', fopen)
             if f"xmlns:{m.group(1)}=" not in oopen]
    newopen = oopen[:-1] + "".join(extra)
    ign = re.search(r'\bmc:Ignorable="([^"]*)"', fopen)
    if ign and "mc:Ignorable=" not in newopen:
        newopen += f' mc:Ignorable="{ign.group(1)}"'
    odoc = odoc.replace(oopen, newopen + ">", 1)
    out.set_text("word/document.xml", odoc)
    out.set_text("[Content_Types].xml", ct)
    _update_fields(out)
    log.insert(0, f"前置区：已装配（{len(copied)} 个部件、{len(added)} 个样式随前置区带入）")
    return log, warnings


def _merge_numbering(out: Package, front: Package, content: str, style_xml: str) -> tuple[str, str]:
    ids = {m.group(1) for m in re.finditer(r'<w:numId w:val="(\d+)"', content + style_xml)} - {"0"}
    if not ids or "word/numbering.xml" not in front.files or "word/numbering.xml" not in out.files:
        return content, style_xml
    fnum = front.text("word/numbering.xml")
    onum = out.text("word/numbering.xml")
    abs_off = max([int(x) for x in re.findall(r'w:abstractNumId="(\d+)"', onum)] + [0]) + 1000
    num_off = max([int(x) for x in re.findall(r'<w:num w:numId="(\d+)"', onum)] + [0]) + 1000
    nums, abss = [], []
    for nid in sorted(ids):
        m = re.search(r'<w:num w:numId="%s"[^>]*>.*?</w:num>' % nid, fnum, re.S)
        if not m:
            continue
        aid = re.search(r'<w:abstractNumId w:val="(\d+)"', m.group(0)).group(1)
        am = re.search(r'<w:abstractNum\b[^>]*w:abstractNumId="%s"[^>]*>.*?</w:abstractNum>' % aid, fnum, re.S)
        nums.append(m.group(0).replace(f'w:numId="{nid}"', f'w:numId="{int(nid) + num_off}"')
                    .replace(f'<w:abstractNumId w:val="{aid}"', f'<w:abstractNumId w:val="{int(aid) + abs_off}"'))
        if am:
            abss.append(re.sub(r'w:abstractNumId="%s"' % aid, f'w:abstractNumId="{int(aid) + abs_off}"', am.group(0)))
    first_num = onum.find("<w:num ")
    first_num = first_num if first_num >= 0 else onum.rfind("</w:numbering>")
    onum = onum[:first_num] + "".join(abss) + onum[first_num:]
    onum = onum.replace("</w:numbering>", "".join(nums) + "</w:numbering>")
    out.set_text("word/numbering.xml", onum)
    def renum(t):
        return re.sub(r'<w:numId w:val="(\d+)"', lambda m: f'<w:numId w:val="{int(m.group(1)) + num_off}"'
                      if m.group(1) in ids else m.group(0), t)
    return renum(content), renum(style_xml)


# CT_Settings 里排在 updateFields 之后的元素；updateFields 要插在它们前面，顺序错了 Word 会报文件损坏
_AFTER_UPDATE = ("hdrShapeDefaults", "footnotePr", "endnotePr", "compat", "docVars", "rsids", "m:mathPr",
                 "attachedSchema", "themeFontLang", "clrSchemeMapping", "doNotIncludeSubdocsInStats",
                 "doNotAutoCompressPictures", "forceUpgrade", "captions", "readModeInkLockDown", "smartTagType",
                 "sl:schemaLibrary", "shapeDefaults", "doNotEmbedSmartTags", "decimalSymbol", "listSeparator")


def _update_fields(pkg: Package) -> None:
    """打开时提示更新域：目录页码、SEQ 编号由 Word 自己算（design D6）。"""
    if "word/settings.xml" not in pkg.files:
        return
    st = pkg.text("word/settings.xml")
    if "<w:updateFields" in st:
        return
    tag = '<w:updateFields w:val="true"/>'
    pos = [st.find("<" + (e if ":" in e else "w:" + e)) for e in _AFTER_UPDATE]
    pos = [p for p in pos if p >= 0]
    at = min(pos) if pos else st.rfind("</w:settings>")
    pkg.set_text("word/settings.xml", st[:at] + tag + st[at:])
