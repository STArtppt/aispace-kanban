# 项目接手工作空间 · Agent 工作约定

本文件是所有 AI Agent 在这个工作空间里的**唯一约定来源**。
`CLAUDE.md` 只是指向本文件的入口，不要把约定重复写在那边。

这是**产品经理 / 需求分析师接手一个既有项目**时使用的工作空间。用户是 PM，不是工程师：
沟通时少用工程术语，多用需求、范围、干系人、验收这类 PM 语言；需要用到脚本或命令时，
你负责执行，不要让用户自己拼命令。

## 四个阶段，四个目录

工作是单向流水线，每一阶段的产物是下一阶段的输入：

```
input/  →  （分析）  →  output/  →  prototypes/
资料      技能+上下文    文档产出    可点击原型
```

| 目录 | 职责 | 写入规则 |
| --- | --- | --- |
| `project.yaml` | 项目元信息：背景目标、干系人、里程碑、成果要求、约束 | 由 `pm-project-meta` 增量维护，见下文 |
| `input/raw/` | 人类给的原始资料（docx / PDF / xlsx / pptx） | **只读**。永不改动、永不删除，它是溯源的终点。**默认禁止读取**（见下文） |
| `input/converted/` | 转换后的 `.md` / `.csv`；**目录结构镜像 `input/raw/`**，见下文 | 由 `scripts/ingest.py` / `pointtable.py` / `realdata.py` 生成，**不要手改**（重跑会覆盖） |
| `input/assets/` | 图片资料：`<文档名>/` 是那份文档抽出的图，`未分类/` 是直接放进 raw/ 的单图 | 脚本生成。看图请直接读图片文件 |
| `input/INDEX.md` | 资料台账 | 表格由脚本生成；人工判断写在「人工批注」区 |
| `output/analysis/` | 分析中间产物（现状基线、需求拆解、澄清问题清单） | 自由写 |
| `output/docs/` | 对外交付文档（PRD、需求规格、评审材料）；**演示/汇报用的 HTML 也放这里** | 自由写，见下文 |
| `output/decisions/` | 决策记录：一个决策一个文件 | 只追加，不要改历史决策 |
| `prototypes/` | Axhub Make 客户端目录 | **不要手动创建文件**，见下文 |

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
- 资料里没有答案的，不要猜着填。写进 `output/analysis/open-questions.md`，
  作为要向对方团队确认的问题清单——**没有答案本身就是重要产出**。

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

