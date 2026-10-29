## MODIFIED Requirements

### Requirement: 原始资料全量列出

「原始资料」SHALL 列出 `input/raw/` 下的全部文件（与扫描的 `raw` 一致），转换过的不再从列表里消失。
扫描的每个 raw 条目 SHALL 带可选字段 `state`：`converted`（有对应产物）/ `pending`（待转），
以及可选 `stale: true`（有产物但原件在转换后改过）。看板 MUST NOT 读取 `input/.ingestignore`，也 MUST NOT 产出 `ignored` 状态或 `stats.ignored`。

#### Scenario: 转换后仍在

- **WHEN** 用户在某份资料的「更多」里点「转换」，转换成功
- **THEN** 它仍在「原始资料」里，标签从「待转」变成「已转」

#### Scenario: 以前忽略的资料

- **WHEN** 工作空间里还留着一份 `input/.ingestignore`，其中有 `raw/批次甲`，该目录下 3 份文件都没有产物
- **THEN** 这 3 份文件标「待转」，计入待转数；`.ingestignore` 文件本身没有被看板改动

#### Scenario: 旧服务进程

- **WHEN** 服务进程是旧的，raw 条目没有 `state`
- **THEN** 列表退回改动前行为：只列待转资料，不显示标签

#### Scenario: 旧服务进程仍给 ignored

- **WHEN** 前端已更新，服务进程是旧的，某个 raw 条目 `state` 为 `ignored`
- **THEN** 该行按「待转」显示，不白屏，菜单里没有忽略相关的操作

### Requirement: 状态标签

每个文件行 SHALL 带一个文本标签：`已转`、`待转`；`stale` 的条目标签为 `改动`。
标签 SHALL 放在文件大小之后、「更多」之前，使各行标签上下对成一列。
`改动` 用 orange（`--destructive`），悬停说明原件在转换后改过；其余为中性灰 outline。

树形视图的目录行 SHALL 在文件数之后带汇总标签，按其下全部原件（不随筛选变化）计算：全部已转为 `已转`，全部待转为 `待转`，两者都有为 `部分`。`改动` 的原件按已转计。

#### Scenario: 目录部分转换

- **WHEN** 目录 `input/raw/批次甲` 下有 2 份已转、1 份待转，用户把筛选切到「待转」
- **THEN** 该目录行标签为「部分」

#### Scenario: 原件改过

- **WHEN** 一份已转资料的原件在转换后被改过
- **THEN** 该行标签为橙色「改动」，与其它行的标签在同一列

### Requirement: 按状态筛选

原始资料工具栏 SHALL 有状态筛选：全部（默认）/ 待转 / 已转 / 改动，各项带数量；选择记在本地存储，读写失败时用默认或存的值已不存在（如旧的「忽略」）时用默认。
行内操作按状态给：待转有「转换」；已转有「打开产物」，`stale` 的另有「重新转换」。树形视图的目录行有「转这一整个目录」。
这些状态上另外的「重命名」和「移动到…」由 `raw-source-organize` 规定，不替换上面按状态给出的操作。
MUST NOT 提供「忽略」「解除忽略」。

#### Scenario: 只看待转

- **WHEN** 用户把筛选切到「待转」
- **THEN** 只剩待转的资料，「资料台账」行仍在顶部，刷新后筛选保持

#### Scenario: 存着旧的忽略筛选

- **WHEN** 本地存储里记着筛选值 `ignored`
- **THEN** 打开原始资料时筛选为「全部」

## ADDED Requirements

### Requirement: 看板不发起全量转换

原始资料视图 MUST NOT 提供转换 `input/raw/` 全部资料的入口；转换进度与报错 SHALL 照旧显示在原位置。
`POST /api/projects/:id/ingest` 在请求不带路径、或路径是 `input/raw` 本身时 MUST 返回 400，且不 spawn `ingest.py`。
单份文件、子目录的转换照旧。

#### Scenario: 没有全局按钮

- **WHEN** 用户打开「输入资料 → 原始资料」，工作空间有 `scripts/ingest.py`
- **THEN** 顶部没有「开始转换」按钮；某一行「更多」里仍有「转换」

#### Scenario: 接口拒绝空路径

- **WHEN** 以 `{}` 或 `{"path":"input/raw"}` 调用 `POST /api/projects/:id/ingest`
- **THEN** 返回 400，没有转换任务被启动

#### Scenario: 转整个子目录

- **WHEN** 用户在树形视图里对目录 `input/raw/批次甲` 点「转这一整个目录」
- **THEN** 只转换该目录下的资料，进度显示在原始资料顶部

### Requirement: 转换脚本必须写明范围

模板的 `scripts/ingest.py` 在没有路径参数、且不是 `--dry-run` 时 MUST 以非 0 退出码结束，MUST NOT 转换或写入任何文件（含 `output/converted/` 与 `input/INDEX.md`），
并 SHALL 在输出里说明要指定文件或目录、给出带路径的示例。`--dry-run` 不带路径时 SHALL 照旧打印全量计划。
显式传入 `input/raw` 时 SHALL 照常转换全部原件。

#### Scenario: 不带参数运行

- **WHEN** 在工作空间根目录执行 `python3 scripts/ingest.py`
- **THEN** 退出码非 0，输出里有带路径的示例；`output/converted/` 与 `input/INDEX.md` 没有变化

#### Scenario: 只看计划

- **WHEN** 执行 `python3 scripts/ingest.py --dry-run`
- **THEN** 打印 `input/raw/` 全部原件的转换计划，不写盘

#### Scenario: 指定一个目录

- **WHEN** 执行 `python3 scripts/ingest.py input/raw/批次甲`
- **THEN** 只转换该目录下的原件

#### Scenario: 旧看板服务发来不带路径的请求

- **WHEN** 实例已更新模板，仍在跑的旧看板服务以空路径 spawn `ingest.py`
- **THEN** 转换任务以失败结束，界面显示脚本给出的提示，没有资料被转换
