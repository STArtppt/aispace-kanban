"""采集：给 docx 每个段落的「实际生效格式」拍快照，输出脱敏报告。

必须排在任何清洗之前 —— 旧文档的样式定义不可信（实测：标题样式写 22pt，
每个标题却都被手动设成 14pt），只有逐段算出来的生效格式才作数。
生效格式的层叠顺序：docDefaults → 表格样式（含首行条件格式）→ 段落样式链 → 段落/字符手动格式。

同一个函数也拿来**反查**生成的样张：逐个角色比对实际格式与规范（见 verify.py）。

报告不含正文原文：段落只保留「编号前缀 + 字数」（如 `（1）[35字]`），页眉页脚只报字数和域。
报告的键名是看板界面的契约（src/app/lib/api.ts 的 DocxCollectReport），改名要两边一起改。
"""

from __future__ import annotations

import json
import re
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET

from .ooxml import NS, q, wval

REPORT_SCHEMA = 1

# ---------- 脱敏 ----------
NUM_PATTERNS = [
    ("第X章", r"^第[一二三四五六七八九十百\d]+[章节部分篇]"),
    ("一、", r"^[一二三四五六七八九十]+[、．.]"),
    ("（一）", r"^[（(][一二三四五六七八九十]+[)）]"),
    ("1.1.1.1", r"^\d+\.\d+\.\d+\.\d+(?!\d)"),
    ("1.1.1", r"^\d+\.\d+\.\d+(?![.\d])"),
    ("1.1", r"^\d+\.\d+(?![.\d])"),
    ("1、/1.", r"^\d+[、．.](?!\d)"),
    ("（1）", r"^[（(]\d+[)）]"),
    ("1）", r"^\d+[)）]"),
    ("①", r"^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]"),
    ("A./a)", r"^[A-Za-z][.)）、]"),
]
CAPTION_RE = re.compile(r"^\s*(图|表|Figure|Table)\s*\d+([\-.－—]\d+)*")


def num_prefix(text: str):
    t = text.strip()
    m = CAPTION_RE.match(t)
    if m:
        return "caption:" + m.group(1), m.group(0).strip()
    for name, pat in NUM_PATTERNS:
        m = re.match(pat, t)
        if m:
            return name, m.group(0)
    return None, ""


def mask(text: str) -> str:
    t = text.strip()
    if not t:
        return "[空]"
    _, prefix = num_prefix(t)
    return f"{prefix}[{len(t) - len(prefix)}字]"


# ---------- 属性抽取 ----------
def ppr_props(ppr) -> dict:
    d = {}
    if ppr is None:
        return d
    jc = ppr.find("w:jc", NS)
    if jc is not None:
        d["jc"] = wval(jc)
    ind = ppr.find("w:ind", NS)
    if ind is not None:
        for k in ("firstLine", "firstLineChars", "hanging", "hangingChars", "left", "leftChars", "start", "startChars"):
            v = ind.get(q("w:" + k))
            if v is not None:
                d["ind." + k] = v
    sp = ppr.find("w:spacing", NS)
    if sp is not None:
        for k in ("before", "after", "beforeLines", "afterLines", "line", "lineRule"):
            v = sp.get(q("w:" + k))
            if v is not None:
                d["sp." + k] = v
    ol = ppr.find("w:outlineLvl", NS)
    if ol is not None:
        d["outlineLvl"] = wval(ol)
    np_ = ppr.find("w:numPr", NS)
    if np_ is not None:
        nid = np_.find("w:numId", NS)
        il = np_.find("w:ilvl", NS)
        if nid is not None:
            d["numId"] = wval(nid)
        if il is not None:
            d["ilvl"] = wval(il)
    for flag in ("keepNext", "pageBreakBefore"):
        if ppr.find("w:" + flag, NS) is not None:
            d[flag] = wval(ppr.find("w:" + flag, NS)) not in ("0", "false")
    return d


def onoff(el):
    if el is None:
        return None
    return wval(el) not in ("0", "false", "off")


