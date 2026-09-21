## Why

不做的话，用户用浏览器插件或剪藏把页面丢进 `visualization/references/`，看板当它不存在（散装 `.html` 扫不到），AI 也读不动那份几 MB 的自包含 HTML。上一份 change 已经给了 `web_ingest.py`，但它只吃 URL、而且明确不写 `visualization/` —— 登录后的内网页、剪藏另存的文件，那条路根本走不通。人只能手工建目录、改名、再对着每条 URL 跑一遍脚本。

## What Changes

- **给 `web_ingest.py` 加收件箱模式**（`--inbox`，无 URL 参数）：扫描 `visualization/references/` 根上的散装 `.html` / `.htm`，收成一份标准参考（子目录 + `index.html` + `meta.json`），再对尚未有对应 Markdown 的参考抽出正文，落进 `input/converted/`。URL 模式原样不动，公开页照旧可以贴地址转换。
- **参考 tab 的链接输入右侧加「刷新」按钮**，形状对齐原型 tab 的刷新、资料转换的「开始转换」：点一下 = 看板 `spawn` 工作空间脚本的收件箱模式。任务立刻返回、前端轮询；完成后 `visualization/` 与 `input/` 的 SSE 自己刷新清单。
- **看板扫描补上「待入库」**：根上还有散装页面时，参考 tab 能看见份数；没有 `scripts/web_ingest.py` 的旧工作空间不显示按钮。
- **空态与技能文案改一句**：散装文件不再只是「扫不到」，而是「丢进来之后点刷新」。

明确不做：不处理 `.mhtml`、浏览器「完整网页」另存出来的资源文件夹；不补截图；不做整站抓取；看板自己不写、不移动任何一个字节。

## ⚠ 需要拍板：新增第五条窄例外

**这个 change 会让看板发起的子进程同时写 `visualization/references/` 和 `input/converted/`。** 它改动的是 AGENTS.md 不变量 1，必须在这里单独列清范围，实施时一并写进 AGENTS.md。

上一份 `workspace-markdown-convention` 写过「`web_ingest.py` 不向 `visualization/` 写任何文件」。本 change **只在收件箱模式里放开这一条**，URL 模式仍然不写 `visualization/`。

| 写哪里 | 谁写 | 范围 |
| --- | --- | --- |
| `<工作空间>/visualization/references/<slug>/` | 工作空间的 `scripts/web_ingest.py --inbox` | 只把**根上的散装** `.html` / `.htm` 收成新目录（`index.html` + `meta.json`）。已有参考目录不覆盖、不删除、不改名 |
| `<工作空间>/input/converted/` | 同一个脚本 | 抽出的 Markdown，落点复用 `layout.py`，与现有网页产物同构 |

约束（越界即为 bug）：
1. **看板只 `spawn`，自己不写、不 `rename`、不 `unlink` 任何一个字节**，与资料转换、原型刷新同构；
2. 必须用户在参考 tab 点「刷新」明确发起，无后台、无定时、无自动入库；
3. 必须环回（`allowMutations`）且非跨站（`rejectIfForeignOrigin`）；
4. 请求**不带任何路径、不带文件名**。脚本自己扫 `visualization/references/`，slug 由脚本生成；
5. `input/raw/`、`output/`、`project.yaml`、`visualization/prototypes/` 仍然只读；已有参考目录里的 `index.html` 只读不改。

不同意这条例外，本 change 就不做看板按钮，退回只在终端里跑 `python3 scripts/web_ingest.py --inbox`。

## Capabilities

### New Capabilities

- `reference-inbox-refresh`：参考 tab 上由用户点击触发的收件箱入库（规范化散装页面 + 抽出可分析文本），含脚本探测、任务轮询、待入库提示与降级。

### Modified Capabilities

- `web-source-ingest`：尚未归档进 `openspec/specs/`，但 `workspace-markdown-convention` 已经落地。本 change 给它增加收件箱模式，并把「脚本不得写 `visualization/`」收窄为「URL 模式不得写；收件箱模式只允许把根上散装文件收成新参考目录」。

## Impact

跨服务端、契约、前端、`templates/` 四个平面；不动 CLI。`src/app/lib/api.ts` **要改**。

| 平面 | 影响 |
| --- | --- |
| 服务端 `src/server/**` | `references.mjs`：列出根上散装页面、给 `canInbox` / `pending`。`http.mjs`：新增 `POST/GET /api/projects/:id/web-ingest`，任务表与 ingest / proto-sync / capture 并列、不共用锁；`spawn` 工作空间 `scripts/web_ingest.py --inbox`，参数由服务端写死 |
| 契约 `src/app/lib/api.ts` | **要改**：`References` 增加可选 `canInbox?` / `pending?`；新增 `WebIngestJob` 类型与 `startWebIngest` / `webIngestStatus` |
| 前端 `src/app/**` | `CaptureBar` 在参考 tab 给链接输入右侧留一个动作位；`ReferencePanel` 接刷新按钮、运行态、结果行。旧服务进程缺字段时按钮不出现 |
| CLI `bin/cli.mjs` | 不动 |
| `templates/` | `scripts/web_ingest.py` 增加 `--inbox`；`AGENTS.md` 与 `pm-doc-ingest` 补收件箱路径。**放进去就是发给每个新建工作空间的** |
| 文档 | `AGENTS.md` 不变量 1 增加第五条窄例外；`dashboard-feature-flow` 的只读红线段落提一句；`smoke-package.mjs` 把新接口列入非环回 403 清单 |

**依赖：** 不引新 npm 包。`defuddle` 仍是工作空间脚本的 PATH 依赖（用户已全局安装），看板不 import、不进 `package.json`。Python 解释器复用 `platform.mjs` 的 `findPython`，与资料转换同一条。

**兼容性：**
- 旧服务 + 新前端：没有 `canInbox`，按钮不出现，行为与改动前一致。
- 新服务 + 旧前端：只多几个前端不认的字段，无变化。
- 没有 `scripts/web_ingest.py` 的旧工作空间：按钮不出现，清单照旧。
- 非环回监听：刷新接口 403，按钮不出现（与资料转换一致）。
