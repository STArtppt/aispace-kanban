# docx-toolchain

## Purpose

随工作空间模板分发的一套 docx 工具链：`scripts/docx_template.py`（采集客户旧文档、生成模板包）、
`scripts/md2docx.py`（把 `.md` 转成 `.docx`）、`scripts/docxkit/`（样式真源与公共代码）。
采集先于清洗、报告不含正文；模板包清空正文、只保留页面设置与页眉页脚，按「通用规范 + 客户差异」重建样式；
有前置区时另写 `front.docx`，转换时装配到成品前面。成品都带生成标记。终端直跑、工作空间 AI 执行、看板 spawn 三条路径得到相同产物。本能力由 `md-to-docx` 与 `docx-front-matter-and-deai` 变更落地。

## Requirements

### Requirement: 工具链随工作空间模板分发

工作空间模板 SHALL 在 `scripts/` 下提供两个入口脚本和一个公共包：

- `scripts/docx_template.py collect <来源.docx> --name <模板名>`：采集，报告写入 `output/docx-template/<模板名>/collect/`；
- `scripts/docx_template.py build --name <模板名> --source <来源.docx>`：从 stdin 读取用户决定（JSON），生成模板包；
- `scripts/md2docx.py <来源.md> --template <模板名 | @base>`：把 `.md` 转成同目录、同基名的 `.docx`；
- `scripts/docxkit/`：公共代码；`scripts/docxkit/base-spec.json`：通用内容规范。

脚本 MUST 只依赖 Python 3 标准库；`md2docx.py` 另需 pandoc。三个入口 MUST 支持 `--json`，
以一行 JSON 报告结果（成功时给出写了哪些文件，失败时给出中文原因和出路），供看板解析；
不带 `--json` 时输出给人看的中文摘要。终端直跑、工作空间 AI 执行、看板 spawn 三条路径 MUST 得到相同产物。

#### Scenario: 终端里直接转换

- **WHEN** 用户在工作空间根目录执行 `python3 scripts/md2docx.py output/docs/方案.md --template @base`
- **THEN** `output/docs/方案.docx` 生成，终端打印写了哪个文件；退出码为 0

#### Scenario: 新建工作空间

- **WHEN** 用 `templates/pm-aispace` 新建一个工作空间
- **THEN** `scripts/docx_template.py`、`scripts/md2docx.py`、`scripts/docxkit/base-spec.json` 都存在

### Requirement: 通用内容规范与客户差异

`base-spec.json` SHALL 是样式清单的唯一真源：用 pandoc 认识的样式名（`Body Text`、`First Paragraph`、`Compact`、
`heading 1`–`heading 4`、`caption`、`Table Caption`、`Image Caption`、`Source Code`、`Verbatim Char`、`Block Text`、
`footnote reference` 等）定义每个角色，外加 `doc_defaults`、`heading_numbering`、`table` 三节，以及自定义样式「提示框」。
客户模板的 `profile.json` SHALL 只写与通用规范不同的部分，生成时深合并覆盖通用规范；每一项 SHOULD 用 `_src` 注明来源
（`extracted` 从旧文档采集 / `decision` 人工拍板）。客户原文没有的角色 MUST 由通用规范补齐。

字体、字号、行距 MUST 写在 `docDefaults`，`Normal` 样式保持为空；`Compact` MUST NOT 设字号 ——
这样表格样式里的字号、行距才能压过正文设置（pandoc 的表格单元格与紧凑列表共用 `Compact`）。
段前段后 MUST NOT 写 `beforeLines` / `afterLines`（它们优先于 `before` / `after`，写了 0 会把段前段后清零）。

#### Scenario: 客户没有代码块

- **WHEN** 客户旧文档里没有任何代码块，用户生成模板后转换一份带代码块的 `.md`
- **THEN** 成品里代码块套用 `Source Code` 样式（等宽字体、浅灰底色），`spec.md` 里代码块一条标「由通用规范补齐」

#### Scenario: 表格字号

- **WHEN** 通用规范正文 14pt、表格 10.5pt，转换一份含表格的 `.md`
- **THEN** 用 LibreOffice 或 Word 打开，表格单元格是 10.5pt 单倍行距，正文是 14pt

### Requirement: 采集先于清洗，报告不含正文

`collect` SHALL 在任何清洗之前，为每个段落计算实际生效的格式（docDefaults → 表格样式 → 段落样式链 → 手动格式），
并记录大纲级别、自动编号与手写编号、图表相邻关系、分节与页眉页脚、样式使用情况，最后按格式聚类。
上层显式字体 MUST 压掉下层继承来的主题字体。
报告 MUST NOT 包含正文原文：段落只保留编号前缀与字数（如 `（1）[35字]`），页眉页脚只报字数和域。

