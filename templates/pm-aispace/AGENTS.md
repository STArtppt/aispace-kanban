# 产品经理AI空间 · Agent 工作约定

本文件是所有 AI Agent 在这个工作空间里的**唯一约定来源**。
`CLAUDE.md` 只是指向本文件的入口，不要把约定重复写在那边。

这是**产品经理 / 需求分析师接手一个既有项目**时使用的工作空间。用户是 PM，不是工程师：
沟通时少用工程术语，多用需求、范围、干系人、验收这类 PM 语言；需要用到脚本或命令时，
你负责执行，不要让用户自己拼命令。

## 四个阶段，四个目录

工作是单向流水线，每一阶段的产物是下一阶段的输入：

```
input/  →  （分析）  →  output/  →  visualization/
资料      技能+上下文    文档产出    视觉呈现（参考 + 原型）
```

| 目录 | 职责 | 写入规则 |
| --- | --- | --- |
| `project.yaml` | 项目元信息：背景目标、干系人、里程碑、成果要求、约束 | 由 `pm-project-meta` 增量维护，见下文 |
| `input/raw/` | 人类给的原始资料（docx / PDF / xlsx / pptx） | **只读**。永不改动、永不删除，它是溯源的终点。**默认禁止读取**（见下文） |
| `input/converted/` | 转换后的 `.md` / `.csv`；**目录结构镜像 `input/raw/`**，见下文 | 由 `scripts/ingest.py` / `pointtable.py` / `realdata.py` / `web_ingest.py` 生成，**不要手改**（重跑会覆盖） |
| `input/assets/` | 图片资料：`<文档名>/` 是那份文档抽出的图，`未分类/` 是直接放进 raw/ 的单图 | 脚本生成。看图请直接读图片文件 |
| `input/INDEX.md` | 资料台账 | 表格由脚本生成；人工判断写在「人工批注」区 |
| `output/analysis/` | 分析中间产物（现状基线、需求拆解） | 自由写 |
| `output/docs/` | 对外交付文档（PRD、需求规格、评审材料）；**演示/汇报用的 HTML 也放这里** | 自由写，见下文 |
| `output/decisions/` | 决策记录：一个决策一个文件 | 只追加，不要改历史决策 |
| `output/<组>/一次归档/` | 三组各自的归档区：不再作数、从主列表移开的产出物；看板照样能搜、能预览 | 一次归档由看板调 `scripts/archive_output.py` 移入，**只移动不删除**；二次归档（分堆 + 短索引）走 `pm-output-archive`，**不写任何「无需再读」清单** |
| `output/questions/` | 未决问题，**一问一文件** `Q<四位编号>.md`；**和 `analysis/` 平级，不进任何视图的文件列表**，只在看板 ⌘K 弹窗里看和处理 | 走 `pm-open-questions`；字段契约见该目录的 `README.md` |
| `output/records/` | 产出物记录，**一份产出物一个** `I<四位编号>.md`；和 `analysis/` 平级，**不进任何视图的文件列表**，只在看板 ⌘K 工作台的「产出物」页里看和处理 | 走 `pm-output-record`；字段契约见该目录的 `README.md` |
| `visualization/references/` | 收下来的**别人的**页面：竞品、友商后台、公开文档站 | **一份参考一个目录，入口必须叫 `index.html`**；这是收来的原样材料，不要改它的内容 |
| `visualization/prototypes/` | 可预览原型库：Axhub Make 客户端、zip 导出包、自己写的单页 HTML | **一个东西一个子目录，入口必须叫 `index.html`**，见下文 |

## 产物落点：`input/converted/` 镜像 `input/raw/`

转换产物**不平铺**。`input/converted/` 的目录结构与 `input/raw/` 一一对齐，
这样资料上千份以后还能按批次删除——删 `converted/站点数据/0_公共/` 就等于删掉那批资料的
全部产物，不留残渣；看板的树形视图也直接按这个结构展示。

三条规则（实现在 [`scripts/layout.py`](scripts/layout.py)，三个转换脚本共用一份——
忽略清单的解析也在这个模块里）：

| 情形 | 落点 |
| --- | --- |
| **一源一产物**（docx / PDF / txt → 一个 `.md`） | 镜像目录下的同名文件 |
| **一源多产物**（xlsx 拆 sheet、html 原型包） | 正文进 `SplittingObject/<文件名>/`，摘要 `_manifest_<文件名>.md` 留在镜像目录 |
| **整目录合并成一份**（点表、几百个同构文件汇总成一个库） | 正文进 `MergedObject/`，摘要 `_manifest_<目录名>批量处理.md` |

```
input/raw/站点数据/0_公共/六大库汛限（正常高）水位.docx
  → input/converted/站点数据/0_公共/六大库汛限(正常高)水位.md

input/raw/站点数据/0_公共/7大库闸门底坎库容.xlsx
  → input/converted/站点数据/0_公共/_manifest_7大库闸门底坎库容.md          ← 看板预览点这个
  → input/converted/站点数据/0_公共/SplittingObject/7大库闸门底坎库容/Sheet1.csv

input/raw/集控点表/（11 个厂站目录，572 个点表）
  → input/converted/集控点表/_manifest_集控点表批量处理.md
  → input/converted/集控点表/MergedObject/测点.sqlite
input/raw/集控点表/南瑞-水调系统测点.xlsx                                  ← 同目录的普通表格
  → input/converted/集控点表/_manifest_南瑞-水调系统测点.md                    照样走上面的规则
  → input/converted/集控点表/SplittingObject/南瑞-水调系统测点/*.csv
```

**产物名尽量保留原文件名**（下划线、括号、中文标点都留着），只压掉路径分隔符这类会出事的
字符——镜像目录要能一眼对回 `input/raw/` 里的那份原件。

