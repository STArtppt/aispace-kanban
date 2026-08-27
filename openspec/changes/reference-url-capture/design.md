## Context

`reference-prototype-view` 已经把 `visualization/references/` 立成工作空间里的可选目录，
看板能扫、能展示、能伺服（并用 CSP `sandbox` 把这些页面关进不透明源）。
缺的是「怎么让页面进到这个目录里」。

相邻仓已经趟过这条路：公开页面用独立子进程 `spawn('single-file', …)` 抓自包含 HTML
（AGPL-3.0 边界：不 import 源码）；登录后的 SPA 这条路会静默失败
（token 在 `localStorage`，注入 cookie 不够），所以那边另做了浏览器扩展，
在页面自己的上下文里序列化再经回环 POST 投递给宿主。

本 change 只做第一条：**公开页面、用户贴 URL**。第二条（接收插件的采集包）等
那边的契约落定后单独立 —— 它复用本 change 的写入收口，不需要再动一次红线。

## Goals / Non-Goals

**Goals:**

- 用户在参考 tab 贴一个公开 URL，点采集，页面落进 `visualization/references/<slug>/index.html`。
- 把「看板可以写 `visualization/references/`」写成一条窄例外，写进 `AGENTS.md` 不变量。
- 写入收口到一个模块，越界在 code review 时能一眼看出来。
- 顺手补上跨站校验，把「环回 ≠ 可信」这个既有窟窿堵掉。

**Non-Goals:**

- 不做登录态采集、不注入 cookie、不引 Playwright、不做截图与预览视频。
- 不接收 annotation-collect 的采集包（下一个 change）。
- 不在界面上删除参考。
- 不把参考送进 `ingest.py`。
- 不做脱敏 —— 只在 `meta.json` 里标注「没脱敏」，见决策 5。

## Decisions

### 1. 只 spawn `single-file`，找不到就明说，不做降级

跟相邻仓同一条 AGPL 边界：`spawn('single-file', args)`，**永不 `import`**，
也不写进 npm `dependencies`（`scripts/build-npm-package.mjs` 按 import 图重算依赖，
写进去会把 AGPL 传染进看板包）。

`single-file` 不在 PATH 上是**绝大多数用户的默认状态** —— 它要全局装。
所以「没装」不是边角错误路径，是主路径之一：错误文案 MUST 直接给出安装命令，
README 和 `templates/help.md` 也要写。只丢一句「请自行安装」等于没做。

**备选 A：引 Playwright 做降级。** 不选。体积、平台安装、常驻进程里再养一套浏览器，
都超过这个功能该付的成本。
**备选 B：用 Node 自己抓 HTML 再内联资源。** 不选。要正确处理 CSS `url()`、
`srcset`、`@import`、字体、跨域，等于重写一遍 single-file，还写不好。
**备选 C：让用户先去别的工具采完再拷过来。** 不选 —— 那正是本 change 要消灭的步骤。

### 2. 写入收口到一个模块，只认服务端生成的 slug

所有落盘走 `references.mjs` 里唯一一个写入函数，它 MUST 先
`resolveInside(root, 'visualization/references/' + slug)`，再在其下 `mkdir` / `writeFile`。
slug 由服务端从标题或 URL 生成并做安全化，**不接受任何客户端传入的路径片段**。
请求体里就算夹带 `../../output/docs` 一类字段也一律忽略。

`resolveInside` 现在是 `src/server/http.mjs` 的模块内私有函数（`http.mjs:91`）。
把它提到一个小模块（如 `src/server/paths.mjs`），`http.mjs` 和 `references.mjs` 都从那里引 ——
**不要复制一份**。它是不变量 2 的载体，复制出来的第二份迟早会漂。

**备选：继续只 spawn 工作空间自己的脚本（照 ingest 的模式）。** 不选。
`single-file` 是主机上的工具，不是工作空间模板里的脚本；再套一层 `scripts/capture.py`
只会让每个老工作空间都缺这个脚本。

**备选：采集写看板缓存，只把一份指针写进工作空间。** 不选。
指针对 AI 没用，拷贝工作空间会丢参考本体。

### 3. 环回不等于可信 —— 补 `Sec-Fetch-Site` / `Origin` 校验

服务端没有 token，`readBody`（`http.mjs:79`）连 Content-Type 都不看。
浏览器里任意一个网页都能用 `enctype="text/plain"` 的表单往 `127.0.0.1:<端口>` POST，
body 拼成合法 JSON 就能被收下 —— 不触发预检，`allowMutations` 那条闸拦不住它。

