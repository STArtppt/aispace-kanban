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

`--front textbox` / `--front table` 另在正文前加四节前置区（替掉开头的标题段与目录项）：
- 封面：textbox 变体是浮动文本框（带兼容回退副本，同一段文字在 XML 里出现两次）+ 一张内嵌图片；
  table 变体是表格排版的封面（一列多行）。两种都是 26pt 文档类型 + 22pt 两段标题（第二段是标题续行）；
- 签署页：textbox 变体是一行三组签字标签（第 1、3、5 列，标签格里还有「日期：值」）；
  table 变体是首列标签（编制 / 审核 / 批准…）的 5×2 表格。页脚沿用正文页脚；
- 版本跟踪表：textbox 变体顶部有横跨整行的合并标题行、表头不加粗、首列是 A/B/C 短编号；table 变体 4×4，加粗表头；
- 正文页眉（两种变体）：单位名 + 与封面文档类型同文的字样，后者拆成三个 run；
- 目录：TOC 域 + 两条样例目录项（带 PAGEREF 域）。textbox 变体包在 sdt 里，table 变体不包、end 所在段带分节符。
前置区里所有「样例数据」都带 FRONT_SENTINEL，回归脚本用它断言报告和 front.docx 里没有这些原文；
「签署页」「目录」、表格标签这类模板文字不带（它们本来就该原样保留）。

