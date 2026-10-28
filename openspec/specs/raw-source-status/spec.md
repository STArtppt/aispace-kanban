# raw-source-status

## Purpose

原始资料按状态全部留在列表里：已转换、待转换、已忽略都列出来，带状态标签，可以按状态筛选。
本能力由 `input-output-view-regroup` 变更落地。

## Requirements

### Requirement: 原始资料全量列出

「原始资料」SHALL 列出 `input/raw/` 下的全部文件（与扫描的 `raw` 一致），转换过的、按 `.ingestignore` 忽略的都不再从列表里消失。
扫描的每个 raw 条目 SHALL 带可选字段 `state`：`converted`（有对应产物）/ `pending`（待转）/ `ignored`（命中忽略规则），
以及可选 `stale: true`（有产物但原件在转换后改过）。判定沿用现有的 pending / ignored / stale 计算，只是不再丢掉非待转的条目。

#### Scenario: 转换后仍在

- **WHEN** 用户点「开始转换」，某份资料转换成功
- **THEN** 它仍在「原始资料」里，标签从「待转」变成「已转」

#### Scenario: 旧服务进程

- **WHEN** 服务进程是旧的，raw 条目没有 `state`
- **THEN** 列表退回改动前行为：只列待转资料，不显示标签

### Requirement: 状态标签

每行 SHALL 在文件名后显示一个文本标签：`已转`、`待转`、`忽略`；`stale` 的条目标签为 `原件已改`。
`原件已改` 用 orange（`--destructive`），其余为中性灰 outline。树形视图里文件行同样带标签，目录行不带。

#### Scenario: 被忽略的资料

- **WHEN** `input/.ingestignore` 里有 `raw/客户版`，该目录下有 3 份文件
- **THEN** 这 3 份文件在列表里带「忽略」标签，不计入待转数

### Requirement: 按状态筛选

原始资料工具栏 SHALL 有状态筛选：全部（默认）/ 待转 / 已转 / 忽略 / 原件已改，各项带数量；选择记在本地存储，读写失败时用默认。
「开始转换」的范围与改动前一致（只转待转与原件已改的），与当前筛选无关。
行内操作按状态给：待转有「转换」「忽略」；已转有「打开产物」「重新转换」；忽略只有「在访达中显示」。
SHALL NOT 提供「取消忽略」（需要删除 `.ingestignore` 的行，不在写入例外清单内）；忽略行的提示说明如何手动恢复。

#### Scenario: 只看待转

- **WHEN** 用户把筛选切到「待转」
- **THEN** 只剩待转的资料，「资料台账」行仍在顶部，刷新后筛选保持
