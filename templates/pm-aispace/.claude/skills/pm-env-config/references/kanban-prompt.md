# 看板「添加环境参数」→ 复制 prompt 契约

这份是看板「添加环境参数」按钮复制出来的 prompt 契约。技能本体在 `SKILL.md`。
看板只负责收集字段、拼出下面这份 prompt；真正写 `.env` / yaml 的是 Agent。

看板**不要存口令、不要读工作空间 `.env`**。用户点「复制」时，口令只进剪贴板。

## 复制出来的 prompt（固定头 + 字段）

第一行必须能触发本技能，后面是平铺的 `key: value`（和 `input/sources/*.yaml` 同一套迷你 yaml）。

```
请按 pm-env-config 技能配置下面的环境参数。凭据只写入 .env，不要写进 yaml 或任何会入库的文件。

kind: <database | api_key | env_var>
…

输出要求：配完后用几句简单易懂的话说明结果——配了哪个源或哪个变量、文件落在哪、数据库连上了没有、还缺什么。不要贴配置原文，不要回显口令或 token。
```

三种 `kind` 的字段如下。必填标 `*`。用户没填的行不要输出。

### kind: database

看板表单只收两样：**显示名** + **一段连接信息原文**（JDBC / Spring / 主机端口账号口令，原样粘贴）。
看板不拆字段、不猜引擎端口 —— 拆解按本技能「解析用户输入」做。

Agent 从原文里认下面这些字段（必填标 `*`）：

| 字段 | 说明 |
| --- | --- |
| `name` | 显示名。用户没填则用库名。会变成 `input/sources/<name>.yaml` 的文件名 |
| `engine` * | `mysql` 或 `postgresql`。可从 JDBC URL 推断 |
| `host` * | 与 `jdbc.url` 二选一（有 URL 就拆 URL） |
| `port` | 缺省：mysql 3306 / postgresql 5432 |
| `database` * | 库名 |
| `username` * | 原样保存。`root@mysql` 是账号本身，不要拆成 user/host |
| `password` * | 口令 |
| `jdbc.url` | 有则拆出 host/port/database/engine，query string 丢掉 |
| `schemas` | 可选。逗号分隔。不填 = 引擎默认 |

复制示例（用户只填了显示名并粘了一段 JDBC）：

```
请按 pm-env-config 技能配置下面的环境参数。凭据只写入 .env，不要写进 yaml 或任何会入库的文件。

kind: database
name: 本系统测试库

jdbc.url=jdbc:mysql://192.168.8.36:31381/ai_smart
jdbc.username=root@mysql
jdbc.password=<口令>

输出要求：配完后用几句简单易懂的话说明结果——配了哪个源或哪个变量、文件落在哪、数据库连上了没有、还缺什么。不要贴配置原文，不要回显口令或 token。
```

### kind: api_key

表单建议：变量名下拉（来自工作空间 `.env.example` 里出现过的 key）+ 值。

| 字段 | 表单标签 |
| --- | --- |
| `key` * | 变量名（如 `MINERU_API_KEY`） |
| `value` * | 值 |

```
请按 pm-env-config 技能配置下面的环境参数。凭据只写入 .env，不要写进 yaml 或任何会入库的文件。

kind: api_key
key: MINERU_API_KEY
value: <token>

输出要求：配完后用几句简单易懂的话说明结果——配了哪个源或哪个变量、文件落在哪、数据库连上了没有、还缺什么。不要贴配置原文，不要回显口令或 token。
```

### kind: env_var

其它本地路径、开关。同样只进 `.env`。

| 字段 | 表单标签 |
| --- | --- |
| `key` * | 变量名（如 `ANYDOC_BIN`） |
| `value` * | 值 |

## 交互建议

- 「添加 API Key」和「添加数据库源」各弹一层，不在同一层里切 tab。
- 主按钮是 **复制 prompt**，不是「保存到看板」。复制成功用 sonner 成功提示「已复制，粘给当前 Agent」，不要写在输入框下面。
- 复制出来的文本末尾 MUST 带「输出要求」那一段，让 Agent 用简单的话汇报结果。
- API Key 的 token 用 password 输入框；数据库连接信息是原文粘贴，不拆成口令框。
- 复制后不必清空（用户可能要发给另一个 Agent），但刷新页面应丢掉。
