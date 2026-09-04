#!/usr/bin/env python3
"""把数据库当**按需查询的远端资料源**接进来，产物仍然是 input/converted/ 下的文件。

与 ingest.py 的关系
-------------------
`ingest.py` 读本地文件、写 `input/converted/`；本脚本读远端库、写
`input/converted/_sources/<源名>/`。两者产物形态同构（都带可溯源的 frontmatter），
只是生产者不同。看板照样只 `spawn` 本脚本、读 stdout，写盘的是脚本自己。

两层产物
--------
L1 schema 快照（低频采一次，KB 级，这是默认进 AI 上下文的唯一一份）::

    input/converted/_sources/<源名>/_manifest_<源名>.md

    表清单、每表列名/类型/注释、主外键、行数**量级**。表多到一份装不下时退化成
    「表清单 + 一句话用途」，单表明细拆进 SplittingObject/<表>.md（沿用 layout.py 的约定）。

L2 查询产物（AI 想问什么才跑）::

    input/converted/_sources/<源名>/<查询名>.csv
    input/converted/_sources/<源名>/_manifest_<查询名>.md   ← SQL 原文 / 行数 / sha256

护栏：写操作由数据库自己拒绝
----------------------------
用户配环境时给的一般就是 root，所以**不把「用户会建只读账号」当安全前提**。
连上之后、发任何一条用户语句之前先把会话置为只读，之后即便拿着 root，
写操作也由数据库服务端打回。这条设置失败就中止，不降级成「只靠脚本白名单」。

脚本侧还有第二道（拒绝非查询语句、禁多语句）。它不是装饰 —— 实测结论（见
openspec/changes/database-input-source/design.md）：

* PostgreSQL 的只读会话挡得住可写 CTE、DDL、TRUNCATE，超级用户也一样。
* MySQL 9.3 的只读事务挡得住 DDL；老版本没环境验，所以 DDL 黑名单保留着兜底。
* **psycopg 3 不带参数时走简单查询协议，多语句是真的会执行的**
  （`SELECT 1; CREATE TABLE x(i int)` 两条都跑）。所以裸分号检查是承重的。
* 只读会话是连接级的，重连即丢失 —— 因此**每次执行用户语句前都重新确认一次**。

依赖
----
脚本本身只用标准库。连库要装驱动，**只有配了数据源的人需要装**::

    pip install "psycopg[binary]"     # PostgreSQL
    pip install pymysql               # MySQL

装不了包的环境可以在 yaml 里写 `client: cli` 走 psql（只保证 schema 采集）。

用法
----
    python3 scripts/db_ingest.py list
    python3 scripts/db_ingest.py schema <源名>
    python3 scripts/db_ingest.py query <源名> --name 近30天入库量 --sql "SELECT …"
    python3 scripts/db_ingest.py query <源名> --name 近30天入库量 --sql-file q.sql
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from envfile import load_dotenv  # noqa: E402
from layout import CONVERTED, REPO, repo_rel, safe_component  # noqa: E402

# 源配置的落点：一个源一份 yaml，只写连接的形状，凭据在 .env 里
SOURCES_DIR = REPO / "input" / "sources"
# 数据库产物的保留目录。看板按这个路径前缀分流：它下面的东西不进「已转换」清单，
# 改挂到「数据库源」tab 里对应的源下。改这个名字要同步 src/server/scan.mjs。
SOURCES_OUT = CONVERTED / "_sources"
# 正文容器目录名，与 layout.SPLIT_DIR 同名（看板的 scan.mjs 已经认它）
SPLIT_DIR = "SplittingObject"

SUPPORTED_ENGINES = ("postgresql", "mysql")
# 表多到一份 manifest 装不下时退化成表清单，单表明细拆出去。
# 阈值按「一份 manifest 要能整体读进上下文」定：每表大约 10 行 × 40 表 ≈ 一屏多一点。
SPLIT_TABLE_THRESHOLD = 40
# 单条查询默认落盘上限 / 语句超时（秒），yaml 里可覆盖
DEFAULT_MAX_ROWS = 5000
DEFAULT_TIMEOUT = 15
# 采样默认关掉：样例行是真实业务数据落盘，得由用户显式决定一次
DEFAULT_SAMPLES = 0
# 抽样例行时每表最多抽几行，挡住 samples 被写成 100000 这种
SAMPLES_CAP = 20


class ConfigError(Exception):
    """这份源配置读不出来 / 写得不对。给中文人话，不抛库的原文。"""


class GuardError(Exception):
    """护栏拒绝了这条语句，或者只读会话没设上。"""


def log(msg: str) -> None:
    print(msg, flush=True)


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


# --------------------------------------------------------------------------- #
# 1. 源配置：input/sources/<名字>.yaml
#
# 用标准库解析，不引 PyYAML —— 只认一个很小的子集（平铺的 key: value、两种列表写法、
# # 注释）。写复杂了就报「这份配置读不出来」，看板上那个源也是同样的状态，
# 不影响同目录下其它源。子集的定义写在 input/sources/README.md 里，两边要一致。
# --------------------------------------------------------------------------- #

def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        return value[1:-1]
    return value


def parse_mini_yaml(text: str) -> dict:
    """平铺 yaml → dict。看不懂的写法一律 ConfigError，不猜。"""
    data: dict = {}
    pending_list_key = ""
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.split("#", 1)[0].rstrip() if not _in_quotes_hash(raw) else raw.rstrip()
        if not line.strip():
            continue
        if line.lstrip().startswith("- "):
            if not pending_list_key:
                raise ConfigError(f"第 {lineno} 行：列表项前面没有对应的字段名")
            data[pending_list_key].append(_unquote(line.lstrip()[2:]))
            continue
        if line[0] in " \t":
            raise ConfigError(f"第 {lineno} 行：不支持缩进的嵌套字段，只能写平铺的 key: value")
        if ":" not in line:
            raise ConfigError(f"第 {lineno} 行：不是 key: value 的写法")
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        if not key:
            raise ConfigError(f"第 {lineno} 行：字段名是空的")
        if not value:
            data[key] = []
            pending_list_key = key
            continue
        pending_list_key = ""
        if value.startswith("[") and value.endswith("]"):
            inner = value[1:-1].strip()
            data[key] = [_unquote(p) for p in inner.split(",") if p.strip()] if inner else []
        else:
            data[key] = _unquote(value)
    return data


def _in_quotes_hash(raw: str) -> bool:
    """这一行的 # 是不是落在引号里（那样它就不是注释）。"""
    pos = raw.find("#")
    if pos < 0:
        return False
    return raw[:pos].count("'") % 2 == 1 or raw[:pos].count('"') % 2 == 1


