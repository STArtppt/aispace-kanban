"""生成参照模板：清洗 → 按规范重建样式 → 补齐通用角色 → 萃取 reference.docx。

以来源文档为底（保留页面设置、页眉页脚、主题），正文清空，只留最后一节的 sectPr。
「通用规范」（@base）没有客户文档，就拿 pandoc 自带的 reference.docx 当底，再套上规范里的页面设置。

几条踩过的坑（都在下面的实现里，改的时候别丢）：
1. `w:beforeLines` 优先于 `w:before`：写了 `beforeLines="0"` 会把段前段后清零，所以规范从不写 *Lines。
2. 字体、字号、行距写在 docDefaults，Normal 保持为空；Compact 不设字号 ——
   层叠顺序是 docDefaults → 表格样式 → 段落样式，这样表格样式里的字号、行距才能生效。
3. 原文已有同名样式时沿用它的 styleId（如 heading 1 的 id 是 `1`），否则页眉页脚、目录对它的引用会断。
4. 这里全程在原始 XML 字符串上做正则，不经过 ET 序列化（见 ooxml.py 的说明）。
"""

from __future__ import annotations

import re
from pathlib import Path
from xml.sax.saxutils import escape

from .ooxml import W, Package

NUMBERING_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"
NUMBERING_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering"


def half(pt):  # pt → 半磅
    return str(int(round(pt * 2)))


def twip(pt):  # pt → 缇
    return str(int(round(pt * 20)))


# ---------- 样式 XML 生成 ----------
def rpr_xml(s: dict) -> str:
    parts = []
    f = s.get("font") or {}
    if f:
        attrs = []
        if "ascii" in f:
            a = escape(f["ascii"], {'"': "&quot;"})
            attrs += [f'w:ascii="{a}"', f'w:hAnsi="{a}"', f'w:cs="{a}"']
        if "eastAsia" in f:
            attrs.append(f'w:eastAsia="{escape(f["eastAsia"], {chr(34): "&quot;"})}"')
        parts.append(f"<w:rFonts {' '.join(attrs)}/>")
    if "bold" in s:
        parts.append("<w:b/><w:bCs/>" if s["bold"] else '<w:b w:val="0"/><w:bCs w:val="0"/>')
    if "italic" in s:
        parts.append("<w:i/><w:iCs/>" if s["italic"] else '<w:i w:val="0"/><w:iCs w:val="0"/>')
    if "color" in s:
        parts.append(f'<w:color w:val="{s["color"]}"/>')
    if "size" in s:
        parts.append(f'<w:sz w:val="{half(s["size"])}"/><w:szCs w:val="{half(s["size"])}"/>')
    if s.get("superscript"):
        parts.append('<w:vertAlign w:val="superscript"/>')
    return f"<w:rPr>{''.join(parts)}</w:rPr>" if parts else ""


def spacing_xml(s: dict) -> str:
    attrs = []
    if "before" in s:
        attrs.append(f'w:before="{twip(s["before"])}"')
    if "after" in s:
        attrs.append(f'w:after="{twip(s["after"])}"')
    if "lineExact" in s:
        attrs.append(f'w:line="{twip(s["lineExact"])}" w:lineRule="exact"')
    elif "line" in s:
        attrs.append(f'w:line="{int(round(s["line"] * 240))}" w:lineRule="auto"')
    return f"<w:spacing {' '.join(attrs)}/>" if attrs else ""


def ind_xml(s: dict) -> str:
    attrs = []
    if "leftChars" in s:
        attrs.append(f'w:leftChars="{s["leftChars"]}" w:left="0"')
    if "firstLineChars" in s:
        attrs.append(f'w:firstLineChars="{s["firstLineChars"]}" w:firstLine="0"')
    return f"<w:ind {' '.join(attrs)}/>" if attrs else ""


