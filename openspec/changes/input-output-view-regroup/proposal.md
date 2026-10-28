## Why

不做的话，看板的栏目和实际用法一直对不上：「概览」单占一个视图，进来先看一屏统计，真正要干活还得再点「输入资料」；
原始资料一转换或一忽略就从列表里消失，想确认「这份到底转没转、是不是被我忽略了」只能去翻目录；
转换产物挂在「输入资料」下，可同事写好、转成 markdown 后要套模板交付的文档，用起来就是一份产出 ——
放在 `input/` 里，交付稿栏、转 Word 这些产出侧能力都得为它开特例。

## What Changes

- **去掉「概览」视图**。导航只剩「输入资料 / 产出文档 / 原型…」，默认进「输入资料」；
  本地记住的视图是 `overview` 时退回「输入资料」。
- **概览并进资料台账**。「输入资料 → 原始资料」列表顶部固定一行「资料台账」，点开后预览窗口显示精简后的概览：
  项目名与阶段、三格统计（资料 / 产出 / 待办信号）、四步进度（推断）、项目元信息摘要；下方接着是 `input/INDEX.md` 正文。
  没有 `INDEX.md` 时只显示概览部分。「最近的产出」不再保留（产出视图本身按时间排序）。
- **原始资料不再因为转换或忽略而消失**。「原始资料」列出 `input/raw/` 的全部文件，每行带文本标签：
  `已转` / `待转` / `忽略`，原件在转换后又改过的标 `原件已改`（orange，需要注意）。
  可按状态筛选，默认「全部」；「开始转换」仍只处理待转的。忽略后不提供「取消忽略」（那要删 `.ingestignore` 的行，属于清单外写入）。
- **BREAKING（工作空间目录约定）：转换产物从 `input/converted/` 搬到 `output/converted/`**；图片目录 **`input/assets/` 不动**，
  「图片资料」页签仍在「输入资料」下（目录与看板位置一致；直接放进 `input/raw/` 的单张图片本来就是原始资料）。
  产物正文里的图片链接改为跨目录指回 `input/assets/`。看板上「转换产物」从「输入资料」挪到「产出文档」下，作为独立一栏，
  **不进产出三组**（不参与产出记录、归档、完整度、产出总数）。数据库源产物 `_sources/` 随目录一起搬。
- 模板同步：`layout.py` / `ingest.py` / `db_ingest.py` / `web_ingest.py` 等脚本的落点，模板 `AGENTS.md`、
  `input/README.md`、`output/README.md` 及引用旧路径的技能；新增一次性迁移脚本，搬目录并改写相对链接。
- **精简模板 `.gitignore`**：`input/raw/`、`input/assets/`、`input/sources/` 下的内容整目录忽略（只留 `.gitkeep`、
  `input/sources/README.md`、`input/sources/example.yaml.txt`），删掉按扩展名逐条列的 `input/**/*.xxx`；
  同一组二进制扩展名规则改挂到 `output/converted/`（转换产物搬过去后，拆表 csv、点表 sqlite 不能因此进库）。
  `input/INDEX.md`、`input/README.md`、`input/.ingestignore` 继续入库。
- **产出文档页签改名**：「分析中间产物」→「分析产物」，「对外交付文档」→「交付文档」；模板文档里的同一组叫法一并对齐。
- 看板在过渡期**两种布局都认**：有 `output/converted/` 用新的，只有 `input/converted/` 时按旧布局显示并提示迁移。
  产出文档里既有的溯源引用（`来源：input/converted/…`）不改写，看板反链把旧前缀当新路径的别名。

## ⚠ 工作空间写入与目录约定（需要拍板）

- **看板不新增任何写入例外**。搬目录、改链接由工作空间的一次性迁移脚本完成，用户（或工作空间 AI）在终端执行，
  `--dry-run` 先看计划；看板不 spawn 它。
- 不变量 1 的文字要跟着改路径：第五条（参考收件箱抽出的 Markdown 写进 `output/converted/`）、基础写入「资料转换」的说明，
  以及上一个 change 第九条里「输入转换产物」的来源位置。**写入范围的性质不变**，只是目录名变了。
- 迁移脚本会改**转换产物正文里的相对链接**（图片、摘要互链）。这些文件是脚本生成的，不是人写的；
  `output/analysis|docs|decisions` 等人写/AI 写的产出一个字节不碰。

## Capabilities

### New Capabilities

- `input-ledger-overview`：资料台账行与预览里的概览；去掉概览视图后的导航与会话兜底。
- `raw-source-status`：原始资料全量列出与状态标签、筛选。
- `converted-in-output`：转换产物的新目录约定、产出视图中的「转换产物」栏、双布局兼容、迁移脚本、溯源旧前缀别名。

### Modified Capabilities

（无单独的 delta。涉及 `docx-output-to-delivery` 的「输入转换产物」来源位置，在本 change 的 `converted-in-output` 里写明两种布局都认。）

## Impact

- **templates**：`scripts/layout.py`、`ingest.py`、`db_ingest.py`、`web_ingest.py`、`pointtable.py`、`realdata.py`、`check_markdown.py`、
  `md2docx.py`（来源规则加 `output/converted/`）等约 28 个引用旧路径的文件；新脚本 `migrate_converted_to_output.py`；`.gitignore`。
- **服务端**：`scan.mjs`（转换产物根目录按布局选择、raw 状态字段、`converted-md` 的 docKey 范围）、`citations.mjs`（旧前缀别名）、
  `http.mjs`（注释与 SSE 范围核对：`output/` 已递归监听，无需新增）。
- **契约 `api.ts`**：raw 条目加可选 `state`；scan 加可选 `convertedRoot` / `layout`；新字段均可选，缺省退回改动前行为。
- **前端**：`App.tsx`、`useBoardSession.ts`（去 `overview`）、`OverviewPanel.tsx`（改为台账预览里的精简概览）、
  `InputPanel.tsx`（台账行、全量原始资料与标签、移走转换产物栏）、`OutputPanel.tsx`（新增「转换产物」栏）、`Reader.tsx`。
- **CLI**：不动。**新依赖**：无。
- **实例**：所有已登记工作空间需同步模板后执行一次迁移。