#### Scenario: 样式定义与实际显示不一致

- **WHEN** 旧文档的 `heading 1` 样式写 22pt，但每个一级标题都被手动设成 14pt
- **THEN** 格式簇里一级标题显示 14pt；报告同时给出样式定义值，供界面提示「样式定义不可信」

#### Scenario: 报告脱敏

- **WHEN** 采集一份含客户名称的旧文档
- **THEN** `collect/report.json` 与 `collect/paragraphs.jsonl` 里搜不到任何正文字句，只有编号前缀、字数、格式与结构

### Requirement: 模板包与生成标记

`build` SHALL 以来源文档为底：清空正文、只保留最后一节的页面设置与页眉页脚；删除未被引用、也不在继承链上的样式与编号定义；
按「通用规范 + profile」重建样式（原文已有同名样式时沿用它的 styleId，保住页眉页脚与目录对它的引用）；
标题多级编号挂在 `heading 1`–`heading 3` 样式上。
来源文档识别出前置区（见「前置区采集」）且用户在第 ④ 步保留了它时，`build` SHALL 另写 `front.docx`：
只含前置区的段落、表格、分节符及它们引用的图片、页眉页脚、样式与编号定义，表格已按清空规则清掉样例数据，
封面上被映射成字段的段落文字替换为占位符 `{{title}}` 这类形式，映射成「清空」的段落删掉文字、保留段落与格式（两种原文都不留在 `front.docx` 里）。
`reference.docx` 与 `front.docx` 的页眉页脚里，按段拼接全部 run 后包含某个已映射字段原文（至少 4 个字）的段落，
SHALL 把那部分写成同一个占位符，前后文字与首个 run 的格式保留。
随后 SHALL 用 `sample.md`（覆盖所有元素的合成样张）转出 `sample.docx`（有前置区时带上前置区），
再用 `collect` 反查样张，逐个角色比对实际格式与规范，不一致的写进结果里的 `warnings`。
找不到 pandoc 时 SHALL 照常写出其余文件，跳过样张与反查，并在 `warnings` 里说明。

工具链写出的每一份 `.docx`（`reference.docx`、`front.docx`、`sample.docx`、`md2docx.py` 的成品）MUST 在 `docProps/custom.xml`
带生成标记 `aispace-docx-generator`（值为工具链版本）。

#### Scenario: 生成模板

- **WHEN** 对一份 179 个样式、43 套编号的旧文档执行 `build`
- **THEN** `output/docx-template/<模板名>/` 下出现 `profile.json`、`reference.docx`、`spec.md`、`sample.docx`；
  `reference.docx` 里只剩被引用的样式与重建的样式、一套标题编号；`sample.docx` 反查无 `warnings`

#### Scenario: 带前置区的模板

- **WHEN** 来源文档是「封面 → 签署页 → 版本跟踪表 → 目录 → 正文」五段，用户在第 ④ 步保留前置区
- **THEN** 模板目录多出 `front.docx`；用解压工具查看它的 `word/document.xml`，搜不到封面原来的标题与单位文字，只有 `{{title}}` 等占位符；
  `sample.docx` 前几页依次是封面、签署页、目录，然后是样张正文

#### Scenario: 正文页眉里写着文档类型

- **WHEN** 来源文档正文页眉写着与封面文档类型同文的字样（在 XML 里被拆成多个 run），封面那段映射为「文档类型」
- **THEN** `reference.docx` 的页眉里这段变成 `{{doctype}}`，页眉的其余文字与格式不变；按段拼接 run 之后全文搜不到那段原文

#### Scenario: 标题续行清空

- **WHEN** 封面标题分两段，第一段映射「标题」，第二段映射「清空」
- **THEN** `front.docx` 里第二段还在（段落格式不变）但没有文字，文本框回退副本里同样没有

#### Scenario: 没有 LibreOffice

- **WHEN** 本机没有安装 LibreOffice
- **THEN** 采集、生成、转换全部正常完成；工具链不调用 LibreOffice

### Requirement: pandoc 探测

`md2docx.py` SHALL 按 `PANDOC_BIN` 环境变量 → 工作空间 `.env` 的 `PANDOC_BIN` → `PATH` 的顺序找 pandoc，并要求主版本号 ≥ 3。
找不到或版本太低时 MUST 以非零退出码结束，`--json` 结果里说明「未找到 pandoc（或版本过低），请安装 pandoc 3 以上」以及安装方式，
不生成半成品。看板服务端 SHALL 用 `platform.mjs` 的同一查找顺序判断可用性，并通过 `/api/health` 的可选字段报告。

#### Scenario: 没装 pandoc

- **WHEN** 本机没有 pandoc，执行 `python3 scripts/md2docx.py output/docs/a.md --template @base --json`
- **THEN** 退出码非 0，JSON 里 `ok: false`，原因写明缺 pandoc；`output/docs/a.docx` 不存在