def ppr_xml(s: dict, num_id: str | None) -> str:
    # 子元素顺序严格按 CT_PPrBase schema，顺序错了 Word 会报文件损坏
    parts = []
    if s.get("keepNext"):
        parts.append("<w:keepNext/>")
    if s.get("keepLines"):
        parts.append("<w:keepLines/>")
    if "numLevel" in s and num_id:
        parts.append(f'<w:numPr><w:ilvl w:val="{s["numLevel"]}"/><w:numId w:val="{num_id}"/></w:numPr>')
    if "borderLeft" in s:
        b = s["borderLeft"]
        parts.append(f'<w:pBdr><w:left w:val="single" w:sz="{b["sz"]}" w:space="4" w:color="{b["color"]}"/></w:pBdr>')
    if "shading" in s:
        parts.append(f'<w:shd w:val="clear" w:color="auto" w:fill="{s["shading"]}"/>')
    if s.get("wordWrap") is False:
        parts.append('<w:wordWrap w:val="0"/>')
    parts.append(spacing_xml(s))
    parts.append(ind_xml(s))
    if "jc" in s:
        parts.append(f'<w:jc w:val="{s["jc"]}"/>')
    if "outline" in s:
        parts.append(f'<w:outlineLvl w:val="{s["outline"] - 1}"/>')
    body = "".join(parts)
    return f"<w:pPr>{body}</w:pPr>" if body else ""


def style_xml(sid: str, s: dict, ids: dict, num_id: str | None, is_default=False) -> str:
    typ = s.get("type", "paragraph")
    attrs = f'w:type="{typ}" w:styleId="{sid}"'
    if is_default:
        attrs += ' w:default="1"'
    if s.get("custom"):
        attrs += ' w:customStyle="1"'
    kids = [f'<w:name w:val="{escape(s["name"])}"/>']
    if s.get("basedOn"):
        kids.append(f'<w:basedOn w:val="{ids[s["basedOn"]]}"/>')
    if s.get("next"):
        kids.append(f'<w:next w:val="{ids[s["next"]]}"/>')
    kids.append("<w:qFormat/>")
    if typ == "paragraph":
        kids.append(ppr_xml(s, num_id))
    kids.append(rpr_xml(s))
    return f"<w:style {attrs}>{''.join(kids)}</w:style>"


def table_style_xml(sid: str, t: dict, table_normal_id: str) -> str:
    sz = t["border_eighths_pt"]
    edges = "".join(f'<w:{e} w:val="{t["border"]}" w:sz="{sz}" w:space="0" w:color="000000"/>'
                    for e in ("top", "left", "bottom", "right", "insideH", "insideV"))
    first_row = ['<w:tblStylePr w:type="firstRow"><w:pPr><w:jc w:val="center"/></w:pPr>']
    first_row.append("<w:rPr><w:b/><w:bCs/></w:rPr>" if t.get("header_bold") else "<w:rPr/>")
    if t.get("header_fill"):
        first_row.append(f'<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="{t["header_fill"]}"/></w:tcPr>')
    first_row.append("</w:tblStylePr>")
    return (
        f'<w:style w:type="table" w:styleId="{sid}"><w:name w:val="Table"/>'
        f'<w:basedOn w:val="{table_normal_id}"/><w:qFormat/>'
        f'<w:pPr><w:spacing w:before="0" w:after="0" w:line="{int(t["line"] * 240)}" w:lineRule="auto"/>'
        f'<w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="left"/></w:pPr>'
        f'<w:rPr><w:sz w:val="{half(t["font_size"])}"/><w:szCs w:val="{half(t["font_size"])}"/></w:rPr>'
        f'<w:tblPr><w:jc w:val="{t["align"]}"/><w:tblBorders>{edges}</w:tblBorders>'
        f'<w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>'
        f'<w:tcPr><w:vAlign w:val="center"/></w:tcPr>'
        f'{"".join(first_row)}</w:style>'
    )


def numbering_xml(ns_decl: str, levels: list[str], formats: list[str], suffix: str, heading_ids: list[str]) -> str:
    lvls = []
    for i in range(9):
        if i < len(levels) and i < len(heading_ids):
            fmt = formats[i] if i < len(formats) else "decimal"
            lvls.append(
                f'<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="{fmt}"/>'
                f'<w:pStyle w:val="{heading_ids[i]}"/><w:lvlText w:val="{escape(levels[i])}"/><w:lvlJc w:val="left"/>'
                f'<w:suff w:val="{suffix}"/><w:pPr><w:ind w:left="0" w:firstLine="0"/></w:pPr></w:lvl>')
        else:
            lvls.append(f'<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="none"/>'
                        f'<w:lvlText w:val=""/><w:lvlJc w:val="left"/><w:suff w:val="nothing"/></w:lvl>')
    return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering {ns_decl}>'
            f'<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="multilevel"/>{"".join(lvls)}</w:abstractNum>'
            f'<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>')


