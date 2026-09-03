## Context

预览窗按 `item.reader` 分流（`scan.mjs` 的 `readerKind`）：

| 扩展名 | 现在 | 用户看到的 |
| --- | --- | --- |
| `.yaml` `.yml` `.json` `.xml` `.txt` | `text` | `<pre>` 等宽纯文本，无语言、无行号 |
| `.csv` `.tsv` | `table` | `/table` 分页 + 多 sheet 下拉（转换包才有） |
| `.xlsx` `.xlsm` `.xls` `.docx` `.pdf` … | `external` | 「网页里不渲染」，点开走系统 |

代码高亮的零件已经在：markdown 围栏走 `MarkdownCodeBlock` → vendored `CodeBlock` → Shiki（`github-light` / `github-dark`）。纯文本预览的检索按行切块：`<pre>` 里每行一个 `span.block`，`collectBlocks()` 认这个结构。

表格分页已经在：`GET /api/projects/:id/table` 返回 `{ headerLine, lines, totalRows, … }`，前端 Papa 解析当页；整表检索走 `/table-search`。这两条接口现在只认 `.csv` / `.tsv`。

xlsx 是 ZIP + OOXML，不能像 csv 那样 `readline` 流式切页。`input/raw/` 里的大表走 `ingest.py` 拆成 csv 之后已经能看；痛点是 **`output/` 里 AI 交出来的工作簿**，以及还没转换的原件 —— 这两处现在只能切到本机 Excel。

约束：工作空间只读、路径过 `resolveInside()`、新字段可选、常驻服务不热更、服务端新依赖必须进 `dependencies`（组包按 import 图重算）。

## Goals / Non-Goals

**Goals:**

- yaml / json / xml 在预览窗按语言高亮，行号清楚，检索仍按行能跳。
- xlsx / xlsm 点开就是表：sheet 可切、分页、能搜；值能读，不用离开浏览器。
- 读不了时说清原因，并留下「用默认程序打开」。
- 旧服务进程 + 新前端不白屏：xlsx 仍显示「网页里不渲染」，yaml 高亮照样生效（正文接口没变）。

**Non-Goals:**

- 不做 YAML 树形折叠、不做编辑。
- 不做 xlsx 编辑、筛选、冻结、合并单元格还原、图表、公式重算、数据透视。
- 不做 `.xls`（BIFF8）、docx、PDF、pptx 的网页渲染。
- 不把 xlsx 转成 csv 写回工作空间。
- 不在扫描阶段解析每一份 xlsx。

## Decisions

### D1 · 代码类文本只换渲染，不换 `reader`、不换接口

**选:** `.yaml` `.yml` `.json` `.xml` 继续是 `reader: 'text'`，仍走 `GET /file` 拿正文。前端按扩展名选 Shiki 语言，用带行号的代码视图替换现在的裸 `<pre>`。`.txt` 保持纯文本。

**为什么不新增 `reader: 'code'`:** 新字段/新枚举要两端一起发，旧前端碰到不认识的 kind 会掉进 `external` 或什么都不画。扩展名前端本来就有，旧进程一样能高亮，yaml 这条不需要重启服务。

**为什么不做 YAML 树 / 折叠:** 用户要的是「按代码类型显示」，不是另一套编辑器。树视图还要处理锚点、检索、大文件，收益只是好看一点。

**为什么 json / xml 一并做:** 它们已经和 yaml 走同一条 `text` 路，只是语言映射多两行。只做 yaml 反而要写「这个 text 高亮、那个 text 不高亮」的例外。

### D2 · 高亮视图必须保住「一行一块」，不改 vendored `CodeBlock`

**选:** 新增一个薄的代码文件视图（不改 `components/ui/code-block.tsx`）。Shiki 高亮后仍按行包 `span.block` 放进 `<pre>`，检索继续走现在的 `collectBlocks()` 纯文本分支。行号用旁边的 muted 数字，不进复制文本。语言标签用扩展名。默认 `max-h-80` 是围栏代码块的高度，整文件预览必须撑满阅读区。

