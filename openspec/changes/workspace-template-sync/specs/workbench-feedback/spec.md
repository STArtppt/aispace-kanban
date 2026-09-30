## MODIFIED Requirements

### Requirement: 反馈单的文件契约

工作空间模板 SHALL 在 `output/feedback/README.md` 定义反馈单契约：一份反馈一个 `F<四位编号>.md`，编号只增不复用。

front-matter 扁平，至少有 `id` `title` `status` `created` `receipt` `sent_at`。
另有可选的 `kind`：`bug`（缺陷单）或 `contribution`（贡献单），缺省为 `bug`。

正文按类型分两套内容节，都另有一节「## 发送记录」：
- 缺陷单：现象、期望、最小复现、疑似源码位置、建议改法、临时绕法；
- 贡献单：贡献了什么、为什么能推广、合成示例、涉及的模板文件、改动内容、实例里的对应。

写区划分：
- AI 写区：`id` `title` `kind` `created` `status`（`pending` / `fixed` / `wontfix`）`receipt` 和内容节；
- 人写区：`sent_at` 和「## 发送记录」下的子节。

最小复现、合成示例、改动内容 MUST 是合成的或已脱敏的内容。

#### Scenario: 新建工作空间

- **WHEN** 用 `templates/pm-aispace` 新建一个工作空间
- **THEN** `<工作空间根>/output/feedback/README.md` 存在，写明两种类型的节，工作空间 `AGENTS.md` 的反馈单一节指向这个目录，不再提 `.kanban-feedback/`

#### Scenario: 旧目录迁移

- **WHEN** 工作空间智能体在一个旧工作空间里看到 `.kanban-feedback/` 下有反馈单
- **THEN** 它按模板 `AGENTS.md` 的步骤，按日期顺序迁成 `output/feedback/F<编号>.md`，状态和回执照搬，迁完删掉旧目录

#### Scenario: 旧单没有 kind

- **WHEN** 一份在本变更之前写的反馈单没有 `kind` 字段
- **THEN** 它按缺陷单处理，文件不需要改

### Requirement: 服务端提供反馈单索引与详情

服务端 SHALL 提供两个接口：
- `GET /api/projects/:id/feedback`（索引）：返回编号、标题、`kind`、状态、`sent_at`、创建日期、回执，以及旧目录 `.kanban-feedback/` 里 `.md` 的份数 `legacyCount`；
- `GET /api/projects/:id/feedback/:fid`（详情）：返回按节拆好的正文和发送记录。节的顺序按 `kind` 对应的那一套，未知节排在后面。

`kind` 缺省报 `bug`；写成其它值时原样返回，由界面归入「未识别」。
`:fid` MUST 匹配 `^F\d{4}$`，否则 400；路径 MUST 过 `resolveInside()`。这两个接口只读，非环回监听时照常可用。

#### Scenario: 目录不存在

- **WHEN** 工作空间里没有 `output/feedback/`
- **THEN** `curl -s localhost:7788/api/projects/<id>/feedback` 返回空列表，状态码 200

#### Scenario: 非法编号

- **WHEN** 请求 `GET /api/projects/<id>/feedback/..%2Fproject.yaml`
- **THEN** 返回 400，不读取任何文件

#### Scenario: 状态写歪

- **WHEN** 某份反馈单写的是 `status: 处理中`
- **THEN** 它出现在索引里，界面归入「未识别」组，并显示原文「处理中」

#### Scenario: 贡献单的节顺序

- **WHEN** 请求一份 `kind: contribution` 的反馈单详情
- **THEN** `sections` 依次是「贡献了什么」「为什么能推广」「合成示例」「涉及的模板文件」「改动内容」「实例里的对应」

### Requirement: 反馈单页与问题单、记录单同构

工作台反馈单页 SHALL 采用与问题单、记录单相同的布局。

左侧列表：
- 按「待发送 / 已发送 / 已修复 / 不修 / 未识别」分组，组可以折叠，待发送默认展开；
- 每一项显示类型标签「缺陷」或「贡献」。

右侧详情卡：
- 显示编号、标题、类型、状态、创建日期、最近发送时间、回执、该类型的内容节和发送记录；
- 正文用现有 `Markdown` 组件渲染。

分组规则：
- 由 `status` 和 `sent_at` 推出：`pending` 且 `sent_at` 为空 → 待发送；`pending` 且 `sent_at` 有值 → 已发送；
- `kind` 写成 `bug` / `contribution` 以外的值时，归入「未识别」。

#### Scenario: 查看一份反馈单

- **WHEN** 用户在「待发送」组里点 `F0003`
- **THEN** 右侧显示它的各节内容，「疑似源码位置」里的 GitHub 链接可以点开

#### Scenario: 查看一份贡献单

- **WHEN** 用户点一份 `kind: contribution` 的 `F0005`
- **THEN** 列表项带「贡献」标签，右侧按贡献单的六节显示，「改动内容」里的 diff 以代码块显示

#### Scenario: 旧服务不报 kind

- **WHEN** 前端已更新，服务进程还是旧版，索引里没有 `kind`
- **THEN** 所有反馈单按「缺陷」显示，页面正常

### Requirement: 邮件发送反馈单

详情卡 SHALL 提供「邮件发送」。点击后先弹出预览，内容如下：
- 收件人：`aispace_kanban@163.com`；
- 标题：缺陷单为 `[aispace-kanban 反馈] <编号> <标题>`，贡献单为 `[aispace-kanban 贡献] <编号> <标题>`；
- 正文：该类型的内容节 + 看板版本号；
- 一句提示：「反馈单可能被带进公开仓库，发之前确认没有真实资料」。

用户确认后，看板 SHALL 用 `mailto:` 唤起本机邮件客户端；看板自身 MUST NOT 发出任何网络请求。
URL 编码后超过约 1800 字符时，正文 SHALL 换成一句「正文已复制到剪贴板，请粘贴」，并把全文写入剪贴板。
预览里 SHALL 同时提供「复制收件人 / 标题 / 正文」，给没有邮件客户端的用户用。

#### Scenario: 正常发送

- **WHEN** 用户在预览里点「打开邮件客户端」
- **THEN** 系统邮件客户端打开一封新邮件，收件人、标题、正文已经填好；这时工作空间里没有任何文件变化

#### Scenario: 正文过长

- **WHEN** 某份反馈单的建议改法里有一段很长的 diff
- **THEN** 预览说明「正文较长，已改为复制到剪贴板」，唤起的邮件里正文是那句提示，剪贴板里是全文

#### Scenario: 发送贡献单

- **WHEN** 用户对一份贡献单点「邮件发送」
- **THEN** 预览里的标题以 `[aispace-kanban 贡献]` 开头，正文是贡献单的六节
