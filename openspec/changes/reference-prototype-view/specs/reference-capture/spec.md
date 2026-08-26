## ADDED Requirements

### Requirement: 参考落在 visualization/references/

工作空间若要收参考页，MUST 使用 `visualization/references/`。
`visualization/` 是可选的视觉平面，与 `input/` `output/` 并列；识别工作空间的判据
（有 `input/` 和 `output/`）MUST NOT 因为缺 `visualization/` 而失败。
每一份参考 MUST 是 `visualization/references/<slug>/` 子目录，入口文件 MUST 叫 `index.html`。
散装的 `某页.html` 扔在 `visualization/references/` 根上，看板 MUST 扫不到。

#### Scenario: 没有 visualization/ 仍是合法工作空间
- **WHEN** 一个已登记工作空间只有 `input/` 和 `output/`，没有 `visualization/`
- **THEN** 扫描成功，参考清单为空，界面走空态，不报「目录丢失」

#### Scenario: 子目录有 index.html 才算一份参考
- **WHEN** `visualization/references/foo/index.html` 存在，同时 `visualization/references/bar.html` 直接躺在该目录根上
- **THEN** 清单里只有 `foo` 这一份，`bar.html` 不出现

### Requirement: 扫描结果经 Scan.references 下发，字段可选

`Scan` MUST 增加可选字段 `references`。形状与原型清单同类：`items`、`note`、`updatedAt`。
每条 item MUST 带 `itemKey`、`title`、可预览的 `url`；可选带 `sourceUrl`、`source`（`url-capture` / `plugin` / `manual`）、`mtime`、封面图地址。
旧服务进程不给这个字段时，前端 MUST 不白屏、不抛错。

#### Scenario: 新服务列出已有参考
- **WHEN** `visualization/references/example/index.html` 的 `<title>` 是「示例后台」，用户打开「参考&原型」的参考 tab
- **THEN** 卡片标题为「示例后台」，点击在新窗口打开看板伺服的那份 HTML

#### Scenario: 旧服务进程缺 references 字段
- **WHEN** 前端已是带参考 tab 的新构建，常驻服务还是改动前的进程，`/api/projects/:id/scan` 没有 `references`
- **THEN** 参考 tab 显示「当前看板服务还没有参考能力，重启看板服务后即可」，原型 tab 仍按现有数据工作
- **AND** 页面不白屏、控制台不因为 `scan.references` 为 `undefined` 报错

#### Scenario: 读不到 visualization/references/ 不拖垮整次扫描
- **WHEN** `visualization/references/` 存在但进程没有读权限
- **THEN** `references.items` 为空，`note` 说明读不到，扫描其余部分（资料、产出、原型）照常返回

### Requirement: 参考 tab 用卡片网格展示

参考 tab MUST 用卡片网格：16:10 预览区 + 标题 + 来源（URL 或相对路径）。
有封面图时 MUST 显示封面；没有时 MUST 用浏览器窗框占位，不得留白。
空态 MUST 说明两件事：可以在本页贴 URL 采集公开页面；也可以把自包含 HTML 放到 `visualization/references/<名字>/index.html`。
配色 MUST 只用语义令牌，预览区不上彩色装饰。

#### Scenario: 有封面的参考
- **WHEN** 某份参考目录里有封面图，扫描把它放进条目
- **THEN** 卡片预览区显示该图，下方是标题和来源 URL

#### Scenario: 没有封面的参考
- **WHEN** 一份参考只有 `index.html` 和 `meta.json`，没有封面
- **THEN** 预览区是浏览器窗框占位 + 标题首字，不出现破图图标

#### Scenario: 空态
- **WHEN** 工作空间没有可展示的参考
- **THEN** 空态标题说明还没有参考页，提示文案提到贴 URL 采集和把 HTML 放进 `visualization/references/<名字>/`

### Requirement: 用户可贴 URL 采集公开页面

参考 tab MUST 提供 URL 输入和「采集」动作。
用户点采集后，服务端 MUST 用独立子进程调用 PATH 上的 `single-file`（即 single-file-cli），把目标页存成自包含 `index.html`，连同 `meta.json` 写入 `visualization/references/<slug>/`。
slug MUST 由服务端生成，MUST NOT 接受客户端传入的相对路径。
采集接口 MUST 走 `allowMutations`：非环回监听时 MUST 返回 403。
同一工作空间同一时刻 MUST 最多一个进行中的采集任务；进行中再点采集 MUST 被拒绝并说明原因。
采集过程 MUST 能在界面上看到进行中状态；完成后 SSE 刷新清单。

