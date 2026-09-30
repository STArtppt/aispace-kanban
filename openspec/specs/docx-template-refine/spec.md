# docx-template-refine

## Purpose

约定 `output/docx-template/` 的产物目录与只读模板列表，以及工作台「模版洗炼」页从一份客户旧 Word 提炼模板的四步流程：
选来源、样式分析、大纲层级、模板补全输出。有前置区时，第 ④ 步确认字段角色与表格清空规则，并写出 `front.docx`。
看板只 spawn `scripts/docx_template.py`，自己不写任何字节；上传仍然不做。
本能力由 `workbench-module-hub`、`md-to-docx` 与 `docx-front-matter-and-deai` 变更落地。

## Requirements

### Requirement: 模板产物目录约定

工作空间模板 SHALL 提供 `output/docx-template/README.md`，约定每个模板占一个子目录 `output/docx-template/<模板名>/`，
里面放 `collect/`（采集报告：格式簇、大纲、样式使用情况、前置区结构，不含正文）、`profile.json`（相对通用规范的客户差异，每项用 `_src` 注明来源；
有前置区时含 `front` 段：字段映射与表格清空规则）、
`reference.docx`（由客户旧文档清洗、重建样式后得到的 pandoc 参照模板，**不是**客户原件）、
`front.docx`（可选：前置区骨架，即封面、签署页、版本跟踪表、目录，字段处是占位符、样例数据已清空）、
`spec.md`（写给写 md 的人看的文字规定）、`sample.docx`（用合成样张转出的效果预览）。
这个目录 MUST NOT 进入产出列表、全局搜索和完整度统计。README MUST 提醒：这些文件含客户版式材料，不要贴进反馈单或公开仓库。

#### Scenario: 新建工作空间

- **WHEN** 用 `templates/pm-aispace` 新建一个工作空间
- **THEN** `output/docx-template/README.md` 存在，并按上述六样说明每个文件；看板产出视图不显示这个目录

### Requirement: 服务端只读列出模板

服务端 SHALL 提供 `GET /api/projects/:id/docx-templates`：列出 `output/docx-template/` 下的一层子目录，
每项给出名称，以及 `collect/`、`profile.json`、`reference.docx`、`front.docx`、`spec.md`、`sample.docx` 是否存在和修改时间；
以及 `GET /api/projects/:id/docx-templates/:name`：额外返回 `spec.md` 原文、`collect/report.json` 与 `profile.json#front`（不存在时缺省）。
`:name` MUST 是不含路径分隔符、不含 `..`、不以 `.` 开头的基名，否则 400；路径 MUST 过 `resolveInside()`。两个接口都只读。

#### Scenario: 目录不存在

- **WHEN** 旧工作空间没有 `output/docx-template/`
- **THEN** 接口返回空列表，状态码 200

#### Scenario: 只采集、还没生成

- **WHEN** 某个模板目录下只有 `collect/`
- **THEN** 列表里它标「未生成」，详情接口返回采集报告，不返回 `spec.md`

#### Scenario: 旧服务进程

- **WHEN** 前端已更新、服务进程还是旧版，列表项里没有 `front` 相关字段
- **THEN** 模板照常列出，概要里不显示「前置区」一行，不报错

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

### Requirement: 前置区确认

采集报告里 `front` 不为空时，第 ④ 步 SHALL 在「生成模板」之前多一块「前置区」确认，默认展开：

- 左侧用阅读器的 `.docx` 预览打开来源文档本身（它就在 `input/raw/`，看板本来就能预览），方便对照；
- 右侧列出前置区的分节（封面 / 签署页 / 目录等，按脚本猜测命名，可改名），以及封面上每个字段（序号、字数、是否在文本框、出现次数），
  每个字段可选「标题 / 客户单位 / 编制单位 / 日期 / 文档类型 / 清空 / 保持原样」，默认用脚本的角色猜测；
  字段的 `headerHits` 大于 0 时，该行注明「页眉页脚另有 N 处随它替换」（选「保持原样」「清空」时不替换页眉页脚）；
- 前置区里的每张表可选清空规则：「保留表头行，清空其余单元格」「保留标签，清空填写内容」「保留表头与标签」「原样保留」；
  表格顶部横跨整行的合并标题行在任何规则下都保留（`captionRows` 大于 0 时注明）；
  默认用报告的 `defaultRule`：像表头的选「保留表头行」，否则像标签表的选「保留标签」，都不像的选「原样保留」；
- 一个总开关「不要前置区」：勾上后不写 `front.docx`，与此前行为一致。

这些决定 SHALL 并入第 ②③ 步的决定 JSON（`front` 键）经 stdin 交给 `docx_template.py build`，同样受 256KB 与「不含路径字段」的限制。
「保持原样」的封面段落 MUST 在第 ④ 步给出提醒：这段模板原文会出现在每一份成品里。

#### Scenario: 默认映射

- **WHEN** 用户选中一份带封面和签署页的旧 Word 完成分析，进入第 ④ 步
- **THEN** 前置区块里封面标题已预选「标题」，日期段已预选「日期」；签署页表格预选「保留标签，清空填写内容」

#### Scenario: 页眉页脚随字段替换

- **WHEN** 封面「文档类型」一段的原文也出现在正文页眉里
- **THEN** 该字段行注明「页眉页脚另有 1 处随它替换」；改成「保持原样」后这行提示消失

#### Scenario: 旧服务的报告

- **WHEN** 服务与工作空间脚本是旧版，报告里的字段没有 `headerHits`、表格没有 `captionRows`
- **THEN** 前置区块照常显示，不出现这两项提示；字段下拉里仍有「清空」，选了它生成时旧脚本会报决定无效，按现有的错误提示显示

#### Scenario: 保持原样的提醒

- **WHEN** 用户把封面上一段单位名称设成「保持原样」
- **THEN** 该行旁出现提醒「这段原文会出现在每一份成品里」，仍允许生成；改成「清空」后提醒消失

#### Scenario: 不要前置区

- **WHEN** 用户勾选「不要前置区」后生成模板
- **THEN** 模板目录里没有 `front.docx`，`profile.json` 里没有 `front` 段，转换出的成品只有正文