def page_sect_xml(page: dict) -> str:
    cm = lambda v: str(int(round(v * 567)))  # noqa: E731
    m = page["margin_cm"]
    return (f'<w:sectPr><w:pgSz w:w="{cm(page["w_cm"])}" w:h="{cm(page["h_cm"])}"/>'
            f'<w:pgMar w:top="{cm(m["top"])}" w:right="{cm(m["right"])}" w:bottom="{cm(m["bottom"])}" '
            f'w:left="{cm(m["left"])}" w:header="{cm(m["header"])}" w:footer="{cm(m["footer"])}" w:gutter="0"/>'
            f'</w:sectPr>')


# ---------- 主流程 ----------
def build_reference(src: Path | Package, spec: dict, use_spec_page: bool = False) -> tuple[Package, list[str], dict]:
    """返回 (参照模板包, 中文日志, 角色 → styleId)。不写盘，由调用方加生成标记后落地。"""
    pkg = src if isinstance(src, Package) else Package.read(src)
    files = pkg.files
    log = []

    styles = pkg.text("word/styles.xml")
    root_open = re.search(r"<w:styles\b[^>]*>", styles).group(0)
    style_blocks = re.findall(r"<w:style\b.*?</w:style>", styles, re.S)
    latent = re.search(r"<w:latentStyles\b.*?</w:latentStyles>", styles, re.S)

    def sid_of(b):
        return re.search(r'w:styleId="([^"]+)"', b).group(1)

    def name_of(b):
        m = re.search(r'<w:name w:val="([^"]+)"', b)
        return m.group(1) if m else sid_of(b)

    by_id = {sid_of(b): b for b in style_blocks}
    id_by_name = {name_of(b).lower(): sid_of(b) for b in style_blocks}

    # 1) 需保留的原样式：页眉页脚引用的 + 目录/超链接/基础样式，以及它们的 basedOn/link 闭包
    keep = set()
    for n in list(files):
        if re.match(r"word/(header|footer)\d+\.xml$", n):
            keep |= set(re.findall(r'<w:(?:pStyle|rStyle|tblStyle) w:val="([^"]+)"', pkg.text(n)))
    for nm in ("toc 1", "toc 2", "toc 3", "hyperlink", "default paragraph font", "normal table", "no list"):
        if nm in id_by_name:
            keep.add(id_by_name[nm])
    changed = True
    while changed:
        changed = False
        for sid in list(keep):
            for ref in re.findall(r'<w:(?:basedOn|link) w:val="([^"]+)"', by_id.get(sid, "")):
                if ref in by_id and ref not in keep:
                    keep.add(ref)
                    changed = True

    # 2) 规范角色 → styleId：原文已有同名样式就沿用它的 id（保住页眉页脚等对它的引用）
    role_ids = {role: id_by_name.get(s["name"].lower(), role) for role, s in spec["styles"].items()}
    table_id = id_by_name.get("table", "Table")
    table_normal_id = id_by_name.get("normal table", "TableNormal")

    generated = set(role_ids.values()) | {table_id}
    kept_blocks = [b for b in style_blocks if sid_of(b) in keep and sid_of(b) not in generated]
    dropped = len(style_blocks) - len(kept_blocks) - len([r for r in generated if r in by_id])
    log.append(f"样式：原 {len(style_blocks)} 个 → 保留原样 {len(kept_blocks)} 个（页眉页脚/目录/超链接及其继承链），"
               f"按规范重建 {len(generated)} 个，删除 {dropped} 个")

    # 保留下来的原样式里若 basedOn / next 指向被删样式，改指 Normal；link 指向被删样式就去掉
    normal_id = role_ids["Normal"]
    valid = {sid_of(b) for b in kept_blocks} | generated

    def fix_refs(b):
        return re.sub(r'<w:(basedOn|next|link) w:val="([^"]+)"\s*/>',
                      lambda m: m.group(0) if m.group(2) in valid else
                      (f'<w:{m.group(1)} w:val="{normal_id}"/>' if m.group(1) != "link" else ""), b)

    kept_blocks = [fix_refs(b) for b in kept_blocks]

    heading_roles = [r for r in ("Heading1", "Heading2", "Heading3") if r in spec["styles"]]
    new_blocks = []
    for role, s in spec["styles"].items():
        clean = {k: v for k, v in s.items() if not k.startswith("_")}
        new_blocks.append(style_xml(role_ids[role], clean, role_ids, "1", is_default=(role == "Normal")))
    new_blocks.append(table_style_xml(table_id, spec["table"], table_normal_id))
    if table_normal_id not in valid:
        new_blocks.append(f'<w:style w:type="table" w:default="1" w:styleId="{table_normal_id}"><w:name w:val="Normal Table"/>'
                          '<w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/>'
                          '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/>'
                          '<w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>')

    # 文档默认：字体/字号/行距放在 docDefaults，Normal 保持空 —— 这样表格样式的字号和行距能压过它
    dd = spec["doc_defaults"]
    doc_defaults = (
        "<w:docDefaults><w:rPrDefault>"
        + (rpr_xml({"font": dd["font"], "size": dd["size"]}) or "<w:rPr/>")
        + "</w:rPrDefault><w:pPrDefault><w:pPr>"
        + spacing_xml({"line": dd["line"], "before": 0, "after": 0})
        + "</w:pPr></w:pPrDefault></w:docDefaults>")
    new_styles = (styles[:styles.index(root_open)] + root_open + doc_defaults + (latent.group(0) if latent else "")
                  + "".join(kept_blocks) + "".join(new_blocks) + "</w:styles>")
    pkg.set_text("word/styles.xml", new_styles)

    # 3) 编号：只留规范的标题多级编号（原文几十套编号定义里通常只用了一两套）
    num_src = pkg.text("word/numbering.xml") if "word/numbering.xml" in files else ""
    m = re.search(r"<w:numbering\b([^>]*)>", num_src)
    ns_decl = m.group(1).strip() if m else f'xmlns:w="{W}"'
    old_abs = num_src.count("<w:abstractNum ")
    hn = spec["heading_numbering"]
    pkg.set_text("word/numbering.xml", numbering_xml(
        ns_decl, hn["levels"], hn.get("formats") or [], hn.get("suffix", "space"), [role_ids[r] for r in heading_roles]))
    if not num_src:
        ct = pkg.text("[Content_Types].xml")
        if "/word/numbering.xml" not in ct:
            pkg.set_text("[Content_Types].xml", ct.replace(
                "</Types>", f'<Override PartName="/word/numbering.xml" ContentType="{NUMBERING_CT}"/></Types>'))
        rels = pkg.text("word/_rels/document.xml.rels")
        if NUMBERING_REL not in rels:
            ids = [int(i) for i in re.findall(r'Id="rId(\d+)"', rels)]
            pkg.set_text("word/_rels/document.xml.rels", rels.replace(
                "</Relationships>",
                f'<Relationship Id="rId{max(ids + [0]) + 1}" Type="{NUMBERING_REL}" Target="numbering.xml"/></Relationships>'))
    log.append(f"编号：原 {old_abs} 套抽象编号 → 1 套（标题 {' / '.join(hn['levels'])}，挂在 heading 1-3 样式上）")

    # 4) 正文清空，只留最后一节 sectPr（页面设置 + 页眉页脚引用）
    doc = pkg.text("word/document.xml")
    body_open = re.search(r"<w:body>", doc)
    body_close = doc.rindex("</w:body>")
    sect_at = doc.rfind("<w:sectPr", 0, body_close)
    last_sect = doc[sect_at:body_close] if sect_at >= body_open.end() else ""
    if use_spec_page or not last_sect:
        last_sect = page_sect_xml(spec["page"])
    pkg.set_text("word/document.xml", doc[:body_open.end()] + "<w:p/>" + last_sect + doc[body_close:])
    log.append("正文：已清空，保留最后一节的页面设置与页眉页脚" if not use_spec_page else "正文：已清空，页面按通用规范设置")

    # 5) 去掉正文里已无引用的关系（封面图片等）
    rels = pkg.text("word/_rels/document.xml.rels")
    body_now = pkg.text("word/document.xml")
    removed_targets = []

    def keep_rel(m):
        rel = m.group(0)
        rid = re.search(r'Id="([^"]+)"', rel).group(1)
        typ = re.search(r'Type="([^"]+)"', rel).group(1)
        if typ.endswith(("/image", "/hyperlink")) and f'"{rid}"' not in body_now:
            removed_targets.append(re.search(r'Target="([^"]+)"', rel).group(1))
            return ""
        return rel

    pkg.set_text("word/_rels/document.xml.rels", re.sub(r"<Relationship\b[^>]*/>", keep_rel, rels))
    still_used = "".join(v.decode("utf-8", "ignore") for k, v in files.items() if k.endswith(".rels"))
    for t in removed_targets:
        part = "word/" + t if not t.startswith("/") else t[1:]
        if part in files and Path(t).name not in still_used:
            pkg.remove(part)
    log.append(f"关系：移除正文不再引用的图片/超链接 {len(removed_targets)} 个")
    return pkg, log, role_ids