**为什么不直接套 `CodeBlock`:** 它的行视图是 `<pre><code><div>`，`collectBlocks` 只认 `<pre> > .block`。改 vendored 快照违反设计系统红线；为它去改 `collectBlocks` 会把检索和上游组件结构绑死。自己包一层，检索零改动。

**为什么高亮失败就退回现在的 `<pre>`:** Shiki 对未知语言会扔，`CodeBlock` 已经这么降级。代码视图同样：高亮挂了，人至少还能读到字。

### D3 · xlsx 服务端解析，响应形状故意长得像 csv 页

**选:** `readerKind('.xlsx'|'.xlsm')` 改为 `'table'`。`/table` 与 `/table-search` 接受这两类扩展名，增加可选查询参数 `sheet`（工作表名）。响应**继续**是 `{ headerLine, lines, totalRows, size, mtime }`：服务端把单元格写成一段 csv 文本，前端 Papa 与 `CsvGrid` 原样吃。新增可选字段 `sheets?: string[]`、`sheet?: string`；缺了就当单表 csv。

默认 `sheet` = 工作簿里第一张表。多表时前端用现成的「数据表」下拉，选项的 ident 是 sheet 名，请求时带 `sheet=`，**不发明** `path#Sheet1` 这种假路径。

**为什么不前端拉二进制再 SheetJS:** 大文件整本进浏览器，和当年 csv 撞 413 是同一类问题；检索、分页、旧进程降级全得在前端再写一遍。

**为什么不调 `ingest.py` 现拆 csv:** 那是写 `input/converted/` 的转换流水线，产出目录里的 xlsx 根本不走它；而且看板不能往工作空间写。

**为什么不新开 `/xlsx` 接口:** 前端表格栈（分页、行号、整表检索、命中跳转）全是按 `/table` 形状长的。新接口等于把 TableReader 分叉。可选字段扩展旧接口，旧前端不传 `sheet` 也能看到第一张表。

**csv/tsv 行为一字不改。** 不传 `sheet` 时路径仍是文件；传了也忽略。

### D4 · 解析库用 SheetJS 社区版 `xlsx`，只放服务端 `dependencies`

**选:** 服务端加 `xlsx`（SheetJS community，Apache-2.0）。只用来 `readFile` + `sheet_to_json({ header: 1, defval: '', raw: false })` 拿二维数组。不进前端 bundle。

**为什么不选 exceljs:** MIT、在维护，但带着浏览器构建，装进 `@startist/aispace-kanban` 会明显撑包。本轮只要单元格显示值。

**为什么不手写 OOXML:** 共享字符串、日期序列、合并格左上角取值，每一项都是坑。工作空间的 `ingest.py` 有一份 Python 实现，看板服务端不复用那份（不同语言、不同平面）。

**代价:** 社区版停在 0.18.x。钉死版本，只用读路径；以后要换库，D3 的「输出仍是 csv 行」把替换面包在服务端。

公式：优先用单元格已缓存的计算结果（`raw: false`）；没有缓存就显示公式字面量，**不重算**。日期走库的格式化字符串。合并格只在左上角有值，其余当空。图表、数据透视、VBA 忽略。

### D5 · xlsx 整本进进程内存，用体积上限和短缓存兜住；csv 仍流式

**选:** 打开一份 xlsx 时把工作簿解析进内存，再按 sheet 切片成页。文件超过 **8 MiB** 直接 413，文案说明太大、请用系统程序打开（点表那种大表继续走 ingest 之后的 csv 流式路径，不走本轮）。加密、损坏、不是 zip 的，返回 400，中文说清。

解析结果按 `绝对路径 + mtimeMs` 缓存在进程里，最多留 4 本；mtime 变了作废。缓存是内存 Map，**不写磁盘**。扫描阶段只改 `reader`，不打开工作簿。

