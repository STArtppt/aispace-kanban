## Context

看板的三个视图对应产品经理工作流的前两段:`input/`(输入文本)、`output/`(输出文本)、
再加一个概览。第三段「视觉呈现」现在只有一个叫「原型」的视图,实现已经跟 Axhub 解耦
(`prototypes.mjs` 认任何 `<子目录>/index.html` 或 zip,看板自己伺服),但空态和注释
还停在「axhub-make 导出包」。

「视觉呈现」这段本身分前后两半:

- **前期收参考** —— 线上系统、友商后台、公开文档站。刚接手一个项目时先出现的是这些,
  它们是做概念表达最快的捷径。
- **后期出可见物** —— 幻灯片、原型、demo。是输入输出积累到一定量之后的产出。

这两半和 `input/raw/` → `ingest.py` → `input/converted/` 不是同一条路:原始文档要转成
AI 可读的 Markdown / CSV;参考页和原型要保持「能点开的页面」这个形态。

**看板不参与原型的生成过程**,只展示结果 —— 原型由 axhub-make、figma make 这类工具产出,
看板要做的是把它们的产物(云端链接或导出包)收进来、摆好、能点开。

本 change 只立**视图与只读能力**:目录约定、扫描、展示、伺服、查看器。
往工作空间写东西的两条路(贴 URL 采集、浏览器插件投递)都要放宽只读红线,
分别在 `visual-capture-engine`、`capture-package-inbox` 里单独拍板。

现有 `annotate-to-agent-loop`(预览里批注 markdown)是另一件事,互不阻挡。

## Goals / Non-Goals

**Goals:**

- 第四个视图改成「视觉呈现」,两个 tab 分开展示两类东西,并给未来的视频 / 幻灯片留位。
- 视觉材料归到 `visualization/`,和 `input/` `output/` 的文档平面分开。
- 定死参考条目与原型条目的目录形态,让后面两个 change 只需要「往这个形状里写」。
- 原型彻底搬进 `visualization/prototypes/`,**只有一个扫描根**。
- 看板能列出、能打开这些页面,且打开它们不会把看板的接口交出去。

**Non-Goals:**

- 不写工作空间。本 change 没有任何 `mkdir` / `writeFile` 落在工作空间里 ——
  包括**不代替用户搬迁旧的 `prototypes/`**。
- 不做 URL 采集、不做插件接收、不引 single-file、不引 Playwright。
- 不解析、不构建源码包(figma make 源码、axhub 源码导出),见决策 6。
- 不把参考送进 `ingest.py`,不把 HTML 转 Markdown。
- 不在界面上删除参考或原型。
- 不改 `inspectWorkspace` 的判据。

## Decisions

### 1. 视觉平面用 `visualization/`,下面再分 `references/` 和 `prototypes/`

工作空间根上的材料分成两类:`input/` `output/` 是文档(要转换、要写、要给 AI 读正文);
「视觉呈现」是给人看、能点开的页面。用一个顶层目录把这件事说清楚,两个 tab
各自对应一个子目录:

```
<工作空间根>/
  input/          # 文档:要转换、要给 AI 读正文
  output/         # 文档:写出来的产物
  visualization/  # 页面:给人看、能点开的            ← 新增,可选
    references/   #   收下来的别人的页面
    prototypes/   #   工具产出的可点击原型
```

目录名取 `visualization/` 而不是 `references-and-prototypes/`,是因为视图名叫「视觉呈现」:
以后加视频、幻灯片就是在 `visualization/` 下再开一个子目录、在视图里再开一个 tab,
目录和视图一起扩,不用再搬一次家。

参考是「当时的页面」,原型是「工具做出来的可点击产物」,两者生命周期不一样,
所以在 `visualization/` 里仍然分开,不混扫。

**备选 A:`input/references/`。** 不选。`input/` 的契约是 raw → converted → assets,
把参考塞进去等于让转换管线和页面快照共用一套忽略 / 待处理逻辑,空态和统计都会被污染。

**备选 B:根上并列 `references/` 和 `prototypes/`。** 不选。两个顶层目录看不出它们和
文档平面的差别,也撑不起「视觉呈现」这个视图名 —— 视图谈的是一整个平面,
目录却和 `input/` 平级、彼此无关,而且以后加视频要再开第三个顶层目录。
这个备选唯一的优势是「原型不用搬家」,而搬家的代价见决策 2,比想象的小。

