## 0. 前置

- [x] 0.1 `md-to-docx` 已归档：`openspec/specs/` 下有 `md-docx-export`、`docx-toolchain`，`docx-template-refine` 是它修改后的版本
- [x] 0.2 proposal「写入工作空间」已确认：第九条第 ⑤ 款加 `front.docx`、第 ④ 款来源扩到 `output/delivery/**`；改交付稿走「批注 → AI 修改 → 同步沉淀」，看板不在线编辑

## 1. 规则先行

- [ ] 1.1 `AGENTS.md` 不变量 1 第九条：第 ④ 款补交付稿来源，第 ⑤ 款文件清单补 `front.docx`；第 3 节目录表补 `output/delivery/` 与新接口；注明去 AI 味这条线看板不新增写入；第六条第二种写入处补一句「交付稿的批注按镜像路径落到原稿记录，边界不变」
- [ ] 1.2 复核 `CLAUDE.md` 不用改

## 2. 工作空间工具链：格式过滤器（templates/pm-aispace/scripts/）

- [ ] 2.1 `docxkit/filters/deai-format.lua`：标题平移（仅当首块是唯一 `#`）、手写编号剥离（受 `-M strip-heading-numbers` 控制）、批注块 → `custom-style="提示框"` Div、段首标签式以外的加粗解除（受 `-M keep-bold` 控制）；在元数据里回传处理计数
- [ ] 2.2 `docxkit/pandoc.py`：`md_to_docx` 挂过滤器与元数据参数，并读回计数，写进 `log` / `warnings`；有前置区时拦下 pandoc 自动生成的 Title / Author / Date 段
- [ ] 2.3 `md2docx.py`：检查 `reference.docx` 的 `heading 1` 是否带 `numPr`，据此决定是否剥编号；新增 `--keep-bold`
- [ ] 2.4 `docxkit/sample.md` 补 `#` 文档标题、手写编号标题、四种批注块、段首标签加粗与句中加粗，覆盖过滤器的每个分支

## 3. 工作空间工具链：前置区

- [ ] 3.1 `docxkit/front.py` · 识别：正文起点判定、分节与块清单、文本框与回退副本归并、角色猜测（字号 / 位置 / 日期格式），报告只出结构与标签
- [ ] 3.2 `collect.py` 报告加 `front` 段；确认报告脱敏断言仍成立
- [ ] 3.3 `decisions.py` 校验 `front` 决定（字段角色枚举、表格清空规则枚举、`disabled`），合进 `profile.json#front`
- [ ] 3.4 `front.py` · 切出：连同图片、页眉页脚、样式（含 basedOn 链）、编号切出前置区，字段段落写占位符，表格按规则清空，写 `front.docx`（带生成标记）
- [ ] 3.5 `build.py` / `docx_template.py`：生成时写 `front.docx`，样张带前置区；`spec.md` 补「封面字段从哪里取值」一节
- [ ] 3.6 `front.py` · 装配：按 D1 把前置区插到 pandoc 输出前，重排 `r:id`、部件名、样式 ID；TOC 缓存项清空并加占位行；`settings.xml` 设 `updateFields`
- [ ] 3.7 `front.py` · 填字段：按 D4 取值（只读 `project.yaml` 的 `identity.甲方` / `identity.承建方`），保住首个 run 格式，同字段所有出现处一起替换；取不到值写「【待填：…】」并给 warning
- [ ] 3.8 `md2docx.py` 接上装配步骤；`log` 注明每个字段的取值来源
- [ ] 3.9 `docxkit/README.md` 补前置区的模块说明与踩坑（样式 ID 对齐、文本框回退副本、最后一个分节符归属）

## 4. 合成回归语料与测试

- [ ] 4.1 `fixtures/docx-template/make_messy_docx.py` 加前置区：文本框封面（带回退副本）、签署页标签表、版本跟踪表、TOC 域、分节符；另生成一份表格排版封面的变体
- [ ] 4.2 `fixtures/docx-template/decisions.json` 补 `front` 决定
- [ ] 4.3 `scripts/check-docx.mjs` 断言：报告不含语料正文（含封面）；`front.docx` 里只有占位符、没有原文；成品分节数等于前置区分节数加一；封面字段已替换且字号未变；
  标题无重复编号；全文搜不到 `[!`；句中加粗已解除、段首标签加粗仍在；`--keep-bold` 下加粗全保留；无 `front.docx` 的模板行为不变
