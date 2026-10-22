# output/docx-template/ — Word 模板

这里放「把 Markdown 转成客户那份 Word 样式」用的模板，一个模板一个子目录。
它不进看板的产出列表、搜索和完整度；在看板 ⌘K 工作台的「模版洗炼」页里看、提炼和预览。

## 谁往这里写

只有 `scripts/docx_template.py`：

- 看板「模版洗炼」页点「开始分析」「生成模板」时，看板启动这支脚本，写盘的是脚本，看板自己不写；
- 你或工作空间 AI 也可以在终端里直接跑同一条命令（用法见脚本文件头）。

它只写 `output/docx-template/<模板名>/` 这一个目录。模板名已存在时，要加 `--regenerate`（看板里勾选「重新生成」）才会覆盖。

## 一个模板一个子目录

```
output/docx-template/<模板名>/
  collect/          采集报告：report.json（格式簇、大纲、样式使用情况）+ paragraphs.jsonl（逐段快照）。
                    只记编号前缀和字数（如「（1）[35字]」），不含正文
  profile.json      相对通用规范（scripts/docxkit/base-spec.json）的客户差异；
                    每一节用 _src 标出每个属性的来源：extracted = 从旧文档采集，decision = 人工选定
  reference.docx    pandoc 用的参照模板：以客户旧文档为底，清空正文、删掉没人用的样式和编号、
                    按「通用规范 + 客户差异」重建样式。它**不是**客户原件
  spec.md           写给写 md 的人（和 AI）看的文字规定：每个角色 md 怎么写、成品长什么样，
                    客户原文没有、由通用规范补齐的角色逐条标出
  sample.docx       合成样张（scripts/docxkit/sample.md）按这个模板转出的效果。生成时本机没有 pandoc 就没有它；
                    有前置区时样张前几页是封面、签署页、目录
  front.docx        可选，前置区骨架：旧文档正文之前的封面、签署页、版本跟踪表、目录。
                    封面上映射成字段的段落写的是占位符 {{title}} 这类，设成「清空」的段落只留格式（原文都不留），
                    签署页和版本表只剩标签、表头和空格子，目录只留 Word 的目录域。
                    提炼第 ④ 步勾「不要前置区」、或旧文档没有前置区时不写
```

有 `front.docx` 的模板，转出来的成品 = 前置区 + 正文。封面字段依次取自 md 的 front-matter（`title` / `client` / `vendor` /
`date` / `doctype`）→ 开头唯一的 `#` 标题（只用于标题；`# 某项目 · 实施方案` 这种在模板有文档类型字段时拆成标题与文档类型）
→ `project.yaml` 的 `identity.甲方` / `identity.承建方` → 转换当天（只用于日期，写法同模板原文，如「2025年06月」）；
都取不到的显示「【待填：…】」，转换结果里会提醒。字段映射、表格清空规则和日期写法记在 `profile.json` 的 `front` 段。
已有模板要带上前置区，在看板里「重新提炼」一次。

正文页眉页脚里与封面字段同文的部分（比如写着文档类型的页眉）在提炼时也写成了 `{{doctype}}` 这类占位符，转换时一起填值。
所以 **`reference.docx` 只经 `scripts/md2docx.py` 使用**：直接拿它当 pandoc 的参照模板，页眉里会露出占位符。

`<模板名>` 是一层目录名：不以 `.` 开头，不含 `/ \ : * ? " < > |` 和 `..`。

只采集、还没生成的目录（只有 `collect/`）在看板里标「未生成」，可以「继续」接着做；转 Word 时选不到它。

## 用模板转 Word

```bash
python3 scripts/md2docx.py output/docs/方案.md --template <模板名>
```

成品是同目录、同名的 `.docx`。需要 pandoc 3。看板产出列表「更多 → 转成 Word」和阅读器版本条上的「转成 Word / 重新转换」调的是同一支脚本。

## 给 AI 的步骤

用户在看板点「复制提示词」粘给你时照提示词做；没有提示词时按下面做。

### 转 Word

```bash
python3 scripts/md2docx.py output/docs/方案.md --template @base      # 通用规范
python3 scripts/md2docx.py output/docs/方案.md --template 客户甲      # 客户模板
```

1. 转之前对照写作规定检查 md：客户模板看 `<模板名>/spec.md`，通用规范看 `scripts/docxkit/base-spec.json`。
   要点：文档标题写成开头唯一的 `#`（或 front-matter 的 `title:`），`##` 起是一级标题；标题里的手写编号、
   `> [!note]` 批注块、句中加粗转换时会自动处理（结果里的 `log` 列出处理了几处）；表题写在表格**下方**一行 `Table: 表 N 标题`；
   图题写在 `![图 N 标题](路径)` 的方括号里。需要改就改 md 的写法，不改内容。
   模板带封面（`front.docx`）时，文档类型要在 md 的 front-matter 写 `doctype:`；转换结果里有「【待填：…】」就补上再转。
   **要交付的文档先去 AI 味、转交付稿**，不要转原稿。
2. 同名 `.docx` 已存在时：带生成标记（上次转出来的）加 `--archive` 重转 —— 上一份改名为 `<基名>-<上次转换时间>.docx` 留在原处，
   在 Word 里的修改不丢；`--overwrite` 会丢掉那些修改，只在用户明说不要上一份时用；
   没有标记的（人手改过另存的、客户给的原件）脚本会拒绝 —— **不要删它、不要改名绕过**，问用户怎么处理。
3. 转完检查：标题编号连续、表格有边框和表头、图片都在；脚本输出里的 warnings 为空。有缺图等提示就先修 md 再转。
4. 找不到 pandoc 时脚本会说明怎么装。装在非标准位置时在 `.env` 里写 `PANDOC_BIN=<路径>`（这一个键只给路径，不是密钥）。

### 提炼模板

```bash
python3 scripts/docx_template.py collect input/raw/客户旧文档.docx --name 客户甲
python3 scripts/docx_template.py build --name 客户甲 --source input/raw/客户旧文档.docx --decisions 决定.json
```

1. 来源必须在 `input/raw/` 里（读原件的是脚本，不是你；不要把原件内容读进上下文）。
2. `collect` 之后读 `collect/report.json` 的 `clusters`（格式簇，带 `suggestedRole`）与 `outline`，
   把映射方案（哪个簇当正文 / 各级标题 / 题注，哪些丢弃，同一角色格式不一致时取哪个值）**列给用户确认**，再写决定 JSON。
   写法见 `scripts/docxkit/decisions.py` 文件头；不写的簇采用建议角色，所以一份 `{}` 也能生成。决定 JSON 用完即删。
3. `build` 输出的 warnings 为空，才说明合成样张各角色格式与规范一致；不为空就把差异告诉用户。
4. 模板名已存在要加 `--regenerate` 才覆盖，先问用户。

## 别把这些文件外传

`collect/`、`profile.json`、`reference.docx`、`front.docx`、`sample.docx` 里是客户的版式材料（页眉、单位名称、字体、页面设置）。
这个目录随工作空间留在本机：不要贴进反馈单、提交说明或公开仓库。
反馈单里的最小复现一律用合成内容。
