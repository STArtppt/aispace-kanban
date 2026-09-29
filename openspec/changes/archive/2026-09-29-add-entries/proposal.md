## Why

现在看板上**每一件要配的事都得先离开看板**:新建工作空间要自己去终端 `pwd` 拷一段绝对路径,
配 MinerU 的 key、加一个数据库源要自己想起来有 `pm-env-config` 这个技能、自己拼一段话发给 AI。
入口不在看板上,用户就想不起来它存在 —— 模板里那份
`pm-env-config/references/kanban-prompt.md` 早就把「看板收字段、AI 落文件」的契约写好了,
等的就是这三个按钮。

同时,数据源真被加进来以后有一个已经踩到的坎:**表多的库,快照这条链路整条都变重**。
实测一个 PostgreSQL 兼容库(单 schema 366 张表)采完是 367 个文件;把白名单放到 5 个 schema
(975 张表)时,摘要 141 KB、单表明细 975 份、而每次扫描下发的 JSON 里
**98.3% 是一份前端只用来数个数的文件清单**。不动它,用户加完源第一件事就是界面变卡。

## What Changes

### 三个「添加」入口(本 change 的主体)

- **新建工作空间弹窗的路径框后面加一个文件夹图标按钮**,点了在**服务所在的机器**上弹出
  系统原生目录选择器,选中的绝对路径回填到输入框(仍可继续编辑)。
  新建 / 登记两个 tab 都有。选择器起不来(没装 zenity、服务跑在没有桌面的机器上)时
  给一句中文说明,输入框照旧能手工填 —— **不阻断原来的路**。
- **「原始资料」tab 的视图切换按钮组前面加一个 key 图标按钮**:弹窗录入 MinerU 的 key,
  点「复制 prompt 给 AI」把一段**能触发 `pm-env-config` 技能**的提示词写进剪贴板,
  用户粘给当前 Agent 由 AI 落 `.env`。
- **「数据库源」tab 加一个数据库图标按钮**:打开独立的「添加数据库源」弹窗
  (显示名 + 一段连接信息粘贴框),同样只产出 prompt。看板不拆引擎/主机/口令。
- **看板不存凭据、不写 `.env`、不读工作空间的 `.env`。** key 和口令只从输入框进剪贴板,
  刷新页面即丢。产出的 prompt 格式**照模板里那份已冻结的字段契约**,不自己发明一套。
- 「数据库源」tab 的出现判据从「已经配过源」放宽到「这个工作空间有 `input/sources/` 目录」,
  否则**第一个源永远加不进来**(没源 → 没 tab → 点不到添加按钮)。

### 大库 schema 快照瘦身

- **扫描不再下发单表明细清单。** 表数超过拆分阈值时,`Scan` 只给一个数字(表数),
  不再给几百上千条 `{path,name,ext,reader,title,size,mtime}`。实测这一刀把
  975 张表那个源的扫描载荷从 331 KB 降到 6 KB 上下,并省掉每次扫描的上千次 `stat`。
- **摘要在表特别多时不再是一张几百行的 Markdown 大表格**,改成按表名前缀分组的紧凑清单。
  实测 975 张表的摘要 141 KB、光解析就要 90~119 ms(Node 里;浏览器只会更慢),
  而它同时是**唯一会被整份读进 AI 上下文的那一份**。
- **修一个静默出错的 bug:** PostgreSQL 那三条 `information_schema` 查询用
  `= ANY(%s)` 传 schema 白名单,在 KingbaseES 这类 PG 兼容库上**不报错、直接返回 0 行**,
  快照写成「0 张表」而日志显示成功。加显式 `::text[]` 转型即可,对原生 PG 行为不变。
- 采集本身**不动**:实测 975 张表三条系统表查询合计 0.97 s,端到端 1.3 s,它不是瓶颈。

明确不做:看板里直接写 `.env` / 写 yaml(那是 `pm-env-config` 的活,也会撞只读红线);
看板里连数据库做连通性测试;在看板里浏览整台机器的文件系统(选目录走系统原生对话框,
不自绘目录树);把单表明细文件合并成几份(先看瘦身后还够不够快)。

