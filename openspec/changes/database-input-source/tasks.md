## 1. 模板平面 · 采集脚本(先独立跑通,不依赖看板)

- [x] 1.1 定 `input/sources/<name>.yaml` 的字段:显示名、引擎(仅 `postgresql` / `mysql`)、主机/端口/库名、schema 白名单、凭据的环境变量名、`samples`(默认 0)、行数上限、语句超时、可选 `client: cli`
- [x] 1.2 写 `templates/pm-aispace/input/sources/README.md`:怎么配;凭据放 `.env` 且**必须**写进 `.gitignore`;明说样例行默认不抽;明说"即使配 root 脚本也只在只读会话里跑,但能建只读账号还是建一个"
- [x] 1.3 新建 `templates/pm-aispace/scripts/db_ingest.py` 骨架:复用 `envfile.py` 读 `.env`;驱动按需 import(`psycopg` / `pymysql`),失败时报中文提示点名该装哪个包
- [x] 1.4 **实测三件事再写护栏**:① PostgreSQL 只读会话能否挡住可写 CTE;② MySQL 只读事务能否挡住 DDL(隐式提交是否绕过);③ 两个驱动默认是否禁多语句。结论写进 design 的 Open Questions 1/2
- [x] 1.5 实现只读会话:连上后、跑任何用户语句前先发 `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`(PG)/ `SET SESSION TRANSACTION READ ONLY`(MySQL);**设置失败即中止**,不降级成"只靠白名单"
- [x] 1.6 实现脚本侧第二道:拒绝非查询语句(增删改 / DDL / TRUNCATE)、裸分号检查禁多语句;报错是中文人话,不是抛数据库原文
- [x] 1.7 按 1.4 的实测结论确认:连接若被驱动重建,只读会话还在不在;不在就每次执行前显式确认一次
- [x] 1.8 实现 `schema` 子命令:走 `information_schema`,行数取估算值(PG `pg_class.reltuples` / MySQL `TABLE_ROWS`),**不发 `count(*)`**;设语句超时、跑完断连
- [x] 1.9 产出 `input/converted/_sources/<源名>/_manifest_<源名>.md`:表清单、列名/类型/注释、主外键、行数量级;frontmatter 记采集时间与源名。**先写临时文件再原子替换**,连不上时上一份快照原样保留
- [x] 1.10 表数超阈值时退化:manifest 只留表清单 + 一句话用途,单表列明细拆进 `_sources/<源名>/SplittingObject/<表>.md`
- [x] 1.11 实现 `query` 子命令:强制 LIMIT + 超时;结果落 `_sources/<源名>/<查询名>.csv`,配 `_manifest_<查询名>.md` 记 SQL 原文、执行时间、行数、sha256;超上限时截断并在 manifest 写明
- [x] 1.12 实现可选的 `client: cli` 路(`psql --csv`)兜底,只保证 schema 采集可用;这条路同样要先置只读会话
- [x] 1.13 对一个**自建的合成小库**(绝不用真实业务库)跑通:schema 采集、正常查询、以及五种被拒场景(UPDATE、可写 CTE、多语句、DDL、只读会话设不上)
- [x] 1.14 在 `templates/pm-aispace/AGENTS.md` 里写清"零依赖"原则的这次让步:驱动是**按需可选**,没配数据源的人零成本

## 2. 服务端平面 · 发现与触发(`src/server/**`)

