## ADDED Requirements

### Requirement: 认出原型工作区同步过来的镜像目录

看板 SHALL 把 `visualization/prototypes/<slug>/` 下含 `SYNC.md` 的目录认作一份「已接入」原型，
并在该条目上下发可选字段 `linked`。聚合过程 MUST 只读，不写、不删、不重命名工作空间里的任何文件。

#### Scenario: 同步过的原型聚合成一个条目
- **WHEN** `visualization/prototypes/` 下有 `demo/SYNC.md`、`demo/meta.json`（`kind: "url"`）和 `demo-html.zip`
- **THEN** `curl /api/projects/<id>/prototypes` 返回的 `demo` 条目带 `linked`，其中 `linked.offline.url` 指向 zip 的伺服入口、`linked.online.target` 等于 `meta.json.target`
- **AND** `demo-html` 条目带 `groupedInto: "demo"`

#### Scenario: 没有 SYNC.md 的目录保持原样
- **WHEN** 工作空间里没有任何 `SYNC.md`
- **THEN** 接口返回的条目与改动前逐字段一致，不出现 `linked` 或 `groupedInto`

#### Scenario: 已接入但从未发布
- **WHEN** 镜像目录有 `SYNC.md` 但没有 `meta.json`
- **THEN** 条目仍带 `linked`，`linked.online` 缺省；界面上不出现「打开在线版」按钮，在线版一格显示「未发布」

### Requirement: 同步状态显式化

`linked.sync` SHALL 从 `SYNC.md` 表格读出源提交、本地最近改动、同步时间，从 `meta.json` 读出发布时间。
只有「本地最近改动」与 `publishedAt` 都是合法时间、且前者更晚时，才 SHALL 下发 `onlineStale: true`。
`离线 HTML 包` 一行含「本次未更新」时 SHALL 下发 `offlineStale: true`。

#### Scenario: 在线版落后
- **WHEN** `SYNC.md` 的本地最近改动为 9 月 14 日，`meta.json.publishedAt` 为 9 月 4 日
- **THEN** 原型行的在线版一格用 orange 显示「落后本地改动 10 天」，并在行底给出「到 Make 里重新发布，再跑一次同步」

#### Scenario: 离线包导出失败
- **WHEN** `SYNC.md` 的离线 HTML 包一行写着「为旧包，本次未更新」
- **THEN** 离线包一格用 orange 显示「本次同步没更新，仍是旧包」，打开离线包按钮仍可用

#### Scenario: SYNC.md 解析不出
- **WHEN** `SYNC.md` 被手工改乱，读不出任何一行
- **THEN** 聚合和资料列表照常，三格状态显示「—」，不出现 orange

### Requirement: 资料可点开阅读

`linked.docs` SHALL 列出镜像目录下 `spec/` `docs/` `annotations/` `comments/` 里的 `.md` 与 `SYNC.md`，
每项带工作空间相对路径、分组和显示名。点击 SHALL 用看板现有的阅读器打开，走现有 `/file` 接口。

#### Scenario: 点开页面级规格
- **WHEN** 用户在原型行的「规格」组点某个页面
- **THEN** 右侧阅读器打开 `visualization/prototypes/<slug>/spec/pages/<页面>/….md` 并渲染 Markdown

#### Scenario: 空分组
- **WHEN** 镜像目录没有 `comments/`
- **THEN** 「批注」分组显示计数 0 且不可点

### Requirement: 重复卡片合并但不代删

看板 SHALL 把重复的手工录入卡片并入已接入原型，且 MUST NOT 删除或改写这些目录：
不带 `SYNC.md` 的 url 形态条目，其链接规范化（只取 origin + pathname，丢掉 hash 与查询串）后与某份已接入原型的在线版相同时，
带 `groupedInto`，并出现在该原型的 `linked.duplicates` 里。

#### Scenario: 手工录入与同步指向同一链接
- **WHEN** `old-card/meta.json.target` 为 `https://host/p/demo/index.html#page=home`，`demo/meta.json.target` 为 `https://host/p/demo/index.html`
- **THEN** 原型 tab 只出现一行 `demo`，行底写明「已并入手工录入的卡片 old-card/，不再需要的话在文件系统里删掉，看板不代删」
- **AND** `old-card/` 目录仍在磁盘上

### Requirement: 原型 tab 分段展示并兼容旧进程

原型 tab SHALL 把带 `linked` 的条目放在「已接入原型工作区」段、一行一份；其余不带 `groupedInto` 的条目放在「其他原型」段、沿用现有卡片网格。tab 计数 SHALL 不计 `groupedInto` 条目。

#### Scenario: 旧服务进程配新前端
- **WHEN** 服务端是改动前的进程，不下发 `linked` / `groupedInto`
- **THEN** 原型 tab 只有卡片网格、不出现分段标题，展示与改动前一致，不报错

#### Scenario: 新服务进程配旧前端
- **WHEN** 前端是改动前的构建
- **THEN** 原型 tab 展示与改动前一致（zip 与重复卡片照旧出现）

#### Scenario: 同步脚本写完后自动刷新
- **WHEN** 看板开着原型 tab，原型工作区跑完一次同步
- **THEN** 不手动刷新，原型行的同步时间更新
