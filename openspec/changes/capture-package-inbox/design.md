## Context

三条 change 铺完之后,看板这边已经有了:`visualization/references/<slug>/` 的条目形状、
扫描与展示、CSP 隔离的查看器(`visual-showcase-view`),以及一个拍过板的写入收口、
一套跨站来源判定(`visual-capture-engine`)。

相邻仓 annotation-collect 的**采集款 v0 已经落地**,它那边定死了两条对外契约:

- **契约 C(`packages/collect/src/format.ts`)** —— 采集包格式:
  `format: "annotation-collect.capture-package"`、`version: 1`,
  清单在 `manifest.json`、人类可读摘要在 `summary.md`,载荷分四种
  (P1 文字批注 / P2 样式改动(v0 不产)/ P3 元素片段 / P4 整页快照)。
- **契约 D(`packages/collect/src/deliver.ts`)** —— 投递:请求体是
  `{ package, triggeredAt }`,成功响应是 `{ accepted: true, location, hostItemId? }`,
  失败分 `target-unreachable` / `refused-by-host` 两类;**非回环地址在扩展侧就被拒**,
  一个字节都不发出去。

扩展的默认投递目标是 `http://127.0.0.1:7788/capture-package`,而 7788 是本仓
`bin/cli.mjs` 的 `DEFAULT_PORT`。也就是说**接收端的地址、路径、请求体、响应体全都已经定了**,
本 change 是照着一份写好的契约实现一端。

它和 `visual-capture-engine` 的分工是清楚的:那条走公开页面(headless 重抓),
这条走登录后的深层页面(扩展在页面上下文里序列化)。后者是前者做不到的 ——
理由在相邻仓的实测里:SPA 把 token 放 `localStorage`,single-file 只注入 cookies,
产物是登录页而任务显示成功。

## Goals / Non-Goals

**Goals:**

- 按契约 C / D 实现接收端,让扩展零配置就能投到看板。
- 把采集包摊平进现有的参考条目形状,不为它另开一套展示。
- 在版本不匹配时**明确拒绝**,让扩展走它的 `refused-by-host` 分支。
- 在共用的来源判定函数里加一条分支放行扩展,**不扩大**已拍板的写入范围。

**Non-Goals:**

- 不接收 P2 样式改动载荷(那边 v0 也不产)。
- 不做任何自动接收 —— 必须是用户在扩展里点投递。
- 不把采集包送进 `ingest.py`,不做二次脱敏,不改包里的内容。
- 不在界面上删除条目。
- 不实现 acgogogo 那边的接收端(那是它自己仓的事)。

## Decisions

### 1. 路径与端口照抄扩展默认值

接收端是 `POST /capture-package`,不是 `/api/projects/:id/capture-package`。

看着别扭,但**扩展的默认目标已经硬编码成这个了**。自造一个前缀,等于每个用户装完扩展
第一件事是去改配置 —— 而这个功能的全部价值就是「贴一下就进来了」。

代价是接收端不带 `projectId`,得自己决定投进哪个工作空间。**取当前登记表里
最近打开的那一个**,并把落点写进响应的 `location` 里让用户看见。
用户投错了工作空间,看响应就知道,重新在看板上切一下再投。

**备选 A:URL 上带 projectId,让扩展去配。** 不选。用户在扩展里配一串工作空间 id 是荒谬的,
而且工作空间会增删,配置立刻过期。

**备选 B:接收端问用户「投到哪个工作空间」。** 不选。扩展那边是一次性的
「点投递 → 拿到落点」,中间插一次交互要改契约 D。真需要的话是下一版的事。

### 2. 版本协商:不认识就明确拒,不猜

收到包先看两个字段:

- `format !== 'annotation-collect.capture-package'` → 400,说明这不是采集包;
- `version > 1`(己知的最高版本)→ 400,说明宿主只认到 v1,请升级看板;
- `version < 1` → 不存在(1 是首版)。

**返回非 2xx 是契约里写好的行为**:扩展拿到非 2xx 会走 `refused-by-host` 分支,
把 HTTP 状态和消息显示给用户,**并且保留批次不清空** —— 用户不会丢数据。
所以这里绝不能「尽力解析一下试试」,那才是会让人丢东西的做法。

**备选:向前兼容,高版本也试着按己知字段解析。** 不选。契约 C 明写这个字段存在的理由就是
「宿主能凭它明确拒绝或降级,而不是解析到一半崩掉」;辜负它等于让失败从一次干净的拒绝
变成一堆半截数据。

### 3. 落盘形态:目录,摊平进现有参考条目

契约 C 的注释里明说:**包的物理形态(zip 还是目录)刻意没定,等第一个宿主接入时再拍板。**
看板是第一个宿主,所以这里要定。

```
visualization/references/<slug>/
  index.html      # 包里的 page-html;没有就用第一个 fragment-html
  manifest.json   # 原样落
  summary.md      # 原样落
  meta.json       # 看板这边的元数据
```

选目录不选 zip 的理由:现有的扫描判据是「目录根上有 `index.html`」,摊成目录就
**天然被认出来、天然能点开、天然进同一个查看器**,一行展示代码都不用写。
存成 zip 则要给参考也做一套解压缓存(原型那套是为了 axhub 导出包才有的),
还要在查看器里解一层 —— 为一个能避免的形态差异多写一套机制。

`manifest.json` 和 `summary.md` 原样落进去,是因为这个包的设计目的就是
「一半读者是人、一半是 AI」:清单让 AI 知道有什么,摘要让人能读,出处让人能回去核对。
把它们扔掉,这个包就退化成「又一个存图文件夹」—— 那正是契约 C 开头警告的事。