def _int_field(data: dict, key: str, default: int, name: str) -> int:
    if key not in data or data[key] == "":
        return default
    try:
        return int(str(data[key]).strip())
    except ValueError:
        raise ConfigError(f"{name}：`{key}` 要写成整数，现在写的是 {data[key]!r}") from None


class Source:
    """一个数据源的配置。**不含凭据** —— 只记环境变量名，值在用的时候才去 .env 里取。"""

    def __init__(self, path: Path, data: dict):
        self.path = path
        self.key = path.stem                       # 源名：文件名去掉 .yaml
        self.display = str(data.get("name") or self.key)
        self.engine = str(data.get("engine") or "").strip().lower()
        if self.engine in ("postgres", "pg"):
            self.engine = "postgresql"
        self.host = str(data.get("host") or "127.0.0.1")
        self.database = str(data.get("database") or "")
        self.user_env = str(data.get("user_env") or "")
        self.password_env = str(data.get("password_env") or "")
        self.client = str(data.get("client") or "driver").strip().lower()
        schemas = data.get("schemas") or []
        if isinstance(schemas, str):
            schemas = [schemas]
        self.schemas = [s for s in (str(x).strip() for x in schemas) if s]
        self.port = _int_field(data, "port", 5432 if self.engine == "postgresql" else 3306, self.key)
        self.samples = min(_int_field(data, "samples", DEFAULT_SAMPLES, self.key), SAMPLES_CAP)
        self.max_rows = _int_field(data, "max_rows", DEFAULT_MAX_ROWS, self.key)
        self.timeout = _int_field(data, "timeout", DEFAULT_TIMEOUT, self.key)

        if self.engine not in SUPPORTED_ENGINES:
            raise ConfigError(
                f"{self.key}：`engine` 现在只支持 postgresql 和 mysql，"
                f"这份写的是 {self.engine or '（空）'}"
            )
        if not self.database:
            raise ConfigError(f"{self.key}：缺 `database`，不知道要连哪个库")
        if self.client not in ("driver", "cli"):
            raise ConfigError(f"{self.key}：`client` 只能写 driver 或 cli")
        if self.client == "cli" and self.engine != "postgresql":
            raise ConfigError(f"{self.key}：`client: cli` 目前只支持 postgresql（走 psql）")
        if not self.schemas:
            self.schemas = ["public"] if self.engine == "postgresql" else [self.database]

    @property
    def out_dir(self) -> Path:
        return SOURCES_OUT / safe_component(self.key)

    @property
    def dsn_label(self) -> str:
        """写进 frontmatter 的来源标识。**不含账号口令** —— 只有连接的形状。"""
        return f"db://{self.engine}/{self.host}:{self.port}/{self.database}"

    def credentials(self) -> tuple[str, str]:
        """从环境变量里取账号口令。缺了就点名缺哪个变量、该写进哪个文件，不回显任何值。"""
        load_dotenv(REPO / ".env")
        missing = [env for env in (self.user_env, self.password_env) if env and env not in os.environ]
        if not self.user_env:
            raise ConfigError(f"{self.key}：缺 `user_env`，不知道账号写在哪个环境变量里")
        if missing:
            raise ConfigError(
                f"{self.key}：环境变量 {'、'.join(missing)} 没有值。"
                f"把它写进工作空间根目录的 .env（.env 已在 .gitignore 里，不会入库），再试一次。"
            )
        return os.environ[self.user_env], os.environ.get(self.password_env, "")


def load_source(name: str) -> Source:
    path = SOURCES_DIR / f"{name}.yaml"
    if not path.is_file():
        raise ConfigError(
            f"没有这个数据源：{name}。配置放在 input/sources/{name}.yaml，"
            f"怎么写见 input/sources/README.md。"
        )
    try:
        data = parse_mini_yaml(path.read_text(encoding="utf-8"))
    except OSError as err:
        raise ConfigError(f"{name}：配置读不出来（{err}）") from None
    return Source(path, data)


def list_sources() -> list[tuple[str, Source | None, str]]:
    """(源名, Source 或 None, 读不出来时的中文原因)。坏的那份不影响其它源。"""
    out = []
    if not SOURCES_DIR.is_dir():
        return out
    for path in sorted(SOURCES_DIR.glob("*.yaml")):
        try:
            out.append((path.stem, load_source(path.stem), ""))
        except ConfigError as err:
            out.append((path.stem, None, str(err)))
    return out


# --------------------------------------------------------------------------- #
# 2. 护栏（脚本侧那一道）
#
# 根本那道是只读会话（数据库强制），见下一节。这里这道的职责是：失败得更早、
# 报错是中文人话，以及补上两个真实存在的缝 ——
#   * psycopg 不带参数时多语句是会执行的（实测），所以裸分号检查承重；
#   * 老版本 MySQL 的 DDL 会不会因隐式提交绕过只读事务，手上没环境验，所以黑名单保留。
# --------------------------------------------------------------------------- #

