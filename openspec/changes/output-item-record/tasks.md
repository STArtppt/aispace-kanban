## 1. 模板侧:目录骨架与字段契约

`templates/` 是另一套语境,本仓编码规范不适用于它内部。注意「放进去就是发出去」。

- [ ] 1.1 在 `templates/pm-aispace/output/` 下建 `records/` 骨架(带 `.gitkeep`)
- [ ] 1.2 写 `output/records/README.md` —— **字段契约的唯一事实源**:布局、编号只增不复用(含空目录先查历史最大编号的命令)、扁平 front-matter 字段表、**按 `kind` 分化的三套状态机**、状态流水写法、人写区/AI 写区分界。照 `output/questions/README.md` 的口径与语气写
- [ ] 1.3 在 `templates/pm-aispace/output/README.md` 里补这个平级目录的说明,并说清它为什么不进看板的三组列表(与 `questions/` 同一条理由)
- [ ] 1.4 在 `templates/pm-aispace/AGENTS.md` 的「Markdown 写法」适用范围表里加 `output/records/` 一行
- [ ] 1.5 新建 `pm-output-record` 技能:建产出物时一并建记录、维护 AI 写区字段、产出物改名时跟进 `target`
- [ ] 1.6 在现有的 `pm-requirement-analysis` / `pm-prd-writing` / `pm-project-handover` 等产出类技能里补一句「产出后建记录」,接到 1.5 的技能
- [ ] 1.7 扩 `templates/pm-aispace/scripts/check_markdown.py` 校验新目录:`id` 与文件名一致、`kind` 三者之一、`status` 属于该 `kind` 的状态机、终态必须有 `resolved_by`、`status` 与流水末条一致、front-matter 里没有长文
- [ ] 1.8 写 `decisions/` 状态迁移脚本:读正文那行 bullet → 建记录并填 `status`,**不删正文那行**,读不出状态的标待人工确认;默认预演,落盘要显式参数

## 2. 服务端:只读接口

- [ ] 2.1 新建 `src/server/records.mjs`:扫 `output/records/` → 清单索引(只含短字段,不含正文)、读单份详情。读失败一律降级成空/默认值,不让进程崩
- [ ] 2.2 把三套状态机写成一张 `kind → 合法状态值` 的映射表,服务端校验与索引都用它,**不要散在各处**
- [ ] 2.3 在 `scan.mjs` 里确认 `output/records/` **不进**三组列表(`scanOutput` 只遍历三个组名,天然不含),并补注释说明为什么它的正文**不喂** `attachReferences` —— 与 `questions/` 的处理不同,理由是状态流水会把反链计数顶虚高
- [ ] 2.4 在 `http.mjs` 挂只读路由(索引 / 详情),沿用现有错误约定(`throw new Error(中文)` + `err.statusCode`)
- [ ] 2.5 **重启 `pnpm serve`**,`curl` 两个只读接口:正常工作空间、没有 `records/` 目录的老工作空间、故意写坏一份 front-matter 的记录(要求照常列出并标「读不出」)、`target` 指向已删除文件的记录(要求标「指向丢失」)

## 3. 契约同步

- [ ] 3.1 在 `src/app/lib/api.ts` 加索引 / 详情 / 状态写入的响应类型与封装,**新增字段一律可选**
- [ ] 3.2 三套状态机的类型定义与服务端那张映射表同源,别在前端抄第二遍字面量
- [ ] 3.3 `pnpm typecheck` 绿

## 4. 前端:工作台提壳 + 产出物页(只读)

按 design 决策 8「提壳,不动内脏」——`QuestionsDialog` 内部逻辑一行不改。

