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
                    封面上映射成字段的段落写的是占位符 {{title}} 这类（原文不留），签署页和版本表只剩空格子，
                    目录只留 Word 的目录域。提炼第 ④ 步勾「不要前置区」、或旧文档没有前置区时不写
```

有 `front.docx` 的模板，转出来的成品 = 前置区 + 正文。封面字段依次取自 md 的 front-matter（`title` / `client` / `vendor` /
`date` / `doctype`）→ 开头唯一的 `#` 标题（只用于标题）→ `project.yaml` 的 `identity.甲方` / `identity.承建方` →
转换当天的「YYYY年M月」（只用于日期）；都取不到的显示「【待填：…】」，转换结果里会提醒。字段映射与表格清空规则记在
`profile.json` 的 `front` 段。已有模板要带上前置区，在看板里「重新提炼」一次。

`<模板名>` 是一层目录名：不以 `.` 开头，不含 `/ \ : * ? " < > |` 和 `..`。

只采集、还没生成的目录（只有 `collect/`）在看板里标「未生成」，可以「继续」接着做；转 Word 时选不到它。

## 用模板转 Word

```bash
python3 scripts/md2docx.py output/docs/方案.md --template <模板名>
```

成品是同目录、同名的 `.docx`。需要 pandoc 3。看板产出列表「更多 → 转成 Word」调的是同一支脚本。

## 别把这些文件外传

`collect/`、`profile.json`、`reference.docx`、`front.docx`、`sample.docx` 里是客户的版式材料（页眉、单位名称、字体、页面设置）。
这个目录随工作空间留在本机：不要贴进反馈单、提交说明或公开仓库。
反馈单里的最小复现一律用合成内容。
