# docx 工具链的回归语料

`templates/pm-aispace/scripts/docx_template.py` 与 `md2docx.py` 的回归用件。
跑 `pnpm test:docx`（`scripts/check-docx.mjs`）：在临时目录里依次跑采集 → 生成模板 → 转换 → 反查，断言关键角色的实际格式。

**只放合成件。** 真实客户文档一律不入库 —— 页眉 logo、单位名称这些版式本身就是客户材料，脱不干净；本仓已开源，进了 git 历史删不干净。

| 文件 | 用途 |
| --- | --- |
| `make_messy_docx.py` | 现生成一份「格式很乱的旧 Word」：大量无效样式、样式定义与实际显示不一致（标题定义 22pt、实际 14pt）、正文全是手动格式且有两种行距、伪标题、手写编号、10 套编号只用 1 套、三种表格边框、正文里的目录项、页眉页脚。每段正文带哨兵词，用来断言采集报告里没有正文 |
| `decisions.json` | 固定的「第 ②③ 步决定」：丢掉两个目录簇、把一段孤立正文并入正文簇、正文行距选 1.5 倍（少数派，验证决定真的生效） |

合成的 `sample.md` 与示意图不在这里，在 `templates/pm-aispace/scripts/docxkit/`（它随工作空间分发，build 用它转样张）。

## 改了生成器之后

`decisions.json` 按簇 id（`c1`、`c10`…）写决定，簇 id 按「段数从多到少」排。
改 `make_messy_docx.py` 让段数变了，先跑一遍采集看新的簇清单，再改 `decisions.json`：

```bash
python3 fixtures/docx-template/make_messy_docx.py /tmp/m.docx
cd templates/pm-aispace/scripts && python3 -c "
from pathlib import Path; from docxkit.collect import collect
r, _ = collect(Path('/tmp/m.docx'))
for c in r['clusters']: print(c['id'], c['count'], c['suggestedRole'], list(c['styles']))"
```

## pandoc

没有 pandoc 3 的机器上，测试只跳过转换与样张那几段并打印说明，不算失败。
CI 目前不装 pandoc、也不跑这一项（仅本地），改了 `docxkit/` 请在有 pandoc 的机器上跑一遍。
