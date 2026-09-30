# 产品经理AI空间模板

产品经理 / 需求分析师**接手既有项目**时用的 AI 工作空间模板。

本目录是 [aispace-kanban](../../) 看板仓库内的一份模板（`templates/pm-aispace/`）。
看板「新建工作空间」会调仓库里的 `templates/init_workspace.py --from` 指向这里。
原先独立的 `pmwork-template` 仓库已并入此处。

一句话说明它解决什么问题：接手项目时你会收到一堆 docx、PDF、Excel，人能看但 AI 读不了；
这个模板把「资料 → 分析 → 文档 → 原型」四步串成一条 AI 能全程参与的流水线。

## 快速开始

```bash
# 1. 从模板起一个新工作空间（二选一）
#    a) 在 aispace-kanban 看板里点「新建」，选「产品经理AI空间模板」
#    b) 命令行：
python3 /path/to/aispace-kanban/templates/init_workspace.py \
  --from /path/to/aispace-kanban/templates/pm-aispace \
  --name "项目名" --path ~/work/某个工作空间
cd ~/work/某个工作空间

# 2. 可选：配 MinerU token（扫描件 / 抽图 / 复杂版式才需要；不配也能跑，PDF 走本地 anydoc）
cp .env.example .env    # 要把 token 填进 MINERU_API_KEY

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
  questions/        未决问题，一问一文件（看板工作台「问题单」，不进产出列表）
  records/          产出物记录与批注（工作台「记录单」）
  feedback/         给看板的缺陷单与贡献单（工作台「反馈单」）
  docx-template/    从客户旧 Word 提炼的模板（工作台「模版洗炼」）
  delivery/         去 AI 味后的交付稿，逐版保存（从原稿的版本条进入）
visualization/    阶段四：视觉平面 —— 给人看、能点开的页面（不是要转换的文档）
  references/       收下来的别人的页面：竞品、友商后台、公开文档站
    <名字>/index.html  一份参考一个目录，入口必须叫 index.html
  prototypes/       工具产出的可点击原型（已构建的 HTML 包 / zip 包 / 自己写的单页 HTML）
    <名字>/index.html  一个东西一个子目录，入口必须叫 index.html，否则看板扫不到
scripts/
  ingest.py         文档转换调度
  layout.py         converted/ 的落点规则（转换脚本共用一份）
  web_ingest.py     网页 → Markdown；`--inbox` 收参考目录根上的散装 HTML
  db_ingest.py      数据库源：schema 快照与只读查询
  archive_output.py 一次归档：把一份产出移进同组 `一次归档/`
  docx_template.py  从客户旧 Word 提炼模板（公共代码在 docxkit/）
  md2docx.py        按模板把 .md 转成 .docx（另需 pandoc 3）
  pointtable.py     点表批量归一 → 测点主表 + sqlite
  realdata.py       现场实测数据归一 → 时序库
  migrate_converted.py  旧版平铺产物 → 镜像结构（一次性）
  anydoc.py         本地 PDF / PPTX 转换客户端
  mineru.py         MinerU 在线解析客户端
skills/           预装的 PM 技能 + skill-creator（→ .claude/skills 软链接）
AGENTS.md         Agent 工作约定（所有 Agent 通用，唯一来源）
CLAUDE.md         Claude Code 入口，引入 AGENTS.md
.env.example      环境变量模板
```

## 依赖

| 用途 | 依赖 | 安装 |
| --- | --- | --- |
| **docx / odt / rtf / epub、PDF、`.doc` / `.ppt` → md** | **本地 anydoc** | 看板依赖 `@firecrawl/anydoc`；自己跑脚本把 `anydoc` 放到 PATH 或设 `ANYDOC_BIN` |
| PPTX → md（抽图） / 扫描件 OCR | MinerU 在线 API | `.env` 里配 `MINERU_API_KEY` |
| `.msg` → md | `markitdown` | `pip install 'markitdown[all]'` |
| xlsx / xlsm → csv | 无（脚本自带 OOXML 解析） | — |
| html / htm → 可预览原型目录 | 无（拷贝 HTML + 校验写 `_manifest.md`） | — |
| `.md` → 客户版式的 `.docx` | pandoc 3 + `scripts/md2docx.py` | macOS：`brew install pandoc`；非标准路径在 `.env` 写 `PANDOC_BIN` |
| 从客户旧 Word 提炼模板 | `scripts/docx_template.py`（标准库） | 生成模板不用 pandoc；没有 pandoc 时只是没有样张 |

