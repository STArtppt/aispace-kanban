# 项目接手工作空间模板

产品经理 / 需求分析师**接手既有项目**时用的 AI 工作空间模板。

本目录是 [aispace-kanban](../) 看板仓库内的模板源（`template/`）：看板「新建工作空间」
会调这里的 `scripts/init_workspace.py`。原先独立的 `pmwork-template` 仓库已并入此处。

一句话说明它解决什么问题：接手项目时你会收到一堆 docx、PDF、Excel，人能看但 AI 读不了；
这个模板把「资料 → 分析 → 文档 → 原型」四步串成一条 AI 能全程参与的流水线。

## 快速开始

```bash
# 1. 从模板起一个新工作空间（二选一）
#    a) 在 aispace-kanban 看板里点「新建工作空间」
#    b) 命令行：
python3 /path/to/aispace-kanban/template/scripts/init_workspace.py \
  --name "项目名" --path ~/work/某个工作空间
cd ~/work/某个工作空间

# 2. 配 MinerU token（PDF/PPTX 解析用；不配也能跑，会退回本地工具）
cp .env.example .env    # 把 token 填进 MINERU_API_KEY

# 3. 把收到的资料丢进 input/raw/（原样丢，不用整理）
cp ~/Downloads/需求规格说明书.docx ~/Downloads/功能清单.xlsx input/raw/

# 4. 转换成 AI 可读格式
python3 scripts/ingest.py

# 5. 打开你的 AI 编码工具开始干活
claude
```

然后就可以直接说人话了：

- 「先把资料过一遍，告诉我这个项目现在是什么状态，哪些地方资料对不上」
- 「按模块把需求拆出来，标上优先级和验收标准」
- 「基于这些写一版 PRD 到 output/docs/」
- 「准备原型输入，然后起 Axhub Make」

## 目录

```
input/            阶段一：资料入库与格式转换
  raw/              原始文档（只读，溯源终点）
  converted/        转换后的 .md / .csv（目录结构镜像 raw/，见 AGENTS.md「产物落点」）
  assets/           图片资料（按来源分目录，单张图进 未分类/）
  INDEX.md          资料台账（脚本生成 + 人工批注）
output/           阶段三：产出
  analysis/         现状基线、需求拆解、澄清问题清单
  docs/             PRD、需求规格、评审材料
  decisions/        决策记录，一事一档
prototypes/       阶段四：Axhub Make 客户端目录（保持空，别手动放文件）
scripts/
  ingest.py         文档转换调度
  layout.py         converted/ 的落点规则（三个转换脚本共用一份）
  pointtable.py     点表批量归一 → 测点主表 + sqlite
  realdata.py       现场实测数据归一 → 时序库
  migrate_converted.py  旧版平铺产物 → 镜像结构（一次性）
  mineru.py         MinerU 在线解析客户端
skills/           预装的 PM 技能 + skill-creator（→ .claude/skills 软链接）
AGENTS.md         Agent 工作约定（所有 Agent 通用，唯一来源）
CLAUDE.md         Claude Code 入口，引入 AGENTS.md
.env.example      环境变量模板
```

## 依赖

| 用途 | 依赖 | 安装 |
| --- | --- | --- |
| docx / odt / rtf → md | `pandoc` | `brew install pandoc` |
| **PDF / pptx → md** | **MinerU 在线 API** | `.env` 里配 `MINERU_API_KEY` |
| PDF / pptx 本地兜底 | `markitdown` | `pip install 'markitdown[all]'` |
| xlsx / xlsm → csv | 无（脚本自带 OOXML 解析） | — |
| html / htm → 可预览原型目录 | 无（拷贝 HTML + 校验写 `_manifest.md`） | — |

Python 侧只用标准库，不需要装任何包（连 MinerU 的 HTTP 调用也是标准库写的）。
缺哪个依赖只影响对应格式，其余照常转换：没配 MinerU key 会自动退回 markitdown 并提示。

## 多 Agent 通用

约定写在 `AGENTS.md`，技能放在 `skills/`（就是 `.claude/skills/` 的软链接），
所以不只 Claude Code 能用：

- **Claude Code** — 自动发现 `.claude/skills/` 并按需触发技能，无需手动加载。
- **Codex / Cursor / Gemini CLI / Cline / Trae 等** — 读 `AGENTS.md`，
  里面有技能索引表，按相关性主动读 `skills/<名字>/SKILL.md` 再执行。

`CLAUDE.md` 只是一个引入 `AGENTS.md` 的薄壳，改约定只改 `AGENTS.md` 一处。

## 四个阶段

**阶段一 · 资料入库**　`scripts/ingest.py` 按格式分派：docx 走 pandoc（顺带抽图），
PDF/pptx 走 MinerU 在线 API（多栏排版、跨页表格、公式的还原远好于本地工具，同样抽图），
xlsx 按 sheet 拆成 CSV 并生成导航清单；**html/htm 当作 PM 互传的单文件可点击原型**，
保留 HTML 供直接预览，并生成 `_manifest.md`（校验 + 结构摘要），不把页面正文转成 md。
每个产物都带 frontmatter 记录来源路径、sha256、转换工具和时间——**接手项目最需要的是能把结论追回原始文档**。
脚本幂等：源文件没变就跳过。

MinerU 是唯一会把资料外发的环节，涉密资料用 `--pdf-engine markitdown` 本地处理。

**阶段二 · 分析**　`pm-project-handover` 摸现状基线，`pm-requirement-analysis` 做需求拆解。
两者都强制区分「资料里写了的」和「我推断的」，并把答不上来的问题沉淀成澄清清单。

**阶段三 · 文档产出**　`pm-prd-writing` 带 PRD 模板和写作规则，产物落 `output/docs/`。

**阶段四 · 原型**　`pm-prototype-brief` 把文档收敛成页面清单、信息架构、主流程点击路径
和字段规则，产出 `output/analysis/原型输入说明.md`，再喂给
[Axhub Make](https://github.com/lintendo/Axhub-Make)。

Axhub Make 服务端是后台常驻服务，**不在本项目里启动**。在它的页面上新建项目并指向本仓库的
`prototypes/`，它会自动在该目录下构建客户端（自带 README 和目录结构）。
所以 `prototypes/` 保持空目录，**不要手动往里放文件**，包括 README。

## 越用越顺手

预装技能覆盖通用套路，但每个项目都有自己的特殊性。工作中出现重复第三遍的动作，
让 AI 用 `skill-creator` 把它固化成新技能存进 `skills/`。
这些技能跟着仓库走，下次接手同类项目直接复用，换个 Agent 也还在。
