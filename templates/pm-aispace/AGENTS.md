# 产品经理AI空间 · Agent 工作约定

本文件是所有 AI Agent 在这个工作空间里的**唯一约定来源**；`CLAUDE.md` 只是入口。
本项目专有的约定在 `AGENTS.local.md`（有就一并读），见文末。

这是**产品经理 / 需求分析师接手一个既有项目**时用的工作空间。用户是 PM，不是工程师：
少用工程术语，多用需求、范围、干系人、验收这类 PM 语言；脚本和命令由你执行，不要让用户自己拼。

## 四个阶段，四个目录

```
input/  →  （分析）  →  output/  →  visualization/
资料      技能+上下文    文档产出    视觉呈现（参考 + 原型）
```

| 目录 | 职责 | 写入规则 |
| --- | --- | --- |
| `project.yaml` | 项目元信息：背景目标、干系人、里程碑、成果要求、约束 | 由 `pm-project-meta` 增量维护 |
| `input/raw/` | 人类给的原始资料 | 原件**内容不改、不删**，是溯源的终点。改名和移动目录只走看板「原始资料 → 重命名 / 移动到…」或 `scripts/move_raw.py`（先 `--dry-run`），**不要在文件夹里手改**，你也不要手改路径。**默认不读**（见「不要做的事」） |
| `input/assets/` | 图片：`<文档名>/` 是抽出的图，`未分类/` 是直接放进 raw/ 的单图 | 脚本生成。看图直接读图片文件 |
| `input/INDEX.md` | 资料台账（产物列链到 `../output/converted/…`） | 表格由脚本生成；人工判断写「人工批注」区 |
| `output/converted/` | 转换后的 `.md` / `.csv`，**目录结构镜像 `input/raw/`**；正文里的图片跨目录指回 `input/assets/`。不属于下面的产出三组（不建记录、不归档） | 脚本生成，**不要手改**（重跑会覆盖） |
| `output/analysis/` | 分析产物（现状基线、需求拆解） | 自由写 |
| `output/docs/` | 交付文档（PRD、需求规格、评审材料），含演示用 HTML | 自由写 |
| `output/decisions/` | 决策记录，一个决策一个文件 | 只追加，不改历史决策 |
| `output/<组>/一次归档/` | 不再作数、从主列表移开的产出物；看板照样能搜能预览 | 看板调 `scripts/archive_output.py` 移入，**只移动不删除**；二次归档走 `pm-output-archive`，**不写「无需再读」清单** |
| `output/questions/` | 未决问题，一问一文件 `Q<四位编号>.md`；不进文件列表，在看板 ⌘K 工作台「问题单」处理 | 走 `pm-open-questions`；字段见该目录 `README.md` |
| `output/records/` | 产出物记录，一份产出物一个 `I<四位编号>.md`；在工作台「记录单」处理 | 走 `pm-output-record`；字段见该目录 `README.md` |
| `output/feedback/` | 交给看板维护者的缺陷单与贡献单 `F<四位编号>.md`；在工作台「反馈单」看和发送 | 字段见该目录 `README.md`；见「看板显示不对时」「贡献改进」 |
| `output/delivery/` | 去 AI 味后的交付稿：镜像原稿路径，`v<三位序号>.md` 逐版保存；同目录还有原稿的 `<基名>.docx`、各版的 `v<序号>.docx`。`converted/` 子目录是 `output/converted/` 单文件转出的 Word。只从阅读器进入。同目录的 `定稿.md` 记「最后交出去的是哪份 Word」 | `v*.md` 只由 `pm-deai-writing` 写，**每版写出后不再改动**；`.docx` 只由 `scripts/md2docx.py` 写；`定稿.md` / `定稿.assets/` 只由看板「定稿」（`scripts/finalize_delivery.py`）写，**不要手改**；见「交付前去 AI 味」 |
| `output/docx-template/` | Word 模板，一个模板一个子目录；在工作台「模版洗炼」页看和提炼 | 只由 `scripts/docx_template.py` 写，见「Word 模板与转 Word」 |
| `visualization/references/` | 收下来的**别人的**页面：竞品、友商后台、公开文档站 | 一份一个目录，入口叫 `index.html`；保持原样 |
| `visualization/prototypes/` | 可预览原型库 | 一个东西一个子目录，入口叫 `index.html`，见「阶段四」 |

## 产物落点：`output/converted/` 镜像 `input/raw/`

