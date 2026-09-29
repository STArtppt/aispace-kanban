## ADDED Requirements

### Requirement: wikilink 按路径打开，不按全库文件名猜测

预览里的 `[[目标]]`、`[[目标|显示文本]]` MUST 渲染成链接。解析 MUST 遵守：

- 目标以 `./` 或 `../` 开头时，相对当前文件。
- 目标含 `/` 且当前预览知道文件在工作空间中的路径时，从工作空间根算，再折成当前文件的相对路径。
- 目标不含 `/` 时，只认当前文件同一目录。没有扩展名时 MUST 补 `.md`。
- 显示文本优先用 `|` 后面的别名；没有别名时用目标自身的名字。
- `[[目标#标题]]` MUST 打开目标文件，标题 MUST 出现在链接文字里（没有别名时），MUST NOT 把 `#标题` 拼进文件路径。
- `http:` / `https:` 目标 MUST 当外链，不按工作空间路径拼接。

同名文件出现在别的目录时，裸文件名 MUST NOT 链到那一份。

#### Scenario: 相对路径 wikilink

- **WHEN** `output/analysis/现状.md` 的正文含 `[[../docs/方案|评审方案]]`
- **THEN** 预览里是一条可读的链接，文字是「评审方案」
- **AND** 点开的文件路径是 `output/docs/方案.md`

#### Scenario: 从工作空间根写的路径

- **WHEN** 同一份文件含 `[[output/docs/方案]]`
- **THEN** 点开的文件路径仍是 `output/docs/方案.md`

#### Scenario: 裸文件名只认同目录

- **WHEN** `output/analysis/现状.md` 含 `[[澄清清单]]`，且 `output/docs/澄清清单.md` 也存在
- **THEN** 链接指向 `output/analysis/澄清清单.md`
- **AND** 不指向 `output/docs/澄清清单.md`

#### Scenario: 标题不进文件路径

- **WHEN** 正文含 `[[../docs/方案#范围]]`
- **THEN** 点开的路径是 `output/docs/方案.md`，路径里没有 `#范围`
- **AND** 链接文字里能看到「范围」

### Requirement: 嵌入只内联图片

`![[目标]]` 在目标是图片（png、jpg、jpeg、gif、webp、svg、avif、bmp）时 MUST 渲染成图片。其它目标 MUST 渲染成链接，MUST NOT 把目标文件的正文插进当前页。

#### Scenario: 嵌入图片

- **WHEN** 正文含 `![[./图.png]]`
- **THEN** 预览里是一张图，而不是一段 `![[./图.png]]` 裸文本

#### Scenario: 嵌入文档

- **WHEN** 正文含 `![[../docs/方案]]`
- **THEN** 预览里是指向该文件的链接
- **AND** 当前页不出现那份文档的标题和段落

### Requirement: callout 不再露出类型标记

`> [!type]` 以及可选的标题 MUST 渲染成一块带标题的引用，正文里 MUST NOT 再出现 `[!type]` 这串标记。

warning、caution、attention、failure、fail、missing、danger、error、bug、important MUST 使用「需要注意」的样式（现有的 destructive 令牌）。其余类型 MUST 只用灰底和边框，MUST NOT 引入新的彩色。

`> [!type]-` MUST 默认折叠，`> [!type]+` MUST 默认展开。没有 `+` / `-` 时 MUST 直接展开，且不是可折叠块。

#### Scenario: 警告 callout

- **WHEN** 正文含 `> [!warning] 风险` 以及下一行引用正文
- **THEN** 预览里看得到标题「风险」和正文
- **AND** 页面文字里没有 `[!warning]`
- **AND** 这块使用「需要注意」的样式

#### Scenario: 普通 callout 不折叠

- **WHEN** 正文含 `> [!note] 背景` 且没有 `+` 或 `-`
- **THEN** 正文直接可见，不需要先点击展开

#### Scenario: 减号默认折叠

- **WHEN** 正文含 `> [!note]- 背景`
- **THEN** 这块可以展开，初始状态是折叠的

### Requirement: 行首标签、注释和块锚点不进入正文

- 段落中、行首（段落开头或换行之后）的 `#标签`（`#` 后紧跟非空格、非 `#`）MUST 渲染成小标签，MUST NOT 成为目录里的标题。`# 标题`（`#` 后有空格）MUST 仍是标题。
- `%%注释%%` MUST NOT 出现在预览文字里。围栏代码块里的 `%%` MUST 原样保留。
- 段落末尾的 `^id`（`^` 前是行首或空白，id 由字母数字、`_`、`-` 组成）MUST NOT 出现在预览文字里。

#### Scenario: 行首标签不是标题

- **WHEN** 正文有一行 `#待确认`，另外有一行 `# 真正的标题`
- **THEN** 目录里有「真正的标题」，没有「待确认」
- **AND** `#待确认` 显示成标签，不是大标题

#### Scenario: 注释被藏起

- **WHEN** 正文是 `结论是 A。%%这句不要给读者看%%后续仍在。`
- **THEN** 预览文字里有「结论是 A。」和「后续仍在。」
- **AND** 没有「这句不要给读者看」

#### Scenario: 代码块里的注释保留

- **WHEN** 围栏代码块里有 `%%not a comment%%`
- **THEN** 这段代码原样显示，包含百分号

#### Scenario: 块锚点不露在段尾

- **WHEN** 某段以 ` 需要复核 ^q-range` 结尾
- **THEN** 预览这段文字以「需要复核」结束，看不到 `^q-range`

### Requirement: 数学公式被排版

`$...$` MUST 渲染成行内公式，`$$...$$` MUST 渲染成独立成行的公式。公式非法时 MUST 留下源文本，MUST NOT 让整篇预览空白或抛到页面外。

#### Scenario: 行内公式

- **WHEN** 正文含 `速度 $v=s/t$ 随时间变`
- **THEN** 预览里公式是排版后的式子，不是两端带美元符号的裸文本

#### Scenario: 非法公式不弄白预览

- **WHEN** 正文含未闭合或 katex 不认识的公式
- **THEN** 该处显示公式源文本或错误提示
- **AND** 公式前后的段落仍然在

### Requirement: 写法规范与校验跟渲染一起放行

`templates/pm-aispace/AGENTS.md` 的「Markdown 写法」MUST 把上述语法列为现在可用，并 MUST 写明三条做不到的事：全库裸文件名匹配、把文档正文嵌进来、打开后滚到某一节。

`scripts/check_markdown.py` MUST NOT 再因为 wikilink、embed、callout、行首标签、百分号注释、块锚点、数学公式报错。扁平 front-matter 与标题层级的检查 MUST 保持不变。

`scripts/web_ingest.py` MUST NOT 再把这些语法从提取结果里剥掉。多个 H1 降级这一条 MUST 保留。

#### Scenario: 使用新语法的文档通过校验

- **WHEN** 对一份使用了 `[[../docs/方案]]`、`> [!note]`、`#待确认`、`%%注释%%` 的 `output/` 文档运行 `check_markdown.py`
- **THEN** 这些写法不产生错误

#### Scenario: 内联数组仍然报错

- **WHEN** front-matter 写着 `tags: [a, b]`
- **THEN** `check_markdown.py` 仍然报错

#### Scenario: 网页提取留下 callout

- **WHEN** 提取出的正文含 `> [!note] 说明`
- **THEN** 落盘的 Markdown 仍包含这一 callout，而不是被改成普通引用