**旧工作空间搬迁**：以前的产物平铺在 `input/converted/` 根下，
`scripts/migrate_converted.py` 负责搬过来。它只搬不重转——MinerU 转过的 PDF 不会再花在线额度，
目录型产物（xlsx 拆表、点表、现场数据）删掉由脚本本地重建。
顺带把 `output/` 里指向旧产物路径的**溯源引用**一并改写：搬完产物却留一堆指不到东西的来源，
等于把已经建立的追溯链断掉。

```bash
python3 scripts/migrate_converted.py --dry-run     # 先看计划（强烈建议）
python3 scripts/migrate_converted.py               # 执行
python3 scripts/ingest.py && python3 scripts/pointtable.py && python3 scripts/realdata.py
python3 scripts/migrate_converted.py --citations-only   # 重建完再跑一次，补上带具体文件名的引用
```

认不出主人的产物（原件已删、或旧版遗留）原地保留并单独列出，交给人判断是删是留。

## 溯源是硬要求

PM 接手项目最大的风险是**把自己的推断当成项目事实**，然后写进 PRD，最后在评审会上被打回。
所以：

- 陈述项目现状的每一条结论，都要能指回来源：`（来源：input/converted/需求规格.md，"3.2 计费规则"）`。
- 你自己的推断必须显式标注 `[推断]`，来自会议口述的标 `[口述待确认]`。
- 资料里没有答案的，不要猜着填。落成一条未决问题
  （`output/questions/` 下一问一文件，走 [`skills/pm-open-questions`](skills/pm-open-questions/SKILL.md)），
  作为要向对方团队确认的问题清单——**没有答案本身就是重要产出**。
- 查证之后仍然只能推断的，凭据写 `我方推断`，**这种条目不许标成「已解决」**。
  把推断和实证混在一栏里、长得一模一样，是「未知被伪装成确定事实」最常见的入口。

## 项目元信息 project.yaml

根目录的 `project.yaml` 是这个工作空间的身份证：项目背景与目标、甲方与承建方、干系人、
里程碑、成果要求、技术与合规约束、验收方式。

**新建工作空间时它几乎是空的**——只有名称和创建日期。这是设计如此：
合同、招标技术文件、立项报告这些定义项目的资料，多数时候是后补进来的。
等它们进了 `input/converted/`，用 `pm-project-meta` 提取，增量补全。

三条规则：

- **`null` 是有意义的值**，表示「该有但资料里还没有」。不要用「暂无」「待定」这类字符串占位，
  也不要因为看起来不完整就填点什么进去。
- **每个非 null 字段都要在 `provenance` 里有来源**（点号路径 → 文件和小节）。
- **推断和口述记在 `confidence` 里**（`推断` / `口述待确认`），资料写明的不记。

新建工作空间：在 aispace-kanban 看板里点「新建」，选「产品经理AI空间模板」。命令行也可以：

```bash
python3 /path/to/aispace-kanban/templates/init_workspace.py \
  --from /path/to/aispace-kanban/templates/pm-aispace \
  --name "项目名" --path <目录>
```

## 技能

技能实体在 `.claude/skills/`，根目录 `skills/` 是指向它的软链接，两个路径等价。
（Windows 上没开开发者模式建不了软链接，`skills/` 会是一份复制品 —— 那种情况下**改技能改
`.claude/skills/`**，另一边不会跟着变。）

**不同 Agent 的加载方式不一样：**

- **Claude Code** 会自动发现 `.claude/skills/` 下的技能，按 description 自动触发，你不用手动读。
- **其他 Agent**（Codex、Cursor、Gemini CLI、Cline、Trae 等）没有自动发现机制。
  按下表判断相关性，然后**主动读 `skills/<名字>/SKILL.md`** 再照它执行。
  技能正文里引用的 `references/`、`assets/` 是按需加载的，用到了再读。

| 技能 | 用在什么时候 |
| --- | --- |
| [`skills/pm-doc-ingest`](skills/pm-doc-ingest/SKILL.md) | 阶段一：导入并转换资料，建台账 |
| [`skills/pm-project-meta`](skills/pm-project-meta/SKILL.md) | 阶段一之后：从合同 / 招标 / 立项文件提取元信息，补 `project.yaml` |
| [`skills/pm-project-handover`](skills/pm-project-handover/SKILL.md) | 阶段二：摸清项目现状，产出现状基线和澄清问题清单 |
| [`skills/pm-open-questions`](skills/pm-open-questions/SKILL.md) | 贯穿全程：未决问题的入口与出口——落新问题、按交付物生成对齐会议清单、关闭归档、体检、迁移旧表格 |
| [`skills/pm-output-record`](skills/pm-output-record/SKILL.md) | 贯穿全程：产出物记录的建立与维护——建产出物时一并建记录、按 `kind` 选状态机、产出物改名或归档时跟进 `target`、给存量决策补记录 |
| [`skills/pm-output-archive`](skills/pm-output-archive/SKILL.md) | 一次归档攒多了之后：把 `output/<组>/一次归档/` 按主题分堆、每堆写一份短索引；只移动不删除，不产出「无需再读」清单 |
| [`skills/pm-requirement-analysis`](skills/pm-requirement-analysis/SKILL.md) | 阶段二：需求拆解、优先级、验收标准、追溯矩阵 |
| [`skills/pm-field-data`](skills/pm-field-data/SKILL.md) | 阶段二之外：现场真实运行数据进来时，核验数据可用性、拿场景可行性的证据 |
| [`skills/pm-list-diff`](skills/pm-list-diff/SKILL.md) | 阶段二之外：两份清单（甲方给的 vs 我方已接入的）交叉比对，产出对外可回填核对件 |
| [`skills/pm-prd-writing`](skills/pm-prd-writing/SKILL.md) | 阶段三：写 PRD / 需求规格说明书 |
| [`skills/pm-prototype-brief`](skills/pm-prototype-brief/SKILL.md) | 阶段四：把文档收敛成原型输入，衔接 Axhub Make |
| [`skills/pm-env-config`](skills/pm-env-config/SKILL.md) | 用户给了数据库连接、API Key 等环境参数时：写 `.env`、配 `input/sources/*.yaml`、验证能连上 |
| [`skills/skill-creator`](skills/skill-creator/SKILL.md) | 工作中发现重复套路时，把它固化成新技能 |

