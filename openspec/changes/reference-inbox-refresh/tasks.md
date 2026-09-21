## 1. 工作空间脚本（`templates/pm-aispace/scripts/web_ingest.py`）

- [x] 1.1 `normalize_url` 保留 fragment（SPA 路由在 hash 里）。无 fragment 的普通地址行为与改前一致。URL 模式复用同一函数
- [x] 1.2 解析 SingleFile 页头注释与 `<title>`：抽出 `url` / `saved date`；不是合法 `http`/`https` 的地址丢弃，不写进 `sourceUrl`
- [x] 1.3 slug 生成对齐 `capture.mjs` 的规则（保留中文、去掉路径分隔符与控制字符、撞名 `-2` `-3`），只用于新建目录
- [x] 1.4 实现 `--inbox`：扫描 `visualization/references/` 根上的 `.html` / `.htm`；每份新建目录、写 `meta.json`（`source: manual`）、`shutil.move` 成 `index.html`；已有参考目录不覆盖、不改名、不删
- [x] 1.5 `--inbox` 第二步：遍历所有合格参考目录，复用现有 defuddle / sanitize / `layout.py` 落点。没有 URL 时 `source` 记参考路径，host 用 `dropped`
- [x] 1.6 批量：单份失败不回滚其它份；缺 `defuddle` 整批失败、打印安装命令、不留半截目录。看板调用路径不带 `--overwrite` / `--as-new`，正文已变则跳过并说明
- [x] 1.7 文档字符串改成两种入口都写清；URL 模式仍不向 `visualization/` 写入。用一份合成的散装 HTML 在模板工作空间跑通 `--inbox`（不要用真实客户页）

## 2. 服务端产出数据（`src/server/references.mjs`）

- [x] 2.1 扫描根上散装 `.html` / `.htm` 的份数，作为 `pending` 下发；它们仍不进 `items`
- [x] 2.2 探测 `scripts/web_ingest.py` 是否存在，下发 `canInbox`（布尔）。读失败降级为 `pending: 0` / `canInbox: false`，不抛
- [x] 2.3 重启 `pnpm dev`，`curl` 扫描接口核对：根上放两份合成 html 时 `pending === 2` 且 `items` 不含它们；合格目录仍在 `items` 里；没有脚本的工作空间 `canInbox === false`

## 3. 服务端接口（`src/server/http.mjs`）

- [x] 3.1 新增 `webIngestJobs` 任务表（与 ingest / proto-sync / capture 并列，不共锁）与 `startWebIngest(project)`：脚本不存在或找不到 Python 时 400；工作空间不可用时 4xx；`spawn` 参数写死为脚本路径 + `--inbox`，cwd 为工作空间根
- [x] 3.2 路由 `POST/GET /api/projects/:id/web-ingest`：POST 先过 `rejectIfRemoteWrite` 与 `rejectIfForeignOrigin`；GET 返回任务状态（没有任务时给 idle 缺省形状）；运行中再 POST 得 409
- [x] 3.3 stdout/stderr 进日志，`error` 事件不崩进程；退出码 0 为 done，其它为 error；message 取脚本输出的摘要，不要改写成「操作失败请重试」
- [x] 3.4 重启 `pnpm dev`，curl 核对：正常 POST 返回 running → GET 轮询到 done；运行中再 POST 得 409；请求体带路径也被忽略（脚本仍扫根目录）；`--host 0.0.0.0` 起服务 POST 得 403；带外站 Origin 得 403

## 4. 同步契约（`src/app/lib/api.ts`）

- [x] 4.1 `References` 增加可选 `canInbox?: boolean` 与 `pending?: number`，注释写清：缺 `canInbox` 就不显示刷新按钮，缺 `pending` 就不提示待入库
- [x] 4.2 新增 `WebIngestJob` 类型（与 `IngestJob` 同构即可，不要 `path` / `item`）；`api` 增加 `startWebIngest(id)` 与 `webIngestStatus(id)`，注释写清旧服务进程 404 时的提示、请求不带路径

## 5. 前端接入（`src/app/**`）

- [x] 5.1 `CaptureBar` 在链接输入右侧加可选 `extraAction`；原型 tab 不传，布局不变
- [x] 5.2 `ReferencePanel`：`canInbox === true` 时渲染刷新按钮（`RefreshCw`，进行中转圈）；`canInbox` 缺省或 `false` 时不渲染。非环回时沿用现有采集入口的隐藏逻辑，刷新按钮一起消失
- [x] 5.3 点击调用 `startWebIngest` 并轮询 `webIngestStatus`；运行中禁用；卸载时停轮询；进页时若已有 running 任务要接上。结果走 Alert：done 中性、error 用 `--destructive`，文案原样显示
- [x] 5.4 `pending > 0` 时左侧 status 用 `--destructive` 提示「N 份散装页面未入库，点右侧刷新」；`pending` 缺省或 0 时不提示
- [x] 5.5 空态 hint 改一句：散装文件丢进根目录后点刷新即可，不再只写「扫不到」

## 6. 自动刷新范围

- [x] 6.1 确认规范化写入的 `visualization/references/<slug>/` 与 Markdown 写入的 `input/converted/` 都在 `watchWorkspace` 已有监听内；刷新完成后参考 tab 与输入资料树无需手动刷新

## 7. 文档与冒烟

- [x] 7.1 `AGENTS.md` 不变量 1 增加第五条窄例外：范围、谁写、五条约束（见 proposal）；`http.mjs` 那一行目录树注释补一句。**不把例外清单复制进其它文件**
- [x] 7.2 `.claude/skills/dashboard-feature-flow` 只读红线段落仍只引用 AGENTS.md，不复制新例外正文
- [x] 7.3 `templates/pm-aispace/AGENTS.md`「阶段一之五：网页资料」与 `pm-doc-ingest` 技能补收件箱路径；技能里只加指针和何时走 `--inbox`，不复述写法规范
- [x] 7.4 `scripts/smoke-package.mjs` 把 `POST /api/projects/:id/web-ingest` 列入非环回 403 与跨站拒绝的写入接口清单

## 8. 验收闸

- [x] 8.1 `pnpm typecheck` 绿
- [x] 8.2 `pnpm build` 绿
- [x] 8.3 重启 `pnpm dev` / `serve`。在一个带 `scripts/web_ingest.py` 的工作空间里：根上丢一份合成的自包含 HTML → 参考 tab 出现待入库提示 → 点刷新 → 卡片出现、输入资料里能打开 Markdown、溯源 front-matter 看得到。再点一次刷新应跳过（幂等）
- [x] 8.4 降级：没有 `web_ingest.py` 的工作空间按钮不出现；无 `project.yaml` 的工作空间刷新仍可用（或按不可用规则 4xx，不白屏）；目录被移走的工作空间点刷新不崩；旧字段缺省时参考 tab 与改动前一致
- [x] 8.5 深色模式下再走一遍 8.3：待入库提示是 orange、成功结果不是
- [x] 8.6 过一遍脱敏红线：本 change 的四份产物、脚本注释、技能补丁里没有真实客户名、本机绝对路径、内网地址、凭据
