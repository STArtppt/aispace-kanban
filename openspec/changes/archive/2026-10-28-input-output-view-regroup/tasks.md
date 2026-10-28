> 前置：`docx-output-to-delivery` 已完成并归档。

## 1. 视图：去掉概览、资料台账（前端为主）

- [x] 1.1 `useBoardSession.ts` 去掉 `overview`，默认与兜底改为 `input`；`App.tsx` 删 `NAV` 项与渲染分支
- [x] 1.2 `OverviewPanel.tsx` 精简为 `LedgerOverview`（抬头、三格统计、单行四步进度、元信息摘要；去「最近的产出」），只用令牌
- [x] 1.3 前端 `FileItem.reader` 加 `ledger`；`Reader.tsx` 渲染 `LedgerOverview` + `INDEX.md` 正文（无 INDEX 时只渲染概览）
- [x] 1.4 `InputPanel.tsx`：原始资料顶部固定「资料台账」行，移除底部台账卡片

- [x] 1.5 `OutputPanel.tsx` 页签文案：「分析产物」「交付文档」；同步模板 `AGENTS.md`、`output/README.md`、`output/records/README.md` 及代码注释里的旧叫法

## 2. 原始资料状态标签

- [x] 2.1 `scan.mjs` `scanInput`：raw 条目加 `state` 与 `stale`（重启 pnpm dev 后 curl 核对）
- [x] 2.2 `api.ts`：raw 条目可选 `state?: 'converted' | 'pending' | 'ignored'`、`stale?: boolean`
- [x] 2.3 `InputPanel.tsx`：原始资料改列全量 raw、行内标签、状态筛选（本地存储 try/catch）、按状态给行内操作；缺 `state` 时退回只列 pending

## 3. 服务端双布局

- [x] 3.1 `scan.mjs`：`convertedRootOf(root)`；转换产物扫描、`describeConverted` 范围校验、`converted-md` docKey 改用它；scan 下发可选 `input.layout`
- [x] 3.2 `citations.mjs`：`input/converted/` 前缀别名
- [x] 3.3 `docxTools.mjs` / `md2docx` 落点 JS 规则：来源 `output/converted/<子路径>.md` → `output/delivery/converted/<子路径>/`，与旧布局同一镜像
- [x] 3.4 `http.mjs` 注释更新；确认 SSE 范围无需改动；重启 pnpm dev，分别在新旧布局工作空间 curl scan

## 4. 前端「转换产物」挪到产出文档

- [x] 4.1 把转换产物列表组件从 `InputPanel.tsx` 抽出复用；`OutputPanel.tsx` 新增「转换产物」栏（排在三组后）
- [x] 4.2 `InputPanel.tsx` 删掉转换产物页签，记住的页签 `converted` 退回「原始资料」
- [x] 4.3 旧布局 / 残留提示条；交付稿栏在新位置正常出现
- [x] 4.4 `api.ts` 注释：`input.converted` 的根目录随布局；`input.layout` 可选

## 5. 模板与迁移脚本（templates/pm-aispace）

- [x] 5.1 `layout.py`（`CONVERTED`）、`db_ingest.py`、`web_ingest.py`、`pointtable.py`、`realdata.py`、`check_markdown.py`、`md2docx.py` 改新路径；`ingest.py` 的 `ASSETS` 保持 `input/assets`，确认图片链接按产物目录跨目录生成
- [x] 5.2 新增 `scripts/migrate_converted_to_output.py`（`--dry-run`、`--reverse`、只搬 `input/converted/`、链接解析→映射→重算、`INDEX.md` 改写、执行后自检）
- [x] 5.3 合成回归语料：迁移前后链接可达、目标非空时拒绝；接进现有 scripts 校验
- [x] 5.4 模板 `AGENTS.md`、`input/README.md`、`output/README.md`、`.gitignore`、引用旧路径的技能全部改新路径；`grep` 复查只剩迁移脚本与兼容说明
- [x] 5.5 模板 `.gitignore`：`input/raw|assets|sources` 整目录忽略并放行 `.gitkeep` 与 sources 的两份说明；删 `input/**/*.<扩展名>`；二进制规则改挂 `output/converted/**`；在模板工作空间用 `git check-ignore -v` 抽查
- [x] 5.6 本仓 AGENTS.md：不变量 1 第五条、基础写入「资料转换」、第九条输入来源的路径文字

## 6. 验收与同步

- [x] 6.1 `pnpm typecheck`、`pnpm build` 全绿
- [x] 6.2 重启 `pnpm dev`；浏览器：无概览视图且旧会话兜底；台账预览（有/无 project.yaml、有/无 INDEX.md、深色模式）；原始资料标签与筛选；产出文档的转换产物栏与交付稿栏；工作空间目录丢失的降级
- [x] 6.3 旧布局工作空间：看板提示迁移、功能正常；对一个实例副本跑迁移脚本 `--dry-run` 与执行，确认图片与「被引用」正常
- [x] 6.4 `local-source-sync` 推模板到已登记实例（本 change 的全部模板改动，含 A 未同步的部分）
- [x] 6.5 逐个实例：对照合并 `.gitignore`（seedOnly，保留实例自加的行）；列出已跟踪的 `input/raw|assets|sources` 文件，用户确认后 `git rm --cached`
- [x] 6.6 逐个实例：迁移脚本 `--dry-run` → 用户确认 → 执行 → 看板核对图片、「被引用」、交付稿 Word 落点
