## 1. 服务端（src/server/**，改完重启 pnpm dev / serve）

- [x] 1.1 `http.mjs`：删 `addIgnore` / `removeIgnore` 及 `/ignore`、`/unignore` 路由
- [x] 1.2 `http.mjs`：`startIngest` 对空路径和 `input/raw` 根返回 400，不 spawn
- [x] 1.3 `scan.mjs`：删 `.ingestignore` 读取、`isIgnored`、`ignored` 判定与 `stats.ignored`；`state` 只剩 converted / pending

## 2. 契约（src/app/lib/api.ts）

- [x] 2.1 删 `addIgnore` / `removeIgnore`；`FileItem.ignored` 去掉，`state` 收窄；`stats.ignored` 去掉
- [x] 2.2 `RawOrganizePlan.ignore` 改为可选，注释写明旧脚本才会给

## 3. 前端

- [x] 3.1 `InputPanel.tsx`：删忽略 / 解除忽略菜单、`ignore` 回调与报错、忽略筛选与计数、`ignored` 标签分支；运行时 `ignored` 按待转显示
- [x] 3.2 `InputPanel.tsx`：目录汇总去掉「忽略」，只剩待转 / 已转 / 部分
- [x] 3.3 `InputPanel.tsx`：`IngestControls` 去掉「开始转换」按钮，保留进度与报错；顶部说明文案同步
- [x] 3.4 `RawOrganizeDialog.tsx`：预览不再渲染忽略规则与通配符警告，说明文案去掉忽略规则
- [x] 3.5 本地存的筛选值 `ignored` 读出来退回「全部」（`isRawFilter` 自然覆盖，确认即可）

## 4. 模板（templates/，放进去就是发出去）

- [x] 4.1 `scripts/layout.py`：删 `IGNOREFILE`、`load_ignore`、`is_ignored`、`add_ignore_flags`、`ignore_patterns`
- [x] 4.2 `ingest.py`、`pointtable.py`、`web_ingest.py`、`migrate_converted.py`：去掉忽略过滤与 `--ignore` / `--no-ignore`，台账不再写忽略段
- [x] 4.3 `move_raw.py`：删 `ignore_plan` 与结果里的 `ignore` 字段、相关输出
- [x] 4.4 `ingest.py`：`paths` 为空且非 `--dry-run` 时打印带路径的用法示例并以非 0 退出，不写任何文件；帮助文案里「默认整个 input/raw/」改掉
- [x] 4.5 删 `input/.ingestignore`；`template.yaml` seedOnly 去掉它；`init_workspace.py` 不再铺
- [x] 4.6 文案：模板 `AGENTS.md`、`README.md`、`input/README.md`、`.gitignore` 注释、`templates/help.md`、`pm-doc-ingest` 与 `pm-template-update` 技能、`init_workspace.py` 结尾提示 —— 去掉忽略，ingest 示例一律带路径；`pm-template-update` 提示遗留 `.ingestignore` 不再生效、不删
- [x] 4.7 自测：合成工作空间里 `python3 scripts/ingest.py` 退出码非 0 且 `output/` 与 `input/INDEX.md` 无变化；`--dry-run` 能出计划；带文件路径正常转换

## 5. 文档与回归

- [x] 5.1 根 `AGENTS.md` 不变量 1 删掉忽略写入例外，其它提到忽略的地方同步
- [x] 5.2 `scripts/smoke-package.mjs`：删忽略接口断言与写接口清单里的 `/ignore`，铺设骨架不再要求 `.ingestignore`，加「ingest 空路径 400」
- [x] 5.3 `scripts/check-move-raw.mjs` 与 `fixtures/raw-move/`：删忽略规则用例
- [x] 5.4 全仓 grep `ingestignore` / `ignored` / `开始转换` / 不带路径的 `scripts/ingest.py`，只剩归档产物与历史 spec

## 6. 验收闸

- [x] 6.1 `pnpm typecheck`、`pnpm build` 都绿；`node scripts/check-move-raw.mjs`、smoke 能跑的部分通过
- [x] 6.2 重启看板后浏览器点一遍原始资料：无全局按钮、无忽略菜单 / 筛选、目录标签、单份转换、移动预览
- [x] 6.3 无 project.yaml、工作空间目录丢失、深色模式三种情况各看一眼不白屏
