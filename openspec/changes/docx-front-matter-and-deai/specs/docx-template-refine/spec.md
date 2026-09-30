## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: 前置区确认

采集报告里 `front` 不为空时，第 ④ 步 SHALL 在「生成模板」之前多一块「前置区」确认，默认展开：

- 左侧用阅读器的 `.docx` 预览打开来源文档本身（它就在 `input/raw/`，看板本来就能预览），方便对照；
- 右侧列出前置区的分节（封面 / 签署页 / 目录等，按脚本猜测命名，可改名），以及封面上每个字段（序号、字数、是否在文本框、出现次数），
  每个字段可选「标题 / 客户单位 / 编制单位 / 日期 / 文档类型 / 保持原样」，默认用脚本的角色猜测；
- 前置区里的每张表可选清空规则：「保留表头行，清空其余单元格」「保留首列标签，清空其余单元格」「保留首行和首列」「原样保留」；
  默认按报告判断：首列像标签列的选「保留首列标签」，否则首行像表头的选「保留表头行」，都不像的选「原样保留」；
- 一个总开关「不要前置区」：勾上后不写 `front.docx`，与此前行为一致。

这些决定 SHALL 并入第 ②③ 步的决定 JSON（`front` 键）经 stdin 交给 `docx_template.py build`，同样受 256KB 与「不含路径字段」的限制。
「保持原样」的封面段落 MUST 在第 ④ 步给出提醒：这段模板原文会出现在每一份成品里。

#### Scenario: 默认映射

- **WHEN** 用户选中一份带封面和签署页的旧 Word 完成分析，进入第 ④ 步
- **THEN** 前置区块里封面标题已预选「标题」，日期段已预选「日期」；签署页表格预选「保留首列标签，清空其余单元格」

#### Scenario: 保持原样的提醒

- **WHEN** 用户把封面上一段单位名称设成「保持原样」
- **THEN** 该行旁出现提醒「这段原文会出现在每一份成品里」，仍允许生成

#### Scenario: 不要前置区

- **WHEN** 用户勾选「不要前置区」后生成模板
- **THEN** 模板目录里没有 `front.docx`，`profile.json` 里没有 `front` 段，转换出的成品只有正文