def rpr_props(rpr) -> dict:
    d = {}
    if rpr is None:
        return d
    f = rpr.find("w:rFonts", NS)
    if f is not None:
        for k in ("ascii", "eastAsia", "hAnsi", "asciiTheme", "eastAsiaTheme", "hAnsiTheme"):
            v = f.get(q("w:" + k))
            if v is not None:
                d["font." + k] = v
    sz = rpr.find("w:sz", NS)
    if sz is not None:
        d["sz"] = wval(sz)
    for k in ("b", "i", "caps"):
        v = onoff(rpr.find("w:" + k, NS))
        if v is not None:
            d[k] = v
    c = rpr.find("w:color", NS)
    if c is not None:
        d["color"] = wval(c)
    return d


def merge_r(base: dict, layer: dict) -> dict:
    """上层显式字体会压掉下层继承来的主题字体（否则会误报成主题里的 Calibri / 宋体）。"""
    out = dict(base)
    for slot in ("ascii", "eastAsia", "hAnsi"):
        if f"font.{slot}" in layer and f"font.{slot}Theme" not in layer:
            out.pop(f"font.{slot}Theme", None)
    out.update(layer)
    return out


def merge_p(base: dict, layer: dict) -> dict:
    """`beforeLines` 优先于 `before`：上层只写了 before 时，要把下层继承来的 beforeLines 去掉，
    否则会按下层的「行」算，和 Word 的显示对不上。"""
    out = dict(base)
    for k in ("before", "after"):
        if f"sp.{k}" in layer and f"sp.{k}Lines" not in layer:
            out.pop(f"sp.{k}Lines", None)
    out.update(layer)
    return out


# ---------- 样式表 ----------
class Styles:
    def __init__(self, root):
        self.by_id = {}
        self.default_para = None
        self.default_table = None
        dd = root.find("w:docDefaults", NS)
        self.doc_ppr = ppr_props(dd.find("w:pPrDefault/w:pPr", NS)) if dd is not None else {}
        self.doc_rpr = rpr_props(dd.find("w:rPrDefault/w:rPr", NS)) if dd is not None else {}
        for s in root.findall("w:style", NS):
            sid = s.get(q("w:styleId"))
            info = {
                "id": sid,
                "name": wval(s.find("w:name", NS)) or sid,
                "type": s.get(q("w:type")),
                "custom": s.get(q("w:customStyle")) == "1",
                "default": s.get(q("w:default")) == "1",
                "basedOn": wval(s.find("w:basedOn", NS)),
                "link": wval(s.find("w:link", NS)),
                "ppr": ppr_props(s.find("w:pPr", NS)),
                "rpr": rpr_props(s.find("w:rPr", NS)),
                "has_tblBorders": s.find("w:tblPr/w:tblBorders", NS) is not None,
            }
            fr = [x for x in s.findall("w:tblStylePr", NS) if x.get(q("w:type")) == "firstRow"]
            if fr:
                info["first_row"] = {"ppr": ppr_props(fr[0].find("w:pPr", NS)), "rpr": rpr_props(fr[0].find("w:rPr", NS))}
            self.by_id[sid] = info
            if info["default"] and info["type"] == "paragraph":
                self.default_para = sid
            if info["default"] and info["type"] == "table":
                self.default_table = sid

    def chain(self, sid):
        out, seen = [], set()
        while sid and sid in self.by_id and sid not in seen:
            seen.add(sid)
            out.append(self.by_id[sid])
            sid = self.by_id[sid]["basedOn"]
        return list(reversed(out))  # 根 → 叶

    def resolved(self, sid, table=None):
        p, r = dict(self.doc_ppr), dict(self.doc_rpr)
        if table:
            ts, first_row = table
            for s in self.chain(ts):
                p = merge_p(p, s["ppr"])
                r = merge_r(r, s["rpr"])
                if first_row and s.get("first_row"):
                    p = merge_p(p, s["first_row"]["ppr"])
                    r = merge_r(r, s["first_row"]["rpr"])
        for s in self.chain(sid):
            p = merge_p(p, s["ppr"])
            r = merge_r(r, s["rpr"])
        return p, r

    def name(self, sid):
        return self.by_id.get(sid, {}).get("name", sid)


