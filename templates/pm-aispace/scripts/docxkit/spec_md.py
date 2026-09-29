"""由合并后的规范生成 spec.md：写给写 Markdown 的人（和工作空间 AI）看的文字规定。

每个角色写清 md 怎么写、成品长什么样；客户旧文档里没有、由通用规范补齐的角色逐条标出来，
方便核对「这条格式是客户文件里真有的，还是我们补的」。
"""

from __future__ import annotations

from .spec import effective

JC = {"left": "左对齐", "center": "居中", "both": "两端对齐", "right": "右对齐"}
FILLED = "由通用规范补齐"
FROM_CUSTOMER = "客户旧文档"


def describe(eff: dict) -> str:
    parts = []
    fonts = []
    if eff.get("eastAsia"):
        fonts.append(f"中文{eff['eastAsia']}")
    if eff.get("ascii"):
        fonts.append(f"西文 {eff['ascii']}")
    if fonts:
        parts.append(" / ".join(fonts))
    parts.append(f"{eff['size']:g}pt")
    if eff.get("bold"):
        parts.append("加粗")
    parts.append(JC.get(eff.get("jc"), eff.get("jc") or "左对齐"))
    if eff.get("firstLineChars"):
        parts.append(f"首行缩进 {eff['firstLineChars']:g} 字符")
    if eff.get("leftChars"):
        parts.append(f"左缩进 {eff['leftChars']:g} 字符")
    if eff.get("before") or eff.get("after"):
        parts.append(f"段前 {eff.get('before', 0):g}pt、段后 {eff.get('after', 0):g}pt")
    line = eff.get("line")
    parts.append(f"固定行距 {line}" if isinstance(line, str) else f"{line:g} 倍行距")
    return "，".join(parts)


def generate(name: str, spec: dict, roles: dict, version: str, date: str) -> str:
    def src(role):
        return FROM_CUSTOMER if role in roles else FILLED

    def row(md, role, extra=""):
        return f"| {md} | {spec['styles'][role]['name']} | {extra} | {describe(effective(spec, role))} | {src(role)} |"

    hn = spec["heading_numbering"]["levels"]
    t = spec["table"]
    table_src = FROM_CUSTOMER if "Table" in roles else FILLED
    lines = [
        f"# {name} · 写作规定",
        "",
        f"> 由 `scripts/docx_template.py build` 生成（{date}，工具链 {version}）。要改规定请回看板「模版洗炼」重新提炼，"
        "手改本文件不会影响转换结果。",
        f"> 来源一列写「{FILLED}」的角色，客户旧文档里没有，格式取自通用规范（`scripts/docxkit/base-spec.json`）。",
        "",
        "转换命令：",
        "",
        "```bash",
        f"python3 scripts/md2docx.py <文件>.md --template {name}",
        "```",
        "",
        "## 标题",
        "",
        "| Markdown | Word 样式 | 编号 | 格式 | 来源 |",
        "| --- | --- | --- | --- | --- |",
        row("`#`", "Heading1", hn[0].replace("%1", "1") if hn else ""),
        row("`##`", "Heading2", hn[1].replace("%1", "1").replace("%2", "1") if len(hn) > 1 else ""),
        row("`###`", "Heading3", hn[2].replace("%1", "1").replace("%2", "1").replace("%3", "1") if len(hn) > 2 else ""),
        row("`####`", "Heading4", "无编号"),
        "",
        "- 标题里**不要手写编号**（「1.1 概述」「一、」），编号由样式自动生成，手写会出现双重编号。",
        "- 最多用到 `####`：它是无编号小标题，不进目录。更深的层级改用加粗段落或列表。",
        "- 文档标题写在 front-matter 的 `title:` 里，成品首段套 Title 样式；正文不要再写一个 `#` 当文档标题。",
        "",
        "## 正文与列表",
        "",
        "| Markdown | Word 样式 | 说明 | 格式 | 来源 |",
        "| --- | --- | --- | --- | --- |",
        row("普通段落", "BodyText", "标题后第一段套 First Paragraph"),
        row("紧凑列表 `-` / `1.`", "Compact", "列表项之间不空行"),
        row("`> 引用`", "BlockText"),
        "",
        "- 段落之间空一行；不要用空格或全角空格做首行缩进，缩进由样式给。",
        "- 列表项之间空一行会变成「松散列表」，每项套正文样式（带首行缩进），一般不要这样写。",
        "",
        "## 表格",
        "",
        "用管道表格，表题写在表格**下方**一行，以 `Table:` 开头（成品里表题在表格上方）：",
        "",
        "```markdown",
        "| 编号 | 名称 |",
        "|:---:|:---|",
        "| F-01 | 数据接入 |",
        "",
        "Table: 表 1 功能清单",
        "```",
        "",
        f"- 表格文字：{t['font_size']:g}pt、{t['line']:g} 倍行距；首行是表头"
        f"{'（加粗）' if t.get('header_bold') else ''}，跨页时自动重复；边框：{t['border']}。来源：{table_src}。",
        f"- 表题套 Table Caption：{describe(effective(spec, 'TableCaption'))}。来源：{src('TableCaption')}。",
        "- 表题里的「表 1」会换成自动编号域：在 Word 里全选后按 F9 更新编号。",
        "- 列宽按列数平均分配；列对齐用分隔行的 `:` 控制。",
        "",
        "## 图片",
        "",
        "```markdown",
        "![图 1 系统架构示意](../assets/arch.png){width=80%}",
        "```",
        "",
        "- 方括号里的文字就是图题（套 Image Caption，在图下方），同样换成自动编号域。",
        f"- 图题格式：{describe(effective(spec, 'ImageCaption'))}。来源：{src('ImageCaption')}。",
        "- 图片路径相对于 `.md` 所在目录；找不到的图会在转换结果里给出提示，成品里以图题文字代替。",
        "",
        "## 代码块、提示框、脚注",
        "",
        "| Markdown | Word 样式 | 说明 | 格式 | 来源 |",
        "| --- | --- | --- | --- | --- |",
        row("```` ``` ```` 代码块", "SourceCode", "带浅灰底色，不自动换行"),
        row('`::: {custom-style="提示框"}`', "Note", "块结束写 `:::`"),
        row("`[^1]` 脚注", "FootnoteText", "脚注文字"),
        "",
        "- 行内代码用反引号，套 Verbatim Char（等宽字体）。",
        "",
        "## 转换后要检查",
        "",
        "1. 标题编号连续，没有双重编号；",
        "2. 表格有边框、表头加粗，表题在表格上方；",
        "3. 图片都在，图题在图下方；",
        "4. 转换结果里的 warnings 为空 —— 有缺图等提示先修 md 再转。",
        "",
    ]
    return "\n".join(lines)