**发现自己在重复第三遍同一套动作时，主动提议用 `skill-creator` 把它做成技能。**
这个工作空间的价值就在于越用越顺手——新技能写到 `skills/`（等同 `.claude/skills/`），
不要写到用户全局目录，否则换台机器或换个 Agent 就丢了。

`skill-creator` 的评测流程依赖子 Agent 和 `claude -p`，在 Claude Code 里最完整；
其他 Agent 可以照 SKILL.md 手写技能，跳过自动评测部分。

## 阶段一：资料转换

```bash
python3 scripts/ingest.py                      # 转换 input/raw/ 下的新资料（幂等，只转有变化的）
python3 scripts/ingest.py --dry-run            # 先看转换计划
python3 scripts/ingest.py --force              # 全部重转
python3 scripts/ingest.py input/raw/某目录      # 只转指定目录或文件（台账会合并，不冲掉其他条目）
python3 scripts/ingest.py --ocr                # 扫描版 PDF，让 MinerU 走 OCR
python3 scripts/ingest.py --pdf-engine mineru  # 要抽图、要公式、版式复杂时走在线
python3 scripts/ingest.py --pdf-engine anydoc  # 强制本地，不外发文件
```

### 忽略清单 `input/.ingestignore`

客户常常一次性交来上千份存量资料，只有一部分需要进分析链路。剩下的既不该转，
也不该在看板上一直报「待转换」把真正的缺口淹掉——写进 `input/.ingestignore`：

```
raw/客户版          # 目录：连同其下所有文件一起忽略
*.bak               # 通配：按文件名匹配，不必带路径
```