def load_theme_fonts(z):
    fonts = {}
    try:
        root = ET.fromstring(z.read("word/theme/theme1.xml"))
    except KeyError:
        return fonts
    for kind in ("major", "minor"):
        f = root.find(f".//a:{kind}Font", NS)
        if f is None:
            continue
        lat = f.find("a:latin", NS)
        ea = f.find("a:ea", NS)
        hans = [x for x in f.findall("a:font", NS) if x.get("script") == "Hans"]
        fonts[kind + "HAnsi"] = fonts[kind + "Ascii"] = lat.get("typeface") if lat is not None else None
        ea_face = ea.get("typeface") if ea is not None else ""
        fonts[kind + "EastAsia"] = ea_face or (hans[0].get("typeface") if hans else None)
    return fonts


def font_of(r, key, theme):
    th = r.get(f"font.{key}Theme")
    if th:
        return theme.get(th) or None
    return r.get(f"font.{key}")


def _num(v, div):
    return None if v is None else round(int(v) / div, 2)


JC_NORMAL = {"start": "left", "end": "right", "distribute": "both"}


def describe(p, r, theme) -> dict:
    """生效格式 → 报告里的格式对象（数值化，单位：pt / 字符 / 倍）。空值按 Word 的缺省补齐。"""
    line, line_exact, line_least = 1.0, None, None
    if "sp.line" in p:
        line = None
        rule = p.get("sp.lineRule", "auto")
        if rule == "auto":
            line = round(int(p["sp.line"]) / 240, 2)
        elif rule == "exact":
            line_exact = _num(p["sp.line"], 20)
        else:
            line_least = _num(p["sp.line"], 20)
    first_chars = _num(p.get("ind.firstLineChars"), 100) if p.get("ind.firstLineChars") not in (None, "0") else None
    first_pt = _num(p.get("ind.firstLine"), 20) if first_chars is None and p.get("ind.firstLine") not in (None, "0") else None
    left_raw_chars = p.get("ind.leftChars") or p.get("ind.startChars")
    left_raw = p.get("ind.left") or p.get("ind.start")
    left_chars = _num(left_raw_chars, 100) if left_raw_chars not in (None, "0") else None
    left_pt = _num(left_raw, 20) if left_chars is None and left_raw not in (None, "0") else None
    jc = p.get("jc", "left")
    outline = p.get("outlineLvl")
    return {
        "eastAsia": font_of(r, "eastAsia", theme),
        "ascii": font_of(r, "ascii", theme),
        "size": _num(r.get("sz"), 2) if r.get("sz") else 10.0,
        "bold": bool(r.get("b")),
        "jc": JC_NORMAL.get(jc, jc),
        "firstLineChars": first_chars,
        "firstLinePt": first_pt,
        "hanging": ("ind.hangingChars" in p or "ind.hanging" in p) and p.get("ind.hanging") != "0",
        "leftChars": left_chars,
        "leftPt": left_pt,
        "before": _num(p.get("sp.before"), 20) or 0.0,
        "after": _num(p.get("sp.after"), 20) or 0.0,
        "beforeLines": _num(p.get("sp.beforeLines"), 100),
        "afterLines": _num(p.get("sp.afterLines"), 100),
        "line": line,
        "lineExact": line_exact,
        "lineAtLeast": line_least,
        "outline": None if outline in (None, "9") else int(outline) + 1,
    }


# 界面上提示「样式定义与实际显示不一致」时比对这几项
MISMATCH_KEYS = ("eastAsia", "ascii", "size", "bold", "jc", "firstLineChars", "line", "before", "after")


# ---------- 编号 ----------
def load_numbering(z):
    try:
        root = ET.fromstring(z.read("word/numbering.xml"))
    except KeyError:
        return {}, {}
    abstracts = {}
    for an in root.findall("w:abstractNum", NS):
        lv = {}
        for l in an.findall("w:lvl", NS):
            lv[l.get(q("w:ilvl"))] = {"fmt": wval(l.find("w:numFmt", NS)), "text": wval(l.find("w:lvlText", NS))}
        abstracts[an.get(q("w:abstractNumId"))] = lv
    nums = {n.get(q("w:numId")): wval(n.find("w:abstractNumId", NS)) for n in root.findall("w:num", NS)}
    return nums, abstracts


