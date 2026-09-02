## Context

看板现在的资料入口只有一条:人把文件放进 `input/raw/`,在界面上点转换,
服务端 `spawn` 工作空间自己的 `scripts/ingest.py`,脚本把产物写进 `input/converted/`,
写盘被 `watchWorkspace` 的 SSE 捕获,页面自己刷新。看板全程只读、只起子进程。

这条链路已经证明是对的:**写盘的责任在工作空间脚本,看板不碰**。
数据库接入沿用它,只换生产者 —— 从"读本地文件"换成"读远端库"。

约束来自三处:
- **只读红线**:看板服务端不写工作空间,不加数据库驱动,不开连接。
- **常驻服务不热更 + 版本错配**:用户可能跑着旧进程配新前端,新增字段必须可选、
  前端缺字段要退回改动前的行为。
- **模板脚本的"零第三方 Python 依赖"传统**:`ingest.py` 一路坚持只用标准库 + 外部 CLI,
  换台机器就能跑。连数据库这件事会第一次挑战它 —— 这是本设计最主要的取舍。

## Goals / Non-Goals

**Goals:**
- 让 AI 能基于业务库里的事实工作,而磁盘上只留 KB 级 schema 摘要 + 真正问过的那几张结果表。
- 上下文里默认只有 schema 摘要;查询结果以"路径 + 行列数 + 摘要"的形式出现,正文按需读。
- 采集对生产库是轻的:只读、有超时、无 `count(*)`、跑完即断。
- 没配数据源的工作空间,界面和接口与今天完全一致。

**Non-Goals:**
- **不做 SQL 客户端**。看板界面上不提供写 SQL 的输入框。L2 查询由 AI 在终端里跑脚本发起,
  看板只提供 L1 的「刷新 schema」按钮。看板是只读看板,不是 DBeaver。
- 不做增量同步、不做本地镜像库、不做定时采集、不做向量索引。
- 不做跨库联查、不做血缘分析。
- 不改 `ingest.py` 已有的任何文件转换行为。

## Decisions

### 决策 1:驱动怎么来 —— 可选第三方驱动为主,官方 CLI 为备

**选择**:`db_ingest.py` 保持"**零强制依赖**",但允许**按需 import** 第三方驱动 ——
本轮只覆盖 PostgreSQL(`psycopg`)与 MySQL(`pymysql`)两种。
import 失败时给出中文提示,点名该装哪个包、装完再试。
yaml 里可选 `client: cli`,改走对应数据库的官方命令行客户端(如 `psql --csv`)作为子进程。

**为什么**:
- 数据库 wire protocol 用标准库自己实现不现实,这条路直接排除。
- 驱动的成本**只落在真的配了数据源的人身上** —— 没配的人一行依赖都不多。
  这与 `ingest.py` 的现状其实是同一个模式:MinerU 要 key、anydoc 要二进制,
  也都是"用到才要"。所谓"零依赖"守的是**开箱即用**,不是"永不 import"。
- 留 CLI 备份路,是因为很多企业环境里 `psql` 早就装好了,而 `pip install` 反倒要走审批。

**代价**:CLI 路的输出解析比驱动脆弱(NULL 和空串难分、引号转义),所以它是备选不是默认,
且只保证 schema 采集可用,查询产物仍推荐走驱动。

### 决策 2:schema 采集统一走 information_schema,行数只取估算值

各引擎的系统表差异很大,但 `information_schema.TABLES / COLUMNS / KEY_COLUMN_USAGE`
是共同底盘。行数走各自的估算来源:PostgreSQL 取 `pg_class.reltuples`,
MySQL 取 `information_schema.TABLES.TABLE_ROWS`。

**为什么不 `count(*)`**:大表全表扫会拖垮生产库,而我们只需要量级 ——
AI 要知道的是"这表是万级还是亿级",不是精确到个位。估算值偏差再大也不影响它写 SQL 的决策。

### 决策 3:样例行默认不抽

