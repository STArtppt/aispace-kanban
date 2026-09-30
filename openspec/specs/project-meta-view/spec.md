# project-meta-view

## Purpose

约定概览页怎么渲染 `project.yaml` 的列表字段：对象数组里的原始值行整行进「内容」列，不按字符拆列；`acceptance.标准` 有「验收标准」渲染入口；模板和 `pm-project-meta` 写明表格类列表要写成键一致的对象数组。

## Requirements

### Requirement: 列表字段的原始值行不拆字

概览页 SHALL 在用表格渲染 `project.yaml` 的对象数组字段（如 `deliverables`、`milestones`、`stakeholders`、`systems`）时，
如果某一行是字符串、数字这类原始值， 把整行放进一列「内容」，MUST NOT 按字符下标拆成多列。
同一个数组里对象行和原始值行混在一起时，表格 SHALL 正常显示：对象行在「内容」列显示「待补充」，原始值行在其他列显示「待补充」。

#### Scenario: 成果要求写成字符串数组

- **WHEN** `project.yaml` 里写的是 `deliverables: ["《示例调研方案》", "《示例设计说明书》"]`
- **THEN** 概览页「成果要求」是一张只有「内容」一列、两行的表，而不是一排 `0 1 2 …` 的列

#### Scenario: 对象行和字符串行混写

- **WHEN** `deliverables` 里既有 `{ 名称: 示例报告, 类型: 报告 }`，也有一个字符串
- **THEN** 表头是 `名称 | 类型 | 内容`，页面不报错、不白屏

### Requirement: 验收标准有渲染入口

`project.yaml` 的 `acceptance.标准` SHALL 和 `acceptance.流程` 一样在概览页显示为一个列表，标题为「验收标准」；为空时不显示。

#### Scenario: 写了验收标准

- **WHEN** `acceptance.标准` 有两条
- **THEN** 概览页在「验收流程」旁边显示「验收标准」列表，共两条

#### Scenario: 旧工作空间没有这个字段

- **WHEN** `project.yaml` 没有 `acceptance`，或者 `acceptance.标准` 缺失
- **THEN** 概览页不显示「验收标准」，其他部分照常显示

### Requirement: 模板写明列表字段的形状

模板 `project.yaml` 里每个列表字段 SHALL 带「形如」注释；`deliverables` 为 `形如 { 名称: , 类型: , 阶段: }`。
`pm-project-meta` 技能 SHALL 写明：表格类列表字段要写成对象数组，同一字段各行的键保持一致。

#### Scenario: 新建工作空间

- **WHEN** 新建一个工作空间并打开 `project.yaml`
- **THEN** `deliverables` 这一行的注释里有「形如」
