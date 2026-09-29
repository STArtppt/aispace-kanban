#!/usr/bin/env python3
"""生成一份「格式很乱的旧 Word」—— docx 工具链的合成回归语料。

内容全部是合成的，用来复现真实客户文档里常见的乱象（真实文档不能进仓库，版式本身就是客户材料）：

- 大量无效样式：60 个自定义段落样式、20 个字符样式、3 个表格样式，都没人用；
- 样式定义与实际显示不一致：heading 1/2/3 定义写 22/16/15pt，每个标题却被手动设成 14pt；
- 正文 100% 手动格式（仿宋 14pt），而且有两种行距：单倍 18 段、1.5 倍 9 段；
- 伪标题：3 段 Normal + 大纲级别 2，没有编号；
- 手写编号：「（1）」「1、」开头的正文；
- 编号定义 10 套，只用 1 套（挂在标题段落的 numPr 上）；
- 三种表格边框：tblBorders 单线、tblBorders 双线、只有单元格边框；
- 目录项（toc 1 / toc 2）直接写在正文里；主题字体（docDefaults 用 minorEastAsia）；
- 页眉（文字）与页脚（PAGE 域），A4 页面。

用法：python3 fixtures/docx-template/make_messy_docx.py <输出.docx>
只用标准库。每段正文都带哨兵词 SENTINEL（见下），回归脚本用它断言采集报告里没有正文。
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path

SENTINEL = "合成语料哨兵句"

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' \
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>"""

ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

DOC_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>
</Relationships>"""

THEME = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="合成主题"><a:themeElements>
<a:clrScheme name="c"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>
<a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink>
<a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
<a:fontScheme name="f"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="等线 Light"/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="等线"/></a:minorFont></a:fontScheme>
<a:fmtScheme name="m"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>"""


def styles_xml() -> str:
    s = [f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles {W}>',
         '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi"/>'
         '<w:sz w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>',
         '<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:widowControl w:val="0"/><w:jc w:val="both"/></w:pPr></w:style>',
         '<w:style w:type="character" w:default="1" w:styleId="a0"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>',
         '<w:style w:type="table" w:default="1" w:styleId="a1"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/></w:tblPr></w:style>',
         '<w:style w:type="numbering" w:default="1" w:styleId="a2"><w:name w:val="No List"/></w:style>']
    for sid, lv, sz in (("1", 0, 44), ("2", 1, 32), ("3", 2, 30)):
        s.append(f'<w:style w:type="paragraph" w:styleId="{sid}"><w:name w:val="heading {lv + 1}"/><w:basedOn w:val="a"/><w:next w:val="a"/>'
                 f'<w:link w:val="{sid}Char"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="340" w:after="330"/><w:outlineLvl w:val="{lv}"/></w:pPr>'
                 f'<w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="{sz}"/></w:rPr></w:style>')
        s.append(f'<w:style w:type="character" w:customStyle="1" w:styleId="{sid}Char"><w:name w:val="标题 {lv + 1} 字符"/>'
                 f'<w:basedOn w:val="a0"/><w:link w:val="{sid}"/><w:rPr><w:b/><w:sz w:val="{sz}"/></w:rPr></w:style>')
    s.append('<w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/><w:basedOn w:val="a"/><w:next w:val="a"/></w:style>')
    s.append('<w:style w:type="paragraph" w:styleId="TOC2"><w:name w:val="toc 2"/><w:basedOn w:val="a"/><w:next w:val="a"/><w:pPr><w:ind w:leftChars="200" w:left="420"/></w:pPr></w:style>')
    s.append('<w:style w:type="character" w:styleId="a3"><w:name w:val="Hyperlink"/><w:basedOn w:val="a0"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>')
    s.append('<w:style w:type="paragraph" w:styleId="a4"><w:name w:val="caption"/><w:basedOn w:val="a"/><w:next w:val="a"/><w:rPr><w:sz w:val="20"/></w:rPr></w:style>')
    s.append('<w:style w:type="paragraph" w:styleId="a5"><w:name w:val="header"/><w:basedOn w:val="a"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="18"/></w:rPr></w:style>')
    s.append('<w:style w:type="paragraph" w:styleId="a6"><w:name w:val="footer"/><w:basedOn w:val="a"/><w:rPr><w:sz w:val="18"/></w:rPr></w:style>')
    s.append('<w:style w:type="table" w:styleId="a7"><w:name w:val="Table Grid"/><w:basedOn w:val="a1"/><w:tblPr><w:tblBorders>'
             + "".join(f'<w:{e} w:val="single" w:sz="4" w:space="0" w:color="auto"/>' for e in ("top", "left", "bottom", "right", "insideH", "insideV"))
             + '</w:tblBorders></w:tblPr></w:style>')
    # 没人用的：60 个自定义段落样式、20 个字符样式、3 个表格样式
    for i in range(60):
        s.append(f'<w:style w:type="paragraph" w:customStyle="1" w:styleId="x{i}"><w:name w:val="旧样式{i}"/><w:basedOn w:val="a"/>'
                 f'<w:rPr><w:sz w:val="{20 + i % 10}"/></w:rPr></w:style>')
    for i in range(20):
        s.append(f'<w:style w:type="character" w:customStyle="1" w:styleId="y{i}"><w:name w:val="旧字符{i}"/><w:rPr><w:i/></w:rPr></w:style>')
    for i in range(3):
        s.append(f'<w:style w:type="table" w:customStyle="1" w:styleId="t{i}"><w:name w:val="旧表格{i}"/><w:basedOn w:val="a1"/></w:style>')
    s.append("</w:styles>")
    return "".join(s)