⚠️ **一个包里可能一张页面都没有**(用户只写了文字批注)。这时 MUST 拒收(400)并说清原因,
**MUST NOT 自己造一个 `index.html`**。看板写进工作空间的每一个字节都必须是包里带来的;
一旦开始生成内容,「看板只读、写入是窄例外」这条就说不清了。

### 4. 来源放行:先实测,再写死

`visual-capture-engine` 立的规矩是「`Sec-Fetch-Site` 表明来自其它站点就拒绝」。
扩展的 background service worker 带 `host_permissions: ["http://127.0.0.1/*"]` 直接 fetch,
来源是 `chrome-extension://<id>` —— **不是同源**,按那条规矩会被一刀拒掉。

所以这条分支必须加,但**加之前要先抓一次真实的投递请求,看它到底带哪些头**
(`Origin` 是什么、`Sec-Fetch-Site` 是 `none` 还是 `cross-site`、有没有预检)。
我没跑过,不在这里写死。任务里第一条就是这个实测。

放行的形状,按实测结果二选一:

- 若请求带稳定的 `Origin: chrome-extension://<id>` → 只放行 `chrome-extension:` 协议的来源,
  **且只对 `/capture-package` 这一条路径**。其它 mutation 接口不放行。
- 若头信息不足以区分「扩展」和「任意网页」→ 那就不能靠头放行,退回到让用户在看板上
  显式打开一个「接收窗口」(限时的一次性开关)。这条更啰嗦,但不能为了省事把
  `127.0.0.1` 上的写接口对所有网页敞开。

无论哪条,`allowMutations`(非环回禁写)那道闸不动。

**备选:干脆不校验来源,反正是环回。** 不选。那正是 `visual-capture-engine` 决策 6 要堵的洞:
任意网页都能用 `enctype="text/plain"` 的表单往 `127.0.0.1` POST 出合法 JSON,不触发预检。
接收端要是敞着,等于把刚堵上的洞在旁边重新开一个。

### 5. `scrubbed: true`,但文案原样搬,不加强

扩展侧的脱敏(`packages/snapshot/src/scrub.ts`)默认开启,包里带着
`REDACTION_NOTICE`:「本包经过自动脱敏(模式匹配),必然有漏网。它不构成安全保证,
分发前请自己看一遍。」

`meta.json` 里 `scrubbed: true`,并把这句话**原样**存进去。
**不要改写成「已脱敏」「安全」这类说法** —— 那边的 spec 明确要求文案不许暗示安全,
理由是它就是模式匹配,必然有漏网。宿主这边把措辞变强,等于替它做了它拒绝做的承诺。

清单里的 `redaction` 汇总(剔了多少条、哪些类别、用户手动还原了几条)一并留在
`manifest.json` 里,不另外抄一份到 `meta.json`。

### 6. 载荷映射:只映射能落成页面的那两种

| 包里的载荷 | 落到哪 |
| --- | --- |
| P4 整页快照(`page-html`) | `index.html` |
| P3 元素片段(`fragment-html`) | 没有 P4 时,第一个片段当 `index.html`;其余留在包目录里按清单里的路径落 |
| P1 文字批注 | 不单独落文件 —— 它在 `manifest.json` 的 `note` 字段里,`summary.md` 里也有 |
| P2 样式改动 | v0 那边不产,收到就按清单原样落文件,不解释 |

截图 / `screenshots/` 这边**不产** —— 包里没有,看板也不为它另跑一次 headless。
参考卡片没有 `hero.png` 就走窗框占位,这条 `visual-showcase-view` 已经兜住了。

## Risks / Trade-offs

- **投错工作空间。** 接收端没有 projectId,靠「最近打开的那个」。
  → 落点写进响应的 `location`,扩展会显示出来;用户一眼能看出投到哪了。
- **来源放行开得太宽,变成新的 CSRF 面。** → 决策 4 的两条路都限定在这一条路径上;
  实测之前不写实现。这是本 change 最需要盯的一条。
- **包体积。** 一份带整页快照的包在几 MB 量级,和贴 URL 采下来的参考同一量级。
  → 沿用 `visual-capture-engine` 的 64 MB 上限,超了就 400 并说明。
- **扩展升级到 v2 而看板没升。** → 决策 2 的明确拒绝;用户看到「宿主只认到 v1」,
  批次保留不丢。这是设计好的路径,不是故障。
- **相邻仓 v0 之后契约还会动。** → 版本号就是为这个存在的。
  本 change 只承诺 v1,回流那句「第一个宿主定为目录形态」也写进那边的 AGENTS,
  让下一版有据可依。

## Migration Plan

- 依赖 `visual-showcase-view`(条目形状与展示)与 `visual-capture-engine`
  (写入收口、slug 生成、来源判定函数、只读红线的窄例外)都已经落地。
- 老工作空间不用改任何东西:第一次投递时 `visualization/references/` 由看板创建。
- 服务没重启:端点不存在,扩展显示「目标未运行」并保留批次,数据不丢。
- 回退:停掉新服务。已经落盘的包留在磁盘上,旧版本仍能把它们当普通参考列出来。

## Open Questions

**一条,必须实测后才能写实现:** 扩展的 background fetch 打到 `127.0.0.1` 时,
实际带的 `Origin` 与 `Sec-Fetch-Site` 是什么,有没有预检。决策 4 的两条路取哪条由它决定。
任务 1.1 就是这次实测。