转换产物**不平铺**，目录结构与 `input/raw/` 一一对齐 —— 删 `converted/某批/` 就删掉那批资料的全部产物。
规则实现在 [`scripts/layout.py`](scripts/layout.py)（各转换脚本共用）：

| 情形 | 落点 |
| --- | --- |
| **一源一产物**（docx / PDF / txt → 一个 `.md`） | 镜像目录下的同名文件 |
| **一源多产物**（xlsx 拆 sheet、html 原型包） | 正文进 `SplittingObject/<文件名>/`，摘要 `_manifest_<文件名>.md` 留在镜像目录 |
| **整目录合并成一份**（点表等几百个同构文件） | 正文进 `MergedObject/`，摘要 `_manifest_<目录名>批量处理.md` |

```
input/raw/站点数据/0_公共/7大库闸门底坎库容.xlsx
  → output/converted/站点数据/0_公共/_manifest_7大库闸门底坎库容.md          ← 看板预览点这个
  → output/converted/站点数据/0_公共/SplittingObject/7大库闸门底坎库容/Sheet1.csv
```

产物名尽量保留原文件名，只压掉路径分隔符这类会出事的字符。

**产物还在 `input/converted/` 的工作空间**（旧约定）用 `scripts/migrate_converted_to_output.py` 整体搬到
`output/converted/`：先 `--dry-run` 看计划，确认后执行；它改写产物里的相对链接和 `input/INDEX.md`，
**不碰** `output/analysis|docs|decisions`（那里写着 `input/converted/…` 的旧引用不用改，看板认）。
目标已有内容时它会拒绝，交给人判断；`--reverse` 可以搬回去。没迁移之前转换脚本会拒绝写产物。

**更早的工作空间**（产物平铺在 `input/converted/` 根下）先用 `scripts/migrate_converted.py` 在原地搬成镜像
（只搬不重转，顺带改写溯源引用，先 `--dry-run`），再走上面的迁移，然后重跑转换脚本、再跑一次它的 `--citations-only`。
认不出主人的产物原地保留并列出，交给人判断。

## 溯源是硬要求

PM 接手项目最大的风险是**把自己的推断当成项目事实**写进 PRD。所以：

- 陈述项目现状的每条结论都要能指回来源：`（来源：output/converted/需求规格.md，"3.2 计费规则"）`。
  迁移前写下的 `input/converted/…` 引用不用改，看板把它当成同一份。
- 你自己的推断显式标 `[推断]`，会议口述标 `[口述待确认]`。
- 资料里没有答案的不要猜，落成一条未决问题（走 [`skills/pm-open-questions`](skills/pm-open-questions/SKILL.md)）——
  **没有答案本身就是重要产出**。
- 查证后仍只能推断的，凭据写 `我方推断`，**不许标成「已解决」**。

## 项目元信息 project.yaml

`project.yaml` 是工作空间的身份证。**新建时几乎是空的**（合同、招标文件多是后补的），
等资料进了 `output/converted/` 再用 `pm-project-meta` 增量补全。三条规则：

- **`null` 有意义**：「该有但资料里还没有」。不要用「暂无」「待定」占位，也不要为了看着完整而填。
- **每个非 null 字段都要在 `provenance` 里有来源**（点号路径 → 文件和小节）。
- **推断和口述记在 `confidence` 里**（`推断` / `口述待确认`），资料写明的不记。

## 技能

技能实体在 `.claude/skills/`，根目录 `skills/` 是指向它的软链接（Windows 上可能是复制品，那时**改 `.claude/skills/`**）。

- **Claude Code** 自动发现并按 description 触发技能。
- **其他 Agent**（Codex、Cursor、Gemini CLI、Cline、Trae 等）按下表判断相关性，**主动读 `skills/<名字>/SKILL.md`** 再照做；
  正文引用的 `references/`、`assets/` 用到再读。