#### Scenario: 采集公开页面成功
- **WHEN** 用户在参考 tab 贴一个可公开访问的 URL 并点采集，本机 PATH 上有 `single-file`
- **THEN** 任务结束后 `visualization/references/<slug>/index.html` 和 `meta.json` 存在
- **AND** `meta.json` 记着源 URL、标题、采集时间和来源 `url-capture`
- **AND** 参考清单出现新卡片，点击能打开刚采下来的页面

#### Scenario: 未安装 single-file
- **WHEN** 用户点采集，但本机 PATH 上找不到 `single-file`
- **THEN** 界面说明缺的是 `single-file`（single-file-cli），并告诉用户需要自行安装这个命令行工具
- **AND** `visualization/references/` 下不留下半成品目录

#### Scenario: 目标页抓不到
- **WHEN** URL 无法访问或 single-file 非零退出
- **THEN** 界面用工具返回的中文（或退出原因）说明失败，不写「操作失败请重试」
- **AND** 不留下缺 `index.html` 的目录

#### Scenario: 非环回禁止采集
- **WHEN** 看板以非环回地址监听，有人 POST 采集接口
- **THEN** 返回 403，工作空间里没有任何新文件

#### Scenario: 客户端不能指定写入路径
- **WHEN** 采集请求体里夹带 `../../output/docs` 一类路径字段
- **THEN** 服务端忽略该字段，只写入自己生成的 `visualization/references/<slug>/`；`output/` 不被改动

### Requirement: 接收 annotation-collect 采集包

看板 MUST 提供环回 POST 接口，接收插件打好的采集包并落进 `visualization/references/<slug>/`。
包 MUST 自带格式版本；版本高于看板认识的范围时 MUST 明确拒绝，不准解析到一半崩掉。
包至少 MUST 能提供一份可离线打开的 HTML；标题、源 URL、封面、清单为可选。
接收 MUST 走 `allowMutations`，非环回 MUST 403。
slug MUST 由服务端生成。
本接口 MUST NOT 在用户未通过插件点「投递」的情况下自己去抓任何页面。

#### Scenario: 投递成功
- **WHEN** 本机插件向环回地址 POST 一份带 `formatVersion` 和 HTML 的采集包
- **THEN** 看板把它写成 `visualization/references/<slug>/index.html`（外加收到的 meta / 封面），响应里带上落点相对路径
- **AND** 参考 tab 经 SSE 出现新卡片

#### Scenario: 未来版本的包
- **WHEN** 采集包的 `formatVersion` 高于看板认识的最大版本
- **THEN** 返回 4xx，正文说明「这个采集包版本看板还不认识」，工作空间不被写入

#### Scenario: 缺 HTML 的包
- **WHEN** 采集包没有可落成 `index.html` 的正文
- **THEN** 返回 4xx，说明缺的是整页快照，不创建空目录

#### Scenario: 非环回禁止接收
- **WHEN** 看板以非环回地址监听，有人 POST 接收接口
- **THEN** 返回 403，工作空间不被写入

### Requirement: 写入范围只限 visualization/references/

采集和接收两条写路径 MUST 只在 `visualization/references/` 下创建目录和文件。
`input/` `output/` `visualization/prototypes/`、工作空间根上的 `prototypes/`、`project.yaml` MUST NOT 被这两条路径改动。
伺服参考页的读接口 MUST 把路径过 `resolveInside()`，越界 MUST 403。

#### Scenario: 伺服路径穿越被拦
- **WHEN** 有人请求参考静态文件，相对路径含 `../output/docs/某.md`
- **THEN** 返回 403，该文档内容不被读出

#### Scenario: 采集失败不改其它目录
- **WHEN** 一次采集失败（缺二进制或目标不可达）
- **THEN** `input/` `output/` `visualization/prototypes/` 以及根上旧 `prototypes/` 的文件列表与内容与采集前一致

### Requirement: 第四个视图叫参考&原型，默认落在参考 tab

侧栏第四项文案 MUST 是「参考&原型」。
进入该视图时 MUST 看到「参考 / 原型」两个 tab；首次进入 MUST 停在「参考」。
概览进度里原来的「原型」一步 MUST 改成「参考&原型」：`visualization/references/`、`visualization/prototypes/` 或根上旧 `prototypes/` 任一有可展示项即算走过。

#### Scenario: 导航文案
- **WHEN** 用户看侧栏
- **THEN** 第四项写着「参考&原型」，不再单独叫「原型」

#### Scenario: 默认 tab
- **WHEN** 用户第一次点进「参考&原型」
- **THEN** 当前 tab 是「参考」

#### Scenario: 概览进度
- **WHEN** 工作空间还没有原型包，但 `visualization/references/` 里已有一份带 `index.html` 的参考
- **THEN** 概览「参考&原型」这一步标记为已完成