# 非查询语句：命中任意一个词就拒。挡的是「这条根本不该发出去」，不是「数据库会不会拒」。
FORBIDDEN = (
    "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "REPLACE",
    "CREATE", "DROP", "ALTER", "TRUNCATE", "RENAME", "COMMENT",
    "GRANT", "REVOKE", "SET", "RESET", "DISCARD", "VACUUM", "REINDEX",
    "CALL", "DO", "COPY", "LOAD", "IMPORT", "LOCK", "PREPARE", "EXECUTE",
    "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "START",
)
# 允许的起手式：查询、以及看结构 / 看计划这类只读语句
ALLOWED_HEADS = ("SELECT", "WITH", "SHOW", "EXPLAIN", "DESCRIBE", "DESC", "TABLE", "VALUES")
# 可以整段包进子查询加 LIMIT 的起手式（SHOW / DESCRIBE 不行，那些走客户端截断）
WRAPPABLE_HEADS = ("SELECT", "WITH", "TABLE", "VALUES")


def strip_sql_noise(sql: str) -> str:
    """去掉注释和字符串/标识符字面量，只留下骨架，供关键字和分号检查用。

    字面量必须去掉，否则 `WHERE note = 'please update'` 会被误判成写操作。
    """
    out = []
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        if ch == "-" and sql.startswith("--", i):
            i = sql.find("\n", i)
            if i < 0:
                break
            continue
        if ch == "/" and sql.startswith("/*", i):
            end = sql.find("*/", i + 2)
            i = n if end < 0 else end + 2
            continue
        if ch in "'\"`":
            quote = ch
            i += 1
            while i < n:
                if sql[i] == "\\" and quote == "'":
                    i += 2
                    continue
                if sql[i] == quote:
                    # 连续两个引号是转义，不算收尾
                    if i + 1 < n and sql[i + 1] == quote:
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
            out.append(" ")
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def ensure_readonly_sql(sql: str) -> str:
    """只放行只读查询，且只放行一条。返回去掉尾分号的原始 SQL。"""
    text = sql.strip()
    if not text:
        raise GuardError("SQL 是空的。")
    skeleton = strip_sql_noise(text).strip()

    # 禁多语句：骨架里除了结尾那个分号，不许再有分号。
    # 实测 psycopg 不带参数时会把 `SELECT 1; DROP TABLE t` 两条都执行掉，这道拦的就是它。
    body = skeleton.rstrip().rstrip(";").rstrip()
    if ";" in body:
        raise GuardError("一次只能跑一条语句。这条 SQL 里还有分号，看着像夹带了第二条。")

    head_match = re.match(r"[A-Za-z]+", body)
    head = head_match.group(0).upper() if head_match else ""
    if head not in ALLOWED_HEADS:
        raise GuardError(
            f"只能跑查询语句（{' / '.join(ALLOWED_HEADS[:4])} 这类），这条是 {head or '看不懂的东西'}。"
        )
    hit = [word for word in FORBIDDEN if re.search(rf"\b{word}\b", body, re.IGNORECASE)]
    if hit:
        raise GuardError(
            f"这条 SQL 里有 {hit[0]}，不是只读查询，脚本不发给数据库。"
            "数据源是只读的：要改数据请走业务系统自己的入口。"
        )
    return text.rstrip().rstrip(";").rstrip()


# --------------------------------------------------------------------------- #
# 3. 连接与只读会话
#
# 根本护栏在这里：连上之后、发任何一条用户语句之前先把会话置为只读。
# 设置失败即中止 —— 不降级成「只靠上面那道白名单」。
# 只读会话是**连接级**的、重连即丢失（实测），所以每次执行前都重新确认一次。
# --------------------------------------------------------------------------- #

def _require_driver(engine: str):
    if engine == "postgresql":
        try:
            import psycopg  # noqa: PLC0415
        except ImportError:
            raise ConfigError(
                "连 PostgreSQL 需要 psycopg，现在没装。跑一次 `pip install \"psycopg[binary]\"` 再试。"
                "装不了包的环境可以在这个源的 yaml 里写 `client: cli` 改走 psql（只保证 schema 采集）。"
            ) from None
        return psycopg
    try:
        import pymysql  # noqa: PLC0415
    except ImportError:
        raise ConfigError(
            "连 MySQL 需要 pymysql，现在没装。跑一次 `pip install pymysql` 再试。"
        ) from None
    return pymysql


