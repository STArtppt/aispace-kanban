"""pandoc 之后的确定性修补。只做这几件，**不改正文文字**：

1. 写生成标记（docProps/custom.xml 的 aispace-docx-generator）；
2. 每张表的首行设为跨页重复的表头（pandoc 3 对有表头的表已经这么做，这里补齐漏网的，幂等）；
3. 以「图 / 表 + 数字」开头的题注，把手写的数字换成 SEQ 域 ——
   域的缓存结果就是原来的数字，所以没刷新域时显示不变，在 Word 里全选 F9 后自动编号；
4. front-matter 的 `title`：pandoc 已把它渲染成 Title 样式的首段，这里不再动；
5. 表格单元格里 pandoc 套的 Compact / 正文段落换成 Table Text（五号、居中、无缩进，见 build.py 第 2 条）——
   md 分隔行写了对齐的，pandoc 在段落上直接写 jc，照样生效；
6. 列表（pandoc 自己生成的编号定义）去掉悬挂缩进：改成首行缩进、编号后接空格，折行回到左边距。
   标题的多级编号（带 pStyle 的那套，来自参照模板）不动。

列宽、封面、目录注入都不在这里做（每一项都要按客户调参，见 design D9）。
改写直接在原始 XML 上做（pandoc 的输出结构稳定），不经 ET 序列化。
"""

from __future__ import annotations

import re

from .ooxml import Package, add_marker

RUN_RE = re.compile(r'<w:r>((?:<w:rPr>(?:(?!</w:rPr>).)*</w:rPr>)?)<w:t(?: [^>]*)?>([^<]*)</w:t></w:r>', re.S)
CAPTION_NUM = re.compile(r"^\s*(图|表)\s*(\d+)")


def _style_ids(pkg: Package, names: tuple[str, ...]) -> set[str]:
    styles = pkg.text("word/styles.xml")
    want = {n.lower() for n in names}
    out = set()
    for m in re.finditer(r'<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>\s*<w:name w:val="([^"]+)"', styles):
        if m.group(2).lower() in want:
            out.add(m.group(1))
    return out


def _t(text: str) -> str:
    return f'<w:t xml:space="preserve">{text}</w:t>'


def _seq_caption(par: str) -> str:
    runs = list(RUN_RE.finditer(par))
    if not runs:
        return par
    joined, spans = "", []
    for r in runs:
        spans.append((len(joined), r))
        joined += r.group(2)
    m = CAPTION_NUM.match(joined)
    if not m:
        return par
    label, (ds, de) = m.group(1), m.span(2)
    for start, r in spans:
        text = r.group(2)
        if start <= ds and de <= start + len(text):
            rpr = r.group(1)
            a, b = ds - start, de - start
            pieces = []
            if text[:a]:
                pieces.append(f"<w:r>{rpr}{_t(text[:a])}</w:r>")
            # 用复杂域而不是 fldSimple：缓存结果是一个普通 run，浏览器预览（docx-preview）也显示得出数字
            pieces.append(
                f'<w:r>{rpr}<w:fldChar w:fldCharType="begin"/></w:r>'
                f'<w:r>{rpr}<w:instrText xml:space="preserve"> SEQ {label} \\* ARABIC </w:instrText></w:r>'
                f'<w:r>{rpr}<w:fldChar w:fldCharType="separate"/></w:r>'
                f'<w:r>{rpr}{_t(text[a:b])}</w:r>'
                f'<w:r>{rpr}<w:fldChar w:fldCharType="end"/></w:r>')
            if text[b:]:
                pieces.append(f"<w:r>{rpr}{_t(text[b:])}</w:r>")
            return par[:r.start()] + "".join(pieces) + par[r.end():]
    return par  # 数字跨了几个 run：不硬拆，保持原样


def _table_text(doc: str, from_ids: set[str], to_id: str) -> tuple[str, int]:
    """表格里的段落样式换成表格文字。md 表格不会嵌套，按 <w:tbl> 非贪婪匹配就够了。"""
    count = 0

    def para_style(m):
        nonlocal count
        if m.group(1) not in from_ids:
            return m.group(0)
        count += 1
        return f'<w:pStyle w:val="{to_id}"/>'

    def table(m):
        return re.sub(r'<w:pStyle w:val="([^"]+)"\s*/>', para_style, m.group(0))

    return re.sub(r"<w:tbl>.*?</w:tbl>", table, doc, flags=re.S), count