| 技能 | 用在什么时候 |
| --- | --- |
| [`skills/pm-doc-ingest`](skills/pm-doc-ingest/SKILL.md) | 阶段一：导入并转换资料（含网页），建台账 |
| [`skills/pm-project-meta`](skills/pm-project-meta/SKILL.md) | 阶段一之后：从合同 / 招标 / 立项文件补 `project.yaml` |
| [`skills/pm-project-handover`](skills/pm-project-handover/SKILL.md) | 阶段二：摸清项目现状，产出现状基线和澄清问题清单 |
| [`skills/pm-open-questions`](skills/pm-open-questions/SKILL.md) | 贯穿全程：未决问题的入口与出口——落问题、生成对齐会议清单、关闭、体检、迁移旧表格 |
| [`skills/pm-output-record`](skills/pm-output-record/SKILL.md) | 贯穿全程：建产出物时一并建记录、按 `kind` 选状态机、跟进 `target`、回写批注 |
| [`skills/pm-output-archive`](skills/pm-output-archive/SKILL.md) | 一次归档攒多了：分堆 + 每堆一份短索引；只移动不删除 |
| [`skills/pm-requirement-analysis`](skills/pm-requirement-analysis/SKILL.md) | 阶段二：需求拆解、优先级、验收标准、追溯矩阵 |
| [`skills/pm-field-data`](skills/pm-field-data/SKILL.md) | 现场真实运行数据进来时：归一、核验数据可用性 |
| [`skills/pm-list-diff`](skills/pm-list-diff/SKILL.md) | 两份清单交叉比对，产出对外可回填的核对件 |
| [`skills/pm-prd-writing`](skills/pm-prd-writing/SKILL.md) | 阶段三：写 PRD / 需求规格说明书 |
| [`skills/pm-prototype-brief`](skills/pm-prototype-brief/SKILL.md) | 阶段四：把文档收敛成原型输入，衔接 Axhub Make |
| [`skills/pm-deai-writing`](skills/pm-deai-writing/SKILL.md) | 交付前：去 AI 味出交付稿、按批注改下一版并沉淀规则、规则库体检 |
| [`skills/pm-env-config`](skills/pm-env-config/SKILL.md) | 用户给了数据库连接、API Key 时：写 `.env`、配 `input/sources/*.yaml`、验证连通 |
| [`skills/pm-template-update`](skills/pm-template-update/SKILL.md) | 更新模板，或发现缺模板后来加的技能 / 脚本 |
| [`skills/skill-creator`](skills/skill-creator/SKILL.md) | 发现重复套路时，固化成新技能 |

**同一套动作重复到第三遍，主动提议用 `skill-creator` 做成技能**，写到 `skills/`，不要写到用户全局目录。
（它的自动评测依赖子 Agent 和 `claude -p`，其他 Agent 可以手写技能、跳过评测。）

## 阶段一：资料转换

```bash
python3 scripts/ingest.py --dry-run                  # 先看全部原件的计划，不写文件
python3 scripts/ingest.py input/raw/某目录            # 转这个目录（幂等，只转有变化的）
python3 scripts/ingest.py input/raw/某目录/说明.docx  # 只转这一份
python3 scripts/ingest.py input/raw                   # 要转整个 input/raw/ 时必须把路径写出来
python3 scripts/ingest.py --force input/raw/某目录    # 这个目录全部重转
```

不带路径、又不是 `--dry-run` 时脚本直接退出，什么都不写。看板里一次只转用户点的那一份或那一个目录。
旧工作空间里留下的 `input/.ingestignore` 不再生效：脚本和看板都不读它。更新模板时不要删、不要改。

格式分派、PDF / PPTX 引擎、MinerU 配置见 [`input/README.md`](input/README.md)。要记住的只有：

- **默认不外发文件**。只有 `--pdf-engine mineru` 或扫描件自动升级 OCR 才会把资料传给 MinerU。
- 产物 frontmatter 带 `warning` 的几乎是空的（OCR 也没识别出来），要提醒用户这份资料实际不可用。
- `.wps` / `.et` / `.dps` 始终不支持，请用户另存为。

### 其它资料管线

| 资料 | 入口 | 细节在哪 |
| --- | --- | --- |
| 成百上千个同构点表（测点清单） | `scripts/pointtable.py` → `MergedObject/测点.sqlite` | [`input/README.md`](input/README.md)「点表批量归一」 |
| 现场实测数据导出（几十万行时序 / 日指标 / 预报） | `scripts/realdata.py` → `SplittingObject/<文件名>/*.sqlite` | [`skills/pm-field-data`](skills/pm-field-data/SKILL.md) |
| 业务系统数据库（按需查询的远端资料源） | `scripts/db_ingest.py list / schema / query` | [`input/sources/README.md`](input/sources/README.md)、[`skills/pm-env-config`](skills/pm-env-config/SKILL.md) |
| 网页（政策、标准、文档站） | `scripts/web_ingest.py <URL>` / `--inbox` | [`skills/pm-doc-ingest`](skills/pm-doc-ingest/SKILL.md)「网页资料」 |