Python 侧默认只用标准库（连 MinerU 的 HTTP 调用也是标准库写的）。
数据库查询是可选路径，驱动缺了会点名让你装，没配数据源的人不受影响。
缺哪个依赖只影响对应格式，其余照常转换：没配 MinerU key 时 PDF 走本地 anydoc。

## 多 Agent 通用

约定写在 `AGENTS.md`，技能放在 `skills/`（就是 `.claude/skills/` 的软链接），
所以不只 Claude Code 能用：

- **Claude Code** — 自动发现 `.claude/skills/` 并按需触发技能，无需手动加载。
- **Codex / Cursor / Gemini CLI / Cline / Trae 等** — 读 `AGENTS.md`，
  里面有技能索引表，按相关性主动读 `skills/<名字>/SKILL.md` 再执行。

`CLAUDE.md` 只是一个引入 `AGENTS.md` 的薄壳，改约定只改 `AGENTS.md` 一处。

## 四个阶段

**阶段一 · 资料入库**　`scripts/ingest.py` 按格式分派：docx/odt/rtf/epub 走本地 anydoc（顺带抽图），
PDF 默认走本地 anydoc（不联网；扫描件自动升级 MinerU OCR），PPTX 维持 MinerU（抽图），
xlsx 按 sheet 拆成 CSV 并生成导航清单；**html/htm 当作 PM 互传的单文件可点击原型**，
保留 HTML 供直接预览，并生成 `_manifest.md`（校验 + 结构摘要），不把页面正文转成 md。
每个产物都带 frontmatter 记录来源路径、sha256、转换工具和时间——**接手项目最需要的是能把结论追回原始文档**。
脚本幂等：源文件没变就跳过。

**默认不外发文件。** 只有 `--pdf-engine mineru` 或扫描件自动升级才会把资料传到 MinerU。

**阶段二 · 分析**　`pm-project-handover` 摸现状基线，`pm-requirement-analysis` 做需求拆解。
两者都强制区分「资料里写了的」和「我推断的」，并把答不上来的问题沉淀成澄清清单。

**阶段三 · 文档产出**　`pm-prd-writing` 带 PRD 模板和写作规则，产物落 `output/docs/`。
要交出去的文档先用 `pm-deai-writing` 去 AI 味，交付稿落 `output/delivery/`（原稿不动），
再按客户模板转成 Word（`scripts/md2docx.py`，看板产出列表的「转成 Word」跑的是同一支）。
模板从客户旧 Word 提炼，落在 `output/docx-template/`。

**阶段四 · 原型**　`pm-prototype-brief` 把文档收敛成页面清单、信息架构、主流程点击路径
和字段规则，产出 `output/analysis/原型输入说明.md`，再喂给
[Axhub Make](https://github.com/lintendo/Axhub-Make)。

Axhub Make 服务端是后台常驻服务，**不在本项目里启动**。在它的页面上新建项目并指向本仓库的
`visualization/prototypes/`，它会自动在该目录下构建客户端（自带 README 和目录结构）——那个目录别去动。

`visualization/prototypes/` 同时也是**可预览原型库**：AI 生成的方案页、可视化、演示页也放这里，
规则是**一个东西一个子目录、入口叫 `index.html`**（散装 `.html` 放根上看板扫不到）。
看板只认**已构建好**的产物；源码包请先用工具的「导出 HTML」，或者用一份 `meta.json`
记一条云端发布链接（`{ "kind": "url", "title": "…", "target": "https://…" }`）。
自带 `.md` 源文的交付文档仍然走 `output/docs/`，两者的分界见 AGENTS.md。

收参考走隔壁的 `visualization/references/`：竞品、友商后台、公开文档站，
一份参考一个目录、入口同样叫 `index.html`。它是别人的页面，不是本工作空间的产出。

## 越用越顺手

预装技能覆盖通用套路，但每个项目都有自己的特殊性。工作中出现重复第三遍的动作，
让 AI 用 `skill-creator` 把它固化成新技能存进 `skills/`。
这些技能跟着仓库走，下次接手同类项目直接复用，换个 Agent 也还在。

模板本身也会更新（修脚本、加技能）。对 AI 说「更新一下模板」，它会先列出这次要更新什么、等你确认，
你改过的文件不会被覆盖。只对本项目成立的约定写进根目录的 `AGENTS.local.md`，更新不会碰它；
换一个项目也成立的改进，AI 会写成贡献单，你在看板反馈单页发出去，就能进到模板里给所有人用。