def numbering_xml() -> str:
    out = [f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering {W}>']
    for a in range(10):
        lv = "".join(
            f'<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="decimal"/>'
            f'<w:lvlText w:val="{".".join("%" + str(k + 1) for k in range(i + 1))}."/><w:lvlJc w:val="left"/></w:lvl>'
            for i in range(3))
        out.append(f'<w:abstractNum w:abstractNumId="{a}"><w:multiLevelType w:val="multilevel"/>{lv}</w:abstractNum>')
    for a in range(10):
        out.append(f'<w:num w:numId="{a + 1}"><w:abstractNumId w:val="{a}"/></w:num>')
    out.append("</w:numbering>")
    return "".join(out)


FANGSONG = '<w:rFonts w:ascii="仿宋_GB2312" w:eastAsia="仿宋_GB2312" w:hAnsi="仿宋_GB2312"/>'


def run(text: str, sz: int = 28, bold: bool = False, fonts: str = FANGSONG) -> str:
    return f'<w:r><w:rPr>{fonts}{"<w:b/>" if bold else ""}<w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/></w:rPr><w:t xml:space="preserve">{text}</w:t></w:r>'


def para(text: str, style: str | None = None, ppr: str = "", **kw) -> str:
    ps = f'<w:pStyle w:val="{style}"/>' if style else ""
    return f"<w:p><w:pPr>{ps}{ppr}</w:pPr>{run(text, **kw)}</w:p>"


def heading(level: int, text: str) -> str:
    # 手动设成 14pt、仿宋、单倍，覆盖样式定义里的 22/16/15pt 黑体
    return para(text, str(level), f'<w:numPr><w:ilvl w:val="{level - 1}"/><w:numId w:val="3"/></w:numPr>'
                '<w:spacing w:before="240" w:after="120" w:line="360" w:lineRule="auto"/><w:jc w:val="left"/>', sz=28, bold=True)


BODY_SINGLE = '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:firstLineChars="200" w:firstLine="560"/>'
BODY_ONEHALF = '<w:spacing w:before="0" w:after="0" w:line="360" w:lineRule="auto"/><w:ind w:firstLineChars="200" w:firstLine="560"/>'


def body(n: int, onehalf: bool = False, prefix: str = "") -> str:
    return para(f"{prefix}这是第{n}段合成正文，{SENTINEL}，用来检验采集报告只保留编号前缀与字数。",
                None, BODY_ONEHALF if onehalf else BODY_SINGLE)


def table(kind: str, n: int) -> str:
    if kind == "single":
        tbl_pr = '<w:tblStyle w:val="a7"/><w:tblW w:w="0" w:type="auto"/>'
        cell_b = ""
    elif kind == "double":
        tbl_pr = ('<w:tblW w:w="0" w:type="auto"/><w:tblBorders>'
                  + "".join(f'<w:{e} w:val="double" w:sz="4" w:space="0" w:color="auto"/>' for e in ("top", "left", "bottom", "right", "insideH", "insideV"))
                  + "</w:tblBorders>")
        cell_b = ""
    else:
        tbl_pr = '<w:tblW w:w="0" w:type="auto"/>'
        cell_b = ('<w:tcBorders>' + "".join(f'<w:{e} w:val="single" w:sz="8" w:space="0" w:color="auto"/>' for e in ("top", "left", "bottom", "right"))
                  + "</w:tcBorders>")
    rows = []
    for r in range(3):
        cells = "".join(
            f'<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/>{cell_b}</w:tcPr>'
            f'<w:p><w:pPr><w:jc w:val="center"/></w:pPr>{run(f"表{n}格{r}{c}", sz=21 if r else 21, bold=(r == 0))}</w:p></w:tc>'
            for c in range(3))
        rows.append(f"<w:tr>{cells}</w:tr>")
    grid = "".join('<w:gridCol w:w="2000"/>' for _ in range(3))
    return f"<w:tbl><w:tblPr>{tbl_pr}</w:tblPr><w:tblGrid>{grid}</w:tblGrid>{''.join(rows)}</w:tbl>"


def caption(text: str) -> str:
    return para(text, "a4", '<w:jc w:val="center"/><w:spacing w:before="120" w:after="120"/>', sz=21,
                fonts='<w:rFonts w:ascii="黑体" w:eastAsia="黑体" w:hAnsi="黑体"/>')


def document_xml() -> str:
    b = []
    b.append(para("合成示例文档标题", None, '<w:jc w:val="center"/><w:spacing w:after="240"/>', sz=44, bold=True,
                  fonts='<w:rFonts w:ascii="黑体" w:eastAsia="黑体" w:hAnsi="黑体"/>'))
    for i in range(3):
        b.append(para(f"目录项{i}", "TOC1", "", sz=21))
        b.append(para(f"目录子项{i}", "TOC2", "", sz=21))
    n = 0
    chapters = 3
    for ch in range(1, chapters + 1):
        b.append(heading(1, f"第{ch}部分合成章节"))
        for sec in range(1, 3):
            b.append(heading(2, f"合成小节{ch}-{sec}"))
            for k in range(2):
                n += 1
                b.append(body(n))
            b.append(heading(3, f"合成条目{ch}-{sec}"))
            n += 1
            b.append(body(n, onehalf=True))
        # 伪标题：Normal + 大纲级别 2，没有编号
        b.append(para(f"合成伪标题{ch}", None, '<w:outlineLvl w:val="1"/><w:spacing w:before="120" w:after="60"/>', sz=28, bold=True))
        n += 1
        b.append(body(n, prefix="（1）"))
        n += 1
        b.append(body(n, prefix="1、", onehalf=True))
        b.append(caption(f"表 {ch} 合成表格"))
        b.append(table(("single", "double", "cell")[ch - 1], ch))
        n += 1
        b.append(body(n))
    b.append('<w:p><w:hyperlink r:id="rId6"><w:r><w:rPr><w:rStyle w:val="a3"/></w:rPr><w:t>合成链接</w:t></w:r></w:hyperlink></w:p>')
    sect = ('<w:sectPr><w:headerReference w:type="default" r:id="rId4"/><w:footerReference w:type="default" r:id="rId5"/>'
            '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/>'
            '</w:sectPr>')
    return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document {W}><w:body>{"".join(b)}{sect}</w:body></w:document>'


HEADER = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr {W}>'
          '<w:p><w:pPr><w:pStyle w:val="a5"/></w:pPr><w:r><w:t>合成单位页眉</w:t></w:r></w:p></w:hdr>')
FOOTER = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:ftr {W}>'
          '<w:p><w:pPr><w:pStyle w:val="a6"/><w:jc w:val="center"/></w:pPr>'
          '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
          '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>')


def make(out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", ROOT_RELS)
        z.writestr("word/_rels/document.xml.rels", DOC_RELS)
        z.writestr("word/document.xml", document_xml())
        z.writestr("word/styles.xml", styles_xml())
        z.writestr("word/numbering.xml", numbering_xml())
        z.writestr("word/theme/theme1.xml", THEME)
        z.writestr("word/header1.xml", HEADER)
        z.writestr("word/footer1.xml", FOOTER)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("用法：python3 make_messy_docx.py <输出.docx>")
    make(Path(sys.argv[1]))
    print(sys.argv[1])
