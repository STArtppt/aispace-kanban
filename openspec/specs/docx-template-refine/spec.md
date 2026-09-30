# docx-template-refine

## Purpose

约定 `output/docx-template/` 的产物目录与只读模板列表，以及工作台「模版洗炼」页从一份客户旧 Word 提炼模板的四步流程：
选来源、样式分析、大纲层级、模板补全输出。看板只 spawn `scripts/docx_template.py`，自己不写任何字节；上传仍然不做。
本能力由 `workbench-module-hub` 与 `md-to-docx` 变更落地。

## Requirements

### Requirement: 模板产物目录约定

工作空间模板 SHALL 提供 `output/docx-template/README.md`，约定每个模板占一个子目录 `output/docx-template/<模板名>/`，
里面放 `collect/`（采集报告：格式簇、大纲、样式使用情况，不含正文）、`profile.json`（相对通用规范的客户差异，每项用 `_src` 注明来源）、
`reference.docx`（由客户旧文档清洗、重建样式后得到的 pandoc 参照模板，**不是**客户原件）、`spec.md`（写给写 md 的人看的文字规定）、
`sample.docx`（用合成样张转出的效果预览），以及可选的 `cover.docx`（本期不生成）。
这个目录 MUST NOT 进入产出列表、全局搜索和完整度统计。README MUST 提醒：这些文件含客户版式材料，不要贴进反馈单或公开仓库。

#### Scenario: 新建工作空间

- **WHEN** 用 `templates/pm-aispace` 新建一个工作空间
- **THEN** `output/docx-template/README.md` 存在，并按上述六样说明每个文件；看板产出视图不显示这个目录

### Requirement: 服务端只读列出模板

服务端 SHALL 提供 `GET /api/projects/:id/docx-templates`：列出 `output/docx-template/` 下的一层子目录，
每项给出名称，以及 `collect/`、`profile.json`、`reference.docx`、`spec.md`、`sample.docx`、`cover.docx` 是否存在和修改时间；
以及 `GET /api/projects/:id/docx-templates/:name`：额外返回 `spec.md` 原文与 `collect/report.json`（不存在时缺省）。
`:name` MUST 是不含路径分隔符、不含 `..`、不以 `.` 开头的基名，否则 400；路径 MUST 过 `resolveInside()`。两个接口都只读。

#### Scenario: 目录不存在

- **WHEN** 旧工作空间没有 `output/docx-template/`
- **THEN** 接口返回空列表，状态码 200

#### Scenario: 只采集、还没生成

- **WHEN** 某个模板目录下只有 `collect/`
- **THEN** 列表里它标「未生成」，详情接口返回采集报告，不返回 `spec.md`

### Requirement: 模版洗炼页的布局

模版洗炼页 SHALL 分成左右两栏：左侧是模板列表（只列 `output/docx-template/` 下的真实模板），顶部有「新建模板」；
右侧显示选中模板的概要，或者新建模板的四步流程。选中已生成的模板时，右侧 SHALL 显示文件清单、渲染 `spec.md`，
并提供「预览样张」（用阅读器的 `.docx` 预览打开 `sample.docx`）与「重新提炼」（带着原来源进入四步流程）。
选中「未生成」的模板时，右侧 SHALL 提供「继续」，从第 ② 步接着做。

#### Scenario: 没有模板

- **WHEN** 工作空间 `output/docx-template/` 为空或不存在
- **THEN** 左侧列表为空，说明「还没有模板：从一份客户旧 Word 提炼一个」，右侧直接显示新建流程第 ① 步

#### Scenario: 有已生成的模板

- **WHEN** `output/docx-template/客户甲/` 下文件齐全
- **THEN** 左侧第一条是「客户甲」，右侧列出文件并渲染 `spec.md`；点「预览样张」看到 `sample.docx` 的分页版式

### Requirement: 四步提炼流程

新建模板 SHALL 依次经过四步，步骤条显示当前步骤，可以回到已完成的步骤：