新建工作空间：`python3 scripts/init_workspace.py --name "项目名" --path <目录>`。

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
| [`skills/pm-requirement-analysis`](skills/pm-requirement-analysis/SKILL.md) | 阶段二：需求拆解、优先级、验收标准、追溯矩阵 |
| [`skills/pm-field-data`](skills/pm-field-data/SKILL.md) | 阶段二之外：现场真实运行数据进来时，核验数据可用性、拿场景可行性的证据 |
| [`skills/pm-list-diff`](skills/pm-list-diff/SKILL.md) | 阶段二之外：两份清单（甲方给的 vs 我方已接入的）交叉比对，产出对外可回填核对件 |
| [`skills/pm-prd-writing`](skills/pm-prd-writing/SKILL.md) | 阶段三：写 PRD / 需求规格说明书 |
| [`skills/pm-prototype-brief`](skills/pm-prototype-brief/SKILL.md) | 阶段四：把文档收敛成原型输入，衔接 Axhub Make |
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
python3 scripts/ingest.py --pdf-engine markitdown   # 不调在线接口，强制本地转
```

### 忽略清单 `input/.ingestignore`

客户常常一次性交来上千份存量资料，只有一部分需要进分析链路。剩下的既不该转，
也不该在看板上一直报「待转换」把真正的缺口淹掉——写进 `input/.ingestignore`：

```
raw/客户版          # 目录：连同其下所有文件一起忽略
*.bak               # 通配：按文件名匹配，不必带路径
```

gitignore 风格，路径相对 `input/` 写。**`scripts/layout.py`（三个转换脚本共用）和看板
`src/server/scan.mjs` 读的是同一份**，改一次全都生效——改动其中一侧的匹配规则时必须同步另一侧。

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

格式分派：docx/odt/rtf 走 pandoc（顺带抽图），**PDF/pptx 走 MinerU 在线 API**，
xlsx/xlsm/xls 按 sheet 拆成 CSV；**html/htm 作为 PM 互传的单文件可点击原型**——不转成
Markdown 正文，而是拷到镜像目录的 `SplittingObject/<名>/` 保留可预览 HTML，并生成配套
`_manifest_<名>.md`（结构摘要 + 可访问性/安全等校验，形态对齐 xlsx）；
纯文本原样拷贝，图片进 `assets/未分类/`。

MinerU 需要 `MINERU_API_KEY`（`.env` 里配，脚本会自己读）。**没配 key 不会报错**，
会自动退回本地 markitdown，只是版式和表格还原差一些——遇到这种情况提醒用户可以配 key 提升质量。
Token 在 <https://mineru.net/apiManage> 创建，免费额度 1000 页/天，单文件上限 200MB / 200 页。

`.doc` / `.ppt` / `.wps` 等老格式脚本不支持，需要请用户先另存为新格式
（`.xls` 是例外：自带 BIFF8 解析器 `scripts/xls_reader.py`，普通 .xls 按 sheet 拆 CSV，
点表形态的 .xls 让给 `pointtable.py` 汇总，见下节）。
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

**不要放进 `prototypes/`。** 那是 Axhub Make 的地盘（见下节），而且看板扫 `prototypes/`
只认 `<目录>/index.html` 或 zip 包，散装 HTML 文件放进去根本扫不到。

## 阶段四：原型

`prototypes/` 是给 [Axhub Make](https://github.com/lintendo/Axhub-Make) 用的**客户端目录**。

- Axhub Make 服务端是**后台常驻服务，不在本项目里启动**，也不要尝试在这里跑 `npx @axhub/make`。
- 用户在 Axhub Make 页面上新建项目并指向本仓库的 `prototypes/`，
  它会自动在该目录下构建客户端，**并自带自己的 README 和目录结构**。
- 所以：**不要在 `prototypes/` 下手动创建任何文件**（包括 README），会和它生成的内容冲突。
  这个目录看起来是空的属于正常状态。

你在阶段四的职责是**准备好输入**：用 `pm-prototype-brief` 把 `output/` 里的文档收敛成
`output/analysis/原型输入说明.md`（页面清单、信息架构、主流程点击路径、字段与状态、交互规则），
交给用户喂进 Axhub Make。原型评审后的结论要回流到 `output/`，不要只留在原型工具里。

## 文件命名

- 中文名可以直接用，IDE 和工具链都能处理，不用转拼音。
- 分析产物加日期前缀便于排序：`2026-07-30-计费模块需求拆解.md`。
- 决策记录：`output/decisions/0001-短标题.md`，四位序号递增。

## 不要做的事

- **不要主动读取 `input/raw/` 下的原始文件**（除非用户明确要求）。分析、写文档、追溯一律优先用 `input/converted/` 和 `input/INDEX.md`。原始文件（尤其 PDF / docx / xlsx）体积大、进上下文烧 token，且内容已由 `scripts/ingest.py` 转成可读文本——默认读转换产物即可。用户说「打开原件」「对照 raw 里的某某」「看一下原始 PDF」时才读 `input/raw/`。
- **不要把现场数据的原始 csv 或 sqlite 事实表整表读进上下文**（几十万到上百万行）。查数走 SQL 只取回需要的几十行，看全局读对应的 `_manifest_*.md`。
- **不要把 `测点主表.csv` 整个读进上下文**（动辄十几万行）。查测点走 `测点.sqlite` 的 SQL，只把命中的几十行拿回来；要看全局分布读 `_manifest.md`。
- 不要修改或删除 `input/raw/` 里的任何文件。
- 不要手改 `input/converted/` 的产物，改脚本或在 `output/analysis/` 里记录修正。
- 不要往 `input/converted/` 里手动建目录。落点规则在 `scripts/layout.py`，
  `SplittingObject/` 和 `MergedObject/` 由脚本创建，手建的目录看板认不出来。
- 不要在 `prototypes/` 下建文件。演示/汇报用的 HTML 放 `output/docs/`，见上文。
- 不要把 `.env` 或其中的 key 写进任何会入库的文件、日志或文档。
- 不要用推断填平资料空白，标注出来交给用户去确认。

## 模板改动回同步源

本工作空间由模板 `/Users/sunchao/Desktop/LIFE/coding/myproj/aispace-kanban/template` 生成。
模板随 **aispace-kanban** 看板仓库一起维护（原先独立的 `pmwork-template` 已并入该目录；
看板「新建工作空间」也是调这里的 `scripts/init_workspace.py`）。

**凡是改动了模板自带文件**（如 `scripts/ingest.py`、`scripts/init_workspace.py`、
`skills/` 下的通用技能、`AGENTS.md` 等），在改动完成后必须同步回模板源，
否则下次新建工作空间会丢失这些优化。

同步规则：

- 改动前先确认目标文件在模板源中存在；不存在时向用户确认路径是否正确。
- 用 `diff` 核对差异，确保只覆盖本次想保留的改动。
- 同步后 **aispace-kanban** 仓库如有 Git 变更，提醒用户提交（提交的是看板仓，
  不是本工作空间）。本工作空间只负责复制文件，不替用户 commit。
