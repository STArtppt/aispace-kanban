## 0. 前置（外部，不在本仓）

- [ ] 0.1 原型工作区同步脚本在每次拉取时于镜像目录写 `sync.json`（`schemaVersion` / `script` / `protoDir`），并把它加入脚本整份覆盖的文件清单与其约定文档
- [ ] 0.2 对已接入的原型跑一次同步，确认镜像里出现 `sync.json`

## 1. 服务端产出数据（`src/server/prototypes.mjs`）

- [ ] 1.1 `readSyncTarget(mirrorAbs, workspaceRoot)`：读 `sync.json`，按 design 决策 1 做三道校验（脚本名与存在、原型目录存在、`.workspace-link.json` realpath 回指），返回 `{ available, reason, script?, protoDir? }`；任何读失败降级为不可用 + 中文原因，不抛
- [ ] 1.2 `aggregateLinked` 给每个已接入原型挂 `linked.refresh = { available, reason? }`（只下发这两个字段，脚本路径不出服务端）
- [ ] 1.3 导出 `resolveRefreshTarget(root, itemKey)`：只按扫描清单里的 slug 命中，返回校验通过的 `{ script, protoDir, title }`，不命中或不可用时抛带 `statusCode` 的中文错误（404 / 400）
- [ ] 1.4 重启 `pnpm dev`，`curl /api/projects/<id>/prototypes` 核对：带 `sync.json` 的镜像 `refresh.available === true`；删掉 / 改坏 `sync.json`、改登记回指时分别得到对应 `reason`；无 `SYNC.md` 的工作空间输出与改动前一致

## 2. 服务端接口（`src/server/http.mjs`）

- [ ] 2.1 新增 `protoSyncJobs` 任务表（与 `ingestJobs` 并列，不共锁）与 `startProtoSync(project, item)`：409 防重、`spawn(process.execPath, [script, protoDir, '--both'], { cwd: protoDir })`、stdout/stderr 进日志、`error` 事件不崩进程、10 分钟看门狗
- [ ] 2.2 `summarizeProtoSyncLog(log, exitCode)`：按 design 决策 5 取 `!` / `✓` / `✗` 行
- [ ] 2.3 路由 `POST/GET /api/projects/:id/proto-sync`：POST 先过 `rejectIfRemoteWrite` 与 `rejectIfForeignOrigin`，工作空间不可用时报错；GET 返回任务状态（`idle` 缺省形状）
- [ ] 2.4 重启 `pnpm dev`，curl 核对：正常 POST 返回 running → GET 轮询到 done 且 message 为脚本汇报；运行中再 POST 得 409；`item` 传 `../x` 得 404；`--host 0.0.0.0` 起服务 POST 得 403；带外站 Origin 得 403

## 3. 同步契约（`src/app/lib/api.ts`）

- [ ] 3.1 `PrototypeLinked` 增加可选 `refresh?: { available: boolean; reason?: string }`，注释写清缺省即不显示按钮
- [ ] 3.2 新增 `ProtoSyncJob` 类型；`api` 增加 `startProtoSync(id, item)` 与 `protoSyncStatus(id)`，注释写清旧服务进程 404 时的提示

## 4. 前端接入（`src/app/**`）

- [ ] 4.1 `LinkedPrototypeRow`：`refresh` 存在时在两个打开按钮前加「刷新」按钮（outline + 旋转图标）；不可用置灰、`title` 显示 reason
- [ ] 4.2 点击调用 `startProtoSync` 并按资料转换的写法轮询 `protoSyncStatus`；运行中禁用按钮并显示进行中文案；组件卸载时停止轮询；进入页面时若已有该原型的 running 任务要接上轮询
- [ ] 4.3 结果行放在行底提示区：done 灰色列 message，error 用 `--destructive` 列 message；接口报错（409 / 400 / 404）原样显示
- [ ] 4.4 核对 orange 只出现在失败结果与既有三处状态，其余走灰阶令牌

## 5. 自动刷新范围

- [ ] 5.1 确认镜像写盘在 `watchWorkspace` 的 `visualization/` 递归监听内，刷新完成后原型 tab 无需手动刷新；推送清单写在工作空间外，只在结果行体现，不接 SSE

## 6. 文档

- [ ] 6.1 `AGENTS.md` 不变量 1 增加第三条窄例外：范围、谁写、五条约束（见 proposal），并在「三个平面与目录结构」里 `http.mjs` 的注释补一句
- [ ] 6.2 `.claude/skills/dashboard-feature-flow` 步骤 1 的只读红线段落把例外清单改为引用 AGENTS.md，不复制
- [ ] 6.3 若 `scripts/smoke-package.mjs` 断言了接口清单或写入收口，确认不受影响（本接口需要外部脚本，冒烟不覆盖）

## 7. 验收闸

- [ ] 7.1 `pnpm typecheck` 绿
- [ ] 7.2 `pnpm build` 绿
- [ ] 7.3 重启 `pnpm dev`，浏览器「视觉内容 · 原型」点一遍：刷新按钮运行态 → 完成后在线版发布时间与同步时间更新、结果行显示；关掉 Make 管理端再刷新，离线包格标 orange、结果行列出导出失败原因
- [ ] 7.4 降级：删掉 `sync.json` 按钮置灰带原因；无 `project.yaml` 的工作空间、目录被移走的工作空间各点一遍（不出现可点按钮、不白屏）
- [ ] 7.5 深色模式下再点一遍