- [x] 2.1 `scan.mjs` 扫 `input/sources/*.yaml`,产出源清单(显示名、引擎、库名、schema 快照的采集时间与产物路径);目录不存在或为空时**不给这个字段**
- [x] 2.2 `scan.mjs` 按路径前缀把 `input/converted/_sources/` 下的产物**排除出 converted 列表**,改挂到对应的源上;确认「已转换」的计数也不含它们
- [x] 2.3 单份 yaml 解析失败降级成「配置读不出来」的条目,不支持的引擎降级成「暂不支持这个引擎」;都不影响其它源、不让整次扫描失败(照 `config.mjs` 的 `readProjects` 风格)
- [x] 2.4 `http.mjs` 加 `sourceJobs` map 与触发采集的路由,代码形状照抄 `startIngest`:立即返回 + 轮询进度、stdout 累积、`child.on('error')` 兜底,不与 `ingestJobs` 共用锁
- [x] 2.5 脚本缺失(老工作空间没有 `db_ingest.py`)时返 400 + 中文说明,点名缺哪个脚本,不创建任何目录
- [x] 2.6 接收的源名先过 `resolveInside()`;非环回监听时该路由返 403(与其它起子进程的接口一致)
- [x] 2.7 确认服务端**没有新增任何数据库驱动依赖**,`package.json` 的 `dependencies` 不变
- [x] 2.8 **重启 `pnpm serve`**,`curl` 扫描接口确认:没配源的工作空间响应与改动前一致;配了源的能拿到源清单;`_sources/` 下的产物没出现在 converted 里;`curl` 触发采集能跑起来并轮到进度

## 3. 契约同步(`src/app/lib/api.ts`)

- [x] 3.1 在 `Scan.input` 上加**可选**的 `sources?` 字段,类型与 2.1 / 2.2 的产出逐字段对齐(含每个源挂着的产物列表与状态)
- [x] 3.2 加采集任务的响应类型(status / startedAt / message / log),与 ingest 的 job 形状保持同构
- [x] 3.3 加触发采集与查询采集进度的接口封装,沿用文件里已有的报错提示风格(含"忘了重启常驻服务"那句提示)

## 4. 前端平面(`src/app/**`)

- [x] 4.1 `InputPanel.tsx` 加第四个 tab「数据库源」,**排在 图片资料 之后**;`InputTab` 联合类型与 `tabCounts` 一并扩
- [x] 4.2 tab 的显示条件 = `sources` 字段有内容;字段缺省时(没配 / 目录空 / 旧服务)整个 tab 不渲染,其余三个 tab 行为不变
- [x] 4.3 tab 内容:每个源一行,显示名 + 引擎 + 库名 + schema 快照"多久之前采的"(用 `lib/format` 的 `formatRelative`)+「刷新 schema」按钮;源下面挂它的 schema 快照与查询产物,点了能预览
- [x] 4.4 快照过期、上次采集失败、配置读不出来、引擎不支持四种状态用 orange 标(`--destructive`),其余一律黑白灰;不硬编码色值
- [x] 4.5 点「刷新 schema」后的进度与报错展示,复用 `useIngestJob` 的模式(必要时抽一个同构的 hook,不复制第二套轮询逻辑)
- [x] 4.6 `localStorage` 记住的 tab 值指向已消失的「数据库源」时,要能退回默认 tab,不白屏

## 5. 自动刷新

- [x] 5.1 确认 `watchWorkspace` 的 SSE 已经覆盖 `input/sources/` 与 `input/converted/_sources/` 的写盘:新增一份 yaml、采集完一份快照,页面应自己刷新,不用手点

## 6. 验收闸

- [x] 6.1 `pnpm typecheck` 绿(只覆盖 `src/app`)
- [x] 6.2 `pnpm build` 绿
- [x] 6.3 **重启 `pnpm dev` / `pnpm serve`**,浏览器把输入资料视图点一遍:没配源(三个 tab)、配了源(四个 tab 且新 tab 在最后)、yaml 写坏、引擎不支持、库连不上、采集成功六种情况
- [x] 6.4 确认查询产物只在「数据库源」里出现,「已转换」的清单与计数都不含它
- [x] 6.5 同一轮里再验三种通用降级:工作空间没有 `project.yaml`、工作空间目录丢失、深色模式
- [x] 6.6 验版本错配:用改动前的服务进程配新前端,确认不显示 tab、不报错、不白屏
- [x] 6.7 `pnpm build:npm && pnpm pack:npm && pnpm smoke:npm` 绿(动了 `templates/` 与服务端,装包冒烟要重跑)
- [x] 6.8 过一遍脱敏:确认 `openspec/` 与 `templates/` 里没有真实库名、内网地址、账号、真实数据样例