- [ ] 4.4 在终端用合成语料手动跑通 collect → build → md2docx，用 LibreOffice 渲染看一眼封面、签署页、目录（本机有，不是依赖）

## 5. 去 AI 味技能（templates/pm-aispace/）

- [ ] 5.1 `.claude/skills/pm-deai-writing/SKILL.md`：去味 / 批注修订与沉淀 / 体检三节，各写输入、输出、自检；批注修订一节写清「改出下一版不改原版」「可推广的判据与正反例」「同批只升一个版本」「回执沉淀标记格式」「被直接改过时的处理」；写明摘要算法（正文、规范化换行、SHA-256 前 16 位）
- [ ] 5.2 `rules/rules.md` v1（spec「首版规则」全部条目，每条带判据、反例、正例、改法、来源；反例用合成句子）、`rules/history/v1.md`、`rules/CHANGELOG.md`
- [ ] 5.3 `output/delivery/README.md`：落点、版本链（`based_on` / `notes`）、每版写出后不再改动、front-matter 字段、原稿不动、改交付稿走批注
- [ ] 5.4 工作空间 `AGENTS.md` 补「交付前去 AI 味」；Markdown 约定表加 `output/delivery/` 一行；`scripts/check_markdown.py` 覆盖 `output/delivery/` 的 front-matter 必填检查
- [ ] 5.5 用合成原稿手动走一遍：去味出 v001 → 在 v001 上写三条批注（一条纯内容、两条可推广）→ 按提示词处理 → 出 v002、规则库升到 v2、回执带沉淀标记 → 再对另一份原稿去味，确认新规则生效

## 6. 服务端

- [ ] 6.1 `scan.mjs`：`output/delivery/**/v<序号>.md` 下发 `docKey`，不进产出列表 / 搜索 / 完整度；`docxTools.mjs` 的 `docKey` 反查纳入这一类
- [ ] 6.2 新建 `src/server/deai.mjs`：解析规则库（front-matter、规则标题与列表项、history 清单、CHANGELOG），解析失败的条目进 `warnings`；列交付稿版本（含 `basedOn` / `notes`）并算 `sourceChanged` / `directlyEdited`（摘要算法与技能说明一致）
- [ ] 6.3 `http.mjs` 路由：`GET deai/rules`、`GET deai/rules/versions/:n`（正整数校验）、`GET delivery?docKey=`；全部只读、过 `resolveInside()`
- [ ] 6.4 `notes.mjs`：`findRecordByTarget` 认出 `output/delivery/<三组之一>/…/v<序号>.md` 并按镜像路径映射到原稿（不读 front-matter）；追加批次时写 `- 对象：` 行；解析时读出对象，旧批次缺省为记录 `target`；`mergeNoteHistory` 按对象过滤出当前文件的批次；回执里的「沉淀为 R<编号>（规则库 v<版本>）」解析成结构化字段
- [ ] 6.4a 工作空间侧同步批注格式：`scripts/check_markdown.py` 的批注检查认「对象」行与回执沉淀标记，`rejected` 只带沉淀标记仍算缺原因；`pm-output-record` 技能说明补这两处格式
- [ ] 6.4b `docxTemplates.mjs`：列表补 `front.docx` 的存在与 mtime，详情补 `profile.json#front`
- [ ] 6.5 **重启 `pnpm dev`**，在 scratchpad 的合成工作空间里用 `curl` 验：规则库各字段、非法版本号 400、未安装 `installed:false`、交付稿三个判定、交付稿 `docKey` 能转换且成品落在交付稿旁、原稿目录无变化；对交付稿写批注落到原稿记录的批注文件且带「对象」行，镜像组名非法时退回缓存、工作空间无新文件

## 7. 契约：`src/app/lib/api.ts`

- [ ] 7.1 新增 `DeaiRules`、`DeaiRule`、`DeaiRuleVersion`、`DeliveryVersion` 类型；批注批次类型补可选 `target`，批注条目补可选 `deposits`（沉淀标记）；`DocxTemplateItem` / `DocxTemplateDetail` 补 `front` 相关可选字段；`DocxCollectReport` 补 `front`；`DocxDecisions` 补 `front`
- [ ] 7.2 `api` 加 `deaiRules`、`deaiRuleVersion`、`deliveryVersions`；404 统一识别为 `unsupported`

## 8. 前端：模版洗炼前置区

