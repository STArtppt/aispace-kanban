## Context

`visual-showcase-view` 已经把 `visualization/` 立成工作空间里的可选视觉平面,看板能扫、
能展示、能伺服(并用 CSP `sandbox` 把这些页面关进不透明源),还定死了两种条目的目录形状:

```
visualization/references/<slug>/   index.html + screenshots/{hero,full,mobile}.png + meta.json
visualization/prototypes/<slug>/   index.html(bundle)  |  cover.png + meta.json(url)
```

缺的是「怎么让东西进到这两个目录里」。

相邻仓 acgogogo 已经趟过这条路:`daemon/capture/index.ts`(2072 行)用独立子进程
`spawn('single-file', …)` 抓自包含 HTML(AGPL 边界:不 import 源码),用 Playwright 出
三档截图,并且记着一堆踩坑经验 —— 尤其**「登录后的 SPA 会静默失败」**:token 在
`localStorage` 而 single-file 只注入 cookies,产物是登录页,任务却显示成功,
它为此叠了 storageState 注入、登录页检测、自动重走入口三层补丁,仍然只是降级。

所以采集分成两条路,本 change 只做第一条:**公开页面、用户贴 URL**。
登录后的深层页面走浏览器扩展(annotation-collect 的采集款,v0 已落地),
在页面自己的上下文里序列化再经回环 POST 投递给宿主 —— 那条在 `capture-package-inbox`,
它复用本 change 的写入收口,不需要再动一次红线。

## Goals / Non-Goals

**Goals:**

- 用户在参考 tab 贴一个公开 URL,页面 + 三张截图 + 元数据落进 `visualization/references/<slug>/`。
- 用户在原型 tab 贴一条云端发布链接,封面 + 元数据落进 `visualization/prototypes/<slug>/`。
- 把「看板可以写 `visualization/` 之下」写成一条窄例外,写进 `AGENTS.md` 不变量。
- 写入收口到一处,越界在 code review 时能一眼看出来。
- 顺手补上跨站校验,把「环回 ≠ 可信」这个既有窟窿堵掉。

**Non-Goals:**

- 不做登录态采集、不注入 cookie / storageState、不做登录页检测。
- 不录预览视频、不做多状态截图、不提品牌令牌 —— 那三条是相邻仓的分析线,不搬。
- 不接收 annotation-collect 的采集包(下一个 change)。
- 不在界面上删除条目、不覆盖已有目录。
- 不把参考送进 `ingest.py`。
- 不做脱敏 —— 只在 `meta.json` 里标注「没脱敏」,见决策 7。

## Decisions

### 1. 两个入口共用一个引擎、一个收口、一次拍板

参考采集和原型 URL 导入看起来是两件事,底下是同一套:一个 headless 浏览器、
一个 slug 生成、一个 `resolveInside` 收口、一张任务表、一次只读红线的拍板。
分成两个 change 做,地基要砌两遍,红线要拍两次。

区别只在**产物档位**:

| | 参考 | 原型(url 形态) |
| --- | --- | --- |
| `index.html` | 要(single-file) | **不要** |
| 截图 | hero / full / mobile 三张 | 只要一张封面 `cover.png` |
| `meta.json` | `source: url-capture`,`scrubbed: false` | `kind: "url"`,`target` |

原型不抓页面本体:云端发布的原型是 SPA,single-file 抓下来既失真又没意义 ——
用户点它就是要开那个原站。

### 2. 三张截图分档照搬相邻仓

```
hero.png    1920×1080 视口,只截首屏      —— 「标准桌面屏的第一眼」
full.png    1280 宽,fullPage 长图         —— 「这一页到底有什么」
mobile.png  390×844,fullPage             —— 「移动端长什么样」
```

`full.png` 用 1280 宽而不是 1920:1920 宽的整页长图动辄几十 MB,而「完整页面」要看的是
信息结构不是像素。这三档是相邻仓 `HERO_VIEWPORT` / `FULL_VIEWPORT` / `MOBILE_VIEWPORT`
的原值,已经在真实站点上跑过。

**一处故意的偏离:mobile 不做响应式探测。** 相邻仓只在检测到 viewport meta + 媒体查询时
才截 mobile(为了省时间)。我们把三张图当承诺:不响应式的页面截出来是「它在手机上就是这样」,
本身就是有用的信息,还省掉一段会误判的探测代码。

每一档单独 try:某一档失败只丢那一档,已经截好的不受影响,任务不因此判失败。

### 3. Playwright 运行时探测,不进 dependencies

看板是 `npx aispace-kanban` 起的轻量工具。把 `playwright` 写进 `dependencies`,
每个用户装看板都要拖一个 Chromium —— 为一个可选功能付这个价钱不合理。

所以:**动态 `import('playwright')`,失败即降级。**

| 缺什么 | 参考采集 | 原型 URL 导入 |
| --- | --- | --- |
| 缺 `playwright` | 仍产出 `index.html` + `meta.json`,**任务成功但标记降级**,说明缺截图与怎么装 | **任务成功**,只写 `meta.json`,卡片用窗框占位 |
| 缺 `single-file` | **任务失败**(参考的本体就是它) | 不受影响(本来就不用) |