gitignore 风格，路径相对 `input/` 写。**`scripts/layout.py`（三个转换脚本共用）和看板
[`src/server/scan.mjs`](https://github.com/STArtppt/aispace-kanban/blob/main/src/server/scan.mjs) 读的是同一份**，改一次全都生效。两边的匹配规则必须一致：要改 `layout.py` 的匹配规则，
看板那一侧你不能改，写反馈单（见「看板显示不对时」）。

`pointtable.py` 的自动发现尤其依赖它：探测点表要逐个读文件头，上千份存量资料全扫一遍要
好几分钟；整个目录被忽略时直接跳过，不走进去。

被忽略的资料**仍留在看板「原始资料」总量里并标注份数**，台账底部也会汇总一行。
这是有意的：它们是「看过、判定用不上」，不是「不存在」——藏干净了下次就没人记得
`input/raw/` 底下还压着几百份没看的东西。

看板上待转换列表「更多 → 忽略此文件 / 忽略此目录」会往这份文件追加一行，效果相同。

`ingest.py` 和 `pointtable.py` 都认这两个开关，语义一致（显式指定目录时忽略清单同样生效）：

```bash
python3 scripts/ingest.py --ignore "raw/某目录"      # 临时追加忽略，不写进文件
python3 scripts/ingest.py --no-ignore               # 本次不应用忽略清单，全部转
python3 scripts/pointtable.py --no-ignore           # 点表脚本同理
```

格式分派：docx/odt/rtf/epub 走本地 anydoc（顺带抽图），**PDF 默认也走本地 anydoc（不联网）**，
扫描件自动升级 MinerU OCR；PPTX 维持 MinerU（抽图），没配 key 时兜底 anydoc；
xlsx/xlsm/xls 按 sheet 拆成 CSV；**html/htm 作为 PM 互传的单文件可点击原型**——不转成
Markdown 正文，而是拷到镜像目录的 `SplittingObject/<名>/` 保留可预览 HTML，并生成配套
`_manifest_<名>.md`（结构摘要 + 可访问性/安全等校验，形态对齐 xlsx）；
纯文本原样拷贝，图片进 `assets/未分类/`。.msg 仍走 markitdown。
`.doc` / `.ppt`（老版二进制 Office）也走本地 anydoc。

**默认不外发文件。** 只有 `--pdf-engine mineru` 或扫描件自动升级才会把资料传到 MinerU。
MinerU 需要 `MINERU_API_KEY`（`.env` 里配，脚本会自己读）。没配 key 时 PDF 照样走本地 anydoc；
扫描件会在台账记 `⚠ 扫描件需 OCR`，不算失败。Token 在 <https://mineru.net/apiManage> 创建，
免费额度 1000 页/天，单文件上限 200MB / 200 页（anydoc 没有这个页数上限）。

`.doc` / `.ppt` 由 anydoc 本地转换；只有 anydoc 不可用时才退回「请用户另存为新格式」，
台账会写明是哪一种原因。`.wps` / `.et` / `.dps`（金山私有格式）始终不支持，必须另存为。
`.xls` 走自带的 BIFF8 解析器 `scripts/xls_reader.py`：普通 .xls 按 sheet 拆 CSV，
点表形态的 .xls 让给 `pointtable.py` 汇总（见下节）——不要改判给 anydoc，
它把整个工作簿压成一份 Markdown，拆不出 CSV。
产物 frontmatter 里带 `warning` 的说明内容几乎是空的（扫描件且 OCR 也没识别出来），
要提醒用户这份资料实际不可用，不要当它已经进来了。

## 阶段一之二：点表批量归一

电力 / 工控项目常会收到**成百上千个同构的点表小文件**（测点清单）。这类资料逐个转换没有意义——
价值在于汇总后**能按测点检索**：「棉花滩所有水位测点是哪些」翻几百个 csv 是答不出来的。
所以点表走单独的管线：

```bash
python3 scripts/pointtable.py                  # 自动发现 input/raw/ 下的点表目录（幂等）
python3 scripts/pointtable.py --dry-run        # 先看识别结果
python3 scripts/pointtable.py input/raw/集控点表 # 只处理指定目录
python3 scripts/pointtable.py --force          # 强制重建
```

支持两类形态，靠**内容**识别而不是扩展名（parser 可插拔，见脚本里的 `PARSERS`）：

| parser | 形态 | 典型来源 |
| --- | --- | --- |
| `hydro_xls` | 表格型 `.xls`/`.xlsx`，首行表头 + 数据行，设备层级来自**目录路径** | 南瑞水电集控（模拟量/开关量/SOE量/温度量） |
| `scada_ini` | 分段型 `.txt`，`[RTU]`/`[遥信]`/`[遥测]` 分段，GBK 与 UTF-8 混杂 | 风电 / 光伏集中监控 |

产物在 `input/converted/<点表集名>/`（整目录合并，见上文「产物落点」）：

- **`_manifest_<点表集名>批量处理.md`** — 轻量台账（规模分布、字段说明、已知局限）。**看板预览点这个**
- `MergedObject/测点主表.csv` — 全量统一 18 列，含溯源列（源文件 + 源行号）
- `MergedObject/分册/<厂站>.csv` — 按厂站拆分，便于预览、也便于单独发给某厂站对接人核对
- `MergedObject/测点.sqlite` — 建好索引，**按测点检索一律走 SQL，不要把主表读进上下文**

```bash
sqlite3 input/converted/集控点表/MergedObject/测点.sqlite \
  "SELECT 厂站,设备分区,测点描述,测点地址 FROM 测点
   WHERE 测点描述 LIKE '%水位%' AND 是否备用='' LIMIT 20;"
```

两个脚本会自动分流：`ingest.py` 识别到点表就让路（打一行汇总日志并记进 INDEX 台账），
点表目录里的普通表格（如跨系统指标清单）仍由 `ingest.py` 按 sheet 转 CSV。

**边界**：脚本只做格式归一，**不做**设备树绑定、间隔匹配、测点编码生成——那些依赖每个厂站
一份的业务规则表（通常随点表附一份 `*-测点解析规则.md`），属于工程侧数据接入范畴，不是需求分析的输入。
分段型点表的「设备名」是内容启发式推断的，写进正式文档前要按解析规则文档核对，
并按溯源要求标 `[推断]`。

## 阶段一之三：现场实测数据归一

客户/现场会陆续交来**已接入数据库导出的真实运行数据**：一个几十上百 MB 的 csv，
几十万行，列名是 `senid` / `time` / `v` 这种系统内部字段。它人读不了、也不能读进上下文，
但它是**验证需求可行性的硬证据**——某个测点现场到底有没有数、多久来一次、有没有断流、
值合不合理。资料只说明设计上应该有什么，这类数据说明实际上有什么。

```bash
python3 scripts/realdata.py                    # 自动发现 input/raw/ 下的现场数据目录（幂等）
python3 scripts/realdata.py --dry-run          # 先看识别到的列映射和时间格式
python3 scripts/realdata.py input/raw/现场数据  # 只处理指定目录下认得出的文件（给单个文件也行）
python3 scripts/realdata.py --force            # 强制重建
python3 scripts/realdata.py --time-format "%m/%d/%Y %H:%M:%S"   # 日月顺序有歧义时手工指定
```

**导出文件放进一个子目录**（如 `input/raw/现场数据/`），别散放在 `input/raw/` 根下——
根下的 csv 更可能是普通表格，归 `ingest.py` 管；放进子目录才会被当成现场数据。
识别靠**表头**不看扩展名。目前两种形态（别名表在 `scripts/realdata.py` 顶部，遇到新系统加一行）：

| 形态 | 表头要能认出 | 主产物 |
| --- | --- | --- |
| 测点时序 | 测点标识 + 时间 + 数值（`senid` / `time` / `v`） | `SplittingObject/<文件名>/实测数据.sqlite` |
| 日指标 | 期间 + 组织 + 指标 + 数值（`period_id` / `orgz_code` / `measure_code` / `measure_value`） | `SplittingObject/<文件名>/日指标.sqlite`，组织名连组织表、指标名连指标字典 |
| 预报 | 宽表：对象 + 发布时间 + `V0..Vn`（`ADID` / `TIME`）；长表：对象 + 发布时间 + 预报时间 + 值（`REGID` / `FTIME` / `BTIME` / `AVERPRE`） | `SplittingObject/<文件名>/预报数据.sqlite`（预报 / 发布 / 对象），占位值只标记不删 |

csv / txt 都能进。

**一个导出文件 = 一个数据集 = 一个库。** 现场常一次导好几张表，各表互相独立
（不同系统、不同测点集），合成一个库反而混。产物按镜像规则落在
`input/converted/<raw 相对目录>/`：

- **`_manifest_<文件名>.md`** — 轻量台账：规模、时间范围、覆盖分布、质量体检、**表结构和 SQL 范例**。
  **看板预览点这个**；AI 要写 SQL 读这一份就够
- 测点时序：`实测数据.sqlite`（测点维表 + 实测事实表 + 日统计）+ `测点覆盖清单.csv` + `日统计.csv` + 未匹配测点
- 日指标：`日指标.sqlite`（组织 / 指标维表 + 日指标事实表 + 覆盖表）+ `覆盖清单.csv` + 未匹配组织/指标

```bash
sqlite3 -header -column input/converted/现场数据/SplittingObject/wds_real_data/实测数据.sqlite \
  "SELECT 场站名称,测点名称,采样间隔秒,\"间隔规律性%\",\"完整率%\"
   FROM 测点 WHERE 测点名称 LIKE '%坝上水位%' ORDER BY \"完整率%\" LIMIT 20;"

sqlite3 -header -column input/converted/现场数据/SplittingObject/t02_product_day/日指标.sqlite \
  "SELECT 日期,组织简称,数值 FROM v_日指标
   WHERE 指标编码='DL01001' AND 机组编码='-1' AND 组织简称 LIKE '%棉花滩%'
   ORDER BY 日期 LIMIT 20;"
```

`ingest.py` 识别到现场数据同样让路（打一行汇总日志并记进 INDEX 台账）。

**边界**：脚本只做格式归一 + 字典对齐，不做单位换算、不剔异常值、不补缺测。
台账里的「采样间隔」是相邻两点间隔的中位数、「完整率」是据此推算的，
**都是统计口径，不是现场承诺的采集频率**；先看 `间隔规律性%` 再看 `完整率%`——
规律性低于 60% 的是雨量这类事件驱动测点，脚本不给它们算完整率，别当缺测报。
状态码 / 质量位的含义资料里通常没写，原样保留、不做解释，写进待确认清单去问。
详细做法见 [`skills/pm-field-data`](skills/pm-field-data/SKILL.md)。

## 阶段一之四：数据库作为按需查询的远端资料源

有一大类事实活在**业务系统的数据库**里。把整个库同步到本机要占磁盘、要维护增量，
生产数据完整落地还有合规问题；挂个数据库 MCP 让 AI 随便查，则是每次结果都直接进上下文，
几百行就把窗口撑爆，还不留产物 —— 换个会话得从头重查。

所以这里走第三条路：**库是远端资料源，只按需取，取到的东西落成文件**。

```bash
python3 scripts/db_ingest.py list                    # 列出 input/sources/ 下配好的源
python3 scripts/db_ingest.py schema 仓库库            # L1：采一次 schema 快照（低频）
python3 scripts/db_ingest.py query 仓库库 \
    --name 近30天入库量 --sql "SELECT …"              # L2：跑一条只读查询，结果落 csv
```

- **L1 schema 快照** `input/converted/_sources/<源名>/_manifest_<源名>.md` ——
  表清单、列名类型注释、主外键、行数**量级**。KB 级，**这是默认进上下文的唯一一份**。
  表超过 40 张就退化成表清单，单表明细在 `SplittingObject/<表>.md`，按需读一张。
- **L2 查询产物** `input/converted/_sources/<源名>/<查询名>.csv` +
  `_manifest_<查询名>.md`（SQL 原文 / 行数 / sha256）。上下文里只留路径和摘要，正文按需读。

源怎么配、凭据放哪儿、为什么样例行默认不抽，见 [`input/sources/README.md`](input/sources/README.md)。
用户把 jdbc / 主机端口 / 账号口令丢过来时，走 [`skills/pm-env-config`](skills/pm-env-config/SKILL.md) 落文件，不要把口令写进 yaml。

## 阶段一之五：网页资料

政策文件、公开标准、友商文档站这类网页，**没有** `input/raw/` 下的原件，
走 `scripts/web_ingest.py` 转成 Markdown 落进 `input/converted/`，
落点与 docx / PDF 同一套规则（`scripts/layout.py`）。页面里的图抽到
`input/assets/<标题>/`，正文只留相对路径，不把几 MB 的 `data:image` 内联进 Markdown。
给人看的页面快照仍走看板
`visualization/references/` 采集——两条链路共用同一份抓下来的 HTML，职责不同
（可分析文本 vs 页面快照），详见 [`skills/pm-doc-ingest`](skills/pm-doc-ingest/SKILL.md)。

```bash
python3 scripts/web_ingest.py <URL>          # 公开页：抽出可分析文本（不写 visualization/）
python3 scripts/web_ingest.py --inbox        # 根上散装 HTML：收成参考目录并抽出正文
```

浏览器另存 / 剪藏丢进 `visualization/references/` 根上的自包含 HTML，走 `--inbox`。
看板参考 tab 的刷新按钮调的就是这一条。何时用哪条入口见 [`skills/pm-doc-ingest`](skills/pm-doc-ingest/SKILL.md)。

**写操作由数据库自己拒绝。** 脚本在发任何一条用户语句之前先把会话置为只读
（PG `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` / MySQL `SET SESSION TRANSACTION READ ONLY`），
即便配的是 root，INSERT / UPDATE / DELETE 也由服务端打回。设置失败就中止，不降级。
脚本侧另有一道白名单 + 禁多语句 —— 它不是装饰：实测 psycopg 不带参数时多语句是真会执行的。
**不要试图绕过它**：要改数据请走业务系统自己的入口。

### 「零 Python 依赖」这次让了一步

`ingest.py` 一路坚持只用标准库 + 外部 CLI（xlsx 直接读 OOXML，.xls 自带 BIFF8 解析），
换台机器就能跑。连数据库这件事做不到 —— wire protocol 用标准库自己实现不现实。

所以 `db_ingest.py` 的口径是**按需可选**，不是「原则松了」：

- 脚本本身仍然只 import 标准库；驱动是**运行到那一步才 import**，import 失败时报中文、点名装哪个包。
- **没配数据源的人一行依赖都不多**，也不会跑到那段代码。所谓「零依赖」守的是
  **开箱即用**，不是「永不 import」—— 这与 MinerU 要 key、anydoc 要二进制是同一个模式。
- 装不了包的环境（`pip install` 要走审批）还有 `client: cli` 走 psql 那条备选路。

新加别的脚本时请照这条线判断：**默认路径必须零依赖**，可选路径可以有可选依赖。

## 演示与汇报材料（HTML）

要给客户汇报、评审、演示的材料，如果产出是 HTML，**放 `output/docs/`，和它的 `.md` 源文并排**，
文件名同名只差扩展名：

```
output/docs/2026-08-18-需求评审材料.md      ← 内容源，改这份
output/docs/2026-08-18-需求评审材料.html    ← 渲染产物，一起改
```

三条规则：

- **写成完整的单文件 HTML**：自带 `<!doctype html>`、内联 CSS、不引外部字体和脚本，
  双击能在浏览器打开，拷给别人也能看。
- **md 是内容源，html 是渲染产物**。两份内容要一致；改内容时两边一起改，不要只改一份。
- **看板已经支持**：`output/docs/*.html` 在「产出文档」视图里带「可演示」标记，
  点开是 iframe 预览，下面有「全屏演示」和「用浏览器打开」——汇报现场直接用。

**和 `visualization/prototypes/` 怎么分**：看有没有 `.md` 源文。

- 有 md 源、html 只是它的渲染产物（PRD、评审材料）→ `output/docs/`，两份并排同名。
- **没有 md 源、页面本身就是产物**（原型、可视化、方案页、演示页）→
  `visualization/prototypes/<名字>/index.html`，见下节。

## 阶段四：视觉呈现

`visualization/` 是**视觉平面**：给人看、能点开的页面。它和 `input/` `output/` 的差别在于
那两个装的是要转换、要写的**文档**，这里装的是**页面**。看板的「视觉呈现」视图分两个 tab 展示它。

### `visualization/references/`：收下来的别人的页面

竞品、友商后台、公开文档站 —— 刚接手一个项目时先出现的就是这些，
它们是做概念表达最快的捷径。一份参考一个目录，入口叫 `index.html`，
旁边可以有 `meta.json`（记来源 URL、采集时间）和 `screenshots/{hero,full,mobile}.png`。
**它是别人的页面，收进来保持原样**，不是本工作空间的产出。

### `visualization/prototypes/`：工具产出的可点击原型

看板扫这个目录，把每一项渲染成能点开的页面。里面可以同时住这几种东西：

| 来源 | 形态 |
| --- | --- |
| [Axhub Make](https://github.com/lintendo/Axhub-Make) 构建的客户端 | 它自己建的目录，自带 README 和结构 |
| 别人给的 zip 导出包 | `<名字>.zip`，包内根上有 `index.html` |
| **你自己写的、或 AI 生成的单页 HTML** | `<名字>/index.html` |
| 云端发布的原型（Axhub Make 发布、figma make 的 publish / share 链接） | `<名字>/meta.json`：`{ "kind": "url", "title": "…", "target": "https://…" }`，可选 `cover.png` |

**三条硬规则**：

- **一个东西一个子目录，入口必须叫 `index.html`。** 看板只认
  `<子目录>/index.html`、`visualization/prototypes/index.html` 和 zip 包 ——
  散装的 `方案.html` 直接扔进 `visualization/prototypes/` 根上，**根本扫不到**，
  界面上什么都不会出现。
- **只认已构建好的产物。** 未构建的源码包（figma make 的源码导出、Axhub Make 的
  「导出源码」包）看板扫不到，也不会为它们装依赖、跑构建 —— 请用工具的「导出 HTML」，
  或者用上面那条云端发布链接。
- **`<title>` 就是看板里显示的名字**，别留空、别叫「Document」。
- **自包含**：内联 CSS、不引外部字体和脚本（看板自己也只声明字体栈不加载 web 字体），
  双击能在浏览器打开，拷给别人也能看。

Axhub Make 服务端是**后台常驻服务，不在本项目里启动**，也不要尝试在这里跑 `npx @axhub/make`。
用户在它的页面上新建项目并指向本仓库的 `visualization/prototypes/`，它会自动在该目录下构建客户端。
**不要动它生成的目录**；你自己的东西各占一个子目录，两边互不干扰。

你在阶段四的职责是**准备好输入**：用 `pm-prototype-brief` 把 `output/` 里的文档收敛成
`output/analysis/原型输入说明.md`（页面清单、信息架构、主流程点击路径、字段与状态、交互规则），
交给用户喂进 Axhub Make。原型评审后的结论要回流到 `output/`，不要只留在原型工具里。

## 文件命名

- 中文名可以直接用，IDE 和工具链都能处理，不用转拼音。
- 分析产物加日期前缀便于排序：`2026-07-30-计费模块需求拆解.md`。
- 决策记录：`output/decisions/0001-短标题.md`，四位序号递增。

## Markdown 写法

工作空间里的 Markdown 写法**只写在这一节**。各技能只留一句指向这里的引用，不要在技能里复述条目。

这是看板渲染器**现在就能显示**的写法。原来就按相对路径链接和普通引用写的文档不用改。
下面几项以前因为看板显示不了而先别用，现在可以直接写。

可执行版本是 [`scripts/check_markdown.py`](scripts/check_markdown.py)
（只读、只报告）和 [`scripts/migrate_markdown.py`](scripts/migrate_markdown.py)
（默认预演，落盘要显式加 `--write`）。**契约变了那两个脚本要跟着变。**

### 适用范围

| 目录 | 本节约束吗 | 原因 |
| --- | --- | --- |
| `output/analysis/`、`output/decisions/` | **管** | 人或 agent 手写的分析 / 决策 |
| `output/docs/` | 语法管、front-matter **不强制** | 要发出去的文档，YAML 头对收件人是噪音；写了的话必须扁平 |
| `output/questions/` | 语法管；字段以该目录 README 为准 | 未决问题有自己的字段契约，扁平约束与这里是同一条 |
| `output/records/` | 语法管；字段以该目录 README 为准 | 产出物记录有自己的字段契约（含按 `kind` 分化的三套状态机），扁平约束与这里是同一条 |
| `output/records/notes/` | 语法管；格式以 `output/records/README.md` 的「批注」为准 | 一份产出物一份批注文件。看板整条追加，agent 只改 `- 状态：` 与 `- 回执：` |
| 各目录下的 `README.md` | 语法管、front-matter **不强制** | 目录说明，不是分析产物 |
| `input/converted/` | **不管** | 由转换脚本生成，重跑即覆盖；要改形态就改脚本 |
| `input/raw/` | **不碰** | 人类给的原件，只读 |

校验脚本只扫 `output/**` 下的 `.md`，显式不读 `input/converted/` 与 `input/raw/`。

### 现在可用

- **扁平 YAML front-matter**：只允许 `key: value` 与 `key:` + `  - item` 两种形态。
  看板的解析器（[`src/server/frontmatter.mjs`](https://github.com/STArtppt/aispace-kanban/blob/main/src/server/frontmatter.mjs)）只认这两种；
  内联数组 `tags: [a, b]` 会被整体当成一个字符串，语义静默丢掉。
  这条与 [`output/questions/README.md`](output/questions/README.md) 已有的扁平约束是**同一条**，
  现在从 `questions/` 扩到全部手写 Markdown。
- **唯一 H1，正文从 H2 起**。标题可以写在 front-matter 的 `title` 里、正文从 H2 起；
  也可以正文留一个 H1 当标题。两个 H1 会把看板的文档目录搅乱。
- **文档间链接**，两种都认：
  - 相对路径：`[文本](../analysis/xxx.md)`。
  - wikilink：`[[../analysis/xxx|文本]]`、`[[output/docs/xxx]]`、`[[xxx|文本]]`。
    `./` 和 `../` 相对当前文件；带 `/` 的从工作空间根算；**没有 `/` 的只认同一目录**下的 `xxx.md`。
    不按全库文件名去猜——同名文件出现在别的目录时，裸文件名不会指到那一份。
    `[[目标#标题]]` 会打开那份文件，标题写在链接文字里，**不会**滚到那一节。
- **嵌入**：`![[./图.png]]` 把图片放进正文。`![[../docs/xxx]]` 只显示成链接，不把那份文档的正文嵌进来。
- **Callout**：`> [!note] 标题` 下一行接着写正文。`warning` / `caution` / `attention` /
  `failure` / `danger` / `error` / `bug` / `important` 用「需要注意」的样式，其余是灰底。
  `> [!note]- 标题` 默认折叠，`> [!note]+ 标题` 默认展开。
- **行首标签**：`#待确认`（`#` 后紧跟非空格）显示成小标签，不进目录。`# 标题`（有空格）仍是标题。
- **注释**：`%%这句不给读者看%%` 阅读时不显示。围栏代码块里的 `%%` 原样保留。
- **段尾块锚点**：`^id` 阅读时不显示。还不能被别的文档拿来跳转。
- **数学**：行内 `$v=s/t$`，单独成行用 `$$...$$`。同一行里两个美元金额（`$100` 和 `$200`）会被当成公式，金额改写成「100 元」或放进代码跨度。
- GFM 表格、围栏代码块（含 mermaid）。

`output/analysis/` 与 `output/decisions/` 的 front-matter 最小形态：

```markdown
---
title: 文档标题
created: 2026-07-30
updated: 2026-07-30
---
```

缺字段时 `scripts/migrate_markdown.py` 会按文件名 / 首个 H1 / 文件日期补齐；它**不改正文措辞、不调标题层级**。

### 不要依赖这些

语法可以写，但这三件事看板**做不到**，写的时候别以为它会发生：

| 写法 | 看板实际会怎样 |
| --- | --- |
| 裸文件名 `[[同名笔记]]`，指望在全库里唯一命中 | 只认**同一目录**。别的目录里的同名文件不会被选中，也不会被拿来消歧 |
| `![[某文档]]` 指望把正文嵌进来 | 只显示一条链接 |
| `[[文件#某节]]` 指望打开后滚到那一节 | 会打开文件，不会滚动。要定位就靠标题，阅读器目录点得动 |

### 违约怎么被看见

```bash
python3 scripts/check_markdown.py            # 只读，只报告
python3 scripts/migrate_markdown.py          # 预演，不落盘
python3 scripts/migrate_markdown.py --write  # 确认后落盘
```

校验闸的作用不是阻止违约——agent 直接改文件谁也拦不住——是**让违约可见，不要静默生效**。
这两个脚本是工作空间自己的工具，看板既不调用也不 spawn。

## 看板显示不对时

看板是另一个仓库的程序，**对你只读**：可以读它的源码来弄清它期望什么，**不能改它**。
它不知道你这份文档，你也不知道它的不变量、验证要求和提交约定 —— 为一份文档改渲染器，
多半会把别的写法弄坏，而且改动没人审、没人提交。

### 去哪查

看板源码公开在 **<https://github.com/STArtppt/aispace-kanban>**。**读 GitHub 上的文件，
不要去翻本机的看板仓库或 npm 包目录**（那在工作空间外，每次都要用户授权）。
取原文用 `https://raw.githubusercontent.com/STArtppt/aispace-kanban/main/<路径>`，下表路径拼在后面：

| 想查什么 | 路径 |
| --- | --- |
| 概览页怎么显示 `project.yaml` | `src/app/components/MetaView.tsx`、`src/server/meta.mjs` |
| front-matter 解析 | `src/server/frontmatter.mjs` |
| Markdown 渲染（callout、wikilink、数学、标签等） | `src/app/components/Markdown.tsx`、`src/app/lib/markdownSyntax.ts` |
| 文档内链接与图片地址 | `src/app/lib/markdownUrls.ts` |
| mermaid 图 | `src/app/components/MermaidBlock.tsx`、`src/app/lib/mermaid.ts` |

GitHub 上的 `main` 可能与用户本机跑的版本有出入，对不上时如实说明，别下定论。

### 怎么处理

1. **先改自己这边。** 对照上文的约定（Markdown 写法、`project.yaml` 里各字段的「形如」注释），
   多数问题是写法没对上，改工作空间里的文件就解决了。
2. **确认是看板的缺陷**（照约定写了还是显示错，或者约定本身没写清）：
   工作空间里的文件照样改到能正确显示（临时绕法），然后**写一份反馈单**，见下。
3. 回复用户时说清：反馈单在哪、用了什么临时绕法、看板那边要改的大致是什么。

**不要改看板仓库或 npm 包目录里的任何文件**，哪怕你已经看出该怎么改 ——
把改法写进反馈单，由用户带到看板仓库那边按它的规矩改。

### 反馈单 `.kanban-feedback/`

放在工作空间根目录的 `.kanban-feedback/`（隐藏目录，看板不扫、不显示），
**一个问题一份**，文件名 `YYYY-MM-DD-<短标题>.md`。目录不存在就建。

```markdown
# <一句话说清问题>

- 状态：待处理
- 回执：

## 现象
看板哪个视图、哪一块、显示成了什么样。

## 期望
应该显示成什么样。

## 最小复现
合成的最小片段（自己编的名称和内容），能单独复现问题。

## 疑似源码位置
GitHub 链接，尽量带行号：https://github.com/STArtppt/aispace-kanban/blob/main/<路径>#L<行>

## 建议改法
文字说明，或一段 diff 文本。只写在这里，不落到看板仓库。

## 临时绕法
工作空间里改了哪些文件、怎么改的；看板修好后要撤掉哪些。
```

- **最小复现必须是合成的**，不贴工作空间里的真实资料、客户名称、截图。这份单子可能被带进公开仓库。
- `状态` 只用三个值：`待处理` / `已修复` / `不修`。
- 用户转来看板那边的回执时：把 `状态` 改掉，`回执` 填上结论和看板提交号（不修就写理由）；
  已修复的，按「临时绕法」一节撤掉绕法，改回按约定的写法。

## 不要做的事

- **不要主动读取 `input/raw/` 下的原始文件**（除非用户明确要求）。分析、写文档、追溯一律优先用 `input/converted/` 和 `input/INDEX.md`。原始文件（尤其 PDF / docx / xlsx）体积大、进上下文烧 token，且内容已由 `scripts/ingest.py` 转成可读文本——默认读转换产物即可。用户说「打开原件」「对照 raw 里的某某」「看一下原始 PDF」时才读 `input/raw/`。
- **不要把现场数据的原始 csv 或 sqlite 事实表整表读进上下文**（几十万到上百万行）。查数走 SQL 只取回需要的几十行，看全局读对应的 `_manifest_*.md`。
- **不要把 `测点主表.csv` 整个读进上下文**（动辄十几万行）。查测点走 `测点.sqlite` 的 SQL，只把命中的几十行拿回来；要看全局分布读 `_manifest.md`。
- 不要修改或删除 `input/raw/` 里的任何文件。
- 不要手改 `input/converted/` 的产物，改脚本或在 `output/analysis/` 里记录修正。
- 不要往 `input/converted/` 里手动建目录。落点规则在 `scripts/layout.py`，
  `SplittingObject/` 和 `MergedObject/` 由脚本创建，手建的目录看板认不出来。
- 不要把散装 `.html` 直接扔在 `visualization/prototypes/` 或 `visualization/references/` 根上
  （两边都扫不到），也不要动 Axhub Make 生成的目录。
  自己的单页 HTML 一个子目录一个 `index.html`，见上文。
- 不要把 `.env` 或其中的 key 写进任何会入库的文件、日志或文档。
- 不要用推断填平资料空白，标注出来交给用户去确认。
- 不要读写本机的看板仓库或看板的 npm 包目录。要看看板源码读 GitHub；看板有缺陷写反馈单
  （见「看板显示不对时」）。唯一的例外是下面「模板改动回同步源」规定的那几个文件。

## 模板改动回同步源

本工作空间由 aispace-kanban 仓库的 `templates/pm-aispace` 生成。
模板随看板仓库一起维护；看板「新建工作空间」调的是仓库里的
`templates/init_workspace.py --from templates/pm-aispace`。

**凡是改动了模板自带文件**（如 `scripts/ingest.py`、`skills/` 下的通用技能、`AGENTS.md` 等），
在改动完成后必须同步回模板源，否则下次新建工作空间会丢失这些优化。

**能写的范围只有一处**：看板仓库 `templates/pm-aispace/` 下、与本工作空间里同名的那个文件
（例如本空间的 `skills/pm-project-meta/SKILL.md` → 看板仓库的
`templates/pm-aispace/.claude/skills/pm-project-meta/SKILL.md`）。
看板仓库的其余部分 —— 根目录下的 `src/`、`bin/`、`scripts/`、`package.json`，`templates/init_workspace.py`
以及别的一切 —— **都不在范围内**。问题要改看板代码才能解决的，写反馈单（见「看板显示不对时」）。

同步规则：

- 改动前先确认目标文件在模板源中存在；不存在时向用户确认路径是否正确。
- 用 `diff` 核对差异，确保只覆盖本次想保留的改动。
- 同步后 **aispace-kanban** 仓库如有 Git 变更，提醒用户提交（提交的是看板仓，
  不是本工作空间）。本工作空间只负责复制文件，不替用户 commit。