用法：python3 fixtures/docx-template/make_messy_docx.py <输出.docx> [--front textbox|table]
只用标准库。每段正文都带哨兵词 SENTINEL（见下），回归脚本用它断言采集报告里没有正文。
"""

from __future__ import annotations

import struct
import sys
import zipfile
import zlib
from pathlib import Path

SENTINEL = "合成语料哨兵句"
FRONT_SENTINEL = "前置哨兵"

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


def document_xml(front: str | None = None) -> str:
    b = []
    if front:
        b.append(front_xml(front))
    else:
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
    ns = FRONT_NS if front else W
    return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document {ns}><w:body>{"".join(b)}{sect}</w:body></w:document>'


# ---------- 前置区 ----------
FRONT_NS = (W + ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'
            ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
            ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
            ' xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"'
            ' xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"'
            ' xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"'
            ' xmlns:w10="urn:schemas-microsoft-com:office:word" mc:Ignorable="w14"')
HEITI = '<w:rFonts w:ascii="黑体" w:eastAsia="黑体" w:hAnsi="黑体"/>'
PAGE = '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/>'


def sect_break(extra: str = "") -> str:
    return f"<w:sectPr>{extra}{PAGE}</w:sectPr>"


def break_para(extra: str = "") -> str:
    return f"<w:p><w:pPr>{sect_break(extra)}</w:pPr></w:p>"


def center(text: str, sz: int, bold: bool = False) -> str:
    return para(text, None, '<w:jc w:val="center"/><w:spacing w:before="120" w:after="120"/>', sz=sz, bold=bold, fonts=HEITI)


COVER_LINES = [  # (文字, 字号半磅, 加粗)
    # 字号最大的一段是文档类型，项目名反而小一号，而且拆成两段（D14 第 2、4 条）
    (f"合成{FRONT_SENTINEL}分析报告", 52, True),
    (f"合成{FRONT_SENTINEL}系统建设项目", 44, True),
    (f"{FRONT_SENTINEL}二期工程", 44, True),
]
DOCTYPE_TEXT = COVER_LINES[0][0]


def textbox(paras: str) -> str:
    """浮动文本框：新版 wps 形状 + 旧版 VML 回退副本，两份里是同样的段落。"""
    return (
        '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>'
        '<wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="1" behindDoc="0" '
        'locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>'
        '<wp:positionH relativeFrom="margin"><wp:align>center</wp:align></wp:positionH>'
        '<wp:positionV relativeFrom="page"><wp:posOffset>2000000</wp:posOffset></wp:positionV>'
        '<wp:extent cx="5000000" cy="1500000"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapTopAndBottom/>'
        '<wp:docPr id="1" name="文本框 1"/><wp:cNvGraphicFramePr/>'
        '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp>'
        '<wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="5000000" cy="1500000"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></wps:spPr>'
        f'<wps:txbx><w:txbxContent>{paras}</w:txbxContent></wps:txbx><wps:bodyPr rot="0" vert="horz" wrap="square" anchor="t"/>'
        '</wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict>'
        '<v:shape id="文本框 1" o:spid="_x0000_s1026" style="position:absolute;margin-left:0;margin-top:157.5pt;'
        'width:393.7pt;height:118.1pt;z-index:1;mso-position-horizontal:center" filled="f" stroked="f">'
        f'<v:textbox><w:txbxContent>{paras}</w:txbxContent></v:textbox><w10:wrap type="topAndBottom"/></v:shape>'
        '</w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>')


LOGO = ('<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
        '<wp:extent cx="952500" cy="952500"/><wp:docPr id="2" name="图片 2"/><a:graphic>'
        '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
        '<pic:nvPicPr><pic:cNvPr id="2" name="logo.png"/><pic:cNvPicPr/></pic:nvPicPr>'
        '<pic:blipFill><a:blip r:embed="rId7"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>'
        '</wp:inline></w:drawing></w:r></w:p>')


def grid_table(rows: list[list[tuple[str, bool]]], widths: int = 2000, borders: bool = True) -> str:
    cols = len(rows[0])
    b = ('<w:tblBorders>' + "".join(f'<w:{e} w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
                                    for e in ("top", "left", "bottom", "right", "insideH", "insideV")) + "</w:tblBorders>") if borders else ""
    trs = "".join("<w:tr>" + "".join(
        f'<w:tc><w:tcPr><w:tcW w:w="{widths}" w:type="dxa"/></w:tcPr>'
        f'<w:p><w:pPr><w:jc w:val="center"/></w:pPr>{run(t, sz=24, bold=bold) if t else ""}</w:p></w:tc>'
        for t, bold in row) + "</w:tr>" for row in rows)
    grid = "".join(f'<w:gridCol w:w="{widths}"/>' for _ in range(cols))
    return f'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>{b}</w:tblPr><w:tblGrid>{grid}</w:tblGrid>{trs}</w:tbl>'


BORDERS = ('<w:tblBorders>' + "".join(f'<w:{e} w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
                                      for e in ("top", "left", "bottom", "right", "insideH", "insideV")) + "</w:tblBorders>")


def tc(paras: str, span: int = 1) -> str:
    gs = f'<w:gridSpan w:val="{span}"/>' if span > 1 else ""
    return f'<w:tc><w:tcPr><w:tcW w:w="{1400 * span}" w:type="dxa"/>{gs}</w:tcPr>{paras}</w:tc>'


def cell_p(text: str) -> str:
    return f"<w:p>{run(text, sz=24) if text else ''}</w:p>"


def signoff_row() -> str:
    cells = []
    for lab, who in (("编写(签字)：", "甲"), ("审核(签字)：", "乙"), ("批准(签字)：", "丙")):
        cells.append(tc(cell_p(lab) + cell_p(f"日期：{FRONT_SENTINEL}日期{who}")))
        cells.append(tc(cell_p(f"{FRONT_SENTINEL}{who}")))
    grid = "".join('<w:gridCol w:w="1400"/>' for _ in range(6))
    return f'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>{BORDERS}</w:tblPr><w:tblGrid>{grid}</w:tblGrid><w:tr>{"".join(cells)}</w:tr></w:tbl>'


def revision_table() -> str:
    rows = [f'<w:tr>{tc(cell_p("文件版本记录"), 3)}</w:tr>',
            "<w:tr>" + "".join(tc(cell_p(h)) for h in ("版本", "版本说明", "日期")) + "</w:tr>"]
    for code in ("A", "B", "C"):
        rows.append("<w:tr>" + tc(cell_p(code)) + tc(cell_p(f"合成{FRONT_SENTINEL}修订{code}"))
                    + tc(cell_p(f"{FRONT_SENTINEL}日期{code}")) + "</w:tr>")
    grid = "".join('<w:gridCol w:w="1400"/>' for _ in range(3))
    return f'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>{BORDERS}</w:tblPr><w:tblGrid>{grid}</w:tblGrid>{"".join(rows)}</w:tbl>'


def toc_entry(text: str, page: str, first: bool) -> str:
    begin = ('<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
             '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>'
             '<w:r><w:fldChar w:fldCharType="separate"/></w:r>') if first else ""
    return (f'<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr>{begin}'
            f'<w:hyperlink w:anchor="_Toc{page}"><w:r><w:t>{text}</w:t></w:r><w:r><w:tab/></w:r>'
            '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
            f'<w:r><w:instrText xml:space="preserve"> PAGEREF _Toc{page} \\h </w:instrText></w:r>'
            f'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>{page}</w:t></w:r>'
            '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:hyperlink></w:p>')


def front_xml(kind: str) -> str:
    b = []
    # 封面
    if kind == "textbox":
        b.append(textbox("".join(center(t, sz, bold) for t, sz, bold in COVER_LINES)))
        b.append(LOGO)
        b.append(center(f"建设单位：合成{FRONT_SENTINEL}客户有限公司", 28))
        b.append(center(f"合成{FRONT_SENTINEL}编制有限公司", 28))
        b.append(center("2025年6月", 28))
    else:
        cells = [[(t, bold)] for t, _, bold in COVER_LINES]
        rows = "".join(
            f'<w:tr><w:tc><w:tcPr><w:tcW w:w="8000" w:type="dxa"/></w:tcPr>{center(t, sz, bold)}</w:tc></w:tr>'
            for t, sz, bold in COVER_LINES + [(f"合成{FRONT_SENTINEL}客户有限公司", 28, False), ("2025年06月", 28, False)])
        del cells
        b.append(f'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:jc w:val="center"/></w:tblPr>'
                 f'<w:tblGrid><w:gridCol w:w="8000"/></w:tblGrid>{rows}</w:tbl>')
    b.append(break_para("<w:titlePg/>"))
    # 签署页
    b.append(center("签署页", 32, True))
    if kind == "textbox":
        # 一行三组签字标签（第 1、3、5 列），标签格里还有「日期：值」（D14 第 5 条）
        b.append(signoff_row())
    else:
        b.append(grid_table([[(lab, False), (f"{FRONT_SENTINEL}{i}" if i != 4 else "", False)]
                             for i, lab in enumerate(("编制", "审核", "批准", "会签", "发布"))]))
    b.append(break_para('<w:footerReference w:type="default" r:id="rId5"/>'))
    # 版本跟踪表
    b.append(center("版本跟踪", 32, True))
    if kind == "textbox":
        # 顶部横跨整行的合并标题行 + 不加粗的表头 + 首列短编号（D14 第 6 条）
        b.append(revision_table())
    else:
        b.append(grid_table([[("版本", True), ("日期", True), ("修改人", True), ("说明", True)]]
                            + [[(f"V1.{i}", False), (f"2025-0{i + 1}-01", False), (f"{FRONT_SENTINEL}人{i}", False),
                                (f"合成{FRONT_SENTINEL}修订{i}", False)] for i in range(3)]))
    b.append(break_para())
    # 目录
    entries = toc_entry(f"第1部分{FRONT_SENTINEL}章节", "3", True) + toc_entry(f"第2部分{FRONT_SENTINEL}章节", "5", False)
    if kind == "textbox":
        b.append('<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/><w:docPartUnique/>'
                 '</w:docPartObj></w:sdtPr><w:sdtContent>' + center("目录", 32, True) + entries
                 + '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:sdtContent></w:sdt>')
        b.append(break_para())
    else:
        b.append(center("目录", 32, True))
        b.append(entries)
        b.append(f'<w:p><w:pPr>{sect_break()}</w:pPr><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>')
    return "".join(b)


def png_1x1() -> bytes:
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\x00\x80")) + chunk(b"IEND", b""))


HEADER = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr {W}>'
          '<w:p><w:pPr><w:pStyle w:val="a5"/></w:pPr><w:r><w:t>合成单位页眉</w:t></w:r></w:p></w:hdr>')
# 前置区变体的正文页眉：左边单位名，右边是与封面文档类型同文的字样，在 XML 里被拆成三个 run（D14 第 1 条）
HEADER_FRONT = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr {W}>'
                '<w:p><w:pPr><w:pStyle w:val="a5"/></w:pPr><w:r><w:t xml:space="preserve">合成单位页眉　</w:t></w:r>'
                + "".join(f'<w:r><w:rPr><w:b/></w:rPr><w:t>{DOCTYPE_TEXT[i:i + 4]}</w:t></w:r>' for i in range(0, len(DOCTYPE_TEXT), 4))
                + '</w:p></w:hdr>')
FOOTER = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:ftr {W}>'
          '<w:p><w:pPr><w:pStyle w:val="a6"/><w:jc w:val="center"/></w:pPr>'
          '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
          '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>')


def make(out: Path, front: str | None = None) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    ct, rels = CONTENT_TYPES, DOC_RELS
    root_rels = ROOT_RELS
    if front:
        ct = ct.replace("</Types>", '<Default Extension="png" ContentType="image/png"/></Types>')
        # 真实文档常自带 docProps/custom.xml：切出前置区时它被裁掉、又由生成标记加回，曾经在 zip 里留下两个同名条目
        ct = ct.replace("</Types>", '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>')
        root_rels = root_rels.replace("</Relationships>", '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/'
                                      'officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>')
        rels = rels.replace("</Relationships>", '<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/'
                            'officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>')
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr("_rels/.rels", root_rels)
        z.writestr("word/_rels/document.xml.rels", rels)
        z.writestr("word/document.xml", document_xml(front))
        if front:
            z.writestr("word/media/image1.png", png_1x1())
            z.writestr("docProps/custom.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                       '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" '
                       'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
                       '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="合成属性">'
                       '<vt:lpwstr>x</vt:lpwstr></property></Properties>')
        z.writestr("word/styles.xml", styles_xml())
        z.writestr("word/numbering.xml", numbering_xml())
        z.writestr("word/theme/theme1.xml", THEME)
        z.writestr("word/header1.xml", HEADER_FRONT if front else HEADER)
        z.writestr("word/footer1.xml", FOOTER)


if __name__ == "__main__":
    args = sys.argv[1:]
    kind = None
    if len(args) == 3 and args[1] == "--front" and args[2] in ("textbox", "table"):
        kind = args[2]
        args = args[:1]
    if len(args) != 1:
        sys.exit("用法：python3 make_messy_docx.py <输出.docx> [--front textbox|table]")
    make(Path(args[0]), kind)
    print(args[0])