`samples` 在 yaml 里默认 `0`。要抽样例行必须显式配,且有行数上限。

**为什么**:样例行是**真实业务数据落盘**。schema(表名列名类型)通常不敏感,
数据本身往往敏感。默认关掉,让"把生产数据写到磁盘"永远是一个用户主动做出的决定。

### 决策 3.5:写操作由数据库自己拒绝,不靠脚本里的字符串匹配

**前提变了**:原设计假设用户会为看板单独建只读账号,把"只读账号"当作根本护栏。
实际上**用户配环境时给的一般就是 root**。这条前提一没,原来那套护栏就只剩脚本里的
字符串白名单 —— 而字符串匹配是挡不住的:

- 多语句:`SELECT 1; DROP TABLE t` 前缀完全合法;
- PostgreSQL 的可写 CTE:`WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x`
  以 `WITH` 开头、以 `SELECT` 收尾,任何前缀白名单都放行;
- 带副作用的函数调用:`SELECT my_proc()`。

**选择**:连上之后、跑任何语句之前,先把**会话**置为只读:

- PostgreSQL:`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`
  (等价于把 `default_transaction_read_only` 打开)。PG 在只读事务里会同时拒绝
  DML 和 DDL,拿着超级用户也一样 —— 这层最硬。
- MySQL:`SET SESSION TRANSACTION READ ONLY`(5.6+)。DML 由服务端直接打回。

**保留的第二道**:脚本侧的语句白名单 + 禁多语句仍然留着,但职责变了 ——
它不再是"根本护栏",而是①失败得更早、报错是人话(告诉 AI"这条不让跑",
而不是抛一句数据库的英文错);②补 MySQL 的那个缝:MySQL 上 DDL 会触发隐式提交,
**只读事务未必拦得住 DDL**,所以 `CREATE` / `DROP` / `ALTER` / `TRUNCATE` 这类
必须在脚本侧就拒掉。PostgreSQL 上这层是冗余的,冗余就冗余。

**禁多语句**靠驱动的默认行为(pymysql 默认不带 `CLIENT_MULTI_STATEMENTS`;
psycopg 走扩展协议,一次 execute 只允许一条),再加脚本侧一道裸分号检查兜底。
这三点在实现时要**逐条实测确认**,不能只信文档 —— 已写进 tasks。

**代价**:多发一条 `SET SESSION`,可忽略。真正的代价是这套东西**没法在看板界面上证明给用户看** ——
用户只能相信脚本这么干了。所以 `input/sources/README.md` 里要写明白:
即使配的是 root,脚本也只在只读会话里跑;但**最稳妥的做法仍然是建个只读账号**,
我们只是不再依赖它。

### 决策 4:manifest 的分级 —— 超阈值就退化成表清单

单份 manifest 目标是 KB 级、能整体进上下文。表数超阈值时退化为"表清单 + 一句话用途",
列明细拆进 `_sources/<源名>/SplittingObject/<表>.md`。

**为什么用 SplittingObject**:这是 `ingest.py` 处理 xlsx 多 sheet 时已有的约定
(摘要留在镜像目录、正文收进 `SplittingObject/<文件名>/`),看板的 `scan.mjs` 已经认它。
复用等于零成本拿到既有的展示形态,不用为数据库再教看板认一套新结构。

### 决策 5:采集任务独立于转换任务

新开一个 `sourceJobs` map,与 `ingestJobs` 并列,不共用同一把锁。

**为什么**:两件事互不相干。正在转一份大 PDF 的时候不该连 schema 都刷不了。
但**代码形状照抄** `startIngest` —— 同样的 job 结构、同样的 stdout 累积、
同样的 `child.on('error')` 兜底(spawn 异步失败不能把常驻服务带崩)、
同样的立即返回 + 轮询进度。这是本仓已经跑通的模式,不发明第二种。

### 决策 6:「数据库源」是 InputPanel 的第四个 tab,数据库产物只在这个 tab 里看