**备选 C:参考混在 `prototypes/` 或 `visualization/` 根上。** 不选。混放之后
「刚接手只有参考」和「已经有原型」分不开,zip 解压缓存也会误伤参考。

**备选 D:写到看板缓存,不进工作空间。** 不选。参考的读者包括本机 agent,
必须能在工作空间里被找到;拷贝工作空间也不该丢参考。

### 2. 原型硬搬家,只保留一个扫描根

`prototypes.mjs` 只扫 `visualization/prototypes/`。**不扫工作空间根上的 `prototypes/`。**

这是一次破坏性变更,前提是项目刚发布、用量还小。算过账才这么定:

**搬家(无双根)的实际代价**

- 服务端:扫描根一个常量 + 6 处 `sourcePath` / note 字符串;`watchWorkspace` 的
  `'prototypes'` 换成 `'visualization'`(递归覆盖两个子目录,**少一个 watcher**)。
- `scan.mjs`、`api.ts`、整个前端:**目录这件事上一个字都不用改** —— 它们只认
  `scan.prototypes` 这个字段名,不认目录。
- 文档与模板:约 27 处路径字符串(README、AGENTS.md、仓内 skill、`templates/` 下的
  help / create-prompt / PM 模板的 AGENTS 与 README、两个 PM skill)。机械替换,
  且这批本来就在「去 axhub-make 化」的范围内。
  **其中 `templates/pm-aispace/.gitignore` 的 `prototypes/**/node_modules|dist|.cache`
  必须跟着改**,否则新工作空间会把原型的构建产物入库。
- 已有工作空间:用户手工 `mv`。仓内自己那份是 git 跟踪的,用 `git mv`。

**保留双根的代价(否掉它的理由)**

合并两份清单、定义「同 slug 谁赢」、`sourcePath` 写实际路径、两处 watcher、
空态要同时说两个位置 —— 比只扫一个根**多** 30~40 行,而且看板对工作空间只读,
**永远不能把旧目录搬过去**,这条兼容分支就永远拆不掉。老工作空间会长期停在
「新建时铺出来的空目录在新位置、实际的包在旧位置」的割裂状态。
用一次性的手工 `mv` 换掉一条永久分支,现在这个时点划算。

**备选 A:实施时自动把旧目录搬过去。** 不选。那是写工作空间,破只读红线,
而且和本 change「全程只读」的定位直接冲突。

**备选 B:保留双根扫描。** 不选,理由见上。

**备选 C:只认新路径,旧包彻底不提。** 不选 —— 那是静默回归,见决策 3。

### 3. 旧位置只探测、不扫描

扫描时顺手 `existsSync` 一下工作空间根上的 `prototypes/`:存在且非空时,
在 `scan.prototypes` 里带一个可选的 `legacyDir` 字段,前端在原型 tab 的空态里
显示一行迁移提示和现成的命令:

```
mkdir -p visualization && mv prototypes visualization/prototypes
```

**这不是双根兼容**:不读里面的内容、不列卡片、不伺服、不合并清单。
只是一次 `existsSync` + 一行提示,等大家迁完可以整条删掉。
代价十几行,换掉「升级后原型 tab 静默变空、用户以为看板坏了」这个唯一会咬人的地方。

**备选:把迁移做成界面上的一个按钮。** 不选。那是 `rename` 工作空间里的目录,
破只读红线,而且后面两个 change 待拍板的写入例外也不覆盖这个动作。给命令让用户自己跑。

### 4. 伺服出去的 HTML 落进不透明源,交互画在看板自己的壳页上

参考是**从外部收下来的页面**,自带它自己的脚本。看板伺服它的路径和 SPA、
和整套 `/api/projects/*` **同源**,而服务端没有 token、没有 CORS 校验
(`readBody` 连 Content-Type 都不看)。不做隔离的话,一份采下来的页面在新窗口打开后,
它的脚本可以直接 `fetch('/api/projects')` 列出你所有登记的工作空间、读任意文件、发起 ingest。

所以参考与原型的伺服响应 MUST 带:

```
Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups
```