所以所有会写盘 / 起子进程的接口 MUST 额外校验：`Sec-Fetch-Site` 存在且不是
`same-origin` / `none` 时拒绝；没有这个头但 `Origin` 与本机服务不符时也拒绝。
这条**同时覆盖现有的** ingest、忽略、新建工作空间、移出看板 —— 它们暴露在同一个问题上，
只是过去写盘的是工作空间脚本、危害小一档。

**备选：给接口加 token，URL 里带。** 不选（这一版）。要改 CLI 输出、要改前端所有请求、
要处理用户手工开页面的场景。头校验是一行判断，先把主要面堵上；
真要做认证是另一个 change。

### 4. 采集任务表仿 ingest，v0 不推日志流

同一工作空间同一时刻最多一个进行中的采集（再点被拒并说明原因）。
前端只需要三态：进行中 / 成功 / 失败原因。**不接 SSE 日志流** ——
`single-file` 的 stderr 对用户几乎不可读，推给他也只是噪音。
落盘完成后靠 `visualization/references/` 的 SSE 刷新清单。

子进程超时 **120 秒**，超时杀掉并按失败处理。
产物超过 **64 MB** 判失败（单页自包含 HTML 正常在几 MB 量级；到 64 MB 说明抓到了
不该抓的东西，写进去只会拖垮之后每一次扫描）。

临时文件写在目标 slug 目录**之外**，成功再整体移入；失败或超时就删干净，
MUST NOT 留下缺 `index.html` 的半成品目录 —— 那种目录会让扫描列出一张点不开的卡片。

### 5. `meta.json` 记 `scrubbed: false`，但不承诺任何脱敏

采集没有脱敏管线：抓到什么就是什么，页面上的原文会原样落进工作空间。
`meta.json` 里恒写 `scrubbed: false`，作用只有一个 —— 让读到这份参考的 AI
知道这页可能带着页面上的原始内容。**它不是安全保证**，也不代表将来会有 `true`。

界面上要说清同一件事：采集的是「当时那个页面的全部内容」，
别对着不该落盘的页面点采集。

**备选：不记这个字段。** 不选。字段成本为零，缺了以后想加就要动已落盘的数据形状。

### 6. 同一 URL 再采一次 → 新 slug，不覆盖

参考的价值是「当时看到的页面」。第二次采集同一个 URL 时 MUST 生成新的 slug
（如 `<slug>-2`），MUST NOT 覆盖已有目录。用户想删旧的就去文件系统删 ——
看板不提供删除（那需要 `unlink` 权限，超出本次拍板的范围）。

**备选：覆盖同名目录。** 不选。覆盖是破坏性操作，而且要求看板有删文件的权限，
比「只新建」危险得多。

## Risks / Trade-offs

- **只读红线被开一个口，以后容易被顺手加宽。**
  → 写入收口到一个模块；`AGENTS.md` 写明「只写 `visualization/references/`、必须用户发起、必须环回」；
  code review 时看到别的目录的 `writeFile` 就按 bug 拦。
- **single-file 抓到的是登录页 / 同意条款页，任务却显示成功。** 这是已知坑，检测不了。
  → 文案写清「只适合不用登录就能看的页面；需要登录的系统请用采集插件」，
  并且采完让用户自己点开确认。不在看板里做登录态检测（那会把 Playwright 引进来）。
- **绝大多数用户没装 single-file，第一次点采集就失败。**
  → 错误文案直接给安装命令；README / help 写明。见决策 1。
- **采下来的页面自带脚本，在看板里被打开。**
  → 已由 `reference-prototype-view` 的 CSP `sandbox` 兜住（不给 `allow-same-origin`）。
  本 change **依赖那一条已经落地**；先做采集后做隔离是不可接受的顺序。
- **AGPL 边界稍有不慎就进包。** → 禁止 import；组包脚本扫的是 import 图，
  spawn 字符串不会把 single-file 打进 tgz。注释和文档写明这条。

## Migration Plan

- 依赖 `reference-prototype-view` 已经落地（`visualization/references/` 目录约定、扫描、伺服、CSP 隔离）。
- 老工作空间不用搬任何东西：第一次采集时 `visualization/references/` 由看板创建（这是被拍板允许的写入）。
- 前端先上、服务没重启：采集接口 404，按钮禁用并说明要重启，参考清单照常。
- 回退：停掉新服务、换回旧前端。已经采下来的文件留在磁盘上，
  旧版本仍能把它们当普通参考列出来（那部分是只读能力），不会删。

## Open Questions

无。超时 / 体积上限 / `scrubbed` / 日志流 / 重复采集，五处都在上面定死了；
实施时若真实产物体积明显偏离 64 MB 的假设，改这一个常量并在这里记一笔。
