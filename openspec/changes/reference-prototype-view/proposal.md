## Why

刚接手一个项目时，第一件事往往不是产出可点击原型，而是把线上系统、友商页面、公开文档站收成能离线打开、能丢给 AI 的参考。看板现在只有「原型」视图，空态还在说 axhub-make 导出包 —— 没有地方放这些参考，人只能把网页另存到乱七八糟的文件夹，AI 也找不到。不做这件事，接手阶段的「看别人怎么做」和后续「自己做出东西」会一直挤在同一个空视图里，前者还根本进不了工作空间。

## What Changes

- **第四个视图从「原型」改成「参考&原型」**，内分「参考 / 原型」两个 tab。默认落在「参考」（刚接手时这里才有东西）。内部路由键仍是 `prototypes`，避免上次打开的视图丢了。
- **视觉材料和文档材料分开。** 工作空间根下新增可选目录 `visualization/`，下面是 `references/` 和 `prototypes/`。它和 `input/` `output/` 的差别就在于：这边是给人看、能点开的页面，不是要转换的文档。识别工作空间的判据不变，仍然只看有没有 `input/` + `output/`。
- **「参考」是新能力。** 看板扫 `visualization/references/` 列出已采集的页面；用户可以在界面上贴一个 URL，把公开页面收成自包含 HTML 落进去。卡片展示复用 acgogogo 采集网格的交互（16:10 预览、标题、来源 URL），视觉走看板自己的黑白灰令牌，不搬它的大圆角和预览视频。
- **「原型」tab 扫描约定不变，落点挪到 `visualization/prototypes/`。** 子目录 `index.html` / zip 包 / 看板伺服，识别规则一条都不改。老工作空间根上的 `prototypes/` 仍能被扫到（只读兼容，看板不搬家）。空态、注释、README 里残留的 axhub-make 口径清掉：原型就是「可点击的 HTML 包」，来源不限。
- **给 annotation-collect 留接收口。** 插件（另一个仓）打好的采集包可以投递进 `visualization/references/`。本 change 只做看板这一侧的接收端和落盘约定，不实现插件本身。
- **概览进度**里「原型」这一步改成「参考&原型」，有参考或有原型都算走过这一步。

v0 明确不做：登录态 / 友商后台的 headless 重抓（那是插件的事）、Playwright 截图与预览视频、品牌令牌提取、把参考塞进 `input/` 的转换管线、在参考页上批注。

## Capabilities

### New Capabilities
- `reference-capture`: 参考页的采集、落盘、扫描、展示，以及接收 annotation-collect 采集包。包括 `visualization/references/` 目录约定、URL 采集怎么发起、失败时怎么说、旧服务进程缺字段时怎么退。
- `prototype-preview`: 第一次把现有「原型」能力写成 spec：扫可点击 HTML 包、伺服、空态。本 change 的增量是 —— 住进「参考&原型」的原型 tab、落点改为 `visualization/prototypes/`（根上旧 `prototypes/` 只读兼容）、文案去 axhub-make 化。

### Modified Capabilities
（无。`rich-doc-convert` 不受影响，参考不走 `ingest.py`。）

## Impact

跨三个平面，并动契约。

| 平面 | 影响 |
| --- | --- |
| 服务端 `src/server/**` | 扫 `visualization/references/` 与 `visualization/prototypes/`（外加根上旧 `prototypes/`）；新增采集 / 接收两条写接口；SSE 改听 `visualization/` |
| 契约 `src/app/lib/api.ts` | **要改**：`Scan` 增加可选的 `references` 字段；新增采集 / 接收 API |
| 前端 `src/app/**` | 导航文案、tab 壳、参考网格、采集入口；原型面板改空态路径文案 |
| CLI `bin/cli.mjs` | 不动（写接口仍走现有 `allowMutations`，非环回 403） |
| `templates/` | **要动**：骨架从根上的 `prototypes/` 改成 `visualization/references/` 和 `visualization/prototypes/`，PM 模板约定写清这是视觉平面。放进去就是发给每个新建工作空间的 |

**依赖：** 不把 `single-file-cli` 写进 npm `dependencies`（它是 AGPL-3.0，只能当独立可执行文件用）。服务端在 PATH 上找、用子进程 `spawn`，找不到就明确告诉用户缺了什么。前端不引新包。不引入 Playwright。

**兼容性：** `Scan.references` 做成可选。旧服务进程不给这个字段时，「参考」tab 显示「当前看板服务还没有参考能力，重启后即可」，原型 tab 照常工作。不得白屏。

---

## 需要人拍板：放宽只读红线

这是本仓**第一次**让看板进程自己往工作空间里写文件（现有的 ingest 是 spawn 工作空间自己的 `scripts/ingest.py`，写盘的是脚本，不是看板）。annotation-collect 那边也已经写明：宿主接收端会撞这条红线，要单独拍板。

**建议拍板的范围（窄）：**

1. **只允许写 `<工作空间根>/visualization/references/`。** 其它目录（`input/` `output/` `visualization/prototypes/`、根上旧 `prototypes/`、`project.yaml`）看板仍然只读。看板也不把旧 `prototypes/` 搬进新位置。
2. **必须用户明确发起。** 两条入口：看板上贴 URL 点采集；插件里用户点「投递到看板」。没有后台自动抓、没有定时任务。
3. **必须环回。** `--host` 不是环回时，采集和接收一律 403，跟现在的 ingest / 忽略 / 新建工作空间同一条闸。
4. **路径必须过 `resolveInside()`。** slug 由服务端生成，不接受客户端指定的相对路径。
5. **这是看板（含插件接收端）写工作空间的唯一场景。** 批注回流、文档修改、原型生成，都不走这条口。

如果这条不批，参考就只能手搓文件丢进目录，看板退回「只扫不采」，插件也无处投递 —— 视图改名和原型文案清理仍可做，但「采集」整段砍掉。

拍板通过后，`AGENTS.md` 第 1 节的不变量清单要补上这一条，避免下一次会话又把写入当成 bug。