`sandbox` 指令让这份响应落进**不透明源**:页面照常渲染、脚本照常跑,但同源请求、
`localStorage`、cookie 全部拿不到。

**这条和「查看参考时左下角浮截图缩略图」直接冲突** —— 缩略图和灯箱不能画在被隔离的
那份 HTML 里(看板改不了别人的页面),也不能靠脚本注入(注进去就等于给它开了口子)。
所以查看器是**看板自己的一个壳页**:

```
/api/projects/:id/ref/:slug/view      ← 壳页(看板的 HTML,同源,带缩略图与灯箱)
  └─ <iframe src=".../ref/:slug/index.html">   ← 原始页面,响应带 CSP sandbox
```

壳页占满窗口,`iframe` 铺满,缩略图浮在左下角。用户感知仍是「新窗口打开了那个原始页面」,
而原始页面在 iframe 里、落在不透明源,拿不到看板接口,也够不到壳页的 DOM。
截图由壳页从 `/api/projects/:id/ref/:slug/screenshots/*.png` 读,那是普通静态资源。

原型的 `bundle` 形态没有截图,不需要壳页,直接开 `index.html`(仍带 sandbox 头);
`url` 形态直接开目标站点,与看板无关。

**备选 A:不隔离,靠「参考都是用户自己放的」。** 不选。这个假设在下一个 change
(贴 URL 采集任意公开页面)就不成立了,而且加一个响应头的成本几乎为零。
现在不加,等采集上线时这段 HTML 已经在用户机器上了。

**备选 B:把缩略图做成看板 SPA 里的一个浮层,参考仍在 iframe 里嵌进主界面。** 不选。
自包含页面常常自带全屏布局和滚动劫持,塞进主界面会和侧栏抢布局;而且用户要的是
「新窗口打开原始 html」的感觉,不是又一个内嵌预览。

**备选 C:单独起一个端口伺服这些页面。** 不选。多一个监听、多一段 CLI 参数、
多一处防火墙提示,收益和一个响应头一样。

注:跨站 CSRF(任意网页往 `127.0.0.1` POST)是既有暴露,本 change 不新增写接口,
留给 `visual-capture-engine` 一起补 `Sec-Fetch-Site` / `Origin` 校验。

### 5. 参考条目的目录形态现在就定死

后面两个 change(贴 URL 采集、插件投递)都要往这个形状里写,形状定晚了就要改两次。

```
visualization/references/<slug>/
  index.html                  # 必须。带交互的原始页面(自包含)
  meta.json                   # 可选。缺了就退回 manual + 从 <title> 取标题
  screenshots/
    hero.png                  # 可选。桌面标准屏首屏 1920×1080
    full.png                  # 可选。完整页面(长图)
    mobile.png                # 可选。移动端响应式
```

`meta.json` 的字段:`title`、`sourceUrl`、`capturedAt`、
`source`(`manual` / `url-capture` / `plugin`)、`scrubbed`(布尔,告知这页有没有经过脱敏,
**不是安全保证**)、`screenshots`(实际存在的那几张的相对路径)。
除 `index.html` 外全部可选 —— **判定「是不是一份参考」的唯一条件仍然是子目录根上有
`index.html`**,这样用户手工另存一份 HTML 摆进去就能被认出来,不必先学会写 `meta.json`。

截图目录扁平,不做 `responsive/` 子层(相邻仓那层是为了容纳多状态截图,我们不采状态)。

**备选:把元信息塞进 `index.html` 的 `<meta>`。** 不选。那要求写入方改别人的页面内容,
而参考的价值恰恰是「原样」。

### 6. 原型只认已构建的产物,源码包不支持

原型条目有两种形态:

- **`bundle`** —— 已构建的可点击 HTML 包。判定规则与改动前逐条一致:子目录根上有
  `index.html`、扫描根上直接有 `index.html`、或 zip(包内能解析到 `index.html`,
  解压到看板自家缓存 `~/.pmwork/dashboard/proto-cache/`,**不写回工作空间**)。
- **`url`** —— 云端发布的原型(见决策 7)。

**源码包不在支持范围内。** 拿三个真实导出包核实过:

| 包 | 实际内容 | 结论 |
| --- | --- | --- |
| axhub-make「导出 HTML」包 | `index.html` + 打包好的 `index.js` + react UMD,5 个文件 | ✅ 直接伺服就能看 |
| figma make 导出包 | 纯源码,`<script type="module" src="/src/main.tsx">`,依赖含 MUI + 全套 radix | ❌ 必须 `install` + `vite build` |
| axhub-make「导出源码」包 | `manifest.json` 标 `format: axhub-published-source`,entry `index.tsx` | ❌ **在 axhub 之外构建不出来** |

第三种是决定性的:它 `import` 了私有包 `@axhub/annotation`,还有
`import ... from '../../common/useHashPage'` —— **相对路径指向包外**。这个包的定位是
回流进 axhub-make,不是给第三方渲染的。第二种理论上能构建,但那要看板装几百 MB
依赖、联网、跑分钟级构建,与「看板不参与原型生成过程、只展示结果」这条定位直接冲突。

所以:源码包丢进来,看板按现有逻辑扫不到它(zip 里没有 `index.html`),
空态和 `note` 里把这条说清楚 —— 请用工具的「导出 HTML」,或者用云端发布链接走 `url` 形态。
**不做「识别出这是源码包并特别提示」**:那要读 zip 里的 `manifest.json` / `package.json`,
为一条死路多写一套探测。

### 7. 云端发布的原型走 `url` 形态,本地只留封面和元数据

axhub-make 能发布到云服务,figma make 的 publish / share 直接给访问链接。这类原型
本地没有产物,硬要抓下来既失真(它们是 SPA)又没必要 —— 用户要的就是点开那个链接。

```
visualization/prototypes/<slug>/
  meta.json      # 必须。{ kind: "url", title, target, capturedAt, source }
  cover.png      # 可选。封面截图
```

判定:子目录里有 `meta.json` 且 `kind` 为 `url` → 一条 `url` 原型,卡片点击**新窗口直接打开
`target`**,不经看板伺服。有 `index.html` → 一条 `bundle` 原型,走原来的路。
两者都没有 → 不是一份原型,忽略。

本 change 只做扫描与展示;把 `meta.json` 和 `cover.png` 写进去是 `visual-capture-engine`
的事(它顺带用同一套截图能力出这张封面)。用户手工写一份 `meta.json` 也能立刻生效。

**备选:把云端原型记在一个集中的清单文件里(如 `visualization/prototypes/index.json`)。**
不选。集中文件要处理并发写、要处理用户手改坏,而一目录一条目和参考、和 `bundle` 形态同构,
SSE 也天然按目录粒度推。

### 8. 视图路由键保持 `prototypes`(这是 UI 状态,不是目录名)

侧栏文案改成「视觉呈现」,`useBoardSession` 的 `View` 仍是 `'prototypes'`。
上次打开的视图、概览 `onGoto`、localStorage 都不用迁移。
tab 自己的选中状态另存(`aispace-kanban:visual-tab`),缺省为 `reference`。

**备选:改成 `'visual'`。** 不选。收益只是名字更贴切,代价是每个人的「上次视图」
掉回概览,还要改一串类型。以后真要改,和别的破坏性变更一起改。

### 9. 卡片封面用 `hero.png`,没有就用现成的窗框占位

`PrototypePanel` 已经有一套「16:10 预览区 + 窗框占位 + 标题首字」的卡片,
参考网格按同一套做,只多一行来源 URL。有 `screenshots/hero.png`(或原型的 `cover.png`)
就当封面铺满预览区,没有就落回窗框占位 —— **不得出现破图**。tab 用现成的 startist `Tabs`。

不把相邻仓的采集网格拷进来:那份有预览视频、品牌方块、28px 大圆角、独立 i18n,
和看板「黑白灰、无阴影、orange 只给需要注意」冲突。

**备选:iframe 缩略图当封面。** 不选。每张卡片一开就是一份完整 HTML,列表一长就卡 ——
这也正是我们要截图的原因。

### 10. SSE 要能捕获 `visualization/` 被创建

`watchWorkspace` 现在对不存在的目录直接跳过。老工作空间升级后还没有 `visualization/`,
用户之后建了目录、搬了原型、放了参考,SSE 一次都不会推 —— 界面要等到手动刷新或
重启服务才更新。**搬家之后这条尤其重要**:用户跑完 `mv` 第一件事就是回看板看效果。
下一个 change 的采集也依赖它:第一次采集时 `visualization/references/` 才被创建。