def fields_of(el):
    out = set()
    for t in el.iter(q("w:instrText")):
        if t.text and t.text.strip():
            out.add(t.text.strip().split()[0])
    for f in el.iter(q("w:fldSimple")):
        ins = (f.get(q("w:instr")) or "").strip()
        if ins:
            out.add(ins.split()[0])
    return sorted(out)


def drawing_of(el):
    if next(el.iter(q("wp:inline")), None) is not None:
        return "inline"
    if next(el.iter(q("wp:anchor")), None) is not None:
        return "anchor"
    if next(el.iter("{urn:schemas-microsoft-com:vml}shape"), None) is not None or next(el.iter(q("w:pict")), None) is not None:
        return "vml"
    return None


def para_text(p):
    return "".join(t.text or "" for t in p.iter(q("w:t")))


def dominant_run_rpr(p, styles, base_r):
    """按字数取占比最高的 run 的最终字符格式。"""
    best, best_len = dict(base_r), -1
    for run in p.iter(q("w:r")):
        txt = "".join(t.text or "" for t in run.findall("w:t", NS))
        if not txt.strip():
            continue
        rpr = run.find("w:rPr", NS)
        eff = dict(base_r)
        rs = wval(rpr.find("w:rStyle", NS)) if rpr is not None else None
        if rs:
            for s in styles.chain(rs):
                eff = merge_r(eff, s["rpr"])
        eff = merge_r(eff, rpr_props(rpr))
        if len(txt) > best_len:
            best, best_len = eff, len(txt)
    return best


def direct_format(p):
    """段落 / run 上会覆盖样式的手动格式项。"""
    ppr = p.find("w:pPr", NS)
    direct_p = {k for k in ppr_props(ppr) if k not in ("numId", "ilvl")} if ppr is not None else set()
    direct_r = set()
    for run in p.iter(q("w:r")):
        direct_r |= set(rpr_props(run.find("w:rPr", NS)))
    return sorted(direct_p), sorted(direct_r)


def suggest_role(c: dict) -> str | None:
    """给格式簇一个建议角色（界面上的默认值，用户可以改）。None = 建议丢弃（目录项等）。

    判据按可靠程度排：区域 → 样式名 → 大纲级别 → 题注形编号 → 自动编号，都认不出就当正文。
    没有 decisions 时 build 直接采用这里的建议，所以终端里 `--decisions` 给个 `{}` 也能出模板。
    """
    if c["zone"] == "table":
        return "Table"
    names = " ".join(c["styles"]).lower()
    if re.search(r"\btoc \d", names):
        return None
    outline = c["fmt"]["outline"]
    if names.startswith("title") or (not outline and c["count"] <= 2 and c["fmt"]["jc"] == "center"
                                     and (c["fmt"]["size"] or 0) >= 18):
        return "Title"
    if outline:
        if c["pseudoHeading"] or outline >= 4:
            return "Heading4"
        return f"Heading{outline}"
    m = re.search(r"\bheading (\d)", names)
    if m:
        return f"Heading{min(int(m.group(1)), 4)}"
    caption = next((k for k in c["manualNum"] if k.startswith("caption:")), None)
    if caption or "caption" in names:
        if caption in ("caption:表", "caption:Table"):
            return "TableCaption"
        if caption in ("caption:图", "caption:Figure"):
            return "ImageCaption"
        return "Caption"
    if any(k != "无" for k in c["autoNum"]):
        return "Compact"
    return "BodyText"


def _counter(c: Counter, n: int | None = None) -> dict:
    return dict(c.most_common(n))