几条跨管线的硬规则：

- **大数据只走 SQL**：点表、现场数据、查询结果都不整表读进上下文，看全局读 `_manifest_*.md`，查数只取回几十行。
- 现场数据导出**放进子目录**（如 `input/raw/现场数据/`），根下的 csv 归 `ingest.py`。台账里的采样间隔、完整率是
  **统计口径，不是现场承诺**；状态码含义资料里通常没写，原样保留、写进待确认清单。
- 数据库是**远端资料源，只按需取、取到的落成文件**：默认只把 L1 schema 快照放进上下文。脚本会先把会话置为只读，
  **不要试图绕过**；口令只进 `.env`，不写进 yaml。
- 脚本只做格式归一，不做业务推断（设备树绑定、单位换算、剔异常值都不做）；启发式推断出的字段写进文档前标 `[推断]`。
- 新加脚本时：**默认路径必须零依赖**（只用标准库 + 外部 CLI），可选路径可以有运行到才 import 的可选依赖。

## 演示与汇报材料（HTML）

有 `.md` 源文、HTML 只是它的渲染产物（PRD、评审材料）→ 放 `output/docs/`，**与 md 并排同名**，
如 `2026-08-18-需求评审材料.md` + `.html`。md 是内容源，改内容两份一起改。
写成**完整的自包含单文件**（内联 CSS、不引外部字体和脚本）。看板会标「可演示」，可全屏演示。

**没有 md 源、页面本身就是产物**（原型、可视化、方案页）→ `visualization/prototypes/<名字>/index.html`，见「阶段四」。

## Word 模板与转 Word

客户要求交付物用他们的 Word 格式时用这两支脚本（公共代码 `scripts/docxkit/`，只用标准库）：

| 脚本 | 做什么 | 写到哪 |
| --- | --- | --- |
| `scripts/docx_template.py` | 从客户旧 Word 提炼模板：`collect` 采集，`build` 按决定生成 | 只写 `output/docx-template/<模板名>/` |
| `scripts/md2docx.py` | 按模板把 `.md` 转成 `.docx`（需 pandoc 3） | 产出原稿写 `output/delivery/<组>/<子路径>/<基名>.docx`；交付稿写同目录 `v<序号>.docx`；`output/converted/` 单文件写 `output/delivery/converted/<子路径>/<基名>.docx`（不写进 `output/converted/`）；其它位置仍写旁边。`--archive` 时把落点上的上一份改名为 `<基名>-<上次转换时间>.docx` |

看板「模版洗炼」「转成 Word」跑的是同一份脚本；用户粘来提示词就照做。
操作步骤见 [`output/docx-template/README.md`](output/docx-template/README.md)「给 AI 的步骤」。必守的几条：

- **要交付的文档先去 AI 味，转交付稿**，不转原稿。
- 表题默认在表格上方。客户要求表题在下方时，md 的 front-matter 写 `table_caption: below`（或命令行 `--table-caption below`），需要 pandoc 3.5 以上。写成「表 2-1」时章号留作文字，章内序号换成自动编号，每章从 1 起编。
- 同名 `.docx` 没有生成标记时脚本会拒绝 —— **不要删它、不要改名绕过**，问用户；有标记的用 `--archive` 重转（上一份改名保留），不要用 `--overwrite`，除非用户明说不要上一份。
- 提炼的映射方案**先列给用户确认**再生成；模板名已存在要 `--regenerate`，先问用户。
- 模板目录里是客户的版式材料，不要贴进反馈单或任何公开的地方。

旧工作空间没有这两支脚本时，走 [`skills/pm-template-update`](skills/pm-template-update/SKILL.md)，不要手工复制。

## 交付前去 AI 味

**要发给客户的文档，先去味、出交付稿**，再转 Word。做法全在 [`skills/pm-deai-writing`](skills/pm-deai-writing/SKILL.md)：

- **去味**：按规则库（`.claude/skills/pm-deai-writing/rules/rules.md`，带版本）改写成
  `output/delivery/<原稿路径去掉 .md>/v<序号>.md`。**原稿一个字节都不动**，事实、数字不变。