所以除了递归监听 `visualization/`,还要监听**工作空间根(非递归)**,
根上多出这个目录时补挂一个递归 watcher。

**备选:每次 SSE 事件重扫一遍该挂哪些 watcher。** 实现上等价,挑最短的那条;
spec 只约束「后建的目录也要能推事件」。

### 11. 契约新增可选字段

`Scan.references?` 可选,形状与 `prototypes` 同类(`items` / `note` / `updatedAt`),
每条 item 带 `itemKey` / `title` / `url`(指向查看器壳页),可选
`sourceUrl` / `source` / `scrubbed` / `mtime` / `cover` / `screenshots`。
`source` 现在只会是 `manual`,`url-capture` / `plugin` 是给后面两个 change 预留的取值 ——
类型里先写全,省得下次动契约。

`PrototypeItem` 增加 `kind: 'url'` 与可选的 `target`(`url` 形态的目标地址)、
`cover`;原有的 `'folder'` / `'zip'` 取值不动 —— 它们是 `bundle` 的两种物理形态,
前端只需要区分「点开看板伺服的 url」还是「点开外部 target」。
`Prototypes.legacyDir?` 可选,只在根上还有非空旧目录时出现。

前端缺 `references` 就显示「重启服务」,不抛错、不白屏。

## Risks / Trade-offs

- **升级后原型 tab 空掉,用户以为看板坏了。** → 决策 3 的迁移提示 + 现成命令;
  README / CHANGELOG 写成破坏性变更。这是本 change 最需要盯的一条。
- **用户搬了目录但没搬干净**(比如只 `mv` 了一部分)。→ 提示只在
  `visualization/prototypes/` 扫不出东西**且**根上旧目录非空时出现,
  搬完就自动消失;没搬完的下次打开还会看到。
- **`.gitignore` 规则漏改,新工作空间把原型构建产物入库。**
  → 已列进任务;验证方式是新建一个工作空间看 `.gitignore` 内容。
  同时要定采集产物的入库策略:一份参考是「整页 HTML + 三张截图」,量级在几 MB 到十几 MB,
  相邻仓一个站点的采集目录实测 8.6 MB。
- **CSP sandbox 可能让某些页面表现异常**(比如依赖 `localStorage` 记状态)。
  → 这正是要的隔离;真打不开还能在文件系统里双击那份 HTML(`file://` 源,与看板无关)。
- **iframe 里的页面可能自己 `top.location` 跳走或做 frame-busting。**
  → sandbox 不给 `allow-top-navigation`,这类脚本会被浏览器挡下;真遇到渲染异常的页面,
  壳页提供「直接打开原始页面」的出口(那条路仍带 sandbox 头,只是没有缩略图)。
- **旧进程 + 新前端。** → `references` 字段可选;参考 tab 自己说明要重启,原型不受影响。
- **用户把散装 `.html` 扔在 `visualization/references/` 根上,扫不到。**
  → 空态明写「一份参考一个目录,入口叫 `index.html`」。
- **用户把 figma make 源码包丢进原型目录,什么都没看见。**
  → 空态与 `note` 明写只认已构建产物,并指路「导出 HTML」或云端发布链接。

## Migration Plan

- **已有工作空间需要用户手工搬一次**(看板只读,不代劳):
  `mkdir -p visualization && mv prototypes visualization/prototypes`。
  没搬之前原型 tab 空,但会显示这条命令。
- 本仓自己的 `templates/pm-aispace/prototypes/` 用 `git mv` 搬(内容是 git 跟踪的)。
- 新建的工作空间带 `visualization/references/` 和 `visualization/prototypes/` 两棵空树,
  不再铺根上的 `prototypes/`。
- 前端先上、忘了重启服务:参考 tab 自己说明,原型不受影响。
- **回退**:停掉新服务、换回旧前端即可。已经搬进 `visualization/prototypes/` 的包
  旧版本看不见(要搬回去),`visualization/references/` 下的文件留在磁盘上不会被删。
  回退成本随用户搬家进度上升 —— 要退就趁早退。

## Open Questions

无。采集与写入相关的取舍全部在 `visual-capture-engine`。
