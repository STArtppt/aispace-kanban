# capability-boundary 实施笔记：能力盘点与细则对照

## 1.0 从 http.mjs 非 GET 路由反推的能力清单

以代码为准（`src/server/http.mjs` 全部 POST / PATCH / DELETE 分支，加 `handleCapturePackage`）。

| 路由 | 能力标识 | 作用域 | 执行者 | AGENTS.md 原条目 | help.md 表格 |
| --- | --- | --- | --- | --- | --- |
| `POST /api/workspaces` | `workspace-init` | workspace | spawn `templates/init_workspace.py` | 基础写入·新建工作空间 | 无（第 1 章讲了入口） |
| `POST /api/projects/:id/ingest` | `raw-ingest` | workspace | spawn `scripts/ingest.py` | 基础写入·资料转换 | 有 |
| `POST /api/projects/:id/db-source` | `db-schema-refresh` | workspace | spawn `scripts/db_ingest.py` | **漏登** | 有 |
| `POST /api/projects/:id/capture` | `visual-capture` | workspace | direct | 第二条 | 有 |
| `POST /capture-package` | `capture-package-inbox` | workspace | direct | 第二条 ⑥（复用收口） | 无（并入采集） |
| `POST /api/projects/:id/proto-sync` | `prototype-refresh` | workspace | spawn `workspace-sync.mjs` | 第三条 | 有 |
| `POST /api/projects/:id/questions/:qid` | `question-feedback` | workspace | direct | 第四条 | 有 |
| `POST /api/projects/:id/web-ingest` | `reference-inbox-refresh` | workspace | spawn `scripts/web_ingest.py --inbox` | 第五条 | 有 |
| `POST /api/projects/:id/records/:rid` | `record-status` | workspace | direct | 第六条 | 有 |
| `POST /api/projects/:id/note-history`（带 `recordId`） | `record-notes` | workspace | direct | 第六条第二种写入 | 有 |
| `POST /api/projects/:id/archive` | `output-archive` | workspace | spawn `scripts/archive_output.py` | 第七条 | 有 |
| `POST /api/projects/:id/feedback/:fid/sent` | `feedback-sent` | workspace | direct | 第八条 | 有 |
| `POST /api/projects/:id/docx-templates/:name/{collect,build}` | `docx-template-refine` | workspace | spawn `scripts/docx_template.py` | 第九条 | 有 |
| `POST /api/projects/:id/docx/convert` | `md-docx-export` | workspace | spawn `scripts/md2docx.py` | 第九条 | 有（落点描述已过时） |
| `POST /api/projects/:id/delivery/final[/pick]` | `delivery-finalize` | workspace | spawn `scripts/finalize_delivery.py` | 第十条 | 有 |
| `POST /api/projects/:id/rename[/preview]` | `output-rename` | workspace | spawn `scripts/rename_output.py` | 第十一条 | **缺** |
| `POST /api/projects/:id/converted-copy[/preview]` | `converted-copy-to-output` | workspace | spawn `scripts/copy_converted.py` | 第十二条 | **缺** |
| `POST /api/projects/:id/raw-organize[/preview]` | `raw-source-organize` | workspace | spawn `scripts/move_raw.py` | 第十三条 | **缺** |
| `POST /api/projects` · `PATCH/DELETE /api/projects/:id` | `project-registry` | local | direct（`~/.pmwork/dashboard/`） | 基础写入·注册表 | — |
| `POST /api/pick-directory` | `directory-picker` | local | spawn 系统选择框 | — | — |
| `POST /api/projects/:id/reveal` | `reveal-in-system` | local | spawn 系统打开 / 定位 | — | — |
| `POST/DELETE /api/projects/:id/note-history`（不带 `recordId`） | `note-history-cache` | local | direct（看板缓存） | — | — |

没有路由、但会写本机状态或起子进程的模块，也以 `local` 登记：`prototype-zip-cache`（`prototypes.mjs` 解压缓存）、
`version-probe`（`version.mjs` 读 git 版本）。

`POST /note-history` 在读请求体之前无法知道走工作空间还是缓存，闸按 `record-notes` 过（两者判定相同）。

三方对齐结论：AGENTS.md 漏登 `db-schema-refresh`；help.md 缺 `output-rename` `converted-copy-to-output` `raw-source-organize`，
且「转成 Word」的落点仍写成"与来源同目录"——按 4.7 整张表删除、改写成第 9 章，不再逐行补。

## 1.1 / 1.3 细则对照表

"共同"列指 AGENTS.md 对所有编号例外的共同约束（用户点击发起；环回 + 非跨站）。
跨站判定在所有写接口上由 `visual-capture` 的「写接口必须环回且非跨站」统一规定（来源判定收在一个函数里、供全部写接口共用），
下表"来源"一栏凡只写到环回的 spec，跨站部分都落在这条 Requirement 上。