降级理由要写进 `meta.json`(如 `degraded: ["screenshots"]`)和界面,不能只在日志里。
`single-file` 同理:AGPL-3.0,`spawn` 调用、**永不 import**、不写进 `dependencies`
(`scripts/build-npm-package.mjs` 按 import 图重算依赖,写进去会把 AGPL 传染进看板包)。

**备选 A:把 playwright 写进 `optionalDependencies`。** 不选。`optionalDependencies`
默认仍会装,只是装失败不报错 —— 省不掉体积,还多一层「装了一半」的状态。

**备选 B:用 Node 自己抓 HTML 再内联资源,不用 single-file。** 不选。要正确处理 CSS
`url()`、`srcset`、`@import`、字体、跨域,等于重写一遍 single-file,还写不好。

**备选 C:不做截图,只存 HTML。** 不选。截图是卡片封面的唯一来源,也是「一眼认出这是哪个页面」
的唯一手段;没有它,参考墙就是一堵标题墙。

### 4. 采集核心是移植,不是 import,也不是调用相邻仓的 daemon

`daemon/capture/index.ts` 耦合了 acgogogo 自己的 `http.ts` / `captures-root` /
`brand/lock` / `auth` / `mode`,跨仓 import 不可能。起它的 daemon 来代劳则产物落在
它的 `data/captures/`,还得搬一次,而且要求用户同时跑两个常驻服务。

所以**抄一份精简的进 `src/server/capture.mjs`**,文件头写明来源、以及只搬了哪两段:

- 搬:`single-file` 子进程调用与重试、三档截图。
- **不搬**:登录态 / storageState 注入、consent 点击、预览视频与 ffmpeg 转码、
  多状态巡览截图、品牌提取、design-spec / logic-spec 分析、并发池。

**踩坑注释连着搬。** 尤其「single-file 在 SPA 水合期偶发竞态:退出码 0 但没产物」
那段重试逻辑,和「登录态下产物是登录页」那段说明 —— 后者我们不做检测,
但要把它变成**界面上的一句话**(见风险)。

### 5. 写入收口到一处,只认服务端生成的 slug

所有落盘走一个写入函数,它 MUST 先 `resolveInside(root, 'visualization/…/' + slug)`,
再在其下 `mkdir` / `writeFile`。slug 由服务端从标题或 URL 生成并做安全化,
**不接受任何客户端传入的路径片段**。请求体里就算夹带 `../../output/docs` 一类字段也一律忽略。

`resolveInside` 现在是 `src/server/http.mjs` 的模块内私有函数(`http.mjs:91`)。
把它提到一个小模块(如 `src/server/paths.mjs`),`http.mjs` 与 `capture.mjs` 都从那里引 ——
**不要复制一份**。它是不变量 2 的载体,复制出来的第二份迟早会漂。

**备选:继续只 spawn 工作空间自己的脚本(照 ingest 的模式)。** 不选。
`single-file` 和 Playwright 是主机上的工具,不是工作空间模板里的脚本;
再套一层 `scripts/capture.py` 只会让每个老工作空间都缺这个脚本。

**备选:采集写看板缓存,只把一份指针写进工作空间。** 不选。
指针对 AI 没用,拷贝工作空间会丢参考本体。

### 6. 环回不等于可信 —— 补 `Sec-Fetch-Site` / `Origin` 校验

服务端没有 token,`readBody`(`http.mjs:79`)连 Content-Type 都不看。
浏览器里任意一个网页都能用 `enctype="text/plain"` 的表单往 `127.0.0.1:<端口>` POST,
body 拼成合法 JSON 就能被收下 —— 不触发预检,`allowMutations` 那条闸拦不住它。

所以所有会写盘 / 起子进程的接口 MUST 额外校验:`Sec-Fetch-Site` 存在且不是
`same-origin` / `none` 时拒绝;没有这个头但 `Origin` 与本机服务不符时也拒绝。
这条**同时覆盖现有的** ingest、忽略、新建工作空间、移出看板 —— 它们暴露在同一个问题上,
只是过去写盘的是工作空间脚本、危害小一档。

⚠️ **给下一个 change 留的口子要现在就想清楚:** `capture-package-inbox` 要接收浏览器扩展
经回环 POST 过来的采集包,而扩展的请求来源是 `chrome-extension://<id>`,**不是同源**,
按上面这条会被一刀拒掉。本 change **不为它开口**(现在开等于开一个没人用的洞),
但校验函数要写成「来源判定」这一件事,把判定收在一个函数里,
下一个 change 只需要往里加一条分支,而不是去改四五个接口。
那条分支具体怎么写(扩展请求实际带哪些头)由下一个 change 实测后定,**不在这里猜**。

**备选:给接口加 token,URL 里带。** 不选(这一版)。要改 CLI 输出、要改前端所有请求、
要处理用户手工开页面的场景。头校验是一行判断,先把主要面堵上;
真要做认证是另一个 change。

### 7. `meta.json` 记 `scrubbed: false`,但不承诺任何脱敏

