## 1. 服务端产出聚合数据（`src/server/prototypes.mjs`）

- [x] 1.1 `readSyncMd(dirAbs)`：按行标签解析 `SYNC.md` 表格，产出 `{ commit, localChangedAt, syncedAt, offlineStale }`；读不到 / 解析不出一律返回空对象，注释写明对应脚本版本
- [x] 1.2 `listLinkedDocs(root, slug)`：walk `spec/ docs/ annotations/ comments/` 只收 `.md`，加上 `SYNC.md`；产出 `{ path, group, label }`，路径为工作空间相对 POSIX 写法；显示名规则按 design 决策 6
- [x] 1.3 `listPrototypePackages` 里对「无 index.html」的目录，除了 `meta.json` 外也检查 `SYNC.md`：有 `SYNC.md` 没 `meta.json` 时也要入表（form 仍为 url、target 为空），避免未发布原型被漏掉
- [x] 1.4 `scanPrototypes` 末尾加聚合：给镜像目录条目挂 `linked`（offline / online / sync / docs / duplicates），给 `<slug>-html.zip` 与规范化链接相同的 url 条目挂 `groupedInto`；`onlineStale` 只在两个时间都合法时计算
- [x] 1.5 保留旧字段形状，被并入的条目不从 `items` 删除
- [x] 1.6 重启 `pnpm dev`，用合成工作空间（`SYNC.md` + `meta.json` + zip + 重复 url 目录）`curl /api/projects/<id>/prototypes` 核对新字段；再对没有 `SYNC.md` 的工作空间核对输出与改动前一致
- [x] 1.7 （实施中发现）url 形态的 `cover.png` 走 `/proto/` 路由时 `resolvePrototypeServeDir` 返回空、一律 404：新增 `resolvePrototypeCover`，`http.mjs` 只对 `cover.png` 放行；重启后 curl 核对封面 200、`../` 穿越 404

## 2. 同步契约（`src/app/lib/api.ts`）

- [x] 2.1 新增 `PrototypeDoc`、`PrototypeLinked` 类型，全部字段可选并写清降级语义
- [x] 2.2 `PrototypeItem` 增加可选 `linked?: PrototypeLinked`、`groupedInto?: string`

## 3. 前端接入（`src/app/**`）

- [x] 3.1 新建 `components/LinkedPrototypeRow.tsx`：封面、打开离线包 / 在线版、三格状态、资料分组列表（每组默认 12 条 + 展开全部）、行底提示
- [x] 3.2 `PrototypePanel` 分两段：带 `linked` 的走行，其余（排除 `groupedInto`）走现有 `ShowcaseGrid`；没有任何 `linked` 时不出分段标题
- [x] 3.3 `VisualPanel` 与 `App.tsx`：把 `onOpen` 传进来，资料点击拼成 `FileItem` 打开阅读器；核对视觉视图下阅读器能正常并排
- [x] 3.4 `VisualPanel` 原型 tab 计数排除 `groupedInto`
- [x] 3.5 orange 只用在在线版落后、离线包没更新、重复卡片提示三处，其余走语义灰阶令牌

## 4. 自动刷新范围

- [x] 4.1 确认 `watchWorkspace` 已递归监听 `visualization/`，同步脚本写入后原型 tab 自动更新；无需改动（`visualization/` 早已在监听列表里）

## 5. 验收闸

- [x] 5.1 `pnpm typecheck` 绿
- [x] 5.2 `pnpm build` 绿
- [x] 5.3 重启 `pnpm dev`，浏览器把「视觉内容 · 原型」点一遍：已接入原型行、点开规格进阅读器（行高亮）、在线版落后标 orange、封面加载。实施中发现阅读器打开后原型行被按视口断点挤成一字一行，已改为容器查询
- [ ] 5.4 降级路径：无 `SYNC.md` 的工作空间已用接口核对（不出现 `linked` / `groupedInto`）；旧服务进程配新前端走 `linked` 缺省即回卡片网格的分支（代码核对）。**无 `project.yaml`、目录丢失两种没有在浏览器里点过**
- [x] 5.5 深色模式下再点一遍（用侧栏「切换主题」按钮）
