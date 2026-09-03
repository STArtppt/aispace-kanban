## Why

现在资料只能从文件进来:人把 docx / xlsx / pdf 丢进 `input/raw/`,`ingest.py` 转成文本。
但知识工作里有一大类事实活在**业务系统的数据库**里 —— 想让 AI 基于它分析,今天只有两条路:
要么人手工导出一堆 CSV 塞进 `input/raw/`(导完就过期,而且导什么全靠猜),
要么把库整个同步到本机(占磁盘、要维护增量、生产数据完整落地还有合规问题)。
第三条常见路子 —— 挂个数据库 MCP 让 AI 直连随便查 —— 每次查询结果都直接进上下文,
几百行就把窗口撑爆,而且不留产物,换个会话得从头重查。

结果就是:**库里的数据进不来,或者进来一次就废掉。**

## What Changes

把数据库当**按需查询的远端资源**接入,而不是当"要同步过来的资料"。产物形态仍然是
`input/converted/` 下的文件,只是生产者从 `ingest.py`(读本地文件)换成
`db_ingest.py`(读远端库)。分三层:

- **L0 连接配置**:工作空间里新增 `input/sources/<name>.yaml`,只写连接的形状
  (引擎、主机占位、库名、schema 白名单、只读账号的**环境变量名**);
  凭据本身留在工作空间的 `.env`,不进 yaml、不进 git。
- **L1 schema 快照**:低频采集一次,产出 `input/converted/_sources/<源名>/_manifest_<源名>.md` ——
  表清单、每表列名/类型/注释、主外键、行数**量级**、少量脱敏样例行。KB 级,
  这是默认进 AI 上下文的唯一一份。行数取 `information_schema` 的估算值,
  **不跑 `count(*)`**,避免拖垮生产库。表多到 manifest 自己要爆时,manifest 只留
  "表清单 + 一句话用途",单表列明细拆进 `_sources/<源名>/SplittingObject/<表>.md`,AI 按需读单表。
- **L2 按需查询产物**:AI 写 SQL,脚本执行,结果落
  `input/converted/_sources/<源名>/<查询名>.csv`,配套 `_manifest_<查询名>.md` 记
  SQL 原文、执行时间、行数、sha256 —— 沿用 `ingest.py` 已有的可溯源 frontmatter 约定。
  强制 `LIMIT` + 语句超时,写操作由**数据库自己**拒绝(见下)。

看板侧:

- 扫描认出 `input/sources/*.yaml`,在 `Scan.input` 上多一块**可选**的数据源信息。
- `InputPanel` 加第四个 tab「数据库源」,与 待转换 / 已转换 / 图片资料 平级;
  **只有工作空间里确实存在 `input/sources/*.yaml` 时才显示这个 tab**,
  没配过的工作空间界面与今天一模一样。tab 里显示每个源的 schema 快照采集时间和
  「刷新 schema」按钮;快照过期或上次采集失败,按现有配色规则用 orange 标出来。
- **L2 的查询产物也在「数据库源」tab 里看,不在「已转换」里建条目。**
  数据库产物和文件转换产物是两条来源,混在一个清单里会让"已转换"的语义糊掉 ——
  用户按源找数据,而不是在几百份文档里翻一份 csv。
  落点用保留目录 `input/converted/_sources/`,扫描按这个路径前缀分流,判据明确、零额外读盘。

**本轮覆盖 PostgreSQL 与 MySQL 两种引擎。** 文件型库(SQLite / DuckDB)不做 ——
它的文件通常在工作空间外,`resolveInside()` 的边界要单独想,留到下一轮。

**不做**:看板服务端不加任何数据库驱动,不在看板进程里开连接、不做连接池、
不做定时同步、不建本地索引或向量库。看板界面上也不提供写 SQL 的输入框。

## Capabilities

### New Capabilities
- `database-source`: 数据库作为工作空间输入源的接入方式 —— 源配置的发现规则、
  schema 快照与查询产物的落点和形态、采集的触发方式、以及"看板不碰数据库"的边界。

### Modified Capabilities
(无)`rich-doc-convert` 的七条需求讲的都是富文档转 Markdown 本身的行为,
没有一条约束"转换由谁触发",数据源采集是另起的一条链路,不改它的任何需求。

## Impact

**平面影响面**

| 平面 | 改什么 |
| --- | --- |
| 服务端 `src/server/**` | `scan.mjs` 认 `input/sources/*.yaml` 并读出源清单;`http.mjs` 新增触发采集的路由,复用 `startIngest` 那条 spawn 模式(改进程,**必须重启**才生效) |
| 前端 `src/app/**` | `lib/api.ts` 加类型;`InputPanel.tsx` 加第四个 tab 及其条件显示 |
| templates | `templates/pm-aispace/scripts/db_ingest.py` 新增;`input/sources/` 骨架与 README 说明 |
| CLI `bin/cli.mjs` | 不动 |

**动 `src/app/lib/api.ts` 契约**:是。`Scan.input` 新增字段,以及采集任务的响应类型。
按常驻服务的兼容性要求,新增字段一律可选,前端读不到就退回改动前的行为
(没有数据源信息 = 不显示那个 tab,正好与"没配过"同一条路径)。

**依赖**:看板两个平面都**不加新依赖**。数据库驱动只可能出现在工作空间的
`db_ingest.py` 里,而模板脚本的既有原则是"零 Python 第三方依赖" ——
这一条在 design 里要专门定,因为连库这件事很难完全靠标准库做完,
它是本提案最需要拍板的技术取舍。

**只读红线**:不放宽。写 `input/converted/` 的仍然是工作空间自己的脚本,
看板只 `spawn` 子进程、读 stdout,与今天触发 `ingest.py` 完全同构。
看板进程自身对工作空间依旧只读,新增的接收路径的接口照样先过 `resolveInside()`。

**已拍板的三件事**

1. **凭据放工作空间的 `.env`**,yaml 里只留环境变量名。这意味着一份明文凭据落在用户自己的
   磁盘上 —— 与"看板只读工作空间"不冲突(看板不读 `.env`,是脚本读),但 `input/sources/README.md`
   必须把这件事和"把 `.env` 写进 `.gitignore`"说在明处。钥匙串方案本轮不做。
2. **只做 PostgreSQL + MySQL。**
3. **AI 只能查,不能增删改。**

**第 3 条改变了整个护栏设计,单独说清楚**

原方案把"只读账号"当作根本护栏,其余三层(语句白名单、强制 LIMIT、SQL 留痕)只是补充。
但现实是**用户配环境时给的一般就是 root** —— 这条前提一没,"只读账号"那层等于不存在,
剩下的全是脚本里的字符串匹配,而字符串匹配挡不住多语句(`SELECT 1; DROP TABLE t`)、
挡不住 PostgreSQL 的 `WITH x AS (DELETE ... RETURNING) SELECT *`。

所以护栏改成**让数据库自己拒绝写操作**:每次连接后先把会话置为只读事务
(PostgreSQL `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`,
MySQL `SET SESSION TRANSACTION READ ONLY`),之后即便拿着 root,
INSERT / UPDATE / DELETE 也会被服务端直接打回。这是**数据库层的强制**,不是君子协定。
脚本侧的语句白名单和多语句禁用仍然保留,但降级为"快速失败 + 给人话报错"的第一道,
外加挡 MySQL 上 DDL 可能因隐式提交绕过只读事务的那个缝。细节见 design.md。
