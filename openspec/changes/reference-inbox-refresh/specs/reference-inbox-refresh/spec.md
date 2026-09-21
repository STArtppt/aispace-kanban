## ADDED Requirements

### Requirement: 参考 tab 能一键把收件箱入库

参考 tab 的链接输入右侧 MUST 有一个「刷新」按钮。用户点击后，看板 MUST `spawn` 当前工作空间的 `scripts/web_ingest.py --inbox`，MUST NOT 自己写、移动或删除工作空间里的任何文件。

请求 MUST NOT 携带路径、文件名或 URL。参数由服务端写死为 `--inbox`。

接口形状与资料转换同构：`POST` 立刻返回任务，`GET` 轮询进度；一个工作空间同一时刻 MUST 至多一个收件箱任务，重复点击 MUST 返回 409。

#### Scenario: 点刷新入库一份散装页面

- **WHEN** `visualization/references/` 根上有一份散装 `.html`，用户在参考 tab 点「刷新」
- **THEN** `POST /api/projects/:id/web-ingest` 返回 `status: running`
- **AND** 任务结束后该文件变成一份可点开的参考卡片（子目录 + `index.html`）
- **AND** `input/converted/` 下出现对应的 Markdown，能在输入资料视图打开

#### Scenario: 请求不带路径

- **WHEN** 检查 `POST /api/projects/:id/web-ingest` 的请求体
- **THEN** 不包含任何路径、文件名或 URL 字段
- **AND** 服务端启动脚本的参数固定为 `--inbox`

#### Scenario: 进行中再点

- **WHEN** 该工作空间已有一轮收件箱任务 `status: running`
- **THEN** 再次 `POST` 返回 409，文案说明正在入库、等这轮结束
- **AND** 已在跑的那一轮不被取消

### Requirement: 没有脚本或旧进程时按钮不出现

`References.canInbox` MUST 为可选字段。工作空间根上存在 `scripts/web_ingest.py` 时服务端 MUST 设为 `true`；不存在时 MUST 设为 `false`。前端缺这个字段时 MUST 不渲染刷新按钮，退回改动前的参考 tab。

工作空间不可用（目录丢失等）时，刷新接口 MUST 返回 4xx 且不启动脚本。

#### Scenario: 旧服务进程

- **WHEN** 前端跑着新界面、服务进程还是改动前的版本
- **THEN** `scan.references` 没有 `canInbox`
- **AND** 参考 tab 不显示刷新按钮，贴 URL 采集与清单不受影响

#### Scenario: 自己 mkdir 的工作空间

- **WHEN** 工作空间里没有 `scripts/web_ingest.py`
- **THEN** `canInbox` 为 `false`，按钮不出现
- **AND** 若仍调用 `POST /api/projects/:id/web-ingest`，返回 400，文案说明这个工作空间没有网页入库脚本

#### Scenario: 目录丢失

- **WHEN** 工作空间目录已经找不到
- **THEN** `POST /api/projects/:id/web-ingest` 返回 4xx
- **AND** 服务端不 spawn 任何进程

### Requirement: 根上的散装页面算待入库

扫描 `visualization/references/` 时，根上的散装 `.html` / `.htm` MUST 计入 `References.pending`（可选数字）。它们 MUST NOT 出现在 `items` 里——判定一份参考的条件仍然只有「子目录根上有 `index.html`」。

`pending > 0` 时参考 tab MUST 用需要注意的样式提示份数，并指向刷新按钮。字段缺省（旧服务进程）时 MUST 不提示。

#### Scenario: 根上有散装文件

- **WHEN** `visualization/references/` 根上有 2 份 `.html`，另有一份合格的参考目录
- **THEN** `items.length` 为 1
- **AND** `pending` 为 2
- **AND** 参考 tab 提示有 2 份散装页面未入库

#### Scenario: 没有散装文件

- **WHEN** `visualization/references/` 下只有合格的参考目录
- **THEN** `pending` 为 0
- **AND** 不出现待入库提示

#### Scenario: 旧服务进程没有 pending

- **WHEN** `scan.references` 没有 `pending` 字段
- **THEN** 参考 tab 不显示待入库提示，清单照常渲染

### Requirement: 非环回监听禁写，跨站请求拒绝

收件箱刷新 MUST 走与资料转换、原型刷新同一套写入口闸：非环回监听时接口 MUST 403；跨站请求 MUST 拒绝。只读的参考清单与 SSE 不受影响。

#### Scenario: 非环回监听

- **WHEN** 服务以非环回 `--host` 启动
- **THEN** `POST /api/projects/:id/web-ingest` 返回 403
- **AND** 参考 tab 不显示刷新按钮

#### Scenario: 跨站请求

- **WHEN** 浏览器里别的网站向该接口发 POST
- **THEN** 请求被拒绝，工作空间内没有任何文件被改动

### Requirement: 任务结果说清做了什么

任务结束后，界面 MUST 展示脚本汇报的结果：成功用中性底色，失败用需要注意的样式，文案 MUST 是服务端/脚本给出的原文，MUST NOT 改写成「操作失败请重试」。

落盘 MUST 由 `visualization/` 与 `input/` 的 SSE 捕获，参考卡片与输入资料树自己更新，前端 MUST NOT 再拉一份旁路清单。

#### Scenario: 成功

- **WHEN** 脚本以退出码 0 结束
- **THEN** 参考 tab 用中性提示显示脚本的摘要（收了几份、抽了几份、跳过几份）
- **AND** 新卡片出现在参考清单里

#### Scenario: 缺 defuddle

- **WHEN** 本机 PATH 上没有 `defuddle`，用户点刷新
- **THEN** 任务以失败结束，提示里含安装命令 `npm install -g defuddle`
- **AND** `visualization/references/` 与 `input/converted/` 都没有半截产物

#### Scenario: 没有 Python

- **WHEN** 本机找不到 Python 3
- **THEN** 接口返回 400，文案说明转换脚本要靠 Python 3，并指出 Windows 用 py 或 python、其它系统用 python3