`/table-search` 对 xlsx：在已经解析出的行数组上做与 csv 相同的「整行文本包含全部分词」。行文本就是分页接口会给前端的那一行 csv，口径一致。命中上限、时间预算、客户端中断沿用 csv 那套。

**为什么 csv 那条「禁止整表进内存」不能套到 xlsx:** OOXML 的 sheet 不是按行存储的文本，不解开 zip 就切不出第 51–100 行。装傻流式会自己实现一半解析器。用体积上限换「这本进内存」，超过上限就拒绝，比假装能流更诚实。

**为什么上限是 8 MiB 不是 4 / 32:** `/file` 对普通文本的上限是 4 MiB；xlsx 是压缩包，解开后更大，8 MiB 给产出表一点余量。再大的表，产品路径是转换成 csv，不是在预览里硬看原件。

### D6 · `reader` 从 `external` 改成 `table` 的兼容口径

这不是「加可选字段」，是**已有字段换值**。

| 组合 | 行为 |
| --- | --- |
| 新前端 + 旧服务 | scan 仍给 `external`，界面与改动前一致（「网页里不渲染」） |
| 新前端 + 新服务 | `table`，走 `/table?sheet=` |
| 旧前端 + 新服务 | 当普通单表 csv 调 `/table`（不带 `sheet`），看到第一张表；能翻页。多 sheet 切不到，但不白屏 |

前端对 `/table` 缺 `sheets` 时按单表渲染。`api.table` / `api.tableSearch` 的 `sheet` 参数可选。

xlsx 预览失败（413 / 400）时，预览区显示错误文案 + 「用默认程序打开」+ 「在文件管理器中显示」，不要空白。顶栏对 xlsx 额外挂一颗「用默认程序打开」：看是看板的事，改还是 Excel 的事。

### D7 · `.xls` 明确不收

**选:** `.xls` 继续 `external`。BIFF8 是另一套二进制，SheetJS 能读一部分，但本轮目标是「产出里的 xlsx」。

## Risks / Trade-offs

- [xlsx 解开后内存放大] → 文件体积先卡 8 MiB；缓存最多 4 本；进程是本机看板，不是多租户。
- [公式没有缓存值，看到的是 `=A1+1`] → 文案不承诺「和 Excel 里看到的一模一样」；需要精确值时用默认程序打开。
- [社区版 `xlsx` 停更] → 钉版本、只用读 API；D3 把表格形状固定在 csv 行，换库不改契约。
- [改 `reader` 值让旧前端把 xlsx 当 csv 请求] → 新服务的 `/table` 必须同时认 xlsx，且缺 `sheet` 时给第一张表（D6）。两端一起发，重启常驻服务。
- [Shiki 高亮把一行拆成许多 token span] → 行容器仍是 `span.block`，检索按行、高亮加在行容器上，不插节点进 markdown 正文（代码预览也没有批注）。
- [隐藏 sheet / 非常规表名] → 原样列出；`sheet` 参数按名字精确匹配，找不到返回 400 并列出可用名。

## Migration Plan

1. 服务端先让 `/table`、`/table-search` 认 xlsx（缺字段时仍当 csv），再改 `readerKind`。
2. 契约加可选字段，前端按扩展名接代码视图、按 `sheets` 接 sheet 下拉。
3. 重启 `pnpm dev` / `serve`。不重启：yaml 高亮已在（纯前端），xlsx 仍是「网页里不渲染」。
4. 回滚：还原 `readerKind` 与 `/table` 扩展名白名单，xlsx 回到 `external`；yaml 高亮可单独留。

不迁移磁盘数据，不改工作空间。

## Open Questions

（无。语言集合、xlsx 体积上限、公式不重算、`.xls` 不收，都已在 Decisions 拍板。若 8 MiB 在真实产出上偏紧，只调这一处数字。）