def _no_hanging(num: str, size_pt: float) -> tuple[str, int]:
    """pandoc 列表编号：每级改成 左 0、首行缩进 2 字符 ×（级别 + 1）、编号后接空格。

    firstLine 同时写按正文字号折算的缇值：Word 以 firstLineChars 为准，LibreOffice 在编号定义里只认缇。"""
    count = 0

    def lvl(m):
        block = m.group(0)
        level = int(m.group(1))
        twips = int(round(2 * size_pt * 20 * (level + 1)))
        ind = f'<w:ind w:left="0" w:leftChars="0" w:firstLineChars="{200 * (level + 1)}" w:firstLine="{twips}"/>'
        if re.search(r"<w:ind\b[^>]*/>", block):
            block = re.sub(r"<w:ind\b[^>]*/>", ind, block, count=1)
        elif "<w:pPr>" in block:
            block = block.replace("<w:pPr>", "<w:pPr>" + ind, 1)
        else:
            block = block.replace("</w:lvl>", f"<w:pPr>{ind}</w:pPr></w:lvl>")
        if "<w:suff" not in block:  # 默认是制表符：没有悬挂缩进后，编号会跳到下一个默认制表位
            block = re.sub(r"<w:lvlText\b", '<w:suff w:val="space"/><w:lvlText', block, count=1)
        return block

    def abstract(m):
        nonlocal count
        block = m.group(0)
        if "<w:pStyle" in block:  # 标题多级编号
            return block
        count += 1
        return re.sub(r'<w:lvl w:ilvl="(\d+)"[^>]*>.*?</w:lvl>', lvl, block, flags=re.S)

    return re.sub(r"<w:abstractNum\b.*?</w:abstractNum>", abstract, num, flags=re.S), count


def postprocess(pkg: Package, version: str) -> list[str]:
    log = []
    doc = pkg.text("word/document.xml")

    # 表头跨页重复
    fixed = 0

    def header_row(m):
        nonlocal fixed
        tr = m.group(0)
        if "<w:tblHeader" in tr:
            return tr
        fixed += 1
        if "<w:trPr>" in tr:
            return tr.replace("<w:trPr>", "<w:trPr><w:tblHeader/>", 1)
        return re.sub(r"^<w:tr\b[^>]*>", lambda x: x.group(0) + "<w:trPr><w:tblHeader/></w:trPr>", tr, count=1)

    doc = re.sub(r"(?<=</w:tblGrid>)\s*<w:tr\b.*?</w:tr>", lambda m: header_row(m), doc, flags=re.S)
    if fixed:
        log.append(f"表头：{fixed} 张表的首行设为跨页重复")

    # 题注 → SEQ 域
    cap_ids = _style_ids(pkg, ("Table Caption", "Image Caption", "caption"))
    count = 0

    def caption(m):
        nonlocal count
        par = m.group(0)
        sm = re.search(r'<w:pStyle w:val="([^"]+)"\s*/>', par)
        if not sm or sm.group(1) not in cap_ids or "SEQ " in par:
            return par
        new = _seq_caption(par)
        if new != par:
            count += 1
        return new

    doc = re.sub(r"<w:p>(?:(?!</w:p>).)*?</w:p>", caption, doc, flags=re.S)
    if count:
        log.append(f"题注：{count} 条手写编号换成 SEQ 域（在 Word 里全选后按 F9 更新）")

    # 表格文字
    to_ids = _style_ids(pkg, ("Table Text",))
    if to_ids:
        doc, n = _table_text(doc, _style_ids(pkg, ("Compact", "Body Text", "First Paragraph")), next(iter(to_ids)))
        if n:
            log.append(f"表格文字：{n} 个单元格段落改用「表格文字」样式（五号、居中、无缩进）")

    # 列表去悬挂缩进
    if "word/numbering.xml" in pkg.files:
        sz = re.search(r'<w:rPrDefault>.*?<w:sz w:val="(\d+)"', pkg.text("word/styles.xml"), re.S)
        num, n = _no_hanging(pkg.text("word/numbering.xml"), int(sz.group(1)) / 2 if sz else 10.5)
        if n:
            pkg.set_text("word/numbering.xml", num)
            log.append(f"列表：{n} 套编号去掉悬挂缩进，改为首行缩进")

    pkg.set_text("word/document.xml", doc)
    add_marker(pkg, version)
    return log