### Requirement: 合成回归语料

仓库 SHALL 在 `fixtures/docx-template/` 放一份脚本生成的「格式很乱的旧文档」（大量无效样式、手动格式、伪标题、手写编号、三种表格边框，内容全部合成）
和覆盖全部元素的 `sample.md`，并提供 `pnpm test:docx`：依次跑采集、生成、转换、反查，断言关键角色的格式与规范一致、报告里没有正文。
真实客户文档 MUST NOT 进入仓库。

#### Scenario: 回归

- **WHEN** 改了 `docxkit/` 里的样式生成代码后运行 `pnpm test:docx`
- **THEN** 断言全部通过时退出码为 0；任何角色格式偏离规范时退出码非 0，并打印哪个角色、哪一项、期望值与实际值

### Requirement: 前置区采集

`collect` SHALL 识别前置区：正文第一个标题段之前的所有分节（或第一个目录域之后的第一个分节符之前，取靠后者），
并在报告里输出 `front` 段：分节数、每节的段落与表格清单、目录域是否存在。
每个段落只给结构：所在节、序号、字数、是否位于文本框、字号、加粗、对齐，以及脚本给出的**角色猜测**
（`title` / `client` / `vendor` / `date` / `doctype` / `clear` / 无）；在文本框和它的兼容回退里重复出现的同一段文字 SHALL 归为一个字段，
并记出现次数，以及页眉页脚里同文出现的次数 `headerHits`。
角色猜测 SHALL 先在大字号段落里认文档类型，再取剩下字号最大、靠前的作标题；紧跟标题、同一文本框（或同节相邻）、字号与加粗相同的段落猜作 `clear`。
日期字段 SHALL 另给形态标记 `dateFormat`（如 `YYYY年MM月`、`YYYY年M月`、`YYYY.MM`），不给日期本身。
每张表给出行数、列数、顶部横跨整行的合并标题行数 `captionRows`、其后第一行是否像表头、是否像标签表（首列像标签列，或别的列里有标签段落），
以及默认清空规则：像表头的 `keepHeader`，否则像标签表的 `keepLabels`，否则 `keepAll`。
报告 MUST 仍然不含正文字句（沿用「采集先于清洗，报告不含正文」）：角色猜测在脚本内部按字号、位置、日期格式等判据得出，只输出标签。

#### Scenario: 封面在文本框里

- **WHEN** 旧文档的封面标题放在浮动文本框里，并带有兼容回退的副本
- **THEN** 报告里这段标题只出现一次，`occurrences` 为 2，`inTextbox` 为真，`guess` 为 `title`

#### Scenario: 文档类型字号比项目名大

- **WHEN** 封面上 26pt 的一段是「××分析报告」，22pt 的两段是项目名（同一文本框、格式相同）
- **THEN** 26pt 那段 `guess` 为 `doctype`，22pt 第一段为 `title`，第二段为 `clear`

#### Scenario: 带合并标题行的版本表

- **WHEN** 版本跟踪表第一行是横跨整行的「文件版本记录」，第二行是「版本｜版本说明｜日期」，下面是样例记录，首列是 A、B 这样的短编号
- **THEN** 这张表 `captionRows` 为 1、`headerLike` 为真、`defaultRule` 为 `keepHeader`；生成后标题行与表头行保留，样例记录（含 A、B）清空

#### Scenario: 一行多组签字标签

- **WHEN** 签署页表格一行里有「编写(签字)：」「审核(签字)：」「批准(签字)：」三组标签，分别在第 1、3、5 列，每格下面还有「日期：」
- **THEN** 默认规则为 `keepLabels`；生成后三组标签和「日期：」都在，签名与日期的值清空

#### Scenario: 没有前置区

- **WHEN** 旧文档第一段就是一级标题
- **THEN** 报告里 `front` 为空，第 ④ 步不出现前置区确认，`build` 不写 `front.docx`

### Requirement: 转换前处理（格式过滤器）

`md2docx.py` SHALL 在调用 pandoc 时挂上工具链自带的 Lua 过滤器 `docxkit/filters/deai-format.lua`，做下列只动格式、不改文字的处理，
每一项的处理次数写进结果的 `log`：

1. **标题平移**：文档第一个块是 `#` 标题、且全文只有这一个 `#` 时，把它取作文档标题（供封面 `title` 字段或 Title 段使用），
   其余标题整体上移一级（`##` → 一级标题）。全文有多个 `#` 时不平移，并给出 warning。front-matter 里有 `title` 时以 front-matter 为准，`#` 仍按上述规则平移。
