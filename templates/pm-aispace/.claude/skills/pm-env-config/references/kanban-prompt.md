# 看板「添加环境参数」→ 复制 prompt 契约

这份是给**以后看板「添加」按钮**用的。技能本体在 `SKILL.md`。
看板只负责收集字段、拼出下面这份 prompt；真正写 `.env` / yaml 的是 Agent。

看板**不要存口令、不要读工作空间 `.env`**。用户点「复制」时，口令只进剪贴板。

## 复制出来的 prompt（固定头 + 字段）

第一行必须能触发本技能，后面是平铺的 `key: value`（和 `input/sources/*.yaml` 同一套迷你 yaml）。

```
请按 pm-env-config 技能配置下面的环境参数。凭据只写入 .env，不要写进 yaml 或任何会入库的文件。

kind: <database | api_key | env_var>
…
```

三种 `kind` 的字段如下。必填标 `*`。用户没填的行不要输出。

### kind: database

表单建议：显示名、引擎、主机、端口、库名、账号、口令；高级可收起 schema / JDBC URL。

| 字段 | 表单标签 | 说明 |
| --- | --- | --- |
| `name` | 显示名 | 不填则用库名。会变成 `input/sources/<name>.yaml` 的文件名 |
| `engine` * | 引擎 | `mysql` 或 `postgresql`。选了 JDBC URL 时可从 URL 推断，表单仍建议让用户选 |
| `host` * | 主机 | 与 `jdbc.url` 二选一（有 URL 就拆 URL） |
| `port` | 端口 | 缺省：mysql 3306 / postgresql 5432 |
| `database` * | 库名 | |
| `username` * | 账号 | 原样保存。`root@mysql` 是账号本身，不要拆成 user/host |
| `password` * | 口令 | |
| `jdbc.url` | JDBC URL | 可选。有则拆出 host/port/database/engine，query string 丢掉 |
| `schemas` | Schema 白名单 | 可选。逗号分隔。不填 = 引擎默认 |

复制示例：

```
请按 pm-env-config 技能配置下面的环境参数。凭据只写入 .env，不要写进 yaml 或任何会入库的文件。

kind: database
name: 本系统测试库
engine: mysql
host: 192.168.8.36
port: 31381
database: ai_smart
username: root@mysql
password: <口令>
```

用户手里只有 Spring/JDBC 片段时，表单也可以提供「粘贴原始连接信息」多行框，原样跟在固定头后面，不必先拆字段。

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
```

### kind: env_var

其它本地路径、开关。同样只进 `.env`。

| 字段 | 表单标签 |
| --- | --- |
| `key` * | 变量名（如 `ANYDOC_BIN`） |
| `value` * | 值 |

## 交互建议

- 「添加」弹出一层：先选类型，再出对应字段。
- 主按钮是 **复制 prompt**，不是「保存到看板」。复制成功后提示「粘贴给当前 Agent」。
- 口令 / token 用 password 输入框；复制后不必清空（用户可能要发给另一个 Agent），但刷新页面应丢掉。
