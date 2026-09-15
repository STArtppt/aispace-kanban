## Why

不做的话，用户在原型工作区（Axhub Make）里发布、批注之后，看板上的「在线版落后」「离线包没更新」会一直挂着，
直到用户切到终端、进另一个仓库、敲一长串同步命令 —— 看板明明已经知道哪份原型过期了，却只能给一句「去跑命令」。

上一个 change（`prototype-linked-group`）让看板认得同步镜像并把过期状态标成 orange。
原型工作区的同步脚本随后也补上了反方向：除了把原型资料**拉**进工作空间，还能把工作空间的变更清单**推**给原型侧。
两个方向都只能手动在终端里触发，而用户在看板上发现问题的那一刻离「刷新」只差一个按钮。

## What Changes

- **已接入原型行加「刷新」按钮**，位置在「打开离线包 / 打开在线版」前面。点一下 = 让看板起子进程跑
  原型工作区自己的同步脚本，一次做完**拉取**（离线包、在线链接、规格 / 文档 / 标注 / 批注）和**推送**（工作空间变更清单写给原型侧）。
- **任务模型沿用资料转换**：接口立刻返回，前端轮询进度；一个工作空间同一时刻至多一个刷新任务，重复点返回 409。
  完成后镜像落盘被 `visualization/` 的 SSE 捕获，行自己刷新；行里显示脚本汇报的结果（成功灰色、失败 orange）。
- **看板怎么找到脚本**：同步脚本每次拉取时在镜像目录多写一份机读的 `sync.json`（脚本路径、原型目录）。
  看板执行前做三道校验，任何一道不过就不显示可用的按钮并说明原因：
  ① 脚本文件名必须是 `workspace-sync.mjs` 且真实存在；② 原型目录存在；
  ③ 原型目录里的登记文件 `.workspace-link.json` **回指当前工作空间**（真实路径相等）。
  命令参数由看板固定拼（`<原型目录> --both`），不从任何文件读参数。
- **Make 管理端没开、离线包导出失败**：脚本本来就会照常同步文档并在 `SYNC.md` 记「本次未更新」，
  看板沿用已有的「离线包没更新」orange 状态，不另起一套错误态。
- **没有 `sync.json` 的旧镜像**：按钮置灰，提示「先在原型工作区跑一次同步」。旧服务进程不下发新字段，按钮不出现。

## ⚠ 需要拍板：放宽只读红线（新增第三条窄例外）

**这个 change 会让看板发起的子进程写工作空间，并且写工作空间以外的另一个仓库。** 用户已在会话中确认要做，
但它改动的是 AGENTS.md 不变量 1，必须在这里单独列清范围，实施时一并写进 AGENTS.md：

| 写哪里 | 谁写 | 范围 |
| --- | --- | --- |
| `<工作空间>/visualization/prototypes/<slug>/`（镜像目录）与同级 `<slug>-html.zip` | 原型工作区的同步脚本 | 脚本自己的约定：只整份覆盖 `spec/ docs/ annotations/ comments/ meta.json SYNC.md sync.json`，其它文件不碰 |
| 原型目录里的 `.workspace-inbox.md` | 同一个脚本 | 只这一份清单文件，不拷内容、不改原型源 |

约束（越界即为 bug）：
1. **看板只 `spawn`，自己不写任何一个字节**，与资料转换、新建工作空间同构；
2. 必须用户在看板上点按钮发起，无后台、无定时；
3. 必须环回（`allowMutations`）且非跨站（`rejectIfForeignOrigin`）；
4. 请求只带原型的 `itemKey`，**不接受任何路径**；脚本路径与原型目录只来自通过三道校验的 `sync.json`；
5. `input/` `output/` `project.yaml` 仍然只读 —— 推送方向只**读**它们的修改时间。

不同意这条例外，本 change 就不做，退回在界面上给复制命令。

## Capabilities

### New Capabilities
- `prototype-refresh`：在已接入原型行上由用户点击触发原型工作区的双向同步（拉取 + 推送），含脚本定位与回指校验、任务轮询、结果展示与降级。

### Modified Capabilities
（无。`prototype-linked-group` 尚未归档为主规格；本 change 不改它的聚合与状态判定，只在 `linked` 上新增一块可选字段。）

## Impact

跨服务端、契约、前端三个平面；不动 CLI、不动 `templates/`；另需原型工作区同步脚本配合写 `sync.json`（不在本仓）。

| 平面 | 影响 |
| --- | --- |
| 服务端 `src/server/**` | `prototypes.mjs`：读并校验镜像里的 `sync.json`，给 `linked` 挂 `refresh`（可用 / 不可用原因）；导出按 `itemKey` 解析刷新目标的函数。`http.mjs`：新增 `POST/GET /api/projects/:id/proto-sync`，任务表与 `ingestJobs` 并列、不共用锁；用 `process.execPath` 起 node，不新增平台分支 |
| 契约 `src/app/lib/api.ts` | **要改**：`PrototypeLinked` 增加可选 `refresh?: { available: boolean; reason?: string }`；新增 `ProtoSyncJob` 类型与 `startProtoSync` / `protoSyncStatus` 两个方法 |
| 前端 `src/app/**` | `LinkedPrototypeRow` 加刷新按钮、运行态、结果行；轮询沿用资料转换的写法 |
| CLI `bin/cli.mjs` | 不动 |
| `templates/` | 不动 |
| 文档 | `AGENTS.md` 不变量 1 增加第三条窄例外；`dashboard-feature-flow` 的只读红线段落同步提一句 |

**依赖：** 不引新包。子进程用看板自己的 node（`process.execPath`），不依赖 PATH 里的 node。

**兼容性：**
- 旧服务 + 新前端：没有 `refresh` 字段，按钮不出现，行为与改动前一致。
- 新服务 + 旧前端：只多一个前端不认的字段，无变化。
- 镜像没有 `sync.json`（旧版同步脚本写的）：按钮置灰并说明原因，聚合与状态照旧。
- 非环回监听：刷新接口 403，按钮不出现（与资料转换一致）。