# ---------- 主流程 ----------
def collect(src: Path, source_label: str | None = None) -> tuple[dict, list[dict]]:
    """返回 (report, paragraphs)。paragraphs 是逐段快照（同样脱敏），反查也用它。"""
    z = zipfile.ZipFile(src)
    theme = load_theme_fonts(z)
    styles = Styles(ET.fromstring(z.read("word/styles.xml")))
    nums, abstracts = load_numbering(z)
    doc = ET.fromstring(z.read("word/document.xml"))
    body = doc.find("w:body", NS)

    used_styles = Counter()
    for part in z.namelist():
        if part.startswith("word/") and part.endswith(".xml") and part not in ("word/styles.xml", "word/numbering.xml"):
            root = ET.fromstring(z.read(part))
            for tag in ("pStyle", "rStyle", "tblStyle"):
                for el in root.iter(q("w:" + tag)):
                    used_styles[wval(el)] += 1

    # 顺序遍历正文块（展开 sdt：目录一般包在 sdt 里）
    blocks = []

    def walk(container, in_table=False, in_sdt=False):
        for el in container:
            if el.tag == q("w:p"):
                blocks.append(("p", el, in_table, in_sdt))
            elif el.tag == q("w:tbl"):
                blocks.append(("tbl", el, in_table, in_sdt))
                tp = el.find("w:tblPr", NS)
                ts = (wval(tp.find("w:tblStyle", NS)) if tp is not None else None) or styles.default_table
                for ri, tr in enumerate(el.findall("w:tr", NS)):
                    for tc in tr.findall("w:tc", NS):
                        walk(tc, (ts, ri == 0), in_sdt)
            elif el.tag == q("w:sdt"):
                c = el.find("w:sdtContent", NS)
                if c is not None:
                    walk(c, in_table, True)

    walk(body)

    paras = []
    used_abstract = set()
    top_seq = []  # 顶层（非表格内）块序列，用于相邻关系
    for kind, el, in_table, in_sdt in blocks:
        if kind == "tbl":
            if not in_table:
                top_seq.append({"kind": "tbl", "el": el})
            continue
        ppr = el.find("w:pPr", NS)
        sid = (wval(ppr.find("w:pStyle", NS)) if ppr is not None else None) or styles.default_para
        sp, sr = styles.resolved(sid, in_table if in_table else None)
        p_eff = merge_p(sp, ppr_props(ppr))
        r_eff = dominant_run_rpr(el, styles, sr)
        text = para_text(el)
        num_id = p_eff.get("numId")
        auto_num = None
        if num_id and num_id != "0":
            used_abstract.add(nums.get(num_id))
            ilvl = p_eff.get("ilvl", "0")
            lv = abstracts.get(nums.get(num_id), {}).get(ilvl, {})
            auto_num = {"fmt": lv.get("fmt"), "text": lv.get("text")}
        pat, _ = num_prefix(text)
        dp, dr = direct_format(el)
        info = {
            "i": len(paras),
            "style": styles.name(sid),
            "styleId": sid,
            "styleMissing": bool(sid) and sid not in styles.by_id,
            "inTable": bool(in_table),
            "inToc": in_sdt,
            "masked": mask(text),
            "len": len(text.strip()),
            "manualNum": pat,
            "autoNum": auto_num,
            "drawing": drawing_of(el),
            "fields": fields_of(el),
            "fmt": describe(p_eff, r_eff, theme),
            "directPpr": dp,
            "directRpr": dr,
        }
        paras.append(info)
        if not in_table:
            top_seq.append({"kind": "p", "info": info})

    # 相邻关系：表格 / 图片的前后一段是什么（判断题注在上还是在下）
    neighbors = {k: Counter() for k in ("beforeTable", "afterTable", "beforeImage", "afterImage")}

    def tag_of(n):
        if n is None:
            return "（无）"
        if n["kind"] == "tbl":
            return "（表格）"
        i = n["info"]
        if i["drawing"]:
            return "（图片）"
        cap = "题注形" if (i["manualNum"] or "").startswith("caption") else ("空段" if i["len"] == 0 else "普通")
        return f"{i['style']} | {cap} | {'SEQ' if 'SEQ' in i['fields'] else '无SEQ'}"

    for idx, b in enumerate(top_seq):
        is_img = b["kind"] == "p" and b["info"]["drawing"]
        if b["kind"] == "tbl" or is_img:
            key = "Table" if b["kind"] == "tbl" else "Image"
            neighbors["before" + key][tag_of(top_seq[idx - 1] if idx > 0 else None)] += 1
            neighbors["after" + key][tag_of(top_seq[idx + 1] if idx + 1 < len(top_seq) else None)] += 1

    # 表格
    tables = []
    for b in top_seq:
        if b["kind"] != "tbl":
            continue
        t = b["el"]
        tp = t.find("w:tblPr", NS)
        ts = wval(tp.find("w:tblStyle", NS)) if tp is not None else None
        rows = t.findall("w:tr", NS)
        borders = tp.find("w:tblBorders", NS) if tp is not None else None
        bdesc = {e.tag.split("}")[1]: f"{wval(e)}/{e.get(q('w:sz'))}" for e in borders} if borders is not None else {}
        tables.append({
            "style": styles.name(ts) if ts else None,
            "rows": len(rows),
            "cols": len(t.findall("w:tblGrid/w:gridCol", NS)),
            "borders": bdesc or None,
            "cellBorders": t.find(".//w:tcBorders", NS) is not None,
            "headerRepeat": bool(rows) and rows[0].find("w:trPr/w:tblHeader", NS) is not None,
            "headerShading": bool(rows) and rows[0].find(".//w:shd", NS) is not None,
            "jc": wval(tp.find("w:jc", NS)) if tp is not None else None,
        })
    border_kinds = Counter(json.dumps(t["borders"], sort_keys=True) if t["borders"] else ("单元格边框" if t["cellBorders"] else "无边框")
                           for t in tables)

    # 分节 / 页面
    sections = []
    for sp_ in doc.iter(q("w:sectPr")):
        pg = sp_.find("w:pgSz", NS)
        mar = sp_.find("w:pgMar", NS)
        sections.append({
            "page": None if pg is None else f"{int(pg.get(q('w:w'))) / 567:.1f}x{int(pg.get(q('w:h'))) / 567:.1f}cm"
                                              + (" 横向" if pg.get(q("w:orient")) == "landscape" else ""),
            "marginCm": None if mar is None else {k: round(int(mar.get(q("w:" + k), 0)) / 567, 2)
                                                 for k in ("top", "bottom", "left", "right", "header", "footer")},
            "headers": [h.get(q("w:type")) for h in sp_.findall("w:headerReference", NS)],
            "footers": [h.get(q("w:type")) for h in sp_.findall("w:footerReference", NS)],
            "titlePg": sp_.find("w:titlePg", NS) is not None,
        })

    # 页眉页脚（脱敏：只报字数、域、有没有图片表格）
    hf = {}
    for part in sorted(z.namelist()):
        if re.match(r"word/(header|footer)\d+\.xml$", part):
            root = ET.fromstring(z.read(part))
            txt = "".join(t.text or "" for t in root.iter(q("w:t")))
            hf[part.split("/")[1]] = {
                "chars": len(txt.strip()),
                "fields": fields_of(root),
                "image": drawing_of(root) is not None,
                "table": next(root.iter(q("w:tbl")), None) is not None,
            }

    # 样式统计：被使用样式的 basedOn / link 闭包也算「有效」
    all_styles = styles.by_id
    used_ids = {s for s in used_styles if s in all_styles}
    closure = set()
    for sid in used_ids:
        for s in styles.chain(sid):
            closure.add(s["id"])
            if s["link"]:
                closure.add(s["link"])

    # 格式聚类：同区域、生效格式完全相同的段落为一簇
    def fmt_key(p):
        return json.dumps(p["fmt"], ensure_ascii=False, sort_keys=True)

    groups = defaultdict(list)
    for p in paras:
        if p["len"] == 0 or p["inToc"]:
            continue
        groups[("table" if p["inTable"] else "body", fmt_key(p))].append(p)

    clusters = []
    for n, ((zone, key), ps) in enumerate(sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0])), 1):
        cid = f"c{n}"
        for p in ps:
            p["cluster"] = cid
        top_style = Counter(p["styleId"] for p in ps).most_common(1)[0][0]
        fmt = json.loads(key)
        defined = describe(*styles.resolved(top_style), theme) if zone == "body" else None
        mismatch = [k for k in MISMATCH_KEYS if defined is not None and defined[k] != fmt[k]]
        numbered = sum(1 for p in ps if p["autoNum"] or p["manualNum"])
        clusters.append({
            "id": cid,
            "zone": zone,
            "count": len(ps),
            "fmt": fmt,
            "styles": _counter(Counter(p["style"] for p in ps), 4),
            "manualNum": _counter(Counter(p["manualNum"] or "无" for p in ps), 4),
            "autoNum": _counter(Counter((p["autoNum"]["text"] if p["autoNum"] else "无") for p in ps), 4),
            "numbered": numbered,
            "avgLen": round(sum(p["len"] for p in ps) / len(ps)),
            "samples": [p["masked"] for p in ps[:3]],
            "styleDefined": defined,
            "mismatch": mismatch,
            # 有大纲级别却没有任何编号的段落：伪标题，界面上要决定并入哪一级标题还是保留为无编号小标题
            "pseudoHeading": fmt["outline"] is not None and numbered == 0,
        })
        clusters[-1]["suggestedRole"] = suggest_role(clusters[-1])

    # 大纲：按级别汇总（正文区）
    levels = defaultdict(list)
    for p in paras:
        if not p["inTable"] and p["len"] and not p["inToc"] and p["fmt"]["outline"]:
            levels[p["fmt"]["outline"]].append(p)
    outline = []
    for lv in sorted(levels):
        ps = levels[lv]
        outline.append({
            "level": lv,
            "count": len(ps),
            "numbered": sum(1 for p in ps if p["autoNum"] or p["manualNum"]),
            "styles": _counter(Counter(p["style"] for p in ps), 4),
            "autoNum": _counter(Counter(p["autoNum"]["text"] for p in ps if p["autoNum"]), 4),
            "autoNumFmt": _counter(Counter(p["autoNum"]["fmt"] for p in ps if p["autoNum"]), 4),
            "manualNum": _counter(Counter(p["manualNum"] for p in ps if p["manualNum"]), 4),
            "clusters": sorted({p["cluster"] for p in ps}, key=lambda c: int(c[1:])),
        })

    content = [p for p in paras if p["len"]]
    report = {
        "schema": REPORT_SCHEMA,
        "source": source_label or src.name,
        "styles": {
            "total": len(all_styles),
            "byType": _counter(Counter(s["type"] for s in all_styles.values())),
            "custom": sum(1 for s in all_styles.values() if s["custom"]),
            "used": len(used_ids),
            "effective": len(closure),
            "unused": len(all_styles) - len(closure),
            "defaultParagraph": styles.name(styles.default_para),
        },
        "numbering": {"abstract": len(abstracts), "used": len(used_abstract)},
        "themeFonts": theme,
        "docDefaults": describe(styles.doc_ppr, styles.doc_rpr, theme),
        "paragraphs": {
            "total": len(paras),
            "nonEmpty": len(content),
            "inTable": sum(1 for p in paras if p["inTable"]),
            "inToc": sum(1 for p in paras if p["inToc"]),
            "directPpr": sum(1 for p in content if p["directPpr"]),
            "directRpr": sum(1 for p in content if p["directRpr"]),
            "directPprKeys": _counter(Counter(k for p in content for k in p["directPpr"]), 10),
            "directRprKeys": _counter(Counter(k for p in content for k in p["directRpr"]), 10),
        },
        "outline": outline,
        "manualNum": _counter(Counter(p["manualNum"] for p in paras if p["manualNum"] and not p["inTable"])),
        "images": _counter(Counter(p["drawing"] for p in paras if p["drawing"])),
        "fields": _counter(Counter(f for p in paras for f in p["fields"])),
        "neighbors": {k: _counter(v, 6) for k, v in neighbors.items()},
        "tables": {"total": len(tables), "borderKinds": _counter(border_kinds), "items": tables[:50]},
        "sections": sections,
        "headersFooters": hf,
        "clusters": clusters,
    }
    return report, paras


def write_report(out_dir: Path, report: dict, paras: list[dict]) -> list[Path]:
    from .ooxml import write_atomic

    rp, pp = out_dir / "report.json", out_dir / "paragraphs.jsonl"
    write_atomic(rp, json.dumps(report, ensure_ascii=False, indent=1).encode("utf-8"))
    write_atomic(pp, "\n".join(json.dumps(p, ensure_ascii=False) for p in paras).encode("utf-8"))
    return [rp, pp]
