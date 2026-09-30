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


FIELD_SOURCE = {
    "title": "front-matter 的 `title` → 开头唯一的 `#` 标题（模板有文档类型字段时，`# 某项目 · 实施方案` 取 `·` 前面）",
    "client": "front-matter 的 `client` → `project.yaml` 的 `identity.甲方`",
    "vendor": "front-matter 的 `vendor` → `project.yaml` 的 `identity.承建方`",
    "date": "front-matter 的 `date` → 转换当天（YYYY年M月）",
    # 表格单元格里的 | 要转义，否则 GFM 把这一行切断
    "doctype": "front-matter 的 `doctype` → 开头 `#` 标题最后一个 `·` / `\\|` / `｜` 后面的部分（都没有就待填）",
}
FIELD_LABEL = {"title": "标题", "client": "客户单位", "vendor": "编制单位", "date": "日期", "doctype": "文档类型"}


def front_lines(front: dict | None) -> list[str]:
    if not front:
        return []
    roles = [r for r in FIELD_LABEL if r in front["fields"].values()]
    keeps = sum(1 for v in front["fields"].values() if v == "keep")
    date_src = f"front-matter 的 `date` → 转换当天（写成 {front.get('dateFormat') or 'YYYY年M月'}）"
    lines = [
        "## 封面字段从哪里取值",
        "",
        f"这个模板带前置区（{'、'.join(front['sections'].values())}），骨架在 `front.docx`。"
        "转换时前置区原样放在正文前面，封面上的字段按下表取值；都取不到时成品里显示「【待填：…】」，转换结果里会有提醒。",
        "",
        "| 字段 | 取值顺序 |",
        "| --- | --- |",
        *[f"| {FIELD_LABEL[r]} | {date_src if r == 'date' else FIELD_SOURCE[r]} |" for r in roles],
        "",
        "```markdown",
        "---",
        "client: 某某单位        # 需要时写在 md 开头，优先于 project.yaml",
        "doctype: 实施方案",
        "---",
        "```",
        "",
        "- 正文页眉页脚里与封面字段同文的部分（比如写着文档类型的页眉）随字段一起替换。",
        "- 签署页、版本跟踪表只留了标签和空格子，交付前在 Word 里填。",
        "- 目录保留为 Word 的目录域：用 Word 打开时会提示更新域，选「是」；没提示就右键目录 → 更新域。",
    ]
    if keeps:
        lines.append(f"- 前置区里有 {keeps} 段设成了「保持原样」，模板里的原文会出现在每一份成品里。")
    lines.append("")
    return lines


def generate(name: str, spec: dict, roles: dict, version: str, date: str, front: dict | None = None) -> str:
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
        row("`##`", "Heading1", hn[0].replace("%1", "1") if hn else ""),
        row("`###`", "Heading2", hn[1].replace("%1", "1").replace("%2", "1") if len(hn) > 1 else ""),
        row("`####`", "Heading3", hn[2].replace("%1", "1").replace("%2", "1").replace("%3", "1") if len(hn) > 2 else ""),
        row("`#####`", "Heading4", "无编号"),
        "",
        "- **文档标题**写成开头唯一的一个 `#`（或 front-matter 的 `title:`，两个都写以 front-matter 为准）。"
        "转换时它被取作文档标题（有封面就填进封面，没有就是首段的 Title），`##` 起依次是一级、二级……标题。"
        "全文有多个 `#` 时不做这层平移，`#` 就是一级标题，转换结果里会提醒。",
        "- 标题里不必手写编号（「1.1 概述」「一、」）：编号由样式生成，转换时会自动剥掉手写的，避免双重编号。",
        "- 最多用到无编号小标题那一级，它不进目录。更深的层级改用段首加粗的标签或列表。",
        "- 加粗只用于段首标签（`**调研对象：** …`）；句中的加粗转换时会解除。`> [!note]` 这类批注块转成提示框。",
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
        f"- 表格文字：{t['font_size']:g}pt、{t['line']:g} 倍行距、居中、无缩进；首行是表头"
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
        *front_lines(front),
        "## 转换后要检查",
        "",
        "1. 标题编号连续，没有双重编号；",
        "2. 表格有边框、表头加粗，表题在表格上方；",
        "3. 图片都在，图题在图下方；",
        "4. 转换结果里的 warnings 为空 —— 有缺图等提示先修 md 再转。",
        "",
    ]
    return "\n".join(lines)