- [ ] 4.1 新建工作台外壳组件:Dialog 容器 + 两页切换 + `⌘K` 接线,从 `App.tsx` 接管现有 `useGlobalHotkey('k', ...)`
- [ ] 4.2 把现有 `QuestionsDialog` 的内部整块搬进工作台当一页,**只剥最外层 Dialog 容器**;`QuestionsFab` 与 `countPending` 留在外面,计数口径不变(只数未决问题)
- [ ] 4.3 新建产出物页:先按 `kind` 分三组、组内按 `status` 分组的清单 + 详情卡片。清单行只显示 `title` 与状态等短字段
- [ ] 4.4 默认排序把需要人处理的排前面(`revising` / `pending` / 停滞较久的 `delivered`);「指向丢失」用 orange(`--destructive`),其余状态不上彩色
- [ ] 4.5 空态:没有 `records/` 目录、接口 404(旧服务进程)、目录存在但没有记录,三种各写清怎么开始
- [ ] 4.6 `pnpm typecheck` + `pnpm build` 绿;浏览器里 `⌘K` 走一遍两页切换与两页状态互不影响

## 5. 服务端:状态写入

约束照 `writeQuestion` 那六条逐条实现,一条都不能少。

- [ ] 5.1 在 `records.mjs` 里实现写入收口:改 `status` / `resolved_by` / `status_changed` + 在「## 状态流水」末尾追加一条。统一走「先写临时文件再原子替换」
- [ ] 5.2 校验:只改已存在的文件(不存在 404)、只写人写区(载荷出现 `target` / `updated` 一律 400 且不落盘)、请求只带编号不接受任何路径、落盘路径由服务端用 `resolveInside()` 自己拼
- [ ] 5.3 状态值必须属于该记录 `kind` 的状态机,否则 400;需要 `resolved_by` 的终态没填则 400;补充说明为空则 400
- [ ] 5.4 挂路由并接上 `allowMutations` 与 `rejectIfForeignOrigin`:非环回或跨站一律 403
- [ ] 5.5 **重启 `pnpm serve`**,`curl` 逐条验:正常写入、跨类状态值(400)、写 AI 写区字段(400)、不存在的编号(404)、编号里塞 `../`(拒绝)、终态不带 `resolved_by`(400)、空说明(400)
- [ ] 5.6 手工验:写入后 `target` 指向的产出物文件、`input/`、`project.yaml` 一个字节都没变,目录里没有残留临时文件

## 6. 前端:写入接线

- [ ] 6.1 状态变更交互做成一次:该 `kind` 的状态下拉 + 紧跟的补充说明输入框 + 保存
- [ ] 6.2 需要 `resolved_by` 的终态要求填消解者编号
- [ ] 6.3 403 / 400 / 404 的界面表现各写清楚,不用「操作失败请重试」这类空话
- [ ] 6.4 `pnpm typecheck` + `pnpm build` 绿;浏览器里三类产出物各点一次状态变更,确认文件真的变了且流水追加正确

## 7. 文档与约定

- [ ] 7.1 改 `AGENTS.md` 不变量 1:新增**第六条窄例外**(产出物记录的状态写入),六条约束逐条写明
- [ ] 7.2 改 `AGENTS.md` 里 `writeQuestion` 那段的措辞 —— 现在写着「它与前三条**形状不同**」,加完之后「看板自己写盘」有两条,这句话要跟着改
- [ ] 7.3 在 `AGENTS.md` 第 3 节的目录树里补 `records.mjs`
- [ ] 7.4 `scripts/build-npm-package.mjs` 的拷贝清单加新增的服务端文件(漏了装包的人会 `ERR_MODULE_NOT_FOUND`)

## 8. 验收闸

- [ ] 8.1 `pnpm typecheck` 绿(只覆盖 `src/app`,服务端没有静态检查)
- [ ] 8.2 `pnpm build` 绿
- [ ] 8.3 重启 `pnpm serve` + `curl -s localhost:7788/api/health`
- [ ] 8.4 **存量 questions 完整回路回归** —— 本 change 唯一碰到已上线功能的地方:`⌘K` 唤出、分组筛选、卡片翻页、保存一条人工反馈、复制 prompt,逐项确认与改动前一致
- [ ] 8.5 浏览器点一遍受影响视图:工作台两页、产出视图(确认三组列表与计数没变)
- [ ] 8.6 三种降级各看一遍:没有 `project.yaml` 的工作空间、工作空间目录丢失、深色模式
- [ ] 8.7 老工作空间(没有 `output/records/`)全程可用,没有任何报错或白屏
- [ ] 8.8 `pnpm build:npm && pnpm smoke:npm` 绿
