# input/sources/ — 数据库作为按需查询的资料源

这个目录里放**连接的形状**，一个源一份 `<名字>.yaml`。
它描述「有这么一个库、它长这样、账号在哪个环境变量里」，**不含任何口令**。

没有这个目录、或目录是空的，一切与从前一样：看板不显示「数据库源」，
`scripts/db_ingest.py` 也不会被用到。这个功能是**配了才存在**的。

## 为什么不直接把库同步下来

同步一份到本机要占磁盘、要维护增量，生产数据整个落地还有合规问题；
挂个数据库 MCP 让 AI 随便查，则是每次查询结果都直接进上下文，几百行就把窗口撑爆，
而且不留产物，换个会话得从头重查。

所以这里走第三条路:**库是远端资料源，只按需取，取到的东西落成文件**。

- **L1 schema 快照**（低频采一次）：`input/converted/_sources/<源名>/_manifest_<源名>.md` —
  表清单、列名类型注释、主外键、行数量级。KB 级，这是默认进 AI 上下文的唯一一份。
- **L2 查询产物**（AI 想问什么才跑）：`input/converted/_sources/<源名>/<查询名>.csv`
  加一份 `_manifest_<查询名>.md` 记 SQL 原文、执行时间、行数、sha256。
  上下文里只留路径和摘要，正文按需读。

## 配一个源

```bash
cp input/sources/example.yaml.txt input/sources/仓库库.yaml   # 改成你自己的名字
```

```yaml
# input/sources/仓库库.yaml
name: 仓库业务库              # 显示名。不写就用文件名
engine: postgresql            # 只支持 postgresql / mysql
host: 127.0.0.1
port: 5432
database: warehouse
schemas:                      # schema 白名单。不写 = 该引擎的默认（PG: public，MySQL: 当前库）
  - public
user_env: WAREHOUSE_DB_USER           # 账号在哪个环境变量里（**不是账号本身**）
password_env: WAREHOUSE_DB_PASSWORD   # 口令在哪个环境变量里（**不是口令本身**）
samples: 0                    # 每张表抽几行样例进 manifest。默认 0 = 不抽，见下
max_rows: 5000                # 单次查询落盘的行数上限，超了截断并在 manifest 里写明
timeout: 15                   # 语句超时（秒）
client: driver                # driver（默认，走 psycopg / pymysql）或 cli（走 psql，见下）
```

口令、token、完整连接串**不要写进 yaml**。yaml 是要入库的，凭据不是。

## 凭据放 `.env`，而 `.env` 必须在 `.gitignore` 里

```bash
# 工作空间根目录的 .env（与 MINERU_API_KEY 同一份）
WAREHOUSE_DB_USER=readonly_user
WAREHOUSE_DB_PASSWORD=你的口令
```

模板自带的 `.gitignore` 里已经有 `.env` 那一行。**自己 mkdir 的工作空间请先确认这一条**：

```bash
grep -q '^\.env$' .gitignore || echo '.env' >> .gitignore
```

这意味着一份明文凭据躺在你自己的磁盘上。看板不读 `.env`（读它的是
`scripts/db_ingest.py` 这个工作空间自己的脚本），但这份文件泄露就等于库泄露 ——
所以它绝不能进版本库、不能随工作空间打包发给别人。

## 关于账号权限：即使你配的是 root

现实里大家配环境时给的一般就是 root，所以脚本**不把「你会自己建只读账号」当成安全前提**。

`db_ingest.py` 在连上之后、发任何一条用户语句之前，先把会话置为只读事务
（PostgreSQL `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`，
MySQL `SET SESSION TRANSACTION READ ONLY`）。之后即便拿着 root，
INSERT / UPDATE / DELETE 也会被**数据库服务端**打回，不是靠脚本里的字符串匹配。
这条设置失败时脚本直接中止，不会降级成「只靠白名单继续跑」。

脚本自己还有第二道：拒绝非查询语句、禁多语句。它的职责是失败得更早、报错是人话，
以及补上 MySQL 那个缝 —— MySQL 的 DDL 会触发隐式提交，只读事务未必拦得住，
所以 `CREATE` / `DROP` / `ALTER` / `TRUNCATE` 必须在脚本侧就拒掉。

**但能建只读账号还是建一个。** 我们不再依赖它，它仍然是最后一道：

```sql
-- PostgreSQL
CREATE USER kanban_ro WITH PASSWORD '…';
GRANT CONNECT ON DATABASE warehouse TO kanban_ro;
GRANT USAGE ON SCHEMA public TO kanban_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO kanban_ro;

-- MySQL
CREATE USER 'kanban_ro'@'%' IDENTIFIED BY '…';
GRANT SELECT ON warehouse.* TO 'kanban_ro'@'%';
```

## 样例行默认不抽

`samples` 默认 `0`。schema（表名列名类型）通常不敏感，**数据本身往往敏感** ——
抽样例行等于把真实业务数据写到磁盘上。所以这件事永远得由你显式做一次决定：
真要抽就把 `samples` 改成一个小数字（3 ~ 5 就够 AI 看清字段长什么样）。

## 采集与查询

```bash
python3 scripts/db_ingest.py list                       # 列出配好的源和它们的状态
python3 scripts/db_ingest.py schema 仓库库               # L1：采一次 schema 快照
python3 scripts/db_ingest.py query 仓库库 \
    --name 近30天入库量 \
    --sql "SELECT dt, count(*) FROM inbound WHERE dt > now() - interval '30 days' GROUP BY dt"
```

看板上「数据库源」tab 里的「刷新 schema」按钮跑的就是上面第二条。
**L2 查询不在看板上做** —— 看板是只读看板，不是 SQL 客户端，界面上没有写 SQL 的输入框。
写 SQL 这件事由 AI 在终端里发起。

采集连不上库时，**上一份快照原样保留**（脚本先写临时文件再原子替换），
不会出现「刷新了一下，好好的快照没了」。

## 需要装驱动

`db_ingest.py` 本身只用标准库，但连数据库这件事没法用标准库做完：

```bash
pip install "psycopg[binary]"     # PostgreSQL
pip install pymysql               # MySQL
```

**只有配了数据源的人需要装**，没配的人一行依赖都不多。
装不了包的环境（比如 `pip install` 要走审批）可以在 yaml 里写 `client: cli`，
改走 `psql` 命令行客户端 —— 但这条路只保证 schema 采集可用，查询产物仍推荐走驱动
（CLI 的输出里 NULL 和空串分不开）。MySQL 暂不支持 `client: cli`。

## yaml 只支持一个很小的子集

脚本用标准库解析这份 yaml（不引 PyYAML），只认这些写法：

- `key: value` 平铺一层，不支持嵌套字典
- 列表写成 `key: [a, b]` 或 `key:` 换行后 `  - a`
- `#` 开头是注释，值里的引号会被剥掉

写复杂了脚本会报「这份配置读不出来」，看板上那个源也会以同样的状态列出来 ——
不影响同目录下其它源。
