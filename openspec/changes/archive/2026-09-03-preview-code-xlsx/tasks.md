## 1. 代码类文本高亮（只前端，不重启服务也生效）

- [x] 1.1 在 `src/app/components/` 新增代码文件视图（不改 `components/ui/code-block.tsx`）：
      用已有 Shiki 按语言高亮，每行包 `span.block` 放进 `<pre>`（检索继续走 `collectBlocks` 的纯文本分支），
      显示行号但不把行号写进复制文本；整文件撑满阅读区，不要套围栏代码块的 `max-h-80`。
      语言映射：`.yaml`/`.yml` → yaml，`.json` → json，`.xml` → xml。高亮失败退回现在的裸 `<pre>`。
- [x] 1.2 `Reader.tsx`：`mode === 'text'` 且扩展名是 yaml/yml/json/xml 时走 1.1；
      `.txt` 保持现有纯文本。`textPreRef` / `getSearchRoot` 仍指向那份 `<pre>`，搜索按钮继续出现。
      代码预览不启用批注。
- [x] 1.3 复制入口：复制结果是文件原文，不含行号。

## 2. 服务端 xlsx 分页与检索（改完必须重启进程）

- [x] 2.1 服务端 `dependencies` 加上 SheetJS 社区版 `xlsx`（钉版本）。只在服务端 import，不进前端。
      组包脚本按 import 图重算依赖，确认它进了 npm 包的 `dependencies`。
- [x] 2.2 新增只读解析模块（如 `src/server/spreadsheet.mjs`）：`readFile` 后按 sheet 转二维数组，
      单元格取显示值（`raw: false`），公式无缓存值时留公式字面量；把一行编成 csv 文本。
      文件 > 8 MiB、加密、损坏时 `throw` 中文错误并挂 `statusCode`（413 / 400）。
      进程内按 `路径 + mtimeMs` 缓存，最多 4 本，**不写磁盘**。路径由调用方先过 `resolveInside()`。
- [x] 2.3 `http.mjs` 的 `/table`：`.xlsx`/`.xlsm` 走 2.2；认可选 `sheet`（缺省第一张）；
      响应保持 `headerLine`/`lines`/`totalRows`/…，另加可选 `sheets`、`sheet`。
      csv/tsv 带 `sheet` 时忽略，行为与改动前一致。`sheet` 对不上 → 400 并列出可用表名。
      越界 403、不存在 404。措辞中文。
- [x] 2.4 `/table-search`：同样认 xlsx/xlsm + 可选 `sheet`；在已解析的行数组上用现有
      `queryTokens` 做「整行包含全部分词」。命中 `text` 必须与 `/table` 那一行 csv 相同。
      命中上限、时间预算、客户端中断沿用 csv 那套。csv/tsv 扫描路径一字不改。
      扩展名白名单改为 `.csv` / `.tsv` / `.xlsx` / `.xlsm`，其它仍 400。
- [x] 2.5 `scan.mjs` 的 `readerKind`：`.xlsx`/`.xlsm` 返回 `'table'`；`.xls` 仍是 `'external'`。
      扫描阶段不打开工作簿。
- [x] 2.6 **重启 `pnpm serve` / `pnpm dev`**，curl 验证：
      合成一份小 xlsx（两张表、带逗号的单元格、一个公式缓存值）请求 `/table`（不带 sheet、带 sheet、错误 sheet 名）、
      `/table-search`；再对 csv 回归一次确认 `sheet` 参数被忽略；越界 path 仍 403。
      确认工作空间目录没有任何文件被新增或改动。

## 3. 同步 api.ts 契约

- [x] 3.1 `TablePage` / `TableSearchResult` 增加可选 `sheets?: string[]`、`sheet?: string`，
      注释写清：旧进程没有、csv 没有；缺了就当单表。
- [x] 3.2 `api.table` / `api.tableSearch` 增加可选 `sheet` 查询参数；不传则请求形状与改动前完全一致。

## 4. 前端 xlsx 表格预览

- [x] 4.1 `TableReader` / `PaginatedCsvTable`：当 `/table` 返回 `sheets.length > 1` 时，
      用现成「数据表」下拉切 sheet，请求带 `sheet=`，**不要**把表名拼进 `path`。
      只有一张或字段缺失时保持现在的单表行为。
- [x] 4.2 整表检索把当前 `sheet` 传给 `api.tableSearch`；切 sheet 视为换了内容对象，重置检索条。
      旧服务 404 仍退回当前页本地搜。
- [x] 4.3 xlsx 预览失败（413/400）时，预览区显示服务端中文原因，并提供「用默认程序打开」
      与「在文件管理器中显示」，不要空白。
- [x] 4.4 xlsx/xlsm 预览成功时，顶栏额外挂「用默认程序打开」（改表仍走 Excel）。
      csv 不要无故多这颗按钮。

## 5. 文档

- [x] 5.1 README「什么格式都在网页里看」那张表：yaml/json/xml 写成代码高亮；
      xlsx/xlsm 写成表格预览（分页、多 sheet）；docx / PDF / `.xls` 仍是交给系统。
      说清「不重算公式、不渲染图表、超过 8 MiB 请用系统程序打开」。

## 6. 验收闸

- [x] 6.1 `pnpm typecheck` 绿。
- [x] 6.2 `pnpm build` 绿。
- [x] 6.3 **重启 `pnpm dev` / `serve`**，浏览器把受影响视图点一遍：
      产出里的 yaml（高亮、行号、检索跳行、复制无行号）、json/xml、txt（确认没被改成代码视图）、
      产出里的 xlsx（默认第一张、切 sheet、翻页、检索命中跳行）、xlsm、
      一份 csv（回归）、一份 `.xls`（仍是原始格式空态）、一份 markdown（检索与批注没被改坏）。
- [x] 6.4 边角：大于 8 MiB 的 xlsx（413 文案 + 系统打开）、加密或坏文件、
      深色模式下降亮对比度（不要出现 orange，除非是读失败这种「需要注意」）。
- [x] 6.5 无 `project.yaml`、工作空间目录丢失两种情况下，打开 yaml / xlsx 都不白屏。
- [x] 6.6 用**旧版本服务进程**配新前端：yaml 仍高亮；xlsx 仍显示「网页里不渲染」，不报未知 kind。
- [x] 6.7 `pnpm build:npm && pnpm pack:npm && pnpm smoke:npm`：确认新依赖被打进包，
      装出来的服务能起；若在 smoke 里加了合成 xlsx 的 `/table` 断言，一并绿。