- **改交付稿走批注**：人在看板对某一版写批注、复制提示词给你；你改出**下一版**（不改那一版本身），
  同一轮把能推广的写法偏好沉淀进规则库，回执里写「沉淀为 R0xx（规则库 vN）」。
- **体检**：查重复、冲突、长期零命中，只给建议。
- **定稿**：交出去的 Word 由人在看板「定稿」，记在镜像目录的 `定稿.md`（front-matter 有每次定稿的记录）。
  接着改一份已定稿的文档前先读它，看交出去的是哪一版、和最新交付稿差在哪；**不要手改它**。见 `output/delivery/README.md`「定稿」。

旧工作空间没有这个技能：走 `pm-template-update` 更新模板。

## 阶段四：视觉呈现

`visualization/` 装的是**页面**（`input/` `output/` 装的是文档），看板分两个 tab 展示。

- **`references/`**：收下来的别人的页面，一份一个目录、入口 `index.html`，可带 `meta.json` 与 `screenshots/`。**保持原样**。
- **`prototypes/`**：可点击原型。可以是 [Axhub Make](https://github.com/lintendo/Axhub-Make) 构建的客户端、
  根上有 `index.html` 的 `<名字>.zip`、你写的单页 `<名字>/index.html`，或云端发布的原型
  （`<名字>/meta.json`：`{ "kind": "url", "title": "…", "target": "https://…" }`，可选 `cover.png`）。

**硬规则：**

- **一个东西一个子目录，入口必须叫 `index.html`。** 散装 `方案.html` 扔在根上**扫不到**。
- **只认已构建好的产物**。源码导出包看板不会装依赖、跑构建 —— 用工具的「导出 HTML」或云端链接。
- **`<title>` 就是看板里显示的名字**，别留空、别叫「Document」。
- **自包含**：内联 CSS、不引外部字体和脚本。

Axhub Make 服务端在本项目之外常驻，**不要在这里跑 `npx @axhub/make`，也不要动它生成的目录**。
你的职责是**准备输入**：用 `pm-prototype-brief` 产出 `output/analysis/原型输入说明.md` 交给用户；
原型评审结论要回流到 `output/`。

## 文件命名

- 中文名直接用，不转拼音。
- 分析产物加日期前缀：`2026-07-30-计费模块需求拆解.md`。
- 决策记录：`output/decisions/0001-短标题.md`，四位序号递增。
- **产出改名走看板「重命名」，不要在文件夹里手改**（产出文档列表行「更多 → 重命名」，终端里是 `scripts/rename_output.py`，先 `--dry-run`）。
  手改会让交付稿、定稿、记录、批注全部对不上；脚本把镜像目录和所有引用一起改，并在记录状态流水里留痕。

## Markdown 写法

工作空间里的 Markdown 写法**只写在这一节**，各技能只引用这里。
可执行版本是 [`scripts/check_markdown.py`](scripts/check_markdown.py)（只读、只报告）和
[`scripts/migrate_markdown.py`](scripts/migrate_markdown.py)（默认预演，`--write` 才落盘）。**契约变了那两个脚本要跟着变。**

### 适用范围

| 目录 | 本节约束吗 | 原因 |
| --- | --- | --- |
| `output/analysis/`、`output/decisions/` | **管** | 人或 agent 手写的分析 / 决策 |
| `output/docs/` | 语法管、front-matter **不强制** | 要发出去的文档；写了的话必须扁平 |
| `output/questions/` | 语法管；字段以该目录 README 为准 | 未决问题有自己的字段契约 |
| `output/records/` | 语法管；字段以该目录 README 为准 | 含按 `kind` 分化的三套状态机 |
| `output/records/notes/` | 语法管；格式以 `output/records/README.md`「批注」为准 | 看板整条追加，agent 只改 `- 状态：` 与 `- 回执：` |
| `output/feedback/` | 语法管；字段以该目录 README 为准 | 智能体写内容和回执，不改 `sent_at` 与发送记录 |
| `output/delivery/` | **管**；front-matter **必填且扁平**，字段以该目录 README 为准 | 看板靠 `source_sha` / `body_sha` 判断原稿是否更新、是否被直接改过 |
| `output/docx-template/` | `spec.md` 语法管、front-matter 不强制 | 其余是 json / docx |
| 各目录下的 `README.md` | 语法管、front-matter **不强制** | 目录说明 |
| `output/converted/` | **不管**（`check_markdown.py` 跳过它） | 脚本生成；要改形态就改脚本 |
| `input/raw/` | **不碰** | 原件内容不改不删；改名和移动只走看板或 `scripts/move_raw.py`，不要在文件夹里手改 |

### 现在可用

- **扁平 YAML front-matter**：只允许 `key: value` 与 `key:` + `  - item` 两种形态。
  看板解析器（[`src/server/frontmatter.mjs`](https://github.com/STArtppt/aispace-kanban/blob/main/src/server/frontmatter.mjs)）
  只认这两种；内联数组 `tags: [a, b]` 会被整体当成一个字符串。
- **唯一 H1，正文从 H2 起**（或标题写在 front-matter 的 `title`、正文从 H2 起）。两个 H1 会搅乱文档目录。
- **文档间链接**：相对路径 `[文本](../analysis/xxx.md)`，或 wikilink `[[../analysis/xxx|文本]]`、`[[output/docs/xxx]]`、`[[xxx|文本]]`。
  `./` `../` 相对当前文件；带 `/` 的从工作空间根算；**没有 `/` 的只认同一目录**。
- **嵌入**：`![[./图.png]]` 放图片。
- **Callout**：`> [!note] 标题`，下一行写正文。`warning` / `caution` / `attention` / `failure` / `danger` / `error` /
  `bug` / `important` 用「需要注意」样式，其余灰底。`[!note]-` 默认折叠，`[!note]+` 默认展开。
- **行首标签** `#待确认`（`#` 后紧跟非空格）；**注释** `%%不给读者看%%`；**段尾块锚点** `^id`（阅读时不显示，还不能跳转）。
- **数学**：行内 `$v=s/t$`，独行 `$$...$$`。同一行两个美元金额会被当成公式，改写成「100 元」或放进代码跨度。
- GFM 表格、围栏代码块（含 mermaid）。

`output/analysis/` 与 `output/decisions/` 的 front-matter 最小形态：

```markdown
---
title: 文档标题
created: 2026-07-30
updated: 2026-07-30
---
```

缺字段时 `migrate_markdown.py` 按文件名 / 首个 H1 / 文件日期补齐，不改正文措辞、不调标题层级。

### 不要依赖这些

| 写法 | 看板实际会怎样 |
| --- | --- |
| 裸文件名 `[[同名笔记]]`，指望全库唯一命中 | 只认**同一目录**，不跨目录消歧 |
| `![[某文档]]` 指望把正文嵌进来 | 只显示一条链接 |
| `[[文件#某节]]` 指望滚到那一节 | 会打开文件，不会滚动 |

校验闸的作用是**让违约可见**，不是阻止违约。这两个脚本是工作空间自己的工具，看板不调用。

## 看板显示不对时

看板是另一个仓库的程序，**对你只读**：可以读源码弄清它期望什么，**不能改它** ——
为一份文档改渲染器，多半会弄坏别的写法，而且改动没人审。

**去哪查**：缺省读 GitHub 上的源码 <https://github.com/STArtppt/aispace-kanban>
（原文 `https://raw.githubusercontent.com/STArtppt/aispace-kanban/main/<路径>`），**不要翻本机的看板仓库或 npm 包目录**。

| 想查什么 | 路径 |
| --- | --- |
| 资料台账（输入资料 → 原始资料顶部）怎么显示 `project.yaml` | `src/app/components/MetaView.tsx`、`src/server/meta.mjs` |
| front-matter 解析 | `src/server/frontmatter.mjs` |
| Markdown 渲染 | `src/app/components/Markdown.tsx`、`src/app/lib/markdownSyntax.ts` |
| 文档内链接与图片地址 | `src/app/lib/markdownUrls.ts` |
| mermaid 图 | `src/app/components/MermaidBlock.tsx`、`src/app/lib/mermaid.ts` |

GitHub 的 `main` 可能与用户本机版本有出入，对不上时如实说明。
**本机条件**成立时（看板配置目录 `runtime.json` 的 `launch` 为 `source`，且 `instances` 含本工作空间），
可以只读正在跑的那份源码核对行为，不改其中任何文件。

**怎么处理：**

1. **先改自己这边**：多数问题是写法没对上约定（Markdown 写法、`project.yaml` 的「形如」注释）。
2. **确认是看板缺陷**：工作空间里的文件先改到能正确显示（临时绕法），再写一份**缺陷单**。
3. 回复用户：反馈单在哪、用了什么绕法、看板那边大致要改什么。

**反馈单** `output/feedback/F<四位编号>.md`，一个问题一份，目录不存在就建。缺陷单 `kind: bug`（不写也按缺陷单）。
字段、分组、发送记录、旧目录 `.kanban-feedback/` 的迁法都以 [`output/feedback/README.md`](output/feedback/README.md) 为准。

- **最小复现必须是合成的**，不贴真实资料、客户名称、截图、本机路径 —— 这份单子可能进公开仓库。
- `status` 只用 `pending` / `fixed` / `wontfix`；新建时 `sent_at` 留空；六个内容节和「## 发送记录」标题都要有。
- 回执转来时**只改 `status` 和 `receipt`**；`sent_at` 与「## 发送记录」由看板写。已修复的撤掉临时绕法。

## 不要做的事

- **不要主动读 `input/raw/`**（除非用户明确说「打开原件」「对照原始 PDF」）。一律优先 `output/converted/` 和 `input/INDEX.md`。
- 不要修改或删除 `input/raw/` 里的任何文件，也不要在那里手动改名、挪目录（台账和产物会对不上；整理走看板或 `scripts/move_raw.py`）；不要手改 `output/converted/` 的产物或在里面手建目录。
  想基于某份转换产物继续写，用看板「产出文档 → 转换产物 → 更多 → 复制到…」（终端里是 `scripts/copy_converted.py`，先 `--dry-run`），
  复制件落进 `output/<组>/` 同样的子目录、图片链接不断；不要直接改 converted 里那份，也不要移走它（下次转换会再生成一份）。
- **不要把大表整个读进上下文**（现场数据 csv / sqlite 事实表、`测点主表.csv`），走 SQL。
- 不要把散装 `.html` 扔在 `visualization/prototypes/` 或 `references/` 根上，不要动 Axhub Make 生成的目录。
- 不要把 `.env` 或其中的 key 写进任何会入库的文件、日志或文档。
- 不要用推断填平资料空白，标注出来交给用户确认。
- **不要改本机的看板仓库或 npm 包目录，`templates/` 也不例外**；缺省也不读它们（例外见「看板显示不对时」）。
  看板有缺陷写缺陷单，有可推广的改进写贡献单，要更新模板走 `pm-template-update`。
- 不要把只对本项目成立的约定写进本文件，写进 `AGENTS.local.md`。
- 不要把客户的 docx 原件或模板材料放进反馈单或公开说明。

## 模板更新

本工作空间由看板仓库的 `templates/pm-aispace` 铺出来，模板的后续改进不会自己过来。
用户说「更新一下模板」时走 [`skills/pm-template-update`](skills/pm-template-update/SKILL.md)：
不带参数跑 `scripts/template_update.py plan` 出计划，讲给用户，**确认后**再落盘。
不要自己搜索本机看板仓库来拼 `--from`。本地改过的不覆盖，两边都改过的逐个合并，资料和产出一概不碰。
基线在 `.aispace/template.lock.json`（入库，别手改）。

## 本项目专有的约定：`AGENTS.local.md`

只对本项目成立的约定（原型工程在哪、客户术语、某个现场系统的特殊字段）写在 `AGENTS.local.md`，**不要写进本文件** ——
本文件由模板管理，更新时整份替换；`AGENTS.local.md` 不随模板分发，更新不碰它。
开始工作前有它就一并读（Claude Code 经 `CLAUDE.md` 自动引入）。两者冲突时以本文件为准。

## 贡献改进

沉淀出**换一个项目也成立**的改进（去 AI 味规则、技能里对谁都适用的补充、模板脚本缺陷修复），
写一份**贡献单**交回模板源：`output/feedback/` 下 `kind: contribution` 的反馈单，形状见该目录 README。

- 判据：**换一个项目这条还成立吗？** 不成立的写进 `AGENTS.local.md`。
- 合成示例和改动内容**必须合成或脱敏**。
- 本地改动照常保留。写完告诉用户贡献单路径：npm 安装的看板在反馈单页预览后发出；源码启动的不必发邮件，那边直接读。
- 回执回来只改 `status` 和 `receipt`；规则类另在本地规则里补 `上游：模板 R<编号>`（见 `pm-deai-writing`「规则库怎么改」）。

新建工作空间时写进 `.claude/settings.local.json` 的 `deny` 规则会拦住 Claude Code 对看板仓库的写入。
