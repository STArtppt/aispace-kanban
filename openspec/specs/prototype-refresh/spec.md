# prototype-refresh

## Purpose

约定已接入原型行上的「刷新」按钮:由用户在看板上点击触发原型工作区自己的同步脚本,
一次做完拉取(离线包、在线链接、规格 / 文档 / 标注 / 批注)与推送(工作空间变更清单写给原型侧)。
看板只 `spawn`,自己不写工作空间里任何一个字节;脚本路径与原型目录只来自镜像里通过三道校验的
`sync.json`,请求只带原型的 `itemKey`、不接受任何路径。任务模型沿用资料转换(立刻返回、前端轮询、
同一工作空间同一时刻至多一个),失败与降级都落在已有的展示位(离线包 orange、按钮置灰并说明原因)。

## Requirements

### Requirement: 已接入原型行提供刷新入口
看板 SHALL 在已接入原型行（带 `linked` 的条目）的「打开离线包 / 打开在线版」之前显示「刷新」按钮。
按钮是否可点由服务端下发的 `linked.refresh` 决定：`available: true` 时可点；`available: false` 时置灰，悬停与行内说明 `reason`；
`refresh` 缺省时 MUST NOT 显示按钮。

#### Scenario: 镜像带合法 sync.json
- **WHEN** 镜像目录有 `sync.json`，且其脚本与原型目录通过全部校验
- **THEN** `GET /api/projects/<id>/prototypes` 返回的该条目 `linked.refresh.available === true`，行上出现可点的「刷新」按钮

#### Scenario: 旧镜像没有 sync.json
- **WHEN** 镜像目录有 `SYNC.md` 但没有 `sync.json`
- **THEN** `linked.refresh` 为 `{ available: false, reason: <说明需先在原型工作区跑一次同步> }`，按钮置灰并显示该说明，聚合行其余内容照常

#### Scenario: 旧服务进程不给新字段
- **WHEN** 前端从旧服务进程拿到的 `linked` 里没有 `refresh`
- **THEN** 行上不出现刷新按钮，其余展示与改动前一致，不报错

### Requirement: 执行前校验脚本与回指
服务端 MUST 只执行通过以下全部校验的同步脚本，任一不过即 `available: false` 并给出对应原因，刷新接口返回 400：
脚本文件名为 `workspace-sync.mjs` 且是存在的文件；原型目录存在；原型目录内 `.workspace-link.json` 的 `workspace` 真实路径等于当前工作空间根的真实路径。
命令参数 MUST 由服务端固定为 `<原型目录> --both`，不得读取任何文件或请求中的参数。

#### Scenario: 登记文件指向别的工作空间
- **WHEN** `sync.json` 指向的原型目录里 `.workspace-link.json` 登记的是另一个工作空间
- **THEN** 该条目 `refresh.available === false`，原因说明登记不指向本工作空间；`POST /proto-sync` 返回 400，且不起任何子进程

#### Scenario: 脚本名被改成别的文件
- **WHEN** `sync.json` 的脚本路径文件名不是 `workspace-sync.mjs`，或文件不存在
- **THEN** `refresh.available === false`，`POST /proto-sync` 返回 400，不起子进程

#### Scenario: 请求试图传路径
- **WHEN** `POST /api/projects/<id>/proto-sync` 的 body 里 `item` 不是扫描清单中某个已接入原型的 `itemKey`（例如 `../x` 或绝对路径）
- **THEN** 返回 404「没有这份已接入原型」，不起子进程

### Requirement: 刷新任务异步执行并可轮询
`POST /api/projects/<id>/proto-sync` SHALL 立刻返回 `status: 'running'`，`GET` 同一路径返回任务状态（`idle | running | done | error`、`message`、`item`、`startedAt`、`finishedAt`、`exitCode`、`log`）。
同一工作空间同一时刻 MUST 至多一个刷新任务；任务超过 10 分钟未结束 MUST 被终止并记为 error。
该接口 MUST 受 `allowMutations`（非环回 403）与 `rejectIfForeignOrigin`（跨站 403）约束。

#### Scenario: 正常刷新
- **WHEN** 用户点击可用的「刷新」
- **THEN** 按钮进入运行态（禁用、图标转动），前端轮询 `GET /proto-sync`；子进程退出码 0 后状态为 `done`，行内以灰色显示脚本汇报（例如离线包已覆盖、在线链接、推送文件数）；镜像写盘经 SSE 触发原型 tab 自动刷新，在线版发布时间更新

#### Scenario: 重复点击
- **WHEN** 已有刷新任务在跑时再次 `POST /proto-sync`
- **THEN** 返回 409，说明正在刷新哪份原型

#### Scenario: 非环回或跨站
- **WHEN** 服务以非环回地址监听，或请求 Origin 不是看板自身
- **THEN** `POST /proto-sync` 返回 403，不起子进程

#### Scenario: 脚本失败
- **WHEN** 子进程退出码非 0（例如登记路径失效）
- **THEN** 状态为 `error`，行内用 orange 显示脚本输出里的 `✗` 行原文；工作空间内容以脚本实际写入为准，看板不做回滚

### Requirement: 导出失败按离线包未更新呈现
离线包导出失败但脚本退出码为 0 时，看板 SHALL 把任务记为 `done`，并依赖刷新后 `SYNC.md` 解析出的 `offlineStale` 在「离线包」格标 orange；任务结果行 MUST 同时列出脚本输出里的 `!` 行。

#### Scenario: Make 管理端没开
- **WHEN** 刷新时 Make 管理端未运行，脚本保留旧 zip、照常同步文档后退出码 0
- **THEN** 任务 `done`；结果行显示「连不上 Make 管理端」那条 `!` 行；刷新后「离线包」格显示「本次同步没更新，仍是旧包」并标 orange，在线版与资料照常更新

### Requirement: 工作空间目录丢失时不可刷新
工作空间 `available === false`（目录被移走）时，服务端 MUST NOT 下发可用的 `refresh`，刷新接口 MUST 返回错误而不起子进程。

#### Scenario: 目录被移走
- **WHEN** 已登记工作空间的根目录不存在
- **THEN** 原型 tab 走既有的目录丢失降级，不出现可点的刷新按钮；直接 `POST /proto-sync` 返回错误说明目录不可用