class Session:
    """一条已经置为只读的连接。用完即断，不留常驻连接、不建连接池。"""

    def __init__(self, source: Source):
        self.source = source
        self.engine = source.engine
        self.conn = None

    def __enter__(self) -> "Session":
        user, password = self.source.credentials()
        src = self.source
        driver = _require_driver(self.engine)
        try:
            if self.engine == "postgresql":
                self.conn = driver.connect(
                    host=src.host, port=src.port, dbname=src.database,
                    user=user, password=password,
                    connect_timeout=src.timeout, autocommit=True,
                )
            else:
                self.conn = driver.connect(
                    host=src.host, port=src.port, database=src.database,
                    user=user, password=password,
                    connect_timeout=src.timeout, read_timeout=src.timeout + 5,
                    autocommit=True, charset="utf8mb4",
                )
        except Exception as err:  # 驱动的异常类型各不相同，一律翻成中文
            raise ConfigError(
                f"连不上 {src.display}（{src.dsn_label}）：{_short(err)}。"
                "检查主机端口通不通、库名对不对、.env 里的账号口令是不是过期了。"
            ) from None
        self._set_readonly()
        self._set_timeout()
        return self

    def __exit__(self, *exc) -> None:
        if self.conn is not None:
            try:
                self.conn.close()
            except Exception:
                pass
        self.conn = None

    def _exec(self, sql: str, params=None):
        cur = self.conn.cursor()
        cur.execute(sql, params) if params else cur.execute(sql)
        return cur

    def _set_readonly(self) -> None:
        stmt = ("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY"
                if self.engine == "postgresql" else "SET SESSION TRANSACTION READ ONLY")
        try:
            self._exec(stmt).close()
        except Exception as err:
            raise GuardError(
                f"没能把会话置为只读（{stmt}）：{_short(err)}。"
                "采集中止 —— 不会退回「只靠脚本白名单」继续跑。"
            ) from None
        self.assert_readonly()

    def _set_timeout(self) -> None:
        ms = max(1, self.source.timeout) * 1000
        stmt = (f"SET statement_timeout = {ms}" if self.engine == "postgresql"
                else f"SET SESSION MAX_EXECUTION_TIME = {ms}")
        try:
            self._exec(stmt).close()
        except Exception as err:
            raise GuardError(f"没能设上语句超时：{_short(err)}。采集中止。") from None

    def assert_readonly(self) -> None:
        """每次执行用户语句前都确认一次 —— 只读会话是连接级的，重连就没了（实测）。"""
        probe = ("SHOW default_transaction_read_only" if self.engine == "postgresql"
                 else "SELECT @@session.transaction_read_only")
        cur = self._exec(probe)
        row = cur.fetchone()
        cur.close()
        value = str(row[0]).strip().lower() if row else ""
        if value not in ("on", "1", "true"):
            raise GuardError(
                "这条连接现在不是只读会话了（可能被驱动重连过）。采集中止 —— "
                "宁可这次不出产物，也不拿一条可写的连接去跑 SQL。"
            )

    def query(self, sql: str, params=None) -> tuple[list[str], list[tuple]]:
        """跑脚本自己的语句（系统表那些）。用户 SQL 一律走 run_user_sql。"""
        cur = self._exec(sql, params)
        cols = [d[0] for d in (cur.description or [])]
        rows = cur.fetchall()
        cur.close()
        return cols, list(rows)

    def run_user_sql(self, sql: str, limit: int) -> tuple[list[str], list[tuple], bool]:
        """跑用户 SQL：先过护栏、再确认只读会话、强制上限。返回 (列名, 行, 是否被截断)。"""
        clean = ensure_readonly_sql(sql)
        self.assert_readonly()
        head = (re.match(r"[A-Za-z]+", clean) or re.match("", "")).group(0).upper()
        # 包一层子查询把上限压到服务端，别把整份结果拉回本地再扔掉。
        # 多取一行用来判断「是不是还有更多」，不跑 count(*)。
        if head in WRAPPABLE_HEADS:
            wrapped = f"SELECT * FROM (\n{clean}\n) AS _pmwork_q LIMIT {limit + 1}"
        else:
            wrapped = clean
        try:
            cur = self._exec(wrapped)
            cols = [d[0] for d in (cur.description or [])]
            rows = list(cur.fetchmany(limit + 1))
            cur.close()
        except Exception as err:
            raise ConfigError(f"查询失败：{_short(err)}") from None
        truncated = len(rows) > limit
        return cols, rows[:limit], truncated


def _short(err: Exception) -> str:
    """把驱动的多行英文错压成一行，别把整段栈糊到界面上。"""
    return str(err).strip().splitlines()[0][:200] if str(err).strip() else type(err).__name__


# --------------------------------------------------------------------------- #
# 4. schema 采集
#
# 统一走 information_schema，行数只取**估算值**（PG 的 pg_class.reltuples /
# MySQL 的 TABLE_ROWS）。绝不对业务表发 count(*) —— 大表全表扫会拖垮生产库，
# 而我们只需要量级：AI 要知道的是「这表是万级还是亿级」，不是精确到个位。
#
# PG 白名单必须写成 ANY(%s::text[])。不带 ::text[] 时，KingbaseES 这类兼容库
# 推不出参数类型，不报错、直接返回 0 行，快照会被写成「0 张表」。
# --------------------------------------------------------------------------- #

PG_TABLES = """
SELECT t.table_schema, t.table_name, t.table_type,
       obj_description(c.oid) AS table_comment,
       COALESCE(c.reltuples, -1) AS row_estimate
  FROM information_schema.tables t
  LEFT JOIN pg_namespace n ON n.nspname = t.table_schema
  LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid
 WHERE t.table_schema = ANY(%s::text[])
 ORDER BY t.table_schema, t.table_name
"""

PG_COLUMNS = """
SELECT c.table_schema, c.table_name, c.column_name, c.data_type,
       c.is_nullable, c.ordinal_position, d.description
  FROM information_schema.columns c
  LEFT JOIN pg_namespace n ON n.nspname = c.table_schema
  LEFT JOIN pg_class k ON k.relname = c.table_name AND k.relnamespace = n.oid
  LEFT JOIN pg_description d ON d.objoid = k.oid AND d.objsubid = c.ordinal_position
 WHERE c.table_schema = ANY(%s::text[])
 ORDER BY c.table_schema, c.table_name, c.ordinal_position
"""

PG_KEYS = """
SELECT tc.table_schema, tc.table_name, tc.constraint_type, kcu.column_name,
       ccu.table_name AS ref_table, ccu.column_name AS ref_column
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
  LEFT JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name AND tc.constraint_type = 'FOREIGN KEY'
 WHERE tc.table_schema = ANY(%s::text[]) AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
 ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position
"""

MY_TABLES = """
SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_COMMENT, COALESCE(TABLE_ROWS, -1)
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA IN ({holes})
 ORDER BY TABLE_SCHEMA, TABLE_NAME
"""

