## Why

刚接手一个项目时，第一件事往往不是产出可点击原型，而是把线上系统、友商页面、公开文档站
收成能离线打开、能丢给 AI 的参考。看板现在只有「原型」视图，空态还在说 axhub-make 导出包 ——
没有地方放这些参考，人只能把网页另存到自己电脑上某个乱七八糟的文件夹，AI 也找不到。
不做这件事，接手阶段的「看别人怎么做」和后续「自己做出东西」会一直挤在同一个空视图里，
前者还根本进不了工作空间。

## What Changes

- **第四个视图从「原型」改成「参考&原型」**，内分「参考 / 原型」两个 tab，默认落在「参考」
  （刚接手时这里才有东西）。内部路由键仍是 `prototypes`，避免每个人「上次打开的视图」丢了。
- **视觉材料和文档材料分开。** 工作空间根下新增可选目录 `visualization/`，下面是
  `references/` 和 `prototypes/`。它和 `input/` `output/` 的差别就在于：这边是给人看、
  能点开的页面，不是要转换的文档。识别工作空间的判据不变，仍然只看有没有 `input/` + `output/`。
- **「参考」是新能力（只读）。** 看板扫 `visualization/references/`，卡片网格展示，
  点击在新窗口打开看板伺服的那份 HTML。参考由用户自己放；「贴 URL 采集」在下一个 change。
- **原型彻底搬到 `visualization/prototypes/`，不留双根。** 识别规则（子目录 `index.html` /
  zip 包 / 看板伺服）一条都不改，只换扫描根。**看板不再扫工作空间根上的 `prototypes/`。**
- **旧位置只探测、不扫描。** 根上还留着非空的 `prototypes/` 时，原型 tab 的空态显示一行
  迁移提示和现成的 `mv` 命令。看板对工作空间只读，**不代替用户搬家**。
- **伺服参考与原型的 HTML 一律加 CSP `sandbox` 响应头**，把这些页面关进不透明源 ——
  它们不再和看板同源，拿不到 `/api/projects/*`。理由见 design 决策 4。
- **SSE 改听 `visualization/`**（递归覆盖两个子目录），并能捕获它**启动后才被创建**的情况。
- **模板**：`BASE_DIRS` 的 `prototypes` 换成 `visualization/references` 和
  `visualization/prototypes`；`.gitignore` 的 `prototypes/**/…` 规则跟着改，
  否则新工作空间会把原型的构建产物入库。
- **概览进度**里「原型」这一步改成「参考&原型」，有参考或有原型都算走过这一步。

**本 change 全程只读。** 看板不往工作空间写任何东西，参考靠用户自己把自包含 HTML 放进
`visualization/references/<名字>/`。「贴 URL 自动采集」在 `reference-url-capture` 里做 ——
那件事要放宽只读红线，单独拍板，不和视图改造捆在一起。

v0 明确不做：URL 采集与插件接收（下一个 change）、封面截图、品牌令牌提取、
把参考塞进 `input/` 的转换管线、在参考页上批注、在界面上删除参考。

## Capabilities

### New Capabilities
- `reference-library`: 参考的目录约定（`visualization/references/`）、扫描、下发、
  卡片展示、伺服与隔离。只读能力，不含采集。
- `prototype-preview`: 第一次把现有「原型」能力写成 spec：扫可点击 HTML 包、伺服、空态。
  本 change 的增量是 —— 住进「参考&原型」的原型 tab、扫描根改成 `visualization/prototypes/`
  （旧位置只探测不扫描）、伺服加 sandbox 隔离、文案去 axhub-make 化。

### Modified Capabilities
（无。`rich-doc-convert` 不受影响，参考不走 `ingest.py`。）

## Impact

跨三个平面并动契约，另外动模板；不动 CLI。

| 平面 | 影响 |
| --- | --- |
| 服务端 `src/server/**` | 新增 `references.mjs`（只扫不写）；`prototypes.mjs` 换扫描根 + 旧位置探测；`scan.mjs` 挂 `references` 字段；`http.mjs` 加参考静态伺服 + 两条伺服路径的 CSP 头；`watchWorkspace` 改听 `visualization/` 并处理「后来才创建」 |
| 契约 `src/app/lib/api.ts` | **要改**：`Scan` 增加**可选**的 `references` 字段，新增 `ReferenceItem` / `References` 类型；`Prototypes` 增加可选的 `legacyDir`（旧位置探测结果） |
| 前端 `src/app/**` | 侧栏文案、tab 壳、参考网格与空态；`PrototypePanel` 挪进原型 tab、改空态文案、显示迁移提示；概览进度那一步 |
| CLI `bin/cli.mjs` | 不动 |
| `templates/` | **要动**：`init_workspace.py` 的 `BASE_DIRS`、`.gitignore` 的 `prototypes/**/…` 规则、PM 模板的 AGENTS.md / README / 两个 skill 里的路径与语义。放进去就是发给每个新建工作空间的 |

**依赖：** 前端后端都不引新包。

**兼容性：这是一次破坏性目录变更。** 已有工作空间升级后，原型 tab 会空 —— 直到用户把
`prototypes/` 移进 `visualization/`。看板给出提示和命令，但不代劳（只读红线）。
项目刚发布、用量还小，这个时点做硬切比长期背一条双根兼容分支便宜（评估见 design 决策 2）。
`Scan.references` 仍做成可选：旧服务进程不给这个字段时，「参考」tab 显示
「当前看板服务还没有参考能力，重启看板服务后即可」，原型 tab 照常工作，不得白屏。

**不需要拍板。** 本 change 没有任何往工作空间写入的路径 —— 只读红线一动不动。
需要拍板的那段在 `openspec/changes/reference-url-capture/`。
