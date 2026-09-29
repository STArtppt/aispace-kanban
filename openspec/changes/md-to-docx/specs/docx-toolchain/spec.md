## ADDED Requirements

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
标题多级编号挂在 `heading 1`–`heading 3` 样式上。随后 SHALL 用 `sample.md`（覆盖所有元素的合成样张）转出 `sample.docx`，
再用 `collect` 反查样张，逐个角色比对实际格式与规范，不一致的写进结果里的 `warnings`。
找不到 pandoc 时 SHALL 照常写出其余文件，跳过样张与反查，并在 `warnings` 里说明。

工具链写出的每一份 `.docx`（`reference.docx`、`sample.docx`、`md2docx.py` 的成品）MUST 在 `docProps/custom.xml`
带生成标记 `aispace-docx-generator`（值为工具链版本）。

#### Scenario: 生成模板

- **WHEN** 对一份 179 个样式、43 套编号的旧文档执行 `build`
- **THEN** `output/docx-template/<模板名>/` 下出现 `profile.json`、`reference.docx`、`spec.md`、`sample.docx`；
  `reference.docx` 里只剩被引用的样式与重建的样式、一套标题编号；`sample.docx` 反查无 `warnings`

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