采集没有脱敏管线:抓到什么就是什么,页面上的原文会原样落进工作空间。
`meta.json` 里恒写 `scrubbed: false`,作用只有一个 —— 让读到这份参考的 AI
知道这页可能带着页面上的原始内容。**它不是安全保证**,也不代表将来会有 `true`。

(下一个 change 的插件投递会带 `scrubbed: true` —— 扩展侧有脱敏管线。
字段现在就留着,那时不用改形状。)

界面上要说清同一件事:采集的是「当时那个页面的全部内容」,
别对着不该落盘的页面点采集。

### 8. 任务表仿 ingest,v0 不推日志流

同一工作空间同一时刻最多一个进行中的采集(再点被拒并说明原因)。
前端只需要三态:进行中 / 成功(可能带降级)/ 失败原因。**不接 SSE 日志流** ——
`single-file` 与 Playwright 的 stderr 对用户几乎不可读,推给他也只是噪音。
落盘完成后靠 `visualization/` 的 SSE 刷新清单。

- `single-file` 子进程超时 **120 秒**;截图整体超时 **90 秒**;都是超时即杀、按对应档位处理。
- 产物 `index.html` 超过 **64 MB** 判失败(单页自包含 HTML 正常在几 MB 量级;
  到 64 MB 说明抓到了不该抓的东西,写进去只会拖垮之后每一次扫描)。
- 临时文件写在目标 slug 目录**之外**,成功再整体移入;失败或超时就删干净,
  MUST NOT 留下缺 `index.html` 的半成品目录 —— 那种目录会让扫描列出一张点不开的卡片。

### 9. 同一 URL 再采一次 → 新 slug,不覆盖

参考的价值是「当时看到的页面」。第二次采集同一个 URL 时 MUST 生成新的 slug
(如 `<slug>-2`),MUST NOT 覆盖已有目录。用户想删旧的就去文件系统删 ——
看板不提供删除(那需要 `unlink` 权限,超出本次拍板的范围)。

**备选:覆盖同名目录。** 不选。覆盖是破坏性操作,而且要求看板有删文件的权限,
比「只新建」危险得多。

## Risks / Trade-offs

- **只读红线被开一个口,以后容易被顺手加宽。**
  → 写入收口到一处;`AGENTS.md` 写明「只写 `visualization/` 之下、必须用户发起、必须环回、
  只新建不覆盖」;code review 时看到别的目录的 `writeFile` 就按 bug 拦。
- **single-file 抓到的是登录页 / 同意条款页,任务却显示成功。** 这是相邻仓验证过的已知坑,
  我们不做检测(那会把登录态注入整条线拖进来)。
  → 文案写清「只适合不用登录就能看的页面;需要登录的系统请用采集插件」,
  并且采完让用户自己点开确认。**三张截图在这里顺带起了作用**:抓成登录页的话,
  hero.png 一眼就能看出来。
- **绝大多数用户既没装 single-file 也没装 playwright,第一次点采集就失败或降级。**
  → 两者的缺失文案都要给出可直接复制的安装命令;README / help 写明。
  区别对待:缺 single-file 是失败(参考的本体就是它),缺 playwright 是降级。
- **采下来的页面自带脚本,在看板里被打开。**
  → 已由 `visual-showcase-view` 的 CSP `sandbox` 兜住(不给 `allow-same-origin`)。
  本 change **依赖那一条已经落地**;先做采集后做隔离是不可接受的顺序。
- **AGPL 边界稍有不慎就进包。** → 禁止 import;组包脚本扫的是 import 图,
  spawn 字符串不会把 single-file 打进 tgz。注释和文档写明这条。
- **Playwright 在常驻服务里跑,浏览器进程可能泄漏。**
  → 每次采集起一个 browser、`finally` 里关;整体超时后强杀。看板是本机常驻的长命进程,
  这条不看住就是几天后内存里躺着十个 Chromium。
- **采集产物让工作空间体积暴涨。** 一份参考几 MB 到十几 MB。
  → `.gitignore` 策略在 `visual-showcase-view` 里已经定;界面上不额外提醒(采几份是用户自己的决定)。

## Migration Plan

- 依赖 `visual-showcase-view` 已经落地(`visualization/` 目录约定与两种条目形状、扫描、
  伺服、CSP 隔离、SSE 能捕获后建目录)。
- 老工作空间不用搬任何东西:第一次采集时 `visualization/references/` 由看板创建
  (这是被拍板允许的写入),SSE 那条「后建目录也要能推」正好覆盖这一刻。
- 前端先上、服务没重启:采集接口 404,按钮禁用并说明要重启,清单照常。
- 回退:停掉新服务、换回旧前端。已经采下来的文件留在磁盘上,
  旧版本仍能把它们当普通条目列出来(那部分是只读能力),不会删。

## Open Questions

无。超时 / 体积上限 / 截图分档 / `scrubbed` / 日志流 / 重复采集,都在上面定死了;
实施时若真实产物体积明显偏离 64 MB 的假设,改这一个常量并在这里记一笔。

扩展投递的来源判定放在 `capture-package-inbox`,那边实测后再定,本 change 只保证
校验逻辑收在一个函数里、加分支不用动接口。