2. **手写编号剥离**：所选模板的 `heading 1`–`heading 3` 样式带自动编号时，剥掉标题开头的手写编号
   （`1.`、`2.1`、`2.1.3`、`一、`、`（一）`、`第三章` 及其后的空白）；样式不带编号时保留原样。
3. **批注块**：`> [!note]`、`[!tip]`、`[!important]`、`[!warning]`、`[!caution]` 等写法转成模板的「提示框」样式段落；
   标记本身不进成品，标记后写了自定义标题的，标题作为提示框首行加粗保留。不认识的类型同样处理并给 warning。
4. **加粗**：正文段落与列表项里，只保留**段首标签式**加粗（加粗片段是段落的第一个元素，且以 `：` 或 `:` 结尾，或紧跟着 `：` / `:`），
   其余加粗解除；表格表头、提示框标题不受影响。命令行 `--keep-bold` 关闭这一项。

#### Scenario: 标题与编号

- **WHEN** md 以 `# 某项目 · 实施方案` 开头，下面是 `## 1. 调研目标`、`### 2.1 站点范围`，模板的标题样式带多级编号
- **THEN** 成品里「调研目标」是一级标题、「站点范围」是二级标题，显示的编号只有样式给的一套；`log` 里有「标题上移一级」「剥离手写编号 N 处」

#### Scenario: 批注块

- **WHEN** md 里有 `> [!note]` 开头的引用块
- **THEN** 成品里对应段落是「提示框」样式，全文搜不到 `[!note]`

#### Scenario: 段中加粗

- **WHEN** 一段正文是 `**调研对象：** 各单位网站负责人，**必须**在两周内反馈`
- **THEN** 成品里「调研对象：」仍加粗，「必须」不加粗，文字一字不差

#### Scenario: 多个一级标题

- **WHEN** md 里有三个 `#` 标题
- **THEN** 标题层级不平移，结果 `warnings` 里说明「有 3 个一级标题，未把第一个当作文档标题」

### Requirement: 前置区装配

所选模板有 `front.docx` 时，`md2docx.py` SHALL 把成品装配成「前置区 + 正文」：
前置区的分节、页眉页脚、图片原样保留；封面字段按 `profile.json#front.fields` 替换，
值依次取自 md front-matter（`title` / `client` / `vendor` / `date` / `doctype`）→ 标题平移得到的文档标题（只用于 `title`）
→ 工作空间 `project.yaml` 的 `identity.甲方` / `identity.承建方`（只用于 `client` / `vendor`）→ 转换当天（只用于 `date`，按模板的 `dateFormat` 写，没有形态标记时写「YYYY年M月」）；
标题平移得到的文档标题含分隔符（`·`、`|`、`｜`）且模板映射了 `doctype` 字段时，SHALL 在最后一个分隔符处拆开：
前半段作 `title`，front-matter 没写 `doctype` 时后半段作 `doctype`（来源记「文档标题后缀」）；front-matter 写了 `title` 或模板没有 `doctype` 字段时不拆；
仍然取不到值的字段写成醒目的占位文字「【待填：客户单位】」这类形式，并给 warning，MUST NOT 把模板来源文档的原文写回去。
字段替换 SHALL 保住原段落与首个 run 的格式（字体、字号、加粗、对齐），同一字段的所有出现处（含文本框回退副本）一起替换。
目录 SHALL 保留 TOC 域并清空模板里的样例目录项，成品 `settings.xml` 设置打开时更新域；正文沿用模板正文节的页眉页脚与页码，
其中的占位符（见「模板包与生成标记」）与封面字段用同一个值替换，`log` 写明页眉页脚替换了几处。
所选模板没有 `front.docx`（含 `@base`）时，行为与此前一致。

#### Scenario: 封面字段替换

- **WHEN** 模板有前置区，md front-matter 没写 `client`，`project.yaml` 的 `identity.甲方` 有值
- **THEN** 成品封面的客户单位是 `project.yaml` 里的值，字号与对齐与模板封面一致；`log` 里注明取值来源

#### Scenario: 标题带文档类型后缀

- **WHEN** md 以 `# 某项目 · 需求调研实施方案` 开头、没有 front-matter，模板封面映射了「标题」和「文档类型」，正文页眉有 `{{doctype}}`
- **THEN** 封面标题是「某项目」，文档类型与正文页眉都是「需求调研实施方案」；`log` 里文档类型的来源是「文档标题后缀」，没有「待填」warning

#### Scenario: 取不到值

- **WHEN** 模板封面映射了 `doctype` 字段，md 与 `project.yaml` 都没有对应值
- **THEN** 成品封面该处显示「【待填：文档类型】」，结果 `warnings` 里有一条对应说明

#### Scenario: 目录

- **WHEN** 用 Word 打开带前置区的成品
- **THEN** Word 提示更新域，更新后目录列出的是本文的标题，不是模板样例文档的章节