侧栏那四个视图(概览 / 输入 / 产出 / 视觉)是稳定心智,不该因为一个可选配置多一格。
数据库源本质就是 input 的一种来源形态,与「图片资料」同级,**排在三个已有 tab 之后**。

**没配数据源时这个 tab 完全不出现** —— 不是灰掉、不是空态,是不渲染。
判据就是 `Scan.input.sources` 这个可选字段有没有内容,于是三种情况走同一条代码路径:
没配、配了但目录空、旧服务进程压根不给这个字段。不需要为版本错配单写分支。

代价是**发现性**:没配过的人在界面上看不到这个功能存在。这是有意的取舍 ——
给一个大多数人用不上的功能常驻一个空 tab,是拿所有人的界面换少数人的发现性。
发现性交给模板自带的 `input/sources/README.md` 和帮助面板里的一句话。

**数据库产物只在这个 tab 里看,不在「已转换」里建条目。** 数据库和文件是两条来源,
混进同一个清单会让"已转换"的语义糊掉 —— 用户是按源找数据,不是在几百份文档里翻一份 csv。

实现上**不靠读 frontmatter 分流**,而是把所有数据库产物落进保留目录
`input/converted/_sources/<源名>/`,`scan.mjs` 按路径前缀分流:
这个前缀下的东西不进 `converted` 列表,改挂到对应的源上。
判据明确、零额外读盘,`_` 前缀也不会跟用户 `input/raw/` 里的真实目录名撞车
(converted 镜像 raw 的结构,raw 里不会有叫 `_sources` 的目录;真撞了也只是那个目录的
产物被归到数据库源下,不会丢)。

`InputPanel` 现有的"非当前 tab 不挂载"约定原样适用。

## Risks / Trade-offs

- **[破了"零 Python 依赖"的传统]** → 破得有条件:只在用户主动配了数据源时才需要装驱动,
  没配的人零成本;报错必须具体到"装哪个包";并保留 CLI 备选路给装不了包的环境。
  这条要在 `templates/pm-aispace/AGENTS.md` 里写清楚,免得后来人以为原则松了。

- **[AI 拿着 root 对生产库发语句]** → 护栏见决策 3.5:根本那层是**只读会话**(数据库强制),
  脚本侧白名单补 MySQL 的 DDL 缝,再加强制 LIMIT + 超时 + SQL 全文留痕。
  **残留风险**:`SET SESSION` 万一没发出去(连接重建、驱动自动重连)就全线失守,
  所以每次执行前要确认会话状态,而不是连上时设一次就假定它一直成立。
  MySQL 的 DDL 是否真能绕过只读事务,实现时必须实测,不能只信文档。

- **[明文 root 凭据落在用户磁盘的 `.env`]** → 已拍板走这条,但风险因为"通常是 root"而变大了:
  泄露的不是一个只读账号,是整个库。与看板的只读承诺不冲突(读 `.env` 的是脚本不是看板),
  但 `input/sources/README.md` 必须把两件事说在明处:把 `.env` 写进 `.gitignore`;
  以及"能建只读账号还是建一个,我们不依赖它,但它是最后一道"。钥匙串方案本轮不做。

- **[schema 快照会过期,AI 拿着旧结构写 SQL]** → 快照的 frontmatter 记采集时间,
  界面显示"多久之前采的",超过阈值用 orange 标"需要处理"。
  不做自动刷新 —— 后台定时连生产库违背"用户明确发起"的一贯原则。

- **[采集失败把好快照弄没了]** → 脚本必须**先写临时文件再原子替换**,
  连不上库时上一份快照原样保留。这一条已经写进 spec 的场景。

- **[结果 CSV 越攒越大]** → 有行数上限和截断标注,但没有自动清理。
  产物的删除仍然由用户在文件系统里做 —— 与看板"只读、不删"的红线一致。

## Migration Plan

纯新增,无迁移、无数据改写:

1. 先落模板侧的 `db_ingest.py` 与 `input/sources/` 骨架 —— 它能独立于看板在终端里跑通,
   这是验证 L1/L2 产物形态最快的路。
