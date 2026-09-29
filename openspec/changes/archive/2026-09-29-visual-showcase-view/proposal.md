## Why

产品经理的工作流可以精炼成三段:**输入文本 → 输出文本 → 视觉呈现**。看板的前两段已经有了
(`input/` 的资料、`output/` 的产出),第三段只有一个叫「原型」的视图,空态还在说
axhub-make 导出包。

而「视觉呈现」这一段本身有前后两半:**前期收参考**(竞品 / 友商 / 大厂的线上系统与页面,
这是想法萌芽时做概念表达的最快捷径),**后期出可见物**(幻灯片 / 原型 / demo,
是输入输出变多之后的必然产出)。现在看板只认后一半,而且只认一种形态。
前一半根本进不了工作空间 —— 用户只能存书签、往自己电脑的某个文件夹里另存,AI 也找不到。

## What Changes

- **第四个视图从「原型」改成「视觉呈现」**,内分「参考 / 原型」两个 tab,默认落在「参考」
  (刚接手时这里才有东西)。取这个名字是为了留扩展位 —— 以后加视频、幻灯片只是多一个 tab。
  内部路由键仍是 `prototypes`,避免每个人「上次打开的视图」丢了。
- **视觉材料和文档材料分开。** 工作空间根下新增可选目录 `visualization/`,下面是
  `references/` 和 `prototypes/`。它和 `input/` `output/` 的差别就在于:这边是给人看、
  能点开的页面,不是要转换的文档。识别工作空间的判据不变,仍然只看有没有 `input/` + `output/`。
- **「参考」是新能力(本 change 全程只读)。** 看板扫 `visualization/references/`,
  卡片网格展示。一份参考是一个目录:`index.html`(带交互的原始页面)+
  `screenshots/`(桌面首屏 / 完整页 / 移动端三张)+ `meta.json`(源 URL、采集时间、来源)。
  **本 change 只负责扫和展示,不负责把东西放进去** —— 采集在 `visual-capture-engine`。
- **参考查看器:新窗口打开原始页面,左下角浮三张截图缩略图,点开灯箱。**
  实现上是看板伺服一个自己的壳页,壳里 `<iframe>` 装被隔离的原始 HTML,
  缩略图和灯箱画在壳上 —— 原始页面拿不到看板的任何接口(见 design 决策 4)。
- **原型彻底搬到 `visualization/prototypes/`,不留双根。** 看板不再扫工作空间根上的
  `prototypes/`;旧位置只探测、不扫描,在空态给一行 `mv` 命令,**看板不代替用户搬家**。
- **原型条目扩成两种形态。** `bundle`:已构建的可点击 HTML 包(现有能力,判定规则一条不改);
  `url`:云端发布的原型(axhub-make 发布、figma make 的 publish / share 链接),
  本地只落一张封面图和一份 `meta.json`,卡片点击直接新窗口打开目标 URL。
  本 change 只做**扫描与展示**这两种形态,写入同样在 `visual-capture-engine`。
- **原型只认已构建的产物,源码包不支持。** 空态与文案直说这一条,理由见 design 决策 6。
- **伺服参考与原型的 HTML 一律加 CSP `sandbox` 响应头**,把这些页面关进不透明源 ——
  它们不再和看板同源,拿不到 `/api/projects/*`。
- **SSE 改听 `visualization/`**(递归覆盖两个子目录),并能捕获它**启动后才被创建**的情况。
- **模板**:`BASE_DIRS` 的 `prototypes` 换成 `visualization/references` 和
  `visualization/prototypes`;`.gitignore` 的 `prototypes/**/…` 规则跟着改,
  并决定采集产物(整页快照 + 截图,体积不小)的入库策略。
- **概览进度**里「原型」这一步改成「视觉呈现」,有参考或有原型都算走过这一步。

**本 change 全程只读。** 看板不往工作空间写任何东西。往里放东西的两条路 ——
贴 URL 采集、浏览器插件投递 —— 都要放宽只读红线,分别在
`visual-capture-engine` 和 `capture-package-inbox` 里单独拍板,不和视图改造捆在一起。

v0 明确不做:URL 采集与插件接收(下两个 change)、源码包的解析与构建、品牌令牌提取、
把参考塞进 `input/` 的转换管线、在参考页上批注、在界面上删除参考。

## Capabilities

### New Capabilities
- `reference-library`: 参考的目录约定(`visualization/references/`)、扫描、下发、
  卡片展示、伺服隔离与查看器。只读能力,不含采集。
- `prototype-preview`: 第一次把现有「原型」能力写成 spec:扫可点击 HTML 包、伺服、空态。
  本 change 的增量是 —— 住进「视觉呈现」的原型 tab、扫描根改成 `visualization/prototypes/`
  (旧位置只探测不扫描)、条目扩出 `url` 形态、伺服加 sandbox 隔离、文案去 axhub-make 化。

### Modified Capabilities
(无。`rich-doc-convert` 不受影响,参考与原型都不走 `ingest.py`。)

## Impact

跨三个平面并动契约,另外动模板;不动 CLI。

| 平面 | 影响 |
| --- | --- |
| 服务端 `src/server/**` | 新增 `references.mjs`(只扫不写);`prototypes.mjs` 换扫描根 + 旧位置探测 + `url` 形态;`scan.mjs` 挂 `references` 字段;`http.mjs` 加参考静态伺服、查看器壳页与两条伺服路径的 CSP 头;`watchWorkspace` 改听 `visualization/` 并处理「后来才创建」 |
| 契约 `src/app/lib/api.ts` | **要改**:`Scan` 增加**可选**的 `references` 字段,新增 `ReferenceItem` / `References` 类型;`PrototypeItem` 增加 `kind: 'url'` 与 `target`;`Prototypes` 增加可选的 `legacyDir` |
| 前端 `src/app/**` | 侧栏文案、tab 壳、参考网格与空态、参考查看器壳页;`PrototypePanel` 挪进原型 tab、支持 `url` 卡片、改空态文案、显示迁移提示;概览进度那一步 |
| CLI `bin/cli.mjs` | 不动 |
| `templates/` | **要动**:`init_workspace.py` 的 `BASE_DIRS`、`.gitignore` 的 `prototypes/**/…` 规则与采集产物入库策略、PM 模板的 AGENTS.md / README / 两个 skill 里的路径与语义。放进去就是发给每个新建工作空间的 |

**依赖:** 前端后端都不引新包。截图与采集要的 Playwright / single-file 都在
`visual-capture-engine`,且都不进 `dependencies`。

**兼容性:这是一次破坏性目录变更。** 已有工作空间升级后,原型 tab 会空 —— 直到用户把
`prototypes/` 移进 `visualization/`。看板给出提示和命令,但不代劳(只读红线)。
项目刚发布、用量还小,这个时点做硬切比长期背一条双根兼容分支便宜(评估见 design 决策 2)。
`Scan.references` 仍做成可选:旧服务进程不给这个字段时,「参考」tab 显示
「当前看板服务还没有参考能力,重启看板服务后即可」,原型 tab 照常工作,不得白屏。

**不需要拍板。** 本 change 没有任何往工作空间写入的路径 —— 只读红线一动不动。
