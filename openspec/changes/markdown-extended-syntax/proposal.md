## Why

不做的话，工作空间里想用的 Obsidian 扩展语法在看板里仍然是坏的：`[[wikilink]]` 是点不开的裸文本，`> [!note]` 会把标记露在普通引用里，行首 `#标签`、`%%注释%%`、段尾 `^id`、`$公式$` 也要么露出来、要么进不了正文该有的样子。`workspace-markdown-convention` 把这些列成「因为看板暂不渲染而禁用」，并写明插件到位后逐条解禁、存量文档不用翻修。现在规范已经落地，该把渲染补上。

## What Changes

- 看板 Markdown 预览认这七类写法，并按下面的解析规则显示：
  - `[[wikilink]]` / `[[目标|文本]]`：变成可点的链接。相对路径（`./`、`../`）相对当前文件；带 `/` 的从工作空间根算；裸文件名只认**同一目录**。不按全库文件名唯一匹配。
  - `[[目标#标题]]`：打开那份文件，标题出现在链接文字里。不滚动到那一节。
  - `![[图片]]`：图片嵌进正文。`![[文档]]`：显示成链接，不把正文嵌进来。
  - `> [!type]` callout：标记不再露出来。warning / danger / failure / bug / error / important / caution 用「需要注意」的样式，其余保持灰。`> [!type]-` 默认折叠，`+` 默认展开。
  - 行首 `#标签`（`#` 后紧跟非空格）：显示成小标签，不进文档目录。`# 标题` 仍是标题。
  - `%%注释%%`：阅读时不显示。
  - 段尾 `^id`：阅读时不显示。
  - `$...$` / `$$...$$`：渲染成公式。
- `templates/pm-aispace/AGENTS.md` 的「Markdown 写法」把上述条目从「现在禁用」挪到「现在可用」，并写明三条做不到的事：全库裸文件名消歧、文档嵌入正文、打开后滚到某一节。
- `scripts/check_markdown.py` 不再把这些语法报成错误。扁平 front-matter、唯一 H1 照旧。
- `scripts/web_ingest.py` 不再剥掉这些语法（多出来的 H1 仍降级）。产物继续能过校验。

**明确不做**

- 不做全库文件名 / 别名解析，不做反向链接面板。`input/converted/` 里同名文件很多，猜一个就是指错。
- 不做 `![[文档]]` 的正文嵌入。
- 不改标题锚点的 `doc-h-N` 编号，因此 `[[文件#某节]]` 不会滚动。这牵动批注与目录，另案处理。
- 不改已有的相对路径链接 `[文本](../x.md)`。存量文档不用改。

## Capabilities

### New Capabilities

- `markdown-extended-syntax`：看板预览对 wikilink、嵌入、callout、行首标签、百分号注释、块锚点、数学公式的渲染规则，以及工作空间写法规范与校验脚本随之放行的契约。

### Modified Capabilities

无。`openspec/specs/` 里现有六份能力的要求都不变。`workspace-markdown-convention` 尚未归档，其中「现在禁用」这七项由本变更取代；归档那份 change 时以本变更的规范为准。

## Impact

**平面**：前端（`src/app/components/Markdown.tsx`、新增的 remark 插件、`src/app/styles/globals.css`）和 **templates**（`templates/pm-aispace/AGENTS.md`、`scripts/check_markdown.py`、`scripts/web_ingest.py`）。

**契约**：`src/app/lib/api.ts` **不动**。链接仍走现有的 `urlTransform` → `/api/projects/:id/file`。服务端与 CLI 不动，没有新老进程兼容问题。

**只读红线**：只改渲染和模板里的约定 / 脚本。看板不往工作空间写任何文件。

**依赖**（前端，打进页面包，服务端不 import）：

- `remark-math`、`rehype-katex`、`katex` —— 数学公式。公式字体随 katex 的样式打进包，不从网上拉字体。
- wikilink、callout、标签、注释、块锚点用看板自己的 remark 插件，不另加包。原因：现成的 vault 插件按「文件名全局唯一」解析，和本仓的目录镜像正好相反。
