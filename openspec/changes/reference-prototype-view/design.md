## Context

看板第四个视图现在叫「原型」，实现已经跟 Axhub 解耦：`prototypes.mjs` 认任何
`<子目录>/index.html` 或 zip，看板自己伺服。空态和注释还停在「axhub-make 导出包」。
工作空间判据只认 `input/` + `output/`，`prototypes/` 本来就是可选的顶层目录。

刚接手一个项目时，先出现的不是这些 HTML 包，而是线上系统、友商后台、公开文档站。
这和 `input/raw/` → `ingest.py` → `input/converted/` 不是同一条路：原始文档要转成
AI 可读的 Markdown / CSV；参考页要保持「当时看到的页面」，离线还能点。

相邻两个仓已经把「怎么把页面收下来」分成两条采集路（公开页用独立子进程调 single-file，
登录后的深层页面用浏览器扩展）。**那两条都要往工作空间写，本 change 一条都不做** ——
这里只把「参考」立成看板里的一等公民：目录、扫描、展示、伺服。采集在
`reference-url-capture`，插件接收再往后。

现有 `annotate-to-agent-loop`（预览里批注 markdown）是另一件事，互不阻挡。

## Goals / Non-Goals

**Goals:**

- 第四个视图改成「参考&原型」，两个 tab 分开展示两类 HTML。
- 视觉材料归到 `visualization/`，和 `input/` `output/` 的文档平面分开。
- 原型彻底搬进 `visualization/prototypes/`，**只有一个扫描根**。
- 看板能列出、能打开这些页面，且打开它们不会把看板的接口交出去。

**Non-Goals:**

- 不写工作空间。本 change 没有任何 `mkdir` / `writeFile` 落在工作空间里 ——
  包括**不代替用户搬迁旧的 `prototypes/`**。
- 不做 URL 采集、不做插件接收、不引 single-file、不引 Playwright。
- 不做封面截图；v0 没封面就用现成的浏览器窗框占位。
- 不把参考送进 `ingest.py`，不把 HTML 转 Markdown。
- 不在界面上删除参考。
- 不改 `inspectWorkspace` 的判据。

## Decisions

### 1. 视觉平面用 `visualization/`，下面再分 `references/` 和 `prototypes/`

工作空间根上的材料分成两类：`input/` `output/` 是文档（要转换、要写、要给 AI 读正文）；
「参考&原型」是给人看、能点开的页面。用一个顶层目录把这件事说清楚，两个 tab
各自对应一个子目录：

```
<工作空间根>/
  input/          # 文档：要转换、要给 AI 读正文
  output/         # 文档：写出来的产物
  visualization/  # 页面：给人看、能点开的            ← 新增，可选
    references/   #   收下来的别人的页面
    prototypes/   #   自己做出来的可点击包
```

参考是「当时的页面」，原型是「自己做出来的可点击产物」，两者生命周期不一样，
所以在 `visualization/` 里仍然分开，不混扫。

**备选 A：`input/references/`。** 不选。`input/` 的契约是 raw → converted → assets，
把参考塞进去等于让转换管线和页面快照共用一套忽略 / 待处理逻辑，空态和统计都会被污染。

**备选 B：根上并列 `references/` 和 `prototypes/`。** 不选。两个顶层目录看不出它们和
文档平面的差别，也撑不起「参考&原型」这个视图名 —— 视图谈的是可视化，
目录却和 `input/` 平级、彼此无关。这个备选唯一的优势是「原型不用搬家」，
而搬家的代价见决策 2，比想象的小。

**备选 C：参考混在 `prototypes/` 或 `visualization/` 根上。** 不选。混放之后
「刚接手只有参考」和「已经有原型」分不开，zip 解压缓存也会误伤参考。

**备选 D：写到看板缓存，不进工作空间。** 不选。参考的读者包括本机 agent，
必须能在工作空间里被找到；拷贝工作空间也不该丢参考。

### 2. 原型硬搬家，只保留一个扫描根

`prototypes.mjs` 只扫 `visualization/prototypes/`。**不扫工作空间根上的 `prototypes/`。**

这是一次破坏性变更，前提是项目刚发布、用量还小。算过账才这么定：

**搬家（无双根）的实际代价**

- 服务端：扫描根一个常量 + 6 处 `sourcePath` / note 字符串；`watchWorkspace` 的
  `'prototypes'` 换成 `'visualization'`（递归覆盖两个子目录，**少一个 watcher**）。