MY_COLUMNS = """
SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE,
       IS_NULLABLE, ORDINAL_POSITION, COLUMN_COMMENT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA IN ({holes})
 ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
"""

MY_KEYS = """
SELECT TABLE_SCHEMA, TABLE_NAME,
       CASE WHEN CONSTRAINT_NAME = 'PRIMARY' THEN 'PRIMARY KEY' ELSE 'FOREIGN KEY' END,
       COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
  FROM information_schema.KEY_COLUMN_USAGE
 WHERE TABLE_SCHEMA IN ({holes})
   AND (CONSTRAINT_NAME = 'PRIMARY' OR REFERENCED_TABLE_NAME IS NOT NULL)
 ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
"""


def magnitude(estimate: float) -> str:
    """行数**量级**的人话。估算值偏差再大也不影响 AI 写 SQL 的决策，所以只说量级。"""
    if estimate is None or estimate < 0:
        return "未知"
    n = int(estimate)
    if n <= 0:
        return "空表或极少"
    for limit, unit, div in ((10_000, "", 1), (100_000_000, "万", 10_000)):
        if n < limit:
            return f"约 {n // div if div > 1 else n}{unit} 行"
    return f"约 {n // 100_000_000} 亿行"


def collect_schema(session: Session, src: Source) -> dict:
    """把整份 schema 读进内存。**全部读完才写盘** —— 中途连不上就一个字节都不写，
    上一份快照原样保留。"""
    if src.engine == "postgresql":
        t_cols, t_rows = session.query(PG_TABLES, (src.schemas,))
        c_cols, c_rows = session.query(PG_COLUMNS, (src.schemas,))
        k_cols, k_rows = session.query(PG_KEYS, (src.schemas,))
    else:
        holes = ", ".join(["%s"] * len(src.schemas))
        t_cols, t_rows = session.query(MY_TABLES.format(holes=holes), tuple(src.schemas))
        c_cols, c_rows = session.query(MY_COLUMNS.format(holes=holes), tuple(src.schemas))
        k_cols, k_rows = session.query(MY_KEYS.format(holes=holes), tuple(src.schemas))

    tables: dict[tuple[str, str], dict] = {}
    for schema, name, ttype, comment, estimate in t_rows:
        tables[(schema, name)] = {
            "schema": schema, "name": name,
            "kind": "视图" if "VIEW" in str(ttype).upper() else "表",
            "comment": (comment or "").strip(),
            "rows": magnitude(float(estimate) if estimate is not None else -1),
            "columns": [], "pk": [], "fk": [],
        }
    for schema, table, column, dtype, nullable, _pos, comment in c_rows:
        entry = tables.get((schema, table))
        if entry is not None:
            entry["columns"].append({
                "name": column, "type": dtype,
                "nullable": str(nullable).upper() == "YES",
                "comment": (comment or "").strip(),
            })
    for schema, table, ctype, column, ref_table, ref_column in k_rows:
        entry = tables.get((schema, table))
        if entry is None:
            continue
        if ctype == "PRIMARY KEY":
            if column not in entry["pk"]:
                entry["pk"].append(column)
        elif ref_table:
            item = f"{column} → {ref_table}.{ref_column}"
            if item not in entry["fk"]:
                entry["fk"].append(item)

    ordered = [tables[k] for k in sorted(tables)]
    if src.samples > 0:
        _attach_samples(session, src, ordered)
    return {"tables": ordered, "sampled": src.samples}


def _attach_samples(session: Session, src: Source, tables: list[dict]) -> None:
    """抽样例行。默认关掉（samples: 0），配了才走这里 —— 这是把真实业务数据写到磁盘上。"""
    quote = '"' if src.engine == "postgresql" else "`"
    for entry in tables:
        ident = f"{quote}{entry['schema']}{quote}.{quote}{entry['name']}{quote}"
        try:
            cols, rows = session.query(f"SELECT * FROM {ident} LIMIT {src.samples}")
            entry["sample_cols"] = cols
            entry["sample_rows"] = [[_cell(v) for v in row] for row in rows]
        except Exception as err:
            # 单表抽不到（没权限、是外部表）不该让整次采集失败
            entry["sample_error"] = _short(err)


def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (bytes, bytearray)):
        return f"<{len(value)} 字节二进制>"
    return str(value)


# --------------------------------------------------------------------------- #
# 5. 产物落盘
#
# 先写临时文件再原子替换：采集失败时上一份快照原样保留，不会出现「刷新了一下，
# 好好的快照没了」。
# --------------------------------------------------------------------------- #

def atomic_write(target: Path, text: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, target)


def frontmatter(meta: dict) -> str:
    lines = ["---"]
    for key, value in meta.items():
        if isinstance(value, list):
            lines.append(f"{key}:")
            lines.extend(f"  - {item}" for item in value)
        else:
            lines.append(f"{key}: {value}")
    lines += ["---", ""]
    return "\n".join(lines)


def _md_cell(text: str) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ")


def table_detail_lines(entry: dict) -> list[str]:
    """一张表的完整明细：列、主外键、（配了才有的）样例行。"""
    out = [f"### {entry['schema']}.{entry['name']}"]
    head = [entry["kind"], entry["rows"]]
    if entry["comment"]:
        head.append(entry["comment"])
    out += ["", " · ".join(head), ""]
    out += ["| 列 | 类型 | 可空 | 注释 |", "| --- | --- | --- | --- |"]
    for col in entry["columns"]:
        out.append(
            f"| {_md_cell(col['name'])} | {_md_cell(col['type'])} | "
            f"{'是' if col['nullable'] else '否'} | {_md_cell(col['comment'])} |"
        )
    if entry["pk"]:
        out += ["", f"主键：{', '.join(entry['pk'])}"]
    if entry["fk"]:
        out += ["", "外键：" + "；".join(entry["fk"])]
    if entry.get("sample_error"):
        out += ["", f"样例行没取到：{entry['sample_error']}"]
    elif entry.get("sample_rows"):
        out += ["", f"样例行（{len(entry['sample_rows'])} 行，来自真实数据）：", ""]
        cols = entry.get("sample_cols") or []
        out += ["| " + " | ".join(_md_cell(c) for c in cols) + " |",
                "| " + " | ".join("---" for _ in cols) + " |"]
        for row in entry["sample_rows"]:
            out.append("| " + " | ".join(_md_cell(v) for v in row) + " |")
    out.append("")
    return out