## Capabilities

### New Capabilities
- `env-config-prompt`: 看板上的「添加环境参数」入口 —— 收字段、拼出能触发工作空间
  `pm-env-config` 技能的提示词、只进剪贴板;凭据不落盘、不进任何接口。
- `directory-picker`: 路径输入旁的系统目录选择器 —— 在服务所在机器上弹原生对话框、
  只返回一个绝对路径、非环回一律拒绝、起不来时退回手工输入。

### Modified Capabilities
- `database-source`: 三处要求变化 —— ①「数据库源」tab 的出现判据放宽到「有 `input/sources/` 目录」;
  ② 表数超阈值时扫描结果 MUST NOT 逐条下发单表明细,只给表数;
  ③ 摘要在表特别多时 MUST 保持可整份读进上下文的体量,并明确 PG 兼容库上的 schema 白名单转型要求。

## Impact

| 平面 | 影响 |
| --- | --- |
| 前端 `src/app/**` | 新增「添加 API Key」与「添加数据库源」两个独立弹窗;`CreateWorkspaceDialog` 路径框后加按钮;`InputPanel` 标题栏两个 tab 各加一个按钮;`SourceItemRow` 的「N 张表的明细」改读表数字段 |
| 契约 `src/app/lib/api.ts` | **要动** —— 新增 `pickDirectory()` 方法与响应类型;`DatabaseSourceItem` 新增可选 `tableCount` |
| 服务端 `src/server/**` | `http.mjs` 新增 `POST /api/pick-directory`(过 `rejectIfRemoteWrite` + `rejectIfForeignOrigin`);`platform.mjs` 新增三平台的目录选择器命令;`scan.mjs` 的 `collectSourceProducts` 超阈值时改发表数 |
| CLI `bin/cli.mjs` | 不动 |
| `templates/` | **要动** —— `pm-aispace/scripts/db_ingest.py` 的 PG 查询加 `::text[]`、摘要在表多时改分组紧凑清单;`pm-env-config/references/kanban-prompt.md` 里「以后看板会…」的措辞改成「看板已经…」 |

**依赖:** 不引任何新包。目录选择器用各平台自带的命令(macOS `osascript`、
Windows PowerShell 的 `FolderBrowserDialog`、Linux `zenity` / `kdialog`),
选择器缺失时降级,不把它变成安装前提。

**兼容性:**
- `pick-directory` 是新接口,旧服务进程返回「未知接口」→ 前端**不显示这个按钮**
  (启动时探一次,或首次点击失败后隐藏),输入框行为与改动前一字不差。
- `tableCount` 是新增可选字段。旧服务进程只给 `tables` 时前端回落到 `tables.length`;
  新服务进程在大库上不给 `tables` 时,旧前端少显示一行「N 张表的明细」副文本 ——
  少显示一块,不白屏,符合既有的兼容约定。
- 「数据库源」tab 判据放宽后,旧前端拿到空数组仍然按「没有数据源」处理,tab 照旧不出现。

**已拍板的两处取舍**(提案评审时确认,实现阶段不再重新讨论):
① 目录选择器走**服务端起系统原生对话框**,不走浏览器侧的目录选择 API ——
后者拿不到绝对路径,而注册表和 `init_workspace.py` 要的正是它(design 决策 1);
② 「数据库源」tab 的出现判据放宽到「有 `input/sources/` 目录」,
否则第一个源永远加不进来:没源就没 tab,没 tab 就点不到添加入口(design 决策 4)。

**只读红线:不放宽,也不需要放宽。** 三个入口一个字都不往工作空间写:
prompt 只进剪贴板,写 `.env` / yaml 的仍然是用户发给 AI 之后由 AI 在工作空间里做。
目录选择器只**读**用户手选的一个路径,不列目录、不返回内容。
唯一新增的系统调用是「弹一个原生对话框」,与既有的「用默认浏览器打开」「在访达中显示」同类,
一并收在 `platform.mjs`。
