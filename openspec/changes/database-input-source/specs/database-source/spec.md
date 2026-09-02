## ADDED Requirements

### Requirement: 数据源靠 input/sources/*.yaml 发现,没配就完全不存在

看板 MUST 通过扫描 `<工作空间根>/input/sources/` 下的 `*.yaml` 来发现数据源,
不做任何自动探测、不猜连接串、不读工作空间的 `.env`。
扫描结果 MUST 作为 `Scan.input` 上的**可选**字段返回;目录不存在、为空、
或 yaml 解析失败时,该字段 MUST 缺省(不是空数组语义之外的任何东西),
使前端退回"没有数据源"这条既有路径。
单份 yaml 解析失败 MUST NOT 影响其它源,也 MUST NOT 让扫描整体失败 ——
坏的那份以「配置读不出来」的形态列出来,让用户看得见。

#### Scenario: 没配过数据源的工作空间
- **WHEN** 工作空间里没有 `input/sources/` 目录
- **THEN** `GET /api/projects/<id>/scan` 的响应与本次改动前一致(不多出数据源信息)
- **AND** 界面上不出现「数据库源」tab,输入资料视图仍是三个 tab

#### Scenario: 配了一份数据源
- **WHEN** 工作空间里有 `input/sources/warehouse.yaml`,引擎是 PostgreSQL 或 MySQL
- **THEN** 扫描结果里出现这个源,带它的显示名、引擎类型、库名
- **AND** 「数据库源」tab 出现,位置在 待转换 / 已转换 / 图片资料 **之后**

#### Scenario: 配了本轮不支持的引擎
- **WHEN** yaml 里写的引擎不是 PostgreSQL 或 MySQL
- **THEN** 该源以「暂不支持这个引擎」的状态列出来,点采集时给出中文说明
- **AND** 不影响同目录下其它可用的源

#### Scenario: yaml 写坏了
- **WHEN** `input/sources/` 下有一份语法错误的 yaml,和一份正常的
- **THEN** 扫描仍然成功返回,正常那份可用
- **AND** 坏的那份以「配置读不出来」的状态列在 tab 里,标注文件名

#### Scenario: 旧服务进程 + 新前端
- **WHEN** 用户跑着改动前的常驻服务,但浏览器加载了新前端
- **THEN** 前端读不到数据源字段,不显示「数据库源」tab,其余功能不受影响
- **AND** 界面不报错、不白屏

### Requirement: 凭据不进 yaml,只进工作空间自己的 .env

`input/sources/<name>.yaml` MUST 只描述连接的**形状**:引擎类型、主机、端口、库名、
schema 白名单、以及账号所用的**环境变量名**。
配置说明 MUST 假定用户给的是高权限账号(现实里通常是 root),
MUST NOT 把"用户会自己建只读账号"当作安全前提。
口令、token、完整连接串 MUST NOT 出现在 yaml 里。
看板服务端 MUST NOT 读取工作空间的 `.env`,也 MUST NOT 把任何凭据经接口返回给前端 ——
读 `.env` 的只能是工作空间自己的 `scripts/db_ingest.py`。

#### Scenario: 接口响应里不含凭据
- **WHEN** 对任意配好数据源的工作空间 `curl` 扫描接口
- **THEN** 响应正文里不出现口令、token 或完整连接串
- **AND** 只出现环境变量名这种指针形式

#### Scenario: 环境变量没配
- **WHEN** yaml 指名的环境变量在工作空间 `.env` 里不存在,用户点「刷新 schema」
- **THEN** 采集失败并给出中文提示,点名缺的是哪个变量、该写进哪个文件
- **AND** 提示里不回显任何已有变量的值

### Requirement: schema 快照是 KB 级摘要,采集不得压垮生产库

采集 MUST 产出 `input/converted/_sources/<源名>/_manifest_<源名>.md`:表清单、每表列名与类型、
可取到的列注释、主外键、行数**量级**、以及受行数上限约束的少量样例行。
行数 MUST 取 `information_schema` 一类的**估算值**,MUST NOT 对业务表执行 `count(*)`。
采集 MUST 只发只读语句,MUST 设置语句超时,MUST 在结束时断开连接 ——
不留常驻连接、不建连接池。
表数量超过阈值时,manifest MUST 退化为"表清单 + 一句话用途",
单表列明细 MUST 拆进 `_sources/<源名>/SplittingObject/<表>.md`,沿用既有的拆分产物约定。

#### Scenario: 采集一个中等规模的库
- **WHEN** 对一个几十张表的库跑一次 schema 采集
- **THEN** 生成的 `_manifest_<源名>.md` 体积在 KB 量级,单份可整体读进上下文
- **AND** 采集期间没有对任何业务表执行 `count(*)`

#### Scenario: 表特别多
- **WHEN** 库里的表数超过 manifest 的单份阈值
- **THEN** manifest 里每张表只剩名字和一句话用途
- **AND** 每张表另有一份 `_sources/<源名>/SplittingObject/<表>.md` 记完整列明细
- **AND** 看板把它们按既有拆分产物的形态展示,不平铺成几百个条目

#### Scenario: 库连不上
- **WHEN** 目标库不可达或凭据失效,用户点「刷新 schema」
- **THEN** 采集在超时内失败,给出中文原因
- **AND** 上一次成功的 schema 快照**原样保留**,不被清空或截断
- **AND** 该源在 tab 里以 orange 标出"需要处理"