| 标识 | 原条目 | ① 写入面 | ② 发起 | ③ 来源 | ④ 寻址 | ⑤ 写入面细则 | ⑥ 可回退 / 失败 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `workspace-init` | 基础·新建 | **缺** → delta `workspace-template-update`「看板新建工作空间只 spawn 铺设脚本」 | 同左 | 同左 | 同左 | `workspace-template-update`「铺设与更新都留下基线」 | 同左 delta |
| `raw-ingest` | 基础·资料转换 | **缺** → delta `raw-source-status`「资料转换只 spawn 转换脚本」 | `raw-source-status`「看板不发起全量转换」 | 同 delta | 「看板不发起全量转换」（空路径 / 根 400） | 同 delta（旧布局拒写、`ANYDOC_BIN`） | 「转换脚本必须写明范围」 |
| `db-schema-refresh` | 漏登 | `database-source`「看板进程不碰数据库,写盘的只能是工作空间脚本」 | 同左（由人点「刷新 schema」） | 同左（非环回 403） | 同左（`resolveInside`） | `database-source`「schema 快照是 KB 级摘要…」（`output/converted/_sources/`） | 同左 |
| `visual-capture` | 第二条 | 「写入范围只限 visualization/ 之下」 | 「用户可贴 URL 采集参考页」 | 「写接口必须环回且非跨站」 | 「用户可贴 URL 采集参考页」（slug 服务端生成） | 「写入范围只限 visualization/ 之下」 | 同左（不删不覆盖、新 slug） |
| `capture-package-inbox` | 第二条 ⑥ | 「接收端的来源放行不得扩大写入面」 | 「按契约 D 在固定路径接收采集包」 | 「接收端的来源放行不得扩大写入面」 | 「采集包摊成一份参考条目」 | 同左 | 同左 |
| `prototype-refresh` | 第三条 | **缺**（工作空间内外写入面）→ delta `prototype-refresh`「刷新的写入面」 | 「已接入原型行提供刷新入口」 | 「刷新任务异步执行并可轮询」 | 「执行前校验脚本与回指」 | 同 delta | 「刷新任务异步执行并可轮询」（失败不回滚） |
| `question-feedback` | 第四条 | `open-questions-workbench`「人工反馈写入」1–6 | 同左 3 | 同左 4 | 同左 5 | 同左 2、6 | 同左 1 |
| `reference-inbox-refresh` | 第五条 | `reference-inbox-refresh`「参考 tab 能一键把收件箱入库」 | 同左 | 「非环回监听禁写，跨站请求拒绝」 | 「根上的散装页面算待入库」 | `web-source-ingest`「收件箱模式把散装页面收成标准参考再抽正文」 | 同左 |
| `record-status` | 第六条 | `output-item-workbench`「写入接口的约束」 | 同左 | 同左 | 同左 | 「状态变更与补充说明是一次写入」（状态机、终态 `resolved_by`、补充说明必填） | 「写入接口的约束」（原子写） |
| `record-notes` | 第六条第二种 | `annotation-status-loop`「写入面的边界」 | 「落盘的时机是用户点「复制提示词」」 | 「写入面的边界」 | 同左 | 「批注文件的格式与两边的写区」「每条批注有自己的状态」（`pending`） | 「写入面的边界」（上限、原子写）；交付稿镜像 → 「交付稿上的批注挂到原稿的记录」 |
| `output-archive` | 第七条 | `output-archive`「归档的写入面边界」 | 同左 | 同左 | 同左 +「本轮只归档组根目录下的文件」 | 「一次归档目录下有一份 README 交接单」 | 「归档只移动,不删除、不覆盖」「看板只 spawn,写盘的是工作空间脚本」 |
| `feedback-sent` | 第八条 | `workbench-feedback`「用户确认后写回发送记录」——**引用 AGENTS 条号** → MODIFIED 内联全部边界（补上结构认不出 409、其余文件只读） | 同左 | 同左 | 同左 | 同左 | 同左 |
| `docx-template-refine` | 第九条 | `docx-template-refine`「提炼的写入边界」——**引用 AGENTS 条号** → MODIFIED 去掉引用，内联 | 同左 | 同左 | 同左 | 「模板产物目录约定」 | 同左（重名 409） |
| `md-docx-export` | 第九条 | `md-docx-export`「成品落在交付稿镜像目录」 | 「直接转换」 | 「转换的失败与降级」（非环回）+ 跨站通用条 | 「直接转换」（`docKey`）+ `converted-docx-export`「可转换的输入转换产物」 | 「成品落在交付稿镜像目录」 | 「同名文件不被误覆盖」；**缺**：来源在 `output/converted/` 而脚本不认时 400 → delta `md-docx-export` |
| `delivery-finalize` | 第十条 | `delivery-finalize`「执行定稿」 | 「顶栏的「定稿」入口」「定稿前确认」 | 「系统选文件框默认打开镜像目录」（403） | 同左（令牌） | 「执行定稿」 | 「定稿的失败与降级」「定稿记录」；**缺**：唯一读工作空间外文件、看板不提供按路径读外部文件 → delta `delivery-finalize` |
| `output-rename` | 第十一条 | `output-rename`「写入边界」 | 「先预览再执行」 | 「写入边界」 | 同左；**缺**：新基名完整规则（≤120 字、禁字符、不等于 `一次归档`）→ delta `output-rename` | 「改名连带镜像目录与 Word 成品」「更新指向这份文件的引用」「改名在记录状态流水里留痕」 | 「冲突拒绝且失败不留半截」 |
| `converted-copy-to-output` | 第十二条 | `converted-copy-to-output`「写入边界」 | 「先预览再执行，冲突拒绝」 | 「写入边界」 | 同左 | 「按子目录结构复制」「复制件链接与留痕」 | 「先预览再执行，冲突拒绝」 |
| `raw-source-organize` | 第十三条 | `raw-source-organize`「看板只 spawn，请求不带路径」 | 「先预览再落盘」 | 同左（非环回）+ 跨站通用条 | 同左 | 「关联在同一次确认里跟进」 | 「这些情况拒绝且不落盘」；**缺**：先写临时文件、改名阶段失败全部改回、替换阶段个别失败如实列出、跨设备 400、空目录不删 → delta `raw-source-organize` |
| 去 AI 味 | 不新增写入 | `deai-workbench`「服务端只读读取规则库」 | — | — | — | — | — |

另：`local-source-sync`「看板不为本机同步写工作空间」写着"不变量 1 的例外清单"，改为"能力清单"（MODIFIED，只改措辞）。
`visual-capture` 的 Purpose 写着"不变量 1 的第二条窄例外"，Purpose 不走 delta，实施第 4 节时直接改一句措辞。