2. 再落服务端的扫描与采集路由(**改完必须重启 `pnpm serve`**)。
3. 最后落前端 tab。

回滚就是删掉新增的路由与 tab;工作空间里已经产出的 schema 快照和查询 CSV
就是普通 Markdown / CSV,回滚后仍然躺在 `input/converted/` 里能被正常预览,不会变成孤儿。

老工作空间(没有 `scripts/db_ingest.py`)不受影响:不显示 tab;
真去点了也只会拿到一句"这个工作空间没有采集脚本"的中文提示,不创建任何目录。

## Open Questions

1. ~~**只读会话在异常路径下会不会失效**~~ —— **已实测,见下**。
2. ~~**MySQL 上 DDL 到底能不能绕过只读事务**~~ —— **已实测,见下**。
3. schema 快照的"过期阈值"是写死一个默认值,还是让 yaml 每个源自己配?
   倾向写死默认 + 允许覆盖,先看用起来什么感觉。
4. 文件型库(SQLite / DuckDB)本轮不做。将来做的话,它的文件常在工作空间外,
   `resolveInside()` 的边界要单独想清楚。

**已关闭**:凭据存放(定为工作空间 `.env` 明文)、引擎范围(定为 PostgreSQL + MySQL)、
写操作护栏(定为只读会话 + 脚本侧白名单双层,不依赖只读账号)。

## 实测结论(任务 1.4)

环境:PostgreSQL 18.4 / psycopg 3.3.5,MySQL 9.3.0 / pymysql 2.2.8,对自建的合成小库跑。
下面每一条都是**跑出来的**,不是从文档抄的。

**① PostgreSQL 的只读会话挡得住可写 CTE** —— 挡得住,而且挡得比预期早:
`WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x` 报的是
`cannot execute SELECT in a read-only transaction`,整条语句在规划阶段就被打回。
UPDATE / CREATE TABLE / TRUNCATE 同样被拒。拿的是**超级用户**,一样拒。

**② MySQL 的只读事务挡得住 DDL** —— 在 9.3.0 上挡得住:CREATE TABLE / TRUNCATE / DROP TABLE
全都报 `(1792, 'Cannot execute statement in a READ ONLY transaction.')`,
隐式提交**没有**绕过只读事务。但这只证明了 9.3.0,老版本(5.7 / 8.0)手上没有环境验,
**所以脚本侧的 DDL 黑名单保留** —— 它现在的职责是给老服务端兜底,外加更早失败、报中文。

**③ 多语句:两个驱动的行为不一样,而且 PG 这边是个真的坑**

- pymysql 默认**不带** `CLIENT_MULTI_STATEMENTS`(实测 `client_flag & MULTI_STATEMENTS == False`),
  `SELECT 1; DROP TABLE t` 直接是语法错误,进不了服务端。
- psycopg 3 **不设防**:不带参数的 `execute()` 走简单查询协议,
  `SELECT 1; CREATE TABLE multi_probe(i int)` **两条都执行了,表真的建出来了**。
  只有带参数时才走扩展协议,报 `cannot insert multiple commands into a prepared statement`。

所以决策 3.5 里「禁多语句靠驱动的默认行为」这句话**对 psycopg 是错的**。
第一轮探测里那条 `SELECT 1; DROP TABLE t` 之所以没删掉表,靠的是只读会话拦下了 DROP,
不是驱动拦下了多语句。**脚本侧的裸分号检查因此是承重的,不是冗余的。**

**④ 只读会话是连接级的,重连即丢失** —— 新开一条没设置过的 PG 连接
`default_transaction_read_only` 是 `off`;pymysql `ping(reconnect=True)` 之后
`@@session.transaction_read_only` 从 1 变回 0。
结论:不能「连上时设一次就假定它一直成立」,**每次执行用户语句前都要重新确认一次会话状态**
(任务 1.7 按这条实现:读回 `default_transaction_read_only` / `@@session.transaction_read_only`,
不是 `on` / `1` 就中止)。
