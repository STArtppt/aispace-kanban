"""pandoc 之后的确定性修补。只做这几件，**不改正文文字**：

1. 写生成标记（docProps/custom.xml 的 aispace-docx-generator）；
2. 每张表的首行设为跨页重复的表头（pandoc 3 对有表头的表已经这么做，这里补齐漏网的，幂等）；
3. 以「图 / 表 + 数字」开头的题注，把手写的数字换成 SEQ 域 ——
   域的缓存结果就是原来的数字，所以没刷新域时显示不变，在 Word 里全选 F9 后自动编号；
4. front-matter 的 `title`：pandoc 已把它渲染成 Title 样式的首段，这里不再动。

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

    pkg.set_text("word/document.xml", doc)
    add_marker(pkg, version)
    return log
