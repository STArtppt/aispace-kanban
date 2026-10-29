## 0. 人工拍板（动手前）

- [x] 0.1 用户明确同意不变量 1 新增第十三条（spawn 族；写入面以 proposal 的边界和 design 决策 4 至 7 为准）。未同意前不改 `AGENTS.md`、不新增脚本、不改服务端和前端

## 1. 工作空间脚本（templates）

- [x] 1.1 新建 `templates/pm-aispace/scripts/move_raw.py`：`--source` 加 `--to`（改名）或 `--into`（移动）二者只取一个；`--dry-run` 或 `--apply --expect <指纹>`；`--json`。校验落在 `input/raw/` 内、非 `input/raw` 自己、非符号链接。基名规则同 design 决策 8
- [x] 1.2 按现有 `source` 找到产物，用 `layout.py` 算新落点；原件与产物用目录重命名，不改原件字节；落点已存在退出 2；`rename` 跨设备失败退出 4，不改成复制
- [x] 1.3 点表集按 design 决策 5：单个点表文件改名或移动退出 4；点表集目录移进别的目录、或含点表文件的子树换顶层目录退出 4；点表集原地改名时按 `merge_paths` 搬走合并产物，更新 `source` / `sources` 和台账 `input/raw/<名>/` 行。判定调用 `ingest.is_pointtable`。现场实测数据按普通一源多产物（`split_paths`）处理
- [x] 1.4 改写范围与排除按 design 决策 6、7。忽略规则按「字面命中 / 只靠 glob 命中」分类，不按有没有 `* ? [`。内容变了的原稿，其交付稿 `source_sha` 换新（复用 `rename_output.py` 第二轮）。链接解析导入 `rename_output.py`；不能导入时抽到 `scripts/mdlinks.py` 并让 `rename_output.py` 改调用，再跑 `pnpm test:rename` 确认行为不变
- [x] 1.5 计划指纹按 design 决策 3（含被移动子树的文件清单、大小、mtime）；`--apply` 重算不符退出 3。落盘按 design 决策 9 的三段：暂存、改名（按需建镜像父目录，失败倒序改回并删本次新建的空目录）、替换（失败不回滚、如实列出）。临时文件去向按改名列表逐个换算，不沿用只认一个镜像目录的写法
- [x] 1.6 合成回归 `scripts/check-move-raw.mjs` 与 `package.json` 的 `test:raw-move`：文件改名后产物 `source`、台账行、相对图片链接、字面忽略规则跟着走，`input/assets/` 文件路径不变；文件名带 `[ ]` 的字面忽略规则被改写；目录移动；通配符忽略规则不改但出现在预览；人工批注原文保留；交付稿 `source_sha` 换新；点表单文件被拒、点表集移进子目录被拒、点表集原地改名成功；现场数据文件单独移动成功；只改大小写放行；落点冲突退出 2；指纹不符不落盘（含目录里新放进文件）；旧位置 `input/converted/` 拒绝且不改名；交付稿 `v*.md` 正文不改；`output/delivery/converted/` 的 `.docx`、`.claude/` 与 `input/sources/` 不改
- [x] 1.7 `templates/pm-aispace/AGENTS.md` 两处（目录表「只读，永不改动删除」、权限表「不碰 / 原件只读」）：原件内容不改不删；改名和移动只走看板或 `scripts/move_raw.py`，不要在文件夹里手改

## 2. 服务端（`src/server/**`，改完重启 `pnpm dev`）

- [x] 2.1 `scan.mjs`：原始文件下发 `organizeKey`；下发 `rawDirs`（只含其下至少有一个已列出文件的目录）；`canOrganizeRaw` 与可选 `organizeRawBlock`（`no-script` / `legacy-converted`）
- [x] 2.2 `http.mjs`：`POST projects/:id/raw-organize/preview` 与 `POST projects/:id/raw-organize`。`allowMutations` + `rejectIfForeignOrigin`。请求只有 `key` 与 `name` 或 `destKey` 其中一个，`destKey` 可为 `root`。重扫反查后 `resolveInside()`，再 spawn。退出码 2、3 → 409，4 → 400，超时 504。产物在旧位置或没有脚本时 400，不 spawn
- [x] 2.3 重启 `pnpm dev` 后用 curl 验证：预览不改磁盘、非法基名 400、同时带 `name` 和 `destKey` 400、非环回 403

## 3. 契约（`src/app/lib/api.ts`）

- [x] 3.1 可选字段 `organizeKey`、`rawDirs`、`canOrganizeRaw`、`organizeRawBlock`；预览与执行的请求和响应类型；`api.rawOrganizePreview` / `api.rawOrganize`。缺字段时类型上保持可选

## 4. 前端（`src/app/**`）

- [x] 4.1 `FileTree` 增加可选的拖放回调。不传回调时产出清单和转换产物的树与现在相同。原始资料只在树形视图、筛选为「全部」且搜索为空时启用；放下只打开预览
- [x] 4.2 `InputPanel.tsx`：文件行和目录行增加「重命名」「移动到…」。置灰文案按 `canOrganizeRaw` 缺失、`no-script`、`legacy-converted`、目录丢失四种情况区分。忽略行仍保留「在访达中显示」，不出现「取消忽略」
- [x] 4.3 预览弹窗：路径与将更新的处数，通配符忽略规则单独列出；预览未成功时「确定」不可点。转换产物行的「重命名」提示改为到原始资料里整理
- [x] 4.4 成功后按响应里的路径对照，更新收藏置顶和当前打开的原件或产物

## 5. 文档

- [x] 5.1 按 0.1 同意的原文，把第十三条写进 `AGENTS.md` 不变量 1，并在开头「spawn 族」的编号列表里补上「十三」；第 3 节服务端说明补上整理入口
- [x] 5.2 若实现时踩了坑，往 `dashboard-feature-flow` 或 `systematic-debugging` 补一行

## 6. 验收闸

- [x] 6.1 `pnpm typecheck` 绿、`pnpm build` 绿、`pnpm test:raw-move` 绿；若抽了 `mdlinks.py`，`pnpm test:rename` 也绿
- [x] 6.2 重启 `pnpm dev`，`curl -s localhost:7788/api/health` 成功
- [x] 6.3 浏览器：在合成工作空间里给已转换文件改名，确认仍是「已转」、台账和产物路径跟着走、图片还能打开；把目录拖到另一目录并确认；预览未确定时磁盘不变；同名冲突看到 409 且文件留在原地；点表集里的单个文件被拒绝、点表集拖进子目录被拒绝；筛选为「待转」时不能拖，但「移动到…」仍能选中目录。再把转换产物行的「重命名」悬停提示点开核对
- [x] 6.4 降级与外观：没有 `project.yaml` 的工作空间仍可打开预览；目录丢失时置灰；删掉脚本后的置灰提示；深色模式下弹窗跟随令牌，没有新的硬编码色值
