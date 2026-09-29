> 三个入口彼此独立,任何一组都能单独落地并验收。
> **建议顺序:第 5~7 组(快照瘦身)可以先做** —— 它修的是一个静默出错的 bug,
> 而前三组只是新增入口。真要分批发,按「7 → 1/2 → 3/4」拆成两次也成立。

## 1. 服务端:目录选择器

- [x] 1.1 `src/server/platform.mjs` 加 `pickDirectory({ prompt })`:三平台各一条命令
      (macOS `osascript` 的 `choose folder` 取 `POSIX path`;Windows `powershell -NoProfile -STA`
      + `FolderBrowserDialog`;Linux `zenity --file-selection --directory`,没有就试 `kdialog`)。
      **命令只写在这一个文件里**,别在 `http.mjs` 里再拼一次
- [x] 1.2 三个平台的「取消」表现不一样(非零退出 / 退出码 1 / 空输出),
      一律翻成「用户取消」,**不当错误**;命令根本不存在时翻成
      「这台机器上起不了目录选择框,请手工填绝对路径」
- [x] 1.3 macOS 上把对话框显式置前(否则会弹到浏览器窗口后面,用户以为没反应);
      在真机上点一次确认它出现在最前
- [x] 1.4 `http.mjs` 加 `POST /api/pick-directory`:先 `rejectIfRemoteWrite`、
      再 `rejectIfForeignOrigin`,然后调 1.1。返回 `{ picked, path? }`
- [x] 1.5 并发与超时:进程内记一个「正在选」的标记,第二个请求 409;
      超时(120 s)杀子进程并返回中文说明。**验证:重启 `pnpm dev` 后连点两次,第二次拿到 409**
- [x] 1.6 冒烟:重启服务后 `curl -X POST localhost:7788/api/pick-directory`,
      在桌面上选一个目录,看返回的是绝对路径;再用 `--host 0.0.0.0` 起一次,
      从别的机器 POST,确认 403 且本机没弹窗

## 2. 契约:api.ts

- [x] 2.1 `src/app/lib/api.ts` 加 `pickDirectory(): Promise<{ picked: boolean; path?: string }>`,
      走统一的 `request`,不在组件里裸写 `fetch`
- [x] 2.2 `DatabaseSourceItem` 加可选 `tableCount?: number`,注释写清
      「大库上服务端不再下发 `tables`,前端优先读这个数、缺省回落 `tables?.length`」
- [x] 2.3 `Scan.input.sources` 的类型注释更新:空数组是合法状态(有 `input/sources/` 目录但还没配源),
      字段缺省才是「跟数据库无关」

## 3. 前端:目录选择按钮

- [x] 3.1 `CreateWorkspaceDialog.tsx` 两个 tab 的路径输入框后面各加一个文件夹图标按钮,
      沿用同文件里「创建模板提示词」那个图标按钮的样式与 Tooltip 写法,不新造一套
- [x] 3.2 打开对话框时探一次接口能力(或首次点击拿到「未知接口」后隐藏按钮),
      **旧服务进程下不显示这个按钮**,对话框其余部分与改动前一字不差
- [x] 3.3 等待态:按钮转圈 + 一行「已打开系统选择框,请在桌面上完成选择」;
      取消时静默恢复;起不来时把服务端那句中文说明显示出来,输入框保持可用
- [x] 3.4 选中的路径回填进输入框后**仍可编辑**(新建场景下用户通常要在父目录后面接一段名字)

## 4. 前端:「添加环境参数」对话框

- [x] 4.1 新建 `src/app/components/EnvConfigDialog.tsx`:两个独立对话框
      (`ApiKeyDialog` / `DatabaseSourceDialog`),不在同一层里切 tab。先读
      `templates/pm-aispace/.claude/skills/pm-env-config/references/kanban-prompt.md`,
      **字段名与固定头照抄那份契约**,不自己发明
- [x] 4.2 `database` 表单只收显示名 + 一段连接信息粘贴框。原文**原样跟在固定头后面**,
      看板不拆字段、不猜引擎端口(拆解是 AI 按技能做的事)
- [x] 4.3 `api_key` 表单:变量名预填 `MINERU_API_KEY`(可编辑)+ 值。**不读工作空间的 `.env.example`**
- [x] 4.4 口令 / token 用 password 输入框;对话框里明写「只进剪贴板,粘给 AI 后建议清空,刷新即丢」;
      关闭或刷新后不保留任何值。**任何字段都不发给任何接口**
- [x] 4.5 主按钮「复制 prompt 给 AI」走已有的 `writeClipboard()`;
      **复制失败必须显式提示并把 prompt 原文显示出来**(从别的机器用 http 访问时没有 Clipboard API),
      不能静默当成功。必填项没填时按钮不可点并说明缺什么