- [ ] 8.1 `templateRefine/RefineWizard.tsx` 第 ④ 步加「前置区」块：左侧 `DocxView` 预览来源原件，右侧分节、字段角色下拉、表格清空规则、「不要前置区」；「保持原样」的提醒
- [ ] 8.2 `templateRefine/plan.ts`：决定 JSON 带上 `front`；文字规定预览补「封面字段取值」
- [ ] 8.3 模板概要补「前置区」一行（有 / 无，字段数）；旧服务缺字段时不显示

## 9. 前端：去 AI 味

- [ ] 9.1 `pnpm add diff`（进 `dependencies`），记录版本与体积；新建 `components/DiffView.tsx`：动态 import，先按段再按字，长段折叠，超过 2000 行降级为按段；配色只用令牌
- [ ] 9.2 `lib/deaiPrompt.ts`：去味、体检、补齐技能三种提示词，以及交付稿批注提示词的附加段（下一版路径、同步沉淀要求、回执沉淀标记格式、自检）
- [ ] 9.3 `components/DeaiPane.tsx`：规则库（分组、展开详情、停用置灰）、版本与变更（CHANGELOG 小节、两版对比）、三张卡片（去味可选原稿、体检、「批注 → 修改 → 沉淀」说明卡列出有待处理批注的交付稿）；规则来源里的批注编号可跳转；`installed:false` 的说明页
- [ ] 9.4 `WorkbenchHub.tsx` / `Workbench.tsx`：第五张卡片「去 AI 味」，计数为「v<版本> · <启用条数> 条」，未安装显示「未安装」
- [ ] 9.5 `OutputPanel.tsx`：`.md` 条目「更多 → 去 AI 味…」复制提示词并 toast
- [ ] 9.6 `Reader.tsx`：产出原稿有交付稿时显示版本条（切换阅读、规则版本与命中、由哪些批注修订、原稿已更新 / 被直接改过 / N 条待处理标记、与原稿对比、与上一版对比、批注、转成 Word）；接口 404 或 `available === false` 时不显示
- [ ] 9.6a 批注：交付稿版本上可进入批注模式；批注清单与标记只显示对象是当前文件的批次；提示词组装在交付稿上拼接附加段；回执的沉淀标记显示成标签并跳到工作台规则详情
- [ ] 9.7 `DocxExportDialog.tsx`：来源可以是交付稿；成功 toast 下可展开 `log`；`warnings` 里有待填字段时用 orange 标「有 N 处待填」

## 10. 文档

- [ ] 10.1 `templates/pm-aispace/output/docx-template/README.md` 补 `front.docx`；README 的产出视图与工作台两节补前置区、交付稿版本条、去 AI 味模块
- [ ] 10.2 `docxkit/README.md` 注明参考了 docx-template-translator（Apache-2.0）的受保护区域思路（只借鉴思路，未复制代码）

## 11. 验收闸

- [ ] 11.1 `pnpm typecheck` 绿
- [ ] 11.2 `pnpm build` 绿，确认首屏包里没有 `diff` 与 `docx-preview`
- [ ] 11.3 `pnpm test:docx` 绿
- [ ] 11.4 **重启 `pnpm dev`**，在合成工作空间点一遍：重新提炼带前置区的模板 → 预览样张（封面、签署页、目录都在）→ 原稿转 Word → 去 AI 味复制提示词 → （手工放入合成交付稿 v001）→ 在 v001 上批注并复制提示词（检查落到原稿记录、带对象行）→（手工放入 v002 并回写回执带沉淀标记）→ 版本条切换、与原稿对比、与上一版对比、被直接改过标记、沉淀标签跳转、交付稿转 Word → 工作台去 AI 味模块三块都点一遍
- [ ] 11.5 三种情况各走一遍：没有 `project.yaml`（封面单位走占位并有 warning）、目录丢失（`available === false`）、深色模式（差异高亮、版本条、纸张预览）
- [ ] 11.6 旧服务配新前端：不重启服务只换前端，版本条不显示、去 AI 味卡片不显示计数、模版洗炼不显示前置区，页面不白屏
- [ ] 11.7 网络面板确认：去 AI 味模块、版本条、除批注落盘外，所有「复制提示词」都没有写请求；批注落盘只写 `notes/I<编号>.md`
- [ ] 11.8 用本地私有目录里的真实客户模板和那份实施方案复验一次（包括与外部技能成品对照结构），结论只记在本地，不进仓库和产物
