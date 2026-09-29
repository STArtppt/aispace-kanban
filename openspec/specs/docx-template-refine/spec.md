# docx-template-refine

## Purpose

约定 `output/docx-template/` 的产物目录与只读模板列表，以及工作台「模版洗炼」页的四步新建流程。本轮只做前端演示：不上传文件、不解析、不落盘，真正的提炼在后续「.md 转 .docx」里实现。本能力由 `workbench-module-hub` 变更落地。

## Requirements

### Requirement: 模板产物目录约定

工作空间模板 SHALL 新增 `output/docx-template/README.md`，约定每个模板占一个子目录 `output/docx-template/<模板名>/`，
里面放 `profile.json`（相对通用规范的客户差异，每项用 `_src` 注明来源）、`reference.docx`、可选的 `cover.docx`、
`spec.md`（写给写 md 的人看的文字规定）和 `collect/`（采集报告）。
这个目录 MUST NOT 进入产出列表、全局搜索和完整度统计。

#### Scenario: 新建工作空间

- **WHEN** 用 `templates/pm-aispace` 新建一个工作空间
- **THEN** `output/docx-template/README.md` 存在，`output/README.md` 的子目录说明里有它；看板产出视图不显示这个目录

### Requirement: 服务端只读列出模板

服务端 SHALL 提供 `GET /api/projects/:id/docx-templates`：列出 `output/docx-template/` 下的一层子目录，
每项给出名称，以及上述五样文件是否存在和修改时间；以及 `GET /api/projects/:id/docx-templates/:name`：额外返回 `spec.md` 原文。
`:name` MUST 是不含路径分隔符、不含 `..`、不以 `.` 开头的基名，否则 400；路径 MUST 过 `resolveInside()`。两个接口都只读。

#### Scenario: 目录不存在

- **WHEN** 旧工作空间没有 `output/docx-template/`
- **THEN** 接口返回空列表，状态码 200

### Requirement: 模版洗炼页的布局

模版洗炼页 SHALL 分成左右两栏：左侧是模板列表，顶部有「新建模板」，列表先放真实模板，再放两条标「示例」的内置合成模板；
右侧显示选中模板的概要，或者新建模板的四步流程。选中真实模板时，右侧 SHALL 显示它包含哪些文件，并渲染 `spec.md`。
页顶 MUST 常驻一条不可关闭的提示：新建流程是演示，分析结果是示例数据，真正的提炼在后续「.md 转 .docx」里实现。

#### Scenario: 没有真实模板

- **WHEN** 工作空间 `output/docx-template/` 为空或不存在
- **THEN** 左侧只有两条示例模板，列表上方说明模板产物会放在 `output/docx-template/`

#### Scenario: 有真实模板

- **WHEN** `output/docx-template/示例客户/` 下有 `reference.docx` 和 `spec.md`
- **THEN** 左侧第一条是「示例客户」，右侧列出这两样文件并渲染 `spec.md`，缺的文件标「缺」

### Requirement: 四步新建流程（演示）

新建模板 SHALL 依次经过四步，步骤条显示当前步骤，可以回到已完成的步骤：

1. **选来源**：上传本地 `.docx`，或者从工作空间 `input/raw/` 的 `.docx` 清单里挑一份；没选来源时不能进入下一步。
2. **样式分析**：用表格列出格式簇（示例字体、字号、行距、段前段后、大纲级别、出现次数），每行可以映射到一个标准样式名，
   也可以标记为保留、合并到另一行或丢弃。
3. **大纲层级**：以树状展示识别出的标题层级，同一层级 MUST 共用一个样式；可以调整某层对应的样式，也可以合并相邻层级。
4. **模板补全输出**：以 Markdown 文字规定展示「写 md 的人要遵守的写法」（标题层级与 `#` 的对应、正文、列表、表格、代码块、
   题注、提示框等），客户原文里没有的角色标「由通用规范补齐」；提供「复制」和「保存为模板」。

第 ②③ 步的修改 SHALL 立即反映到第 ④ 步的输出里。

#### Scenario: 从工作空间挑文件

- **WHEN** `input/raw/` 下有两份 `.docx`，用户在第 ① 步切到「从工作空间选择」
- **THEN** 列出这两份文件，选中一份后「下一步」可以点

#### Scenario: 工作空间里没有 docx

- **WHEN** `input/raw/` 下没有 `.docx`
- **THEN** 「从工作空间选择」显示空态，上传方式仍然可用

#### Scenario: 映射联动

- **WHEN** 用户在第 ② 步把某个格式簇从「Body Text」改映射为「First Paragraph」，然后进入第 ④ 步
- **THEN** 输出的文字规定里对应条目随之改变

#### Scenario: 保存为模板

- **WHEN** 用户在第 ④ 步点「保存为模板」
- **THEN** 左侧列表多出一条，标「仅本次会话」；刷新页面后消失，`output/docx-template/` 下没有新文件

### Requirement: 演示不上传、不落盘

模版洗炼页 MUST NOT 调用任何写接口，也 MUST NOT 把文件内容发给服务端。上传的文件只在浏览器里读取文件名和大小；
不管来源是哪份文件，第 ②③ 步展示的都是前端内置的合成示例数据。

#### Scenario: 上传一份文件

- **WHEN** 用户在第 ① 步上传一份本地 `.docx`
- **THEN** 网络面板里没有携带文件内容的请求；工作空间和 `~/.pmwork/` 下没有新文件

#### Scenario: 工作空间目录丢失

- **WHEN** 当前工作空间 `available === false`
- **THEN** 「从工作空间选择」和真实模板列表显示目录不可用的降级文案，示例模板和演示流程照常可用
