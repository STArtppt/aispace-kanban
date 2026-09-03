## Why

产出里越来越多 yaml 配置和 xlsx 表。yaml 现在当纯文本糊在预览里，结构看不清；xlsx 网页不渲染，只能切到本机 Excel 再切回来。评审一版产出要在浏览器和编辑器之间来回跳，看板「不用离开浏览器」的承诺在这两类文件上是空的。

## What Changes

- **代码类文本按语言高亮。** `.yaml` / `.yml` / `.json` / `.xml` 仍走现有文本接口读正文，预览改成带语言的代码视图（行号、Shiki 高亮、可复制），不再是一坨等宽纯文本。`.txt` 保持现在的纯文本，不动。
- **xlsx 在看板里当表看。** `.xlsx` / `.xlsm` 从「原始格式、交给系统打开」改成表格预览：多 sheet 可切换、分页、能搜。单元格显示已算出的值，不跑公式、不画图表、不能编辑。太大、加密、坏掉的文件说清原因，并留下「用默认程序打开」。
- **`.xls`（老 BIFF）和其它 Office 格式（docx / PDF / pptx）不在本轮。** 它们继续走「用默认程序打开」。
- **不往工作空间写任何文件。** xlsx 解析只在服务端内存里做，不落 CSV、不改原件。

不做：YAML 树形折叠编辑、xlsx 编辑 / 筛选 / 冻结窗格 / 透视、图表渲染、公式重算、跨文件检索。

## Capabilities

### New Capabilities
- `code-preview`: 代码类文本（yaml / json / xml）在预览窗按语言高亮显示，并保持预览窗内检索可用。
- `spreadsheet-preview`: 工作空间内的 `.xlsx` / `.xlsm` 在预览窗以表格呈现（sheet 切换、分页、整表检索、失败降级）。

### Modified Capabilities
- `preview-search`: 纯文本那一支要覆盖「按代码高亮后的正文」—— 搜索按钮仍出现，命中按行定位；xlsx 进表格预览后走整表检索，不再是「原始格式没有搜索入口」。
- `table-scan-search`: `/table` 与 `/table-search` 从「只认 csv/tsv」扩到 xlsx 工作簿里的一张 sheet；匹配语义不变，路径仍过 `resolveInside()`。

## Impact

- **平面**：服务端 + 前端。CLI 与 templates 不动。
  - 服务端：`scan.mjs` 的 `readerKind` 把 xlsx/xlsm 标成 `table`；`http.mjs` 的 `/table`、`/table-search` 能读工作簿（按 sheet 分页 / 扫描），路径过 `resolveInside()`。
  - 契约：`src/app/lib/api.ts` —— `TablePage` / `TableSearchResult` 与 `api.table` / `api.tableSearch` 增加可选的 sheet 相关字段；缺字段时前端退回「单 csv」行为。
  - 前端：`Reader.tsx` 代码类文本走高亮视图；xlsx 复用现有表格分页与 sheet 切换，失败时仍给「用默认程序打开」。
- **新依赖（服务端，进 `dependencies`）**：只读解析 xlsx 的库（选型见 design）。前端不另引表格/高亮库，Shiki 与表格 UI 已经在。
- **只读红线**：不写工作空间。解析缓存在**进程内存**，按路径 + mtime 失效，不落磁盘。
- **兼容**：旧服务进程仍把 xlsx 标成 `external`，新前端按原样显示「网页里不渲染」；yaml 高亮只看扩展名，旧进程一样生效（正文接口没变）。改了服务端必须重启才看得到 xlsx 预览。
