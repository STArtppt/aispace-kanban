## ADDED Requirements

### Requirement: 「转成 Word」入口

产出视图里每个 `.md` 条目（`analysis` / `docs` / `decisions` 三组，含组内子目录与已归档项）的「更多」菜单 SHALL 有「转成 Word」。
入口可用的前提是该条目带有服务端下发的 `docKey`；没有 `docKey`（旧服务进程）时菜单项置灰，提示「看板服务是旧版本，重启后可用」。
非 `.md` 条目不出现这一项。

#### Scenario: 打开弹窗

- **WHEN** 用户在 `output/docs/方案/总体设计.md` 这一行点「更多 → 转成 Word」
- **THEN** 弹出「转成 Word」对话框，标题栏显示来源文件名，目标文件显示为同目录的 `总体设计.docx`

### Requirement: 选择模板

弹窗 SHALL 列出可选模板：「通用规范」（`@base`，永远在第一位）以及 `output/docx-template/` 下每个带 `reference.docx` 的模板；
缺 `reference.docx` 的模板目录显示但不可选，并说明「还没生成模板」。默认选中上次在本工作空间用过的模板（记在 `localStorage`，
key 为 `aispace-kanban:docx-template:<工作空间 id>`），找不到就选「通用规范」。
弹窗 SHALL 提供「在模版洗炼里查看」跳转到工作台对应模板。

#### Scenario: 没有任何客户模板

- **WHEN** `output/docx-template/` 为空
- **THEN** 只有「通用规范」一项，下方提示可以去工作台「模版洗炼」提炼客户模板

### Requirement: 直接转换

用户选好模板后点「转换」，前端 SHALL 调用 `POST /api/projects/:id/docx/convert`，载荷只有 `docKey`、`template`、`overwrite`。
服务端 SHALL 用 `docKey` 反查出来源 `.md`，启动工作空间的 `scripts/md2docx.py`，同步等待（超时 120 秒），返回写出的文件相对路径与 `warnings`。
成功后弹窗关闭，toast 显示「已生成 <文件名>」并带「预览」按钮；产出列表经 SSE 出现新的 `.docx`。

#### Scenario: 正常转换

- **WHEN** 用户选「通用规范」转换 `output/docs/a.md`，同目录没有 `a.docx`
- **THEN** 几秒内 `output/docs/a.docx` 出现，点 toast 的「预览」在阅读器里看到分页版式；`a.md` 一个字节都没变

#### Scenario: md 里引用了相对路径图片

- **WHEN** `a.md` 里写着 `![架构](../assets/arch.png)`
- **THEN** 成品里嵌入了这张图（pandoc 以 `.md` 所在目录为资源路径）；图不存在时成品照常生成，结果里多一条 warning 指出缺哪张图

### Requirement: 同名文件不被误覆盖

目标 `.docx` 已存在时，弹窗 SHALL 在转换前提示。只有当已有文件带工具链生成标记 `aispace-docx-generator` 时，
才提供「覆盖」勾选；用户勾选后载荷 `overwrite: true`。已有文件没有生成标记时 MUST 拒绝转换，
提示「同名的 Word 不是本工具生成的，为避免覆盖人工修改，请先改名或移走」。服务端与脚本 MUST 各自再校验一次，不能只靠前端。

#### Scenario: 覆盖上次生成的成品

- **WHEN** `a.docx` 是上次转换生成的，用户勾选「覆盖」后转换
- **THEN** `a.docx` 被新成品替换

#### Scenario: 同名文件是人手改过的

- **WHEN** `a.docx` 没有生成标记，有人用 curl 直接发 `overwrite: true`
- **THEN** 接口返回 409，`a.docx` 不变

### Requirement: 复制提示词

弹窗 SHALL 提供「复制提示词」：只写剪贴板，不发任何写请求。提示词包含：来源 `.md` 的工作空间相对路径、所选模板、
要执行的命令（`python3 scripts/md2docx.py <路径> --template <模板>`）、同名文件的处理规则、
以及转换后要检查的事项（标题编号、表格、图片、题注是否正常，有 warnings 就先修 md 再转）。
这条路径在 pandoc 缺失、非环回监听、脚本缺失时 MUST 仍然可用（脚本缺失时提示词改为说明如何从模板补齐脚本）。

#### Scenario: 交给工作空间 AI

- **WHEN** 用户点「复制提示词」并粘贴给工作空间 AI
- **THEN** 剪贴板里是完整可执行的说明；看板这一侧工作空间没有任何文件变化

### Requirement: 转换成品的后处理

`md2docx.py` SHALL 在 pandoc 输出后做确定性的后处理：写入生成标记；表格首行设为跨页重复的表头；
以「图 / 表 + 数字」开头的题注把手写编号换成 SEQ 域（打开 Word 更新域后自动编号，未更新时显示原数字）；
md front-matter 里的 `title` 渲染为 `Title` 样式的首段。后处理 MUST NOT 改动正文文字。

#### Scenario: 手写编号的题注

- **WHEN** md 里表题写成 `Table: 表 3 功能清单`
- **THEN** 成品表题是「表 {SEQ 表} 功能清单」形式的域，未刷新时显示「表 3 功能清单」

### Requirement: 转换的失败与降级

以下情况接口 SHALL 返回 400 并给出中文出路，界面原样显示，且 MUST NOT 生成任何文件：
工作空间没有 `scripts/md2docx.py`（提示用复制提示词让 AI 从模板补齐，或手动复制脚本）；找不到 Python 3；找不到 pandoc 3；
所选模板不存在或缺 `reference.docx`；`docKey` 反查不到（提示列表已变化、请刷新）。
非环回监听时接口 403，「转换」按钮置灰并说明，「复制提示词」可用。脚本超时或非零退出时返回 500，附脚本给出的原因。

#### Scenario: 没装 pandoc

- **WHEN** `/api/health` 报告 pandoc 不可用
- **THEN** 弹窗里「转换」置灰，说明「本机没有 pandoc 3，装好后重启看板」；「复制提示词」可用

#### Scenario: 工作空间目录丢失

- **WHEN** 当前工作空间 `available === false`
- **THEN** 产出列表按现有方式降级，不出现「转成 Word」