1. **选来源**：从 `input/raw/` 的 `.docx` 清单里选一份，并填写模板名（一层基名；与已有模板重名时提示，需勾选「重新生成」才能继续）。
   不提供上传；清单为空时说明「把客户旧 Word 放进 `input/raw/`」，并提供「在访达中显示」打开该目录。
2. **样式分析**：点「开始分析」调用 `POST /api/projects/:id/docx-templates/:name/collect`（载荷只有 `docKey`），
   展示真实的格式簇（区域、段数、中文 / 西文字体、字号、加粗、对齐、缩进、行距、段前段后、大纲级别、样式名、编号情况、示例的编号前缀与字数）。
   每个簇可以映射到一个标准角色，或标记为合并到另一簇、丢弃；界面 SHALL 标出「样式定义与实际显示不一致」的簇，并以实际显示为准。
3. **大纲层级**：以树状展示识别出的标题层级、编号格式与伪标题（有大纲级别但无编号的段落）。同一层级 MUST 共用一个样式；
   可以调整层级对应的角色、合并相邻层级，决定伪标题并入某级标题还是保留为无编号小标题；
   格式不一致的项（如同一角色有两种行距）SHALL 要求用户选定一个值。
4. **模板补全输出**：点「生成模板」调用 `POST /api/projects/:id/docx-templates/:name/build`（载荷：`docKey`、用户决定、`regenerate`），
   完成后展示 `spec.md`（客户原文没有、由通用规范补齐的角色有标注）、反查结果（`warnings` 为空时显示「样张各角色格式与规范一致」），
   并提供「预览样张」。

第 ②③ 步的决定 SHALL 立即反映到第 ④ 步生成前的文字规定预览里；未点「生成模板」前离开页面，已采集的报告保留，决定不保留。

#### Scenario: 从采集到生成

- **WHEN** 用户选中 `input/raw/` 里的一份旧 Word，模板名填「客户甲」，完成分析与层级确认后点「生成模板」
- **THEN** `output/docx-template/客户甲/` 下出现 `collect/`、`profile.json`、`reference.docx`、`spec.md`、`sample.docx`；
  左侧列表出现「客户甲」；「转成 Word」弹窗里能选到它

#### Scenario: 行距不统一

- **WHEN** 采集发现正文有单倍（57 段）和 1.5 倍（33 段）两种行距
- **THEN** 第 ③ 步要求用户二选一，默认选段数多的那个，并显示两边的段数

#### Scenario: input/raw 里没有 docx

- **WHEN** `input/raw/` 下没有 `.docx`
- **THEN** 第 ① 步显示空态和「在访达中显示」，「下一步」不可点

### Requirement: 提炼的写入边界

采集与生成 MUST 满足 AGENTS.md 不变量 1 第九条：看板只 spawn `scripts/docx_template.py`，自己不写字节；
由用户点「开始分析」「生成模板」明确发起；环回且非跨站，否则 403；请求只带 `docKey`、模板名基名与决定 JSON，
`docKey` 反查不到或决定 JSON 超过 256KB、含路径字段时 400；脚本只写 `output/docx-template/<模板名>/`。
工作空间没有该脚本、找不到 Python 3 时接口 400，界面说明出路（复制提示词让工作空间 AI 从模板补齐脚本）。

#### Scenario: 非环回监听

- **WHEN** 看板以 `--host 0.0.0.0` 启动，从另一台机器点「开始分析」
- **THEN** 接口返回 403，工作空间没有新文件；按钮置灰并说明原因，已有模板仍可浏览

#### Scenario: 重名未确认

- **WHEN** 「客户甲」已存在，有人不带 `regenerate: true` 直接调用 build
- **THEN** 接口返回 409，模板目录不变

#### Scenario: 旧工作空间缺脚本

- **WHEN** 工作空间是本 change 之前建的，没有 `scripts/docx_template.py`
- **THEN** 「开始分析」返回 400，界面说明「这个工作空间还没有 docx 工具链」并提供「复制提示词」