### Requirement: 写操作由数据库自己拒绝,不依赖账号权限

脚本 MUST 在建立连接后、执行任何用户语句之前,把会话置为只读
(PostgreSQL `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`,
MySQL `SET SESSION TRANSACTION READ ONLY`),使即便使用高权限账号,
写操作也由数据库服务端拒绝。
脚本 MUST 额外在自身拒绝非查询语句(增删改、DDL、TRUNCATE),
以便更早失败并给出中文说明,同时覆盖 MySQL 上 DDL 可能因隐式提交绕过只读事务的情况。
脚本 MUST 禁止一次提交多条语句。
只读会话的设置失败 MUST 视为致命错误:不得降级成"只靠脚本白名单"继续执行。

#### Scenario: 用 root 账号跑一条写语句
- **WHEN** 配置的是高权限账号,提交的 SQL 是 `UPDATE`
- **THEN** 语句不被执行,给出中文说明
- **AND** 目标表的数据没有任何变化

#### Scenario: 可写 CTE 混在 SELECT 里
- **WHEN** 提交 `WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x`(PostgreSQL)
- **THEN** 被拒绝,数据没有变化
- **AND** 即使脚本侧的前缀检查放行了它,数据库层也必须拦下

#### Scenario: 多语句夹带
- **WHEN** 提交 `SELECT 1; DROP TABLE t`
- **THEN** 被拒绝,不产生任何产物,表仍然存在

#### Scenario: DDL
- **WHEN** 提交 `CREATE TABLE` / `DROP TABLE` / `TRUNCATE` 中的任意一条
- **THEN** 在脚本侧就被拒绝,不发往数据库

#### Scenario: 只读会话设不上
- **WHEN** 目标库不支持或拒绝了只读会话的设置语句
- **THEN** 采集与查询都中止,给出中文说明
- **AND** 不退回"只靠脚本白名单"继续跑

### Requirement: 查询产物落盘且可溯源,上下文里只留路径与摘要

按需查询 MUST 把结果写成 `input/converted/_sources/<源名>/<查询名>.csv`,
并配一份 `_manifest_<查询名>.md`,frontmatter MUST 记录 SQL 原文、执行时间、
返回行数、结果文件的 sha256 —— 与 `ingest.py` 现有产物的溯源字段同构。
每条查询 MUST 带行数上限与语句超时;超上限时 MUST 截断并在 manifest 里显式写明"已截断"。
`input/converted/_sources/` 前缀下的产物 MUST NOT 出现在「已转换」清单里,
MUST 挂到「数据库源」tab 里对应的源下 —— 数据库和文件是两条来源,不混在一个清单里。

#### Scenario: 跑一条查询
- **WHEN** 执行一条返回若干行的只读查询
- **THEN** `input/converted/_sources/<源名>/` 下出现结果 csv 和对应的 `_manifest_<查询名>.md`
- **AND** manifest 的 frontmatter 里能读到完整 SQL、行数和 sha256
- **AND** 这份产物出现在「数据库源」tab 里对应的源下
- **AND** 「已转换」tab 的清单里**没有**它,该 tab 的计数也没有因它增加

#### Scenario: 结果超过行数上限
- **WHEN** 查询命中的行数超过配置的上限
- **THEN** csv 只含上限内的行
- **AND** manifest 里明确写着已截断、原本估计有多少

#### Scenario: 老工作空间里已有同名目录
- **WHEN** 某个工作空间的 `input/raw/` 下碰巧有叫 `_sources` 的目录,其产物落进了 `converted/_sources/`
- **THEN** 这些产物被归到「数据库源」tab 下而不是「已转换」
- **AND** 它们仍然可以被预览,不丢失、不报错

### Requirement: 看板进程不碰数据库,写盘的只能是工作空间脚本

看板服务端 MUST NOT 引入任何数据库驱动依赖,MUST NOT 在自身进程内建立数据库连接。
采集与查询 MUST 通过 `spawn` 工作空间的 `scripts/db_ingest.py` 完成,
与现有触发 `scripts/ingest.py` 的路径同构:看板只起子进程、读 stdout、报进度,
写 `input/converted/` 的是脚本本身。
新增的接收路径参数的接口 MUST 先过 `resolveInside()`。
非环回监听时,触发采集的接口 MUST 返回 403,与其它会起子进程的接口一致。

#### Scenario: 依赖面不变
- **WHEN** 检查看板 `package.json` 的 `dependencies`
- **THEN** 没有新增任何数据库驱动

#### Scenario: 工作空间没有采集脚本
- **WHEN** 用户在一个老工作空间(没有 `scripts/db_ingest.py`)里点「刷新 schema」
- **THEN** 接口返回中文说明,点名缺的是哪个脚本
- **AND** 不创建任何目录、不写任何文件

#### Scenario: 非环回监听
- **WHEN** 服务以非环回地址 `--host` 启动,外部调用触发采集的接口
- **THEN** 返回 403
- **AND** 只读的扫描与文件读取不受影响

#### Scenario: 路径穿越
- **WHEN** 请求里带 `../` 试图指向工作空间外的源配置
- **THEN** 被 `resolveInside()` 拦下并报错
