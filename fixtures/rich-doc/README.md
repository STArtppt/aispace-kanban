# 富文档转换的回归语料

`templates/pm-aispace/scripts/anydoc_writer.mjs` 的回归基线用件。
跑 `node scripts/check-rich-doc.mjs` 比对 `scripts/check-rich-doc.mjs` 里写死的期望统计。

**只放合成件。** 真实客户资料一律不入库 —— 本仓已开源，进了 git 历史删不干净。

| 文件 | 覆盖什么 |
| --- | --- |
| `source.md` + `diagram.png` | 合成件的源：标题层级、粗体/斜体/删除线/行内代码、内外链接、裸露元字符、嵌入图、有序/无序/嵌套列表、GFM 表格、引用、分隔线 |
| `sample.docx` `.odt` `.rtf` `.epub` | 由 `source.md` 生成，四种格式各一份 |
| `merged.html` | 第二个合成件的源：**跨行列表格**、字母编号列表、嵌套编号、无表头表格、单元格里的 `|` 与换行 |
| `merged.docx` | 由 `merged.html` 生成 |

## 重新生成

需要本机装 pandoc（**只有生成语料时要**，转换链路本身已经不依赖 pandoc）：

```bash
cd fixtures/rich-doc
pandoc source.md -o sample.docx
pandoc source.md -o sample.odt
pandoc source.md -o sample.epub
pandoc source.md -s --embed-resources -o sample.rtf   # rtf 必须 -s，否则没有 {\rtf1 头，anydoc 认不出
pandoc merged.html -o merged.docx
```

重新生成后期望统计可能变，改 `scripts/check-rich-doc.mjs` 的 `EXPECTED` 之前
先确认是**语料变了**而不是 Writer 退化了。