- `scan.mjs`、`api.ts`、整个前端：**一个字都不用改** —— 它们只认 `scan.prototypes`
  这个字段名，不认目录。
- 文档与模板：约 27 处路径字符串（README、AGENTS.md、仓内 skill、`templates/` 下的
  help / create-prompt / PM 模板的 AGENTS 与 README、两个 PM skill）。机械替换，
  且这批本来就在「去 axhub-make 化」的范围内。
  **其中 `templates/pm-aispace/.gitignore` 的 `prototypes/**/node_modules|dist|.cache`
  必须跟着改**，否则新工作空间会把原型的构建产物入库。
- 已有工作空间：用户手工 `mv`。仓内自己那份是 git 跟踪的，用 `git mv`。

**保留双根的代价（否掉它的理由）**

合并两份清单、定义「同 slug 谁赢」、`sourcePath` 写实际路径、两处 watcher、
空态要同时说两个位置 —— 比只扫一个根**多** 30~40 行，而且看板对工作空间只读，
**永远不能把旧目录搬过去**，这条兼容分支就永远拆不掉。老工作空间会长期停在
「新建时铺出来的空目录在新位置、实际的包在旧位置」的割裂状态。
用一次性的手工 `mv` 换掉一条永久分支，现在这个时点划算。

**备选 A：实施时自动把旧目录搬过去。** 不选。那是写工作空间，破只读红线，
而且和本 change「全程只读」的定位直接冲突。

**备选 B：保留双根扫描。** 不选，理由见上。

**备选 C：只认新路径，旧包彻底不提。** 不选 —— 那是静默回归，见决策 3。

### 3. 旧位置只探测、不扫描

扫描时顺手 `existsSync` 一下工作空间根上的 `prototypes/`：存在且非空时，
在 `scan.prototypes` 里带一个可选的 `legacyDir` 字段，前端在原型 tab 的空态里
显示一行迁移提示和现成的命令：

```
mkdir -p visualization && mv prototypes visualization/prototypes
```

**这不是双根兼容**：不读里面的内容、不列卡片、不伺服、不合并清单。
只是一次 `existsSync` + 一行提示，等大家迁完可以整条删掉。
代价十几行，换掉「升级后原型 tab 静默变空、用户以为看板坏了」这个唯一会咬人的地方。

**备选：把迁移做成界面上的一个按钮。** 不选。那是 `rename` 工作空间里的目录，
破只读红线，而且 `reference-url-capture` 里待拍板的写入例外也只覆盖
`visualization/references/`，不含这个。给命令让用户自己跑。

### 4. 伺服出去的 HTML 必须落进不透明源

参考是**从外部收下来的页面**，自带它自己的脚本。看板伺服它的路径
（`/api/projects/:id/ref/:slug/index.html`）和 SPA、和整套 `/api/projects/*` **同源**，
而服务端没有 token、没有 CORS 校验（`readBody` 连 Content-Type 都不看）。
不做隔离的话，一份采下来的页面在新窗口打开后，它的脚本可以直接
`fetch('/api/projects')` 列出你所有登记的工作空间、读任意文件、发起 ingest。

所以参考的伺服响应 MUST 带：

```
Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups
```

`sandbox` 指令让这份响应落进**不透明源**：页面照常渲染、脚本照常跑，但同源请求、
`localStorage`、cookie 全部拿不到。原型伺服也一并加上 —— 原型多是自己做的，
风险低一档，但同样是「工作空间里的 HTML 被看板用自己的 origin 跑起来」，没有理由区别对待。

**备选 A：不隔离，靠「参考都是用户自己放的」。** 不选。这个假设在下一个 change
（贴 URL 采集任意公开页面）就不成立了，而且加一个响应头的成本几乎为零。
现在不加，等采集上线时这段 HTML 已经在用户机器上了。

**备选 B：单独起一个端口伺服这些页面。** 不选。多一个监听、多一段 CLI 参数、
多一处防火墙提示，收益和一个响应头一样。

**备选 C：塞进 iframe 用 `sandbox` 属性。** 不选。自包含 HTML 常常自带布局和脚本，
塞进看板预览栏会和外壳抢布局；原型已经是新窗口，两条 tab 保持一致。
CSP 头对新窗口同样生效。

注：跨站 CSRF（任意网页往 `127.0.0.1` POST）是既有暴露，本 change 不新增写接口，
留给 `reference-url-capture` 一起补 `Sec-Fetch-Site` / `Origin` 校验。

### 5. 视图路由键保持 `prototypes`（这是 UI 状态，不是目录名）

