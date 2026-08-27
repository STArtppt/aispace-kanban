## ADDED Requirements

### Requirement: 参考落在 visualization/references/

工作空间若要收参考页，MUST 使用 `visualization/references/`。
`visualization/` 是可选的视觉平面，与 `input/` `output/` 的文档平面并列；识别工作空间的判据
（有 `input/` 和 `output/`）MUST NOT 因为缺 `visualization/` 而失败。
每一份参考 MUST 是 `visualization/references/<slug>/` 子目录，入口文件 MUST 叫 `index.html`。
散装的 `某页.html` 扔在 `visualization/references/` 根上，看板 MUST 扫不到。
本能力 MUST NOT 往工作空间写入任何文件。

#### Scenario: 没有 visualization/ 仍是合法工作空间
- **WHEN** 一个已登记工作空间只有 `input/` 和 `output/`，没有 `visualization/`
- **THEN** 扫描成功，参考清单为空，界面走空态，不报「目录丢失」

#### Scenario: 子目录有 index.html 才算一份参考
- **WHEN** `visualization/references/foo/index.html` 存在，
  同时 `visualization/references/bar.html` 直接躺在该目录根上
- **THEN** 清单里只有 `foo` 这一份，`bar.html` 不出现

#### Scenario: 参考不出现在原型 tab
- **WHEN** `visualization/references/foo/index.html` 存在，`visualization/prototypes/` 为空
- **THEN** 参考 tab 有一张卡片，原型 tab 走空态

### Requirement: 扫描结果经 Scan.references 下发，字段可选

`Scan` MUST 增加可选字段 `references`，形状与原型清单同类：`items`、`note`、`updatedAt`。
每条 item MUST 带 `itemKey`、`title`、可预览的 `url`；可选带 `sourceUrl`、
`source`（`manual` / `url-capture` / `plugin`）、`mtime`、封面图地址。
工作空间没有 `visualization/` 时，新服务进程 MUST 仍然返回这个字段（空结构），
好让前端区分「没有参考」和「旧进程没有这个字段」。
旧服务进程不给这个字段时，前端 MUST 不白屏、不抛错。

#### Scenario: 新服务列出已有参考
- **WHEN** `visualization/references/example/index.html` 的 `<title>` 是「示例后台」，
  用户打开参考 tab
- **THEN** 卡片标题为「示例后台」，点击在新窗口打开看板伺服的那份 HTML

#### Scenario: 旧服务进程缺 references 字段
- **WHEN** 前端已是带参考 tab 的新构建，常驻服务还是改动前的进程，
  `/api/projects/:id/scan` 没有 `references`
- **THEN** 参考 tab 显示「当前看板服务还没有参考能力，重启看板服务后即可」，
  原型 tab 仍按现有数据工作
- **AND** 页面不白屏、控制台不因为 `scan.references` 为 `undefined` 报错

#### Scenario: 读不到 visualization/references/ 不拖垮整次扫描
- **WHEN** `visualization/references/` 存在但进程没有读权限
- **THEN** `references.items` 为空，`note` 说明读不到，
  扫描其余部分（资料、产出、原型）照常返回

### Requirement: 伺服的参考页必须落进不透明源

看板伺服 `visualization/references/<slug>/` 下的文件 MUST 走独立路径
（`/api/projects/:id/ref/:slug/…`），路径 MUST 过 `resolveInside()`，越界 MUST 403。
HTML 响应 MUST 带 `Content-Security-Policy: sandbox`（允许脚本 / 表单 / 弹窗，
但不给 `allow-same-origin`），使该页面无法访问看板的同源接口、cookie 与 `localStorage`。
原型伺服路径 MUST 同样带这个头。

#### Scenario: 参考页拿不到看板接口
- **WHEN** 用户在新窗口打开一份参考，页面里的脚本请求 `/api/projects`
- **THEN** 该请求被浏览器按跨源拒绝，拿不到工作空间列表

#### Scenario: 路径穿越被拦
- **WHEN** 有人请求参考静态文件，相对路径含 `../../output/docs/某.md`
- **THEN** 返回 403，该文档内容不被读出

#### Scenario: 原型伺服同样受隔离
- **WHEN** 用户在新窗口打开一份原型包
- **THEN** 响应同样带 sandbox 头，页面正常渲染，但拿不到看板接口

### Requirement: 参考 tab 用卡片网格展示

参考 tab MUST 用卡片网格：16:10 预览区 + 标题 + 来源（URL 或相对路径）。
有封面图时 MUST 显示封面；没有时 MUST 用浏览器窗框占位，不得留白、不得出现破图。
空态 MUST 说清放法：把自包含 HTML 放到 `visualization/references/<名字>/index.html`，
一份参考一个目录。
配色 MUST 只用语义令牌，预览区不上彩色装饰。

#### Scenario: 没有封面的参考
- **WHEN** 一份参考只有 `index.html`，没有封面
- **THEN** 预览区是浏览器窗框占位 + 标题首字，不出现破图图标

#### Scenario: 空态
- **WHEN** 工作空间没有可展示的参考
- **THEN** 空态说明还没有参考页，并写明放到 `visualization/references/<名字>/index.html`

### Requirement: 后来才创建的目录也要能推 SSE

看板 MUST 对启动时还不存在、之后才被创建的 `visualization/` 同样推送 SSE：
该目录（含两个子目录）内容变化时界面自动刷新，MUST NOT 要求用户重启服务。
这条覆盖用户手工把旧 `prototypes/` 搬进 `visualization/` 的那一刻。

#### Scenario: 启动后才建 visualization/
- **WHEN** 服务启动时工作空间没有 `visualization/`；用户随后创建该目录并放入
  `visualization/references/foo/index.html`
- **THEN** 界面不手动刷新也出现「foo」这张卡片

#### Scenario: 搬完原型立刻可见
- **WHEN** 用户对一个原型还在根上 `prototypes/` 的工作空间执行
  `mkdir -p visualization && mv prototypes visualization/prototypes`
- **THEN** 界面不手动刷新，原型 tab 就列出这些包，迁移提示消失
