## ADDED Requirements

### Requirement: xlsx 在预览窗以表格呈现

扫描 MUST 把扩展名 `.xlsx`、`.xlsm` 的文件标成 `reader: 'table'`（与 csv/tsv 相同）。`.xls` 以及其它 Office 格式（docx / PDF / pptx）MUST 继续是 `reader: 'external'`，网页里不渲染。

用户点开一份 xlsx / xlsm 时，预览窗 MUST 用现有表格网格显示单元格值，MUST 分页（每页行数与 csv 预览相同），MUST NOT 把整本工作簿拉进浏览器。

单元格 MUST 显示已缓存的计算结果；没有缓存值时 MUST 显示公式字面量。看板 MUST NOT 重算公式，MUST NOT 渲染图表、数据透视或 VBA。合并单元格 MUST 只在左上角显示值，其余当作空。

预览是只读的：MUST NOT 提供编辑、筛选、排序写入或任何改写工作簿的操作。

路径 MUST 过 `resolveInside()`。看板 MUST NOT 把解析结果写进工作空间（不落 csv、不改原件）。

#### Scenario: 产出目录里的 xlsx 直接能看
- **WHEN** `output/` 下有一份 `.xlsx`，用户在产出列表点开它
- **THEN** 预览窗显示表格，而不是「网页里不渲染」
- **AND** 可以翻页

#### Scenario: xlsm 同样能看数据
- **WHEN** 用户点开一份 `.xlsm`
- **THEN** 预览窗显示其中的表数据
- **AND** 不运行宏

#### Scenario: xls 仍交给系统
- **WHEN** 用户点开一份 `.xls`
- **THEN** 预览窗仍是「网页里不渲染」，并提供用默认程序打开

#### Scenario: 旧服务进程退回原行为
- **WHEN** 常驻服务还是旧版本，scan 给这份 xlsx 的 `reader` 仍是 `external`
- **THEN** 新前端显示「网页里不渲染」，不白屏、不报未知 kind

### Requirement: 多 sheet 可切换，缺省看第一张

`GET /api/projects/:id/table` 对 `.xlsx` / `.xlsm` MUST 接受可选查询参数 `sheet`（工作表名）。省略时 MUST 返回工作簿里的第一张表。

响应 MUST 保持 csv 分页的既有字段（`headerLine`、`lines`、`totalRows`、`offset`、`limit`、`size`、`mtime`），以便现有表格 UI 原样解析。响应 MUST 另带可选字段 `sheets`（工作表名数组，按工作簿原有顺序）和 `sheet`（本次返回的表名）。这两字段缺省时前端 MUST 按单表 csv 渲染。

`sheet` 名字 MUST 按工作簿里的表名精确匹配；找不到时 MUST 返回 400，并说明有哪些可用表名。csv / tsv 请求带 `sheet` 时 MUST 忽略该参数，行为与改动前一致。

前端在 `sheets` 多于一个时 MUST 提供与转换包相同的「数据表」下拉；切换 MUST 只改 `sheet` 参数，MUST NOT 把表名拼进文件路径。检索范围 MUST 是当前选中的那一张 sheet，MUST NOT 跨表。

#### Scenario: 多表工作簿能切 sheet
- **WHEN** 一份 xlsx 里有「汇总」和「明细」两张表
- **AND** 用户打开它
- **THEN** 默认显示「汇总」（第一张）
- **AND** 下拉里能切到「明细」，表格换成那一张的数据

#### Scenario: 不传 sheet 时给第一张
- **WHEN** 请求 `/api/projects/:id/table?path=<工作簿.xlsx>` 且不带 `sheet`
- **THEN** 返回第一张表的一页数据
- **AND** 响应里带 `sheets` 列出全部表名

#### Scenario: 表名不存在
- **WHEN** 请求 `sheet=不存在的表`
- **THEN** 接口返回 400，说明没有这张表，并列出可用表名

#### Scenario: csv 不受 sheet 参数影响
- **WHEN** 对一份 `.csv` 请求 `/table` 并附带 `sheet=任何值`
- **THEN** 行为与不传 `sheet` 时相同，仍按该 csv 分页

### Requirement: 读失败时说清原因并留下系统打开入口

xlsx 预览在下列情况 MUST 失败并返回中文原因，MUST NOT 写任何文件：

- 文件大于 8 MiB：413，说明文件太大、请用系统程序打开；
- 加密、损坏、或不是有效工作簿：400，说明读不了的原因；
- 路径越界：403；
- 文件不存在或是目录：404。

前端接到这些错误时 MUST 在预览区显示该原因，并提供「用默认程序打开」和「在文件管理器中显示」。xlsx 预览成功时，顶栏 MUST 仍提供「用默认程序打开」，方便需要改表的人回到 Excel。

#### Scenario: 超过体积上限
- **WHEN** 用户打开一份大于 8 MiB 的 xlsx
- **THEN** 预览区说明文件太大、请用系统程序打开
- **AND** 有「用默认程序打开」按钮
- **AND** 工作空间里没有新文件

#### Scenario: 加密工作簿
- **WHEN** 用户打开一份带密码的 xlsx
- **THEN** 预览区说明这是加密文件、看板读不了
- **AND** 有「用默认程序打开」按钮

#### Scenario: 路径穿越被挡
- **WHEN** `/table` 的 `path` 指向工作空间之外
- **THEN** 接口返回 403，不读取任何文件