- [x] 4.6 `InputPanel.tsx` 标题栏挂两个入口:「原始资料」tab 在 `ViewModeToggle` **之前**放
      key 图标按钮(预选 `api_key`);「数据库源」tab 在 `SourceRefreshButton` 旁边放
      数据库图标按钮(预选 `database`)。注意那一排是 grid 叠层,
      `assets` / `sources` tab 下左边那格是 `invisible` 的,别把按钮塞进被隐藏的那一格
- [x] 4.7 图标一律走 lucide,颜色只用语义令牌 —— 这两个按钮不是「需要注意」,**不许上 orange**

## 5. 服务端:数据库源 tab 的出现判据 + 扫描瘦身

- [x] 5.1 `scan.mjs` 的 `scanSources()`:判据从「没有 yaml 且没有产物目录 → 返回 null」
      改成「没有 `input/sources/` 目录 → 返回 null」,目录在就返回数组(可能为空)。
      确认 `canIngestSources` 在空数组时照样下发
- [x] 5.2 `collectSourceProducts()` 给拆分快照加 `tableCount`(始终给);
      `tables` 数组**只在表数 ≤ 拆分阈值时给**,超过就不给也不 `stat`
- [x] 5.3 阈值与模板脚本的 `SPLIT_TABLE_THRESHOLD` 保持同一个语义,
      在注释里点名它对应脚本里的哪个常量(两边各有一份,别让它们悄悄漂移)
- [x] 5.4 冒烟:重启 `pnpm dev` 后 `curl -s "localhost:7788/api/projects/<id>/scan" | wc -c`,
      对比改动前后的字节数;再确认小库(几十张表)的响应**一字未变**

## 6. 前端:接住瘦身后的形状

- [x] 6.1 `SourceItemRow` 的「N 张表的明细」改成优先读 `tableCount`、缺省回落 `tables?.length`;
      两者都没有就不显示这行副文本
- [x] 6.2 `InputPanel` 的 `showSources` 判据从 `sources.length > 0` 改成「服务端给了这个字段」;
      空数组时渲染空态 + 「添加数据库源」按钮
- [x] 6.3 手动验一遍三种组合:新前端+新服务、新前端+旧服务(拿不到 `tableCount`)、
      旧前端+新服务(大库上少一行副文本)。**三种都不许白屏**

## 7. 模板:db_ingest.py 与技能文档

> `templates/` 是另一套语境,本仓的编码规范不适用于它内部;
> 而且**放进去就是发出去** —— 改完要意识到它会随模板发给每个新建的工作空间。

- [x] 7.1 PG 的三条 `information_schema` 查询把 `= ANY(%s)` 改成 `= ANY(%s::text[])`。
      **验证:对一个 PostgreSQL 兼容库(KingbaseES)采一次,改之前是 0 张表、改之后是真实表数**
- [x] 7.2 `cmd_schema`:采到 0 张表时**报失败、不写盘**,说明「一张表都没读到,
      请检查 schema 白名单」,上一份快照原样保留。
      验证:故意把白名单写成一个不存在的 schema,确认旧快照还在
- [x] 7.3 `write_schema_snapshot()` 在表数很多时,把表清单从五列大表格改成
      **按表名前缀分组的紧凑清单**:每组给组名 + 组内表数,组内每表一行
      (表名 · 列数 · 表注释)。表注释必须保留
- [x] 7.4 分不出前缀分组时(分组数接近表数)退回**按首字母分段的单一清单**,
      不许造出一堆只含一张表的组。用一份表名毫无规律的合成用例验这条路径
- [x] 7.5 实测对比:同一个库采两次,记下摘要字节数与 Markdown 解析耗时,
      确认瘦身生效;单表明细文件**照旧一表一份**(本轮不合并)
- [x] 7.6 `pm-env-config/references/kanban-prompt.md` 里「这份是给**以后**看板「添加」按钮用的」
      改成已经落地的说法;`SKILL.md` 里「看板以后会用…」同步。
      **字段契约本身不改**,改了就要同时改 4.1

## 8. 验收闸

- [x] 8.1 `pnpm typecheck` 绿(只覆盖 `src/app`,服务端全绿不代表没错)
- [x] 8.2 `pnpm build` 绿
- [x] 8.3 **重启** `pnpm dev`(服务端不热更),`curl -s localhost:7788/api/health` 活着
- [x] 8.4 浏览器把受影响视图点一遍:侧栏「新建」两个 tab(含目录选择器的选中 / 取消 / 起不来三条路)、
      「输入资料」四个 tab、「数据库源」的空态与有源态、大库快照点开
- [x] 8.5 三种降级情况各点一遍:**没有 `project.yaml` 的工作空间**、
      **目录被改名/移走**(`available === false`)、**深色模式**
- [x] 8.6 只读红线自查:整轮改动没有任何一处往工作空间写文件;
      新接口没接收路径参数,因此不涉及 `resolveInside`,但也**没有绕过它读工作空间内的东西**