侧栏文案改成「参考&原型」，`useBoardSession` 的 `View` 仍是 `'prototypes'`。
上次打开的视图、概览 `onGoto`、localStorage 都不用迁移。
tab 自己的选中状态另存（`aispace-kanban:refs-tab`），缺省为 `reference`。

**备选：改成 `'references'`。** 不选。收益只是名字更贴切，代价是每个人的「上次视图」
掉回概览，还要改一串类型。不值。

### 6. 参考卡片复用现有占位，不搬相邻仓的组件

`PrototypePanel` 已经有一套「16:10 预览区 + 窗框占位 + 标题首字」的卡片，
参考网格直接按同一套做，只多一行来源 URL。tab 用现成的 startist `Tabs`。
不把相邻仓的采集网格拷进来：那份有预览视频、品牌方块、28px 大圆角、独立 i18n，
和看板「黑白灰、无阴影、orange 只给需要注意」冲突。

**备选：iframe 缩略图当封面。** 不选。每张卡片一开就是一份完整 HTML，列表一长就卡。

### 7. SSE 要能捕获 `visualization/` 被创建

`watchWorkspace` 现在对不存在的目录直接跳过。老工作空间升级后还没有 `visualization/`，
用户之后建了目录、搬了原型、放了参考，SSE 一次都不会推 —— 界面要等到手动刷新或
重启服务才更新。**搬家之后这条尤其重要**：用户跑完 `mv` 第一件事就是回看板看效果。

所以除了递归监听 `visualization/`，还要监听**工作空间根（非递归）**，
根上多出这个目录时补挂一个递归 watcher。

**备选：每次 SSE 事件重扫一遍该挂哪些 watcher。** 实现上等价，挑最短的那条；
spec 只约束「后建的目录也要能推事件」。

### 8. 契约新增可选字段

`Scan.references?` 可选，形状与 `prototypes` 同类（`items` / `note` / `updatedAt`），
每条 item 带 `itemKey` / `title` / `url`，可选 `sourceUrl` / `source` / `mtime` / 封面地址。
`source` 现在只会是 `manual`，`url-capture` / `plugin` 是给下一个 change 预留的取值 ——
类型里先写全，省得下次动契约。
`Prototypes.legacyDir?` 可选，只在根上还有非空旧目录时出现。

前端缺 `references` 就显示「重启服务」，不抛错、不白屏。

## Risks / Trade-offs

- **升级后原型 tab 空掉，用户以为看板坏了。** → 决策 3 的迁移提示 + 现成命令；
  README / CHANGELOG 写成破坏性变更。这是本 change 最需要盯的一条。
- **用户搬了目录但没搬干净**（比如只 `mv` 了一部分）。→ 提示只在
  `visualization/prototypes/` 扫不出东西**且**根上旧目录非空时出现，
  搬完就自动消失；没搬完的下次打开还会看到。
- **`.gitignore` 规则漏改，新工作空间把原型构建产物入库。**
  → 已列进任务；验证方式是新建一个工作空间看 `.gitignore` 内容。
- **CSP sandbox 可能让某些页面表现异常**（比如依赖 `localStorage` 记状态）。
  → 这正是要的隔离；真打不开还能在文件系统里双击那份 HTML（`file://` 源，与看板无关）。
- **旧进程 + 新前端。** → `references` 字段可选；参考 tab 自己说明要重启，原型不受影响。
- **用户把散装 `.html` 扔在 `visualization/references/` 根上，扫不到。**
  → 空态明写「一份参考一个目录，入口叫 `index.html`」。

## Migration Plan

- **已有工作空间需要用户手工搬一次**（看板只读，不代劳）：
  `mkdir -p visualization && mv prototypes visualization/prototypes`。
  没搬之前原型 tab 空，但会显示这条命令。
- 本仓自己的 `templates/pm-aispace/prototypes/` 用 `git mv` 搬（内容是 git 跟踪的）。
- 新建的工作空间带 `visualization/references/` 和 `visualization/prototypes/` 两棵空树，
  不再铺根上的 `prototypes/`。
- 前端先上、忘了重启服务：参考 tab 自己说明，原型不受影响。
- **回退**：停掉新服务、换回旧前端即可。已经搬进 `visualization/prototypes/` 的包
  旧版本看不见（要搬回去），`visualization/references/` 下的文件留在磁盘上不会被删。
  回退成本随用户搬家进度上升 —— 要退就趁早退。

## Open Questions

无。采集相关的取舍全部在 `reference-url-capture`。
