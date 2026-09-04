---
name: pm-env-config
description: 把用户提供的环境参数写进工作空间：数据库连接落成 input/sources/*.yaml（只含连接形状）+ .env 里的账号口令，API Key 和其它变量写入 .env；yaml 不含口令，.env 必须在 .gitignore。当用户说「配一下数据库」「配置数据源」「这是测试环境的 jdbc」「帮我配 .env」「写入 API Key」「配 MINERU_API_KEY」「添加数据库源」「这是连接信息」「配 MinerU token」，或消息以「请按 pm-env-config」开头、贴了 jdbc.url / jdbc.username / host:port / 账号口令时，使用这个技能。用户从看板「添加」按钮复制 prompt 发过来时也走这里。
---

# 环境参数配置

用户给的是连接串、账号口令、API Key；你的产出是**能用的本地配置**，不是一份把秘密写进去的文档。

数据库 yaml 的字段、只读会话、样例行默认不抽，以 [`input/sources/README.md`](input/sources/README.md) 为准，这里不重复。本技能只负责：**把用户丢过来的参数安全地落到文件上，并验证能连上。**

看板「添加 API Key / 添加数据库源」会把字段拼成下面这种消息，用户粘过来时走本技能。数据库那一侧往往是显示名 + 一段连接信息原文，按下面「解析用户输入」拆。字段契约见 [`references/kanban-prompt.md`](references/kanban-prompt.md)。

## 先分清三种东西

| kind | 用户典型原话 | 落到哪 |
| --- | --- | --- |
| `database` | jdbc、主机端口、库名、账号口令 | `input/sources/<名>.yaml` + `.env` 里的 `*_DB_USER` / `*_DB_PASSWORD` |
| `api_key` | MinerU token、OCR key | `.env` 里已有的变量名（先看 `.env.example`） |
| `env_var` | ANYDOC_BIN、其它 KEY=VALUE | `.env` 新增或覆盖一行 |

引擎目前只支持 `mysql` / `postgresql`。Oracle、SQL Server、Mongo 直接告诉用户「这个工作空间还接不了」，不要写一份连不上的 yaml。

## 凭据纪律

口令、token、完整连接串进了 git 或 yaml，就等于进了会发给别人的工作空间。所以：

- 凭据只写 `.env`。yaml 里只写 `user_env` / `password_env`（**变量名**，不是账号本身）。
- 写 `.env` 之前确认 `.gitignore` 有单独一行 `.env`。没有就补上。
- **不要**把 `.env` 正文读进上下文、写进 `output/`、INDEX、commit message、或回复用户。要看已有变量，跑：

```bash
python3 skills/pm-env-config/scripts/upsert_env.py --env .env --print-keys
python3 skills/pm-env-config/scripts/upsert_env.py --gitignore .gitignore
```

- 回复里可以提主机、端口、库名、源名、表数量级；**不要回显口令或 token**（包括前几位）。
- 写入用脚本、值走 stdin JSON，不要 `echo KEY=口令 >> .env`：

```bash
python3 skills/pm-env-config/scripts/upsert_env.py --env .env --comment "本系统测试库" <<'JSON'
{"AI_SMART_DB_USER": "readonly_user", "AI_SMART_DB_PASSWORD": "…"}
JSON
```

已有同名 key 会被覆盖（用户这轮给的就是新值），其它行原样保留。没有 `.env` 时脚本会建一份，不要先 `cp .env.example .env` 再覆盖——以免把空模板和真实值搅在一起；若用户还没有 `.env`、只是加一把已知的 API Key，可以从 `.env.example` 复制一份再 upsert。

## 解析用户输入

结构化块（看板复制出来的）按迷你 yaml 读：`kind:`、`name:`、`engine:`、`host:`、`port:`、`database:`、`username:`、`password:`、`key:`、`value:`、`jdbc.url:`。

用户经常直接贴 Spring / JDBC 片段，按下面拆，缺字段再问：

- `jdbc:mysql://host:port/db?…` → engine=mysql，丢掉 `?` 后面
- `jdbc:postgresql://host:port/db` → engine=postgresql
- `jdbc.username` / `username` / `user`：原样当账号。`root@mysql` **是账号本身**，不要拆成 user=`root` host=`mysql`
- `jdbc.password` / `password` / `pwd`
- 没有 URL、只有 host/port/database 也行
- `kind` 没写时：出现 jdbc / host+database+password → `database`；出现 `MINERU_API_KEY` 或「MinerU / OCR token」→ `api_key`；明确的 `KEY=VALUE` → `env_var`

库名、主机、账号、口令缺任何一个，停下来问，不要用 `localhost` / `root` / 空口令去猜。

## 配数据库

1. **源文件名** = `name`（显示名）。没有就用 `database`。用中文可以。不要用路径分隔符。落点：`input/sources/<name>.yaml`。
2. **环境变量名**：库名能当标识符就用 `<DB>_DB_USER` / `<DB>_DB_PASSWORD`（`ai_smart` → `AI_SMART_DB_USER`）。库名不行就用 `DB_<主机里的字母数字>_<端口>_USER`。用户指定了 `user_env` 则用用户的。
3. 对照已有 `input/sources/*.yaml`：同名且 host/port/database 相同 → 只更新 `.env` 口令、yaml 缺的字段补上；同名但连的是另一台机器 → 先告诉用户，等确认再覆盖。
4. yaml **只含连接形状**，照 `input/sources/example.yaml.txt` 写。`samples: 0`，`client: driver`，`timeout: 15`，`max_rows: 5000`。不要把 jdbc URL 整段写进去。
5. upsert 账号口令进 `.env`。
6. 驱动：mysql 要 `pymysql`，postgresql 要 `psycopg[binary]`。缺了先 `pip install`；遇到 externally-managed-environment 再 `--user --break-system-packages`。工作空间已有 `.venv` 就装进那个。不要为这一步新建虚拟环境。
7. 验证：

```bash
python3 scripts/db_ingest.py list
python3 scripts/db_ingest.py schema <源名>
```

`list` 能认出源、`schema` 采到表，才算配完。连不上就根据脚本的中文报错改（主机不通、库名、口令），**上一份 schema 快照会被脚本保留**，不要手工删。

样例行保持 0。用户明确说「抽几行样例」才改 `samples`。

## 配 API Key / 其它变量

1. 读 `.env.example`，对上已知变量名（`MINERU_API_KEY`、`MINERU_LANGUAGE`、`ANYDOC_BIN`）。用户说「MinerU / OCR / 扫描件 token」但没给变量名，就写入 `MINERU_API_KEY`。
2. 未知的 `KEY=VALUE`：用户写了完整变量名就照写，在 `.env` 里加一行注释「用户提供的环境变量」；不要自作主张写进 `.env.example`（那是模板）。
3. upsert 后用 `--print-keys` 确认 key 在，不要读值。API Key 没有等价于 `db_ingest.py schema` 的连通检查——配完告诉用户「下次转扫描件 / 抽图会用到」，不要拿这个 key 去打第三方接口做探活（会把 token 带出工作空间）。

## 向用户汇报

看板复制出来的 prompt 末尾有「输出要求」，按这一节说。PM 要听到的是「配好了、能用了」，用几句简单易懂的话：

1. 配了哪个源 / 哪几个变量（只报名字）
2. 文件落在哪：yaml 路径、`.env` 里的变量名（不是值）
3. 数据库：连上没有、多少张表、结构快照路径。挑几张和当前需求相关的表用一句话点明，不要把 28 张表结构贴进对话
4. 还缺什么：只读账号（现在是 root 也能跑，因为会话是只读的，但能建还是建议建）、驱动没装上、连不上时的具体原因

不要把「我写了 yaml 但还没连」说成配完。