def _table_prefix(name: str) -> str | None:
    """表名前缀。`t_sys_user` → `t_sys`（两段），`user_info` → `user`（一段）。

    企业库常见 `t_<模块>_<实体>`，只切第一段会把几乎所有表收进一个 `t_*` 里。
    没有下划线或以下划线开头则分不出组。
    """
    parts = name.split("_")
    if len(parts) >= 3 and parts[0] and parts[1]:
        return f"{parts[0]}_{parts[1]}"
    if len(parts) >= 2 and parts[0]:
        return parts[0]
    return None


def group_tables_by_prefix(tables: list[dict]) -> list[tuple[str, list[dict]]] | None:
    """按表名前缀（`<前缀>_…`）分组。分不出有意义的组时返回 None，调用方改走首字母清单。

    「有意义」= 至少一半的表落进「≥2 张表」的前缀组。单表组一律丢掉，
    不许造出一堆只含一张表的「组」。
    """
    buckets: dict[str, list[dict]] = {}
    for entry in tables:
        prefix = _table_prefix(entry["name"])
        if not prefix:
            continue
        buckets.setdefault(prefix, []).append(entry)
    real = {p: g for p, g in buckets.items() if len(g) >= 2}
    grouped_n = sum(len(g) for g in real.values())
    if not real or grouped_n < len(tables) * 0.5:
        return None
    grouped_ids = {id(e) for g in real.values() for e in g}
    rest = [e for e in tables if id(e) not in grouped_ids]
    sections = sorted(real.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    if rest:
        sections.append(("其他", rest))
    return sections


def group_tables_by_letter(tables: list[dict]) -> list[tuple[str, list[dict]]]:
    """按表名首字符分段的单一清单。ASCII 字母数字一组，其余归到「#」。"""
    buckets: dict[str, list[dict]] = {}
    for entry in tables:
        ch = (entry["name"][:1] or "#").upper()
        key = ch if ("A" <= ch <= "Z" or "0" <= ch <= "9") else "#"
        buckets.setdefault(key, []).append(entry)
    return sorted(buckets.items(), key=lambda kv: (kv[0] == "#", kv[0]))


def _compact_table_line(entry: dict) -> str:
    file_name = f"{safe_component(entry['schema'] + '.' + entry['name'])}.md"
    comment = (entry.get("comment") or "").strip().replace("\n", " ")
    bits = [f"`{entry['schema']}.{entry['name']}`", f"{len(entry['columns'])} 列"]
    if comment:
        bits.append(comment)
    bits.append(f"[明细]({SPLIT_DIR}/{file_name})")
    return "- " + " · ".join(bits)


def write_schema_snapshot(src: Source, data: dict) -> Path:
    """写 L1 快照。表多到一份装不下时退化成表清单，单表明细拆进 SplittingObject/。"""
    tables = data["tables"]
    out_dir = src.out_dir
    manifest = out_dir / f"_manifest_{safe_component(src.key)}.md"
    split = len(tables) > SPLIT_TABLE_THRESHOLD

    meta = {
        "source": src.dsn_label,
        "source_kind": "database",
        "source_name": src.display,
        "engine": src.engine,
        "schemas": ", ".join(src.schemas),
        "tables": len(tables),
        "samples": src.samples,
        "converted_by": "db_ingest.py (schema)",
        "converted_at": now_iso(),
    }
    if split:
        meta["payload"] = SPLIT_DIR

    body = [f"# {src.display} · 数据库结构快照", ""]
    body += [
        f"`{src.dsn_label}` 的 schema 摘要，采于 {meta['converted_at']}。",
        "行数是 **估算量级**（没跑 `count(*)`，那会拖垮生产库），够判断该怎么写 SQL 就行。",
        "",
        f"共 {len(tables)} 张表 / 视图，schema：{', '.join(src.schemas)}。",
        "",
    ]
    if src.samples == 0:
        body += ["样例行没抽（`samples: 0`）——那是真实业务数据落盘，得在 yaml 里显式打开。", ""]

    if split:
        body += [
            f"表太多（超过 {SPLIT_TABLE_THRESHOLD} 张），这里只留按前缀分组的清单，"
            f"单表的列明细在 `{SPLIT_DIR}/<表名>.md`，按需读一张。",
            "",
        ]
        sections = group_tables_by_prefix(tables)
        prefix_mode = sections is not None
        if sections is None:
            body += ["表名分不出稳定前缀，改按首字母分段。", ""]
            sections = group_tables_by_letter(tables)
        for title, group in sections:
            heading = f"{title}_*" if prefix_mode and title != "其他" else title
            body += [f"## {heading}（{len(group)} 张）", ""]
            for entry in group:
                body.append(_compact_table_line(entry))
            body.append("")
    else:
        body += ["## 表", ""]
        for entry in tables:
            body += table_detail_lines(entry)

    # 全部内容先在内存里拼好，到这一步才动磁盘
    atomic_write(manifest, frontmatter(meta) + "\n".join(body).rstrip() + "\n")

    split_dir = out_dir / SPLIT_DIR
    if split:
        split_dir.mkdir(parents=True, exist_ok=True)
        keep = set()
        for entry in tables:
            file_name = f"{safe_component(entry['schema'] + '.' + entry['name'])}.md"
            keep.add(file_name)
            head = frontmatter({
                "source": src.dsn_label,
                "source_kind": "database",
                "source_name": src.display,
                "table": f"{entry['schema']}.{entry['name']}",
                "converted_by": "db_ingest.py (schema)",
                "converted_at": meta["converted_at"],
            })
            atomic_write(split_dir / file_name, head + "\n".join(table_detail_lines(entry)))
        # 上一轮采过、这一轮已经不在库里的表：删掉它的明细，免得留下过期结构
        for stale in split_dir.glob("*.md"):
            if stale.name not in keep:
                stale.unlink()
    elif split_dir.is_dir():
        for stale in split_dir.glob("*.md"):
            stale.unlink()
    return manifest


def write_query_result(src: Source, name: str, sql: str, cols: list[str],
                       rows: list, truncated: bool, seconds: float) -> tuple[Path, Path]:
    """写 L2 查询产物：csv + 同名 manifest（SQL 原文 / 行数 / sha256 都在里面）。"""
    safe = safe_component(name)
    out_dir = src.out_dir
    csv_path = out_dir / f"{safe}.csv"

    buf = io.StringIO(newline="")
    writer = csv.writer(buf)
    writer.writerow(cols)
    for row in rows:
        writer.writerow([_cell(v) for v in row])
    payload = buf.getvalue()
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()

    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = csv_path.with_name(f".{csv_path.name}.tmp")
    tmp.write_text(payload, encoding="utf-8", newline="")
    os.replace(tmp, csv_path)

    meta = {
        "source": src.dsn_label,
        "source_kind": "database",
        "source_name": src.display,
        "engine": src.engine,
        "query_name": name,
        "result": csv_path.name,
        "rows": len(rows),
        "columns": len(cols),
        "truncated": "true" if truncated else "false",
        "row_limit": src.max_rows,
        "elapsed_seconds": f"{seconds:.3f}",
        "result_sha256": digest,
        "converted_by": "db_ingest.py (query)",
        "converted_at": now_iso(),
    }
    body = [
        f"# {name}", "",
        f"对 `{src.display}` 跑的一条只读查询，结果在 [`{csv_path.name}`]({csv_path.name})。", "",
        f"- 返回 {len(rows)} 行 × {len(cols)} 列，用时 {seconds:.3f} 秒",
        f"- 结果文件 sha256：`{digest}`",
    ]
    if truncated:
        body += [
            f"- **已截断**：命中的行数多于上限 {src.max_rows} 行，csv 里只有前 {len(rows)} 行。"
            "总行数没有精确统计（对生产库跑 `count(*)` 代价太大）——"
            "要全量请把这个源的 `max_rows` 调大，或在 SQL 里自己聚合。",
        ]
    body += ["", "## SQL 原文", "", "```sql", sql.strip(), "```", ""]
    atomic_write(out_dir / f"_manifest_{safe}.md", frontmatter(meta) + "\n".join(body))
    return csv_path, out_dir / f"_manifest_{safe}.md"


# --------------------------------------------------------------------------- #
# 6. CLI 备选路（client: cli）
#
# 给「装不了 pip 包，但 psql 早就装好了」的环境兜底。**只保证 schema 采集可用** ——
# CLI 的 csv 输出里 NULL 和空串分不开，查询产物仍推荐走驱动。
# 这条路同样先置只读会话：PGOPTIONS 把 default_transaction_read_only 打开，
# 再读回来确认一次，确认不上就中止。
# --------------------------------------------------------------------------- #

def psql_rows(src: Source, sql: str, params: list[str]) -> list[list[str]]:
    user, password = src.credentials()
    env = {**os.environ, "PGPASSWORD": password,
           "PGOPTIONS": "-c default_transaction_read_only=on "
                        f"-c statement_timeout={max(1, src.timeout) * 1000}"}
    # psql 不接命名参数，这里只用来替换 schema 白名单这种脚本自己拼的值
    for i, value in enumerate(params, 1):
        sql = sql.replace(f"${i}", "'" + value.replace("'", "''") + "'")
    cmd = ["psql", "--csv", "--no-psqlrc", "--tuples-only", "-h", src.host,
           "-p", str(src.port), "-U", user, "-d", src.database, "-c", sql]
    try:
        proc = subprocess.run(cmd, env=env, capture_output=True, text=True,
                              timeout=max(10, src.timeout * 3))
    except FileNotFoundError:
        raise ConfigError(
            "这个源配了 `client: cli`，但机器上找不到 psql。装一个 PostgreSQL 客户端，"
            "或者把 `client` 改回 driver 并 `pip install \"psycopg[binary]\"`。"
        ) from None
    except subprocess.TimeoutExpired:
        raise ConfigError(f"psql 超时（{src.timeout * 3} 秒没返回）。") from None
    if proc.returncode != 0:
        # psql 的报错是「第一行说清楚、后面几行给建议」，要的是第一行 ——
        # 取最后一行会拿到「Is the server running…」这种没头没尾的续行
        lines = [ln.strip() for ln in (proc.stderr or "").splitlines() if ln.strip()]
        raise ConfigError(f"psql 失败：{lines[0][:200] if lines else '没有输出'}")
    return [row for row in csv.reader(io.StringIO(proc.stdout)) if row]


def cli_collect_schema(src: Source) -> dict:
    """走 psql 的 schema 采集。第一件事是确认只读会话真的生效了。"""
    probe = psql_rows(src, "SHOW default_transaction_read_only", [])
    if not probe or probe[0][0].strip().lower() != "on":
        raise GuardError(
            "psql 这条路没能把会话置为只读（PGOPTIONS 没生效）。采集中止 —— "
            "不降级成「只靠脚本白名单」。"
        )
    schemas = "{" + ",".join(f'"{s}"' for s in src.schemas) + "}"
    t_rows = psql_rows(src, PG_TABLES.replace("%s", "$1"), [schemas])
    c_rows = psql_rows(src, PG_COLUMNS.replace("%s", "$1"), [schemas])
    k_rows = psql_rows(src, PG_KEYS.replace("%s", "$1"), [schemas])

    tables: dict[tuple[str, str], dict] = {}
    for row in t_rows:
        if len(row) < 5:
            continue
        schema, name, ttype, comment, estimate = row[:5]
        tables[(schema, name)] = {
            "schema": schema, "name": name,
            "kind": "视图" if "VIEW" in ttype.upper() else "表",
            "comment": comment.strip(),
            "rows": magnitude(float(estimate) if estimate else -1),
            "columns": [], "pk": [], "fk": [],
        }
    for row in c_rows:
        if len(row) < 7:
            continue
        entry = tables.get((row[0], row[1]))
        if entry is not None:
            entry["columns"].append({"name": row[2], "type": row[3],
                                     "nullable": row[4].upper() == "YES", "comment": row[6].strip()})
    for row in k_rows:
        if len(row) < 6:
            continue
        entry = tables.get((row[0], row[1]))
        if entry is None:
            continue
        if row[2] == "PRIMARY KEY":
            if row[3] not in entry["pk"]:
                entry["pk"].append(row[3])
        elif row[4]:
            item = f"{row[3]} → {row[4]}.{row[5]}"
            if item not in entry["fk"]:
                entry["fk"].append(item)
    return {"tables": [tables[k] for k in sorted(tables)], "sampled": 0}


# --------------------------------------------------------------------------- #
# 7. 子命令
# --------------------------------------------------------------------------- #

def cmd_list(_args) -> int:
    entries = list_sources()
    if not entries:
        log("还没有配数据源。在 input/sources/ 下放一份 <名字>.yaml，写法见那个目录的 README.md。")
        return 0
    for key, src, error in entries:
        if src is None:
            log(f"✗ {key} —— {error}")
            continue
        manifest = src.out_dir / f"_manifest_{safe_component(key)}.md"
        state = f"快照 {repo_rel(manifest)}" if manifest.is_file() else "还没采过 schema"
        log(f"· {key}（{src.display}） {src.engine} {src.database} —— {state}")
    return 0


def cmd_schema(args) -> int:
    src = load_source(args.source)
    log(f"正在采 {src.display} 的 schema（{src.dsn_label}）…")
    if src.client == "cli":
        log("走 psql 命令行客户端（这个源配了 client: cli）。")
        if src.samples > 0:
            log(f"注意：`samples: {src.samples}` 在 cli 这条路上不生效，这次不抽样例行。")
        data = cli_collect_schema(src)
    else:
        with Session(src) as session:
            log("会话已置为只读，开始读 information_schema…")
            data = collect_schema(session, src)
    if not data["tables"]:
        raise ConfigError(
            "一张表都没读到，请检查 schema 白名单"
            + (f"：{', '.join(src.schemas)}" if src.schemas else "。")
            + "上一份快照原样保留，没有写成空快照。"
        )
    manifest = write_schema_snapshot(src, data)
    log(f"schema 快照已更新：{repo_rel(manifest)}（{len(data['tables'])} 张表 / 视图）")
    return 0


def cmd_query(args) -> int:
    src = load_source(args.source)
    sql = args.sql
    if args.sql_file:
        sql_path = Path(args.sql_file)
        if not sql_path.is_file():
            raise ConfigError(f"找不到 SQL 文件：{args.sql_file}")
        sql = sql_path.read_text(encoding="utf-8")
    if not sql or not sql.strip():
        raise ConfigError("要跑什么查询？用 --sql 或 --sql-file 给一条只读 SQL。")
    if src.client == "cli":
        raise ConfigError(
            f"{src.key} 配的是 `client: cli`，这条路只保证 schema 采集。"
            "查询产物请把 client 改回 driver 并装驱动。"
        )
    with Session(src) as session:
        log(f"会话已置为只读，开始跑「{args.name}」（上限 {src.max_rows} 行，超时 {src.timeout} 秒）…")
        started = dt.datetime.now()
        cols, rows, truncated = session.run_user_sql(sql, src.max_rows)
        seconds = (dt.datetime.now() - started).total_seconds()
    csv_path, manifest = write_query_result(src, args.name, sql, cols, rows, truncated, seconds)
    log(f"结果已落盘：{repo_rel(csv_path)}（{len(rows)} 行 × {len(cols)} 列，用时 {seconds:.3f} 秒）")
    if truncated:
        log(f"⚠ 已截断：命中行数多于上限 {src.max_rows}，manifest 里写明了。")
    log(f"摘要：{repo_rel(manifest)}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="把数据库当按需查询的远端资料源接进来")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="列出 input/sources/ 下配好的源").set_defaults(func=cmd_list)

    p_schema = sub.add_parser("schema", help="采一次 schema 快照（L1）")
    p_schema.add_argument("source", help="源名，即 input/sources/<源名>.yaml 的文件名")
    p_schema.set_defaults(func=cmd_schema)

    p_query = sub.add_parser("query", help="跑一条只读查询并落盘（L2）")
    p_query.add_argument("source", help="源名")
    p_query.add_argument("--name", required=True, help="查询名，决定产物文件名")
    p_query.add_argument("--sql", default="", help="只读 SQL")
    p_query.add_argument("--sql-file", default="", help="从文件读 SQL")
    p_query.set_defaults(func=cmd_query)

    args = ap.parse_args()
    try:
        return args.func(args)
    except (ConfigError, GuardError) as err:
        log(f"✗ {err}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
