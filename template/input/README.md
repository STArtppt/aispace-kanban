# input/ — 阶段一：资料入库

把人类可读的文档，变成 AI 和 IDE 可读的 UTF-8 文本。

## 怎么用

```bash
cp ~/Downloads/*.docx ~/Downloads/*.xlsx input/raw/   # 原样丢进来，不用整理
python3 scripts/ingest.py                             # 转换
```

不用手动分类、不用改文件名、不用先删掉没用的——先全部进来，`INDEX.md` 会列出清单，
之后再判断哪些是权威版本。

## 三个子目录

- **`raw/`** — 原始文件。**只读**：不改名、不编辑、不删除。它是所有结论的溯源终点，
  评审时被质疑「这条需求哪来的」，答案必须能落到这里的某个文件。
- **`converted/`** — 脚本产物，**不要手改**（重跑会覆盖）。发现转换质量有问题，
  改脚本或在 `output/analysis/` 里记录修正，不要改产物。
- **`assets/`** — 从文档里抽出来的图片。Claude 用 Read 工具可以直接看图，
  流程图、界面截图这类信息量很大的资料别漏掉。

## 支持的格式

| 输入 | 产物 | 工具 |
| --- | --- | --- |
| `.docx` `.odt` `.rtf` `.html` `.epub` | 一个 `.md`，图片抽到 `assets/<名字>/` | pandoc |
| `.pdf` `.pptx` | 一个 `.md`，图片抽到 `assets/<名字>/` | **MinerU 在线 API** |
| `.msg` | 一个 `.md` | markitdown |
| `.xlsx` `.xlsm` | 一个目录：每个 sheet 一个 `.csv` + `_manifest.md` 导航 | 脚本自带解析 |
| `.md` `.csv` `.json` `.txt` `.yaml` `.xml` | 原样拷贝 | — |
| `.png` `.jpg` `.gif` `.webp` | 拷到 `assets/` | — |

**老格式不支持**：`.doc` `.xls` `.ppt` `.wps` `.et` `.dps` 会被跳过并在台账里标记，
请先用 Office / WPS 另存为新格式。

## PDF / PPTX 走 MinerU

PDF 是接手资料里最难啃的格式——多栏排版、跨页表格、图表、公式，本地工具基本还原不出来。
所以 PDF 和 PPTX 走 [MinerU](https://mineru.net) 的在线解析 API（v4 精度版）。

配置一次：

```bash
cp .env.example .env       # 然后把 token 填进 MINERU_API_KEY
```

Token 在 <https://mineru.net/apiManage> 创建。`.env` 已在 `.gitignore` 里，不会入库。

**没配 key 也能用**：脚本自动退回本地 markitdown 并给出提示，只是版式和表格还原差一些。
想明确控制用哪个引擎：

```bash
python3 scripts/ingest.py --pdf-engine mineru       # 强制在线（没 key 会明确报错）
python3 scripts/ingest.py --pdf-engine markitdown   # 强制本地，不外发文件
python3 scripts/ingest.py --ocr                     # 扫描版 PDF，让 MinerU 走 OCR
python3 scripts/ingest.py --model-version vlm       # 版式特别复杂时换模型试试
```

几个实际限制：单文件 200MB / 200 页，免费额度 1000 页/天，一批最多 200 个文件。
超限脚本会在上传前就拦住并说清原因。整批解析是异步的，脚本会打印轮询进度。

**注意资料会上传到 MinerU 服务器。** 涉密资料用 `--pdf-engine markitdown` 本地处理，
或者先脱敏。这是这个模版里唯一会把资料外发的环节，其余格式全部本地转换。

## 产物里的 frontmatter

每个 `.md` 产物开头都有一段元数据，这是溯源链的关键：

```yaml
---
source: input/raw/需求规格说明书.docx   # 原始文件在哪
source_sha256: 2edc8fbb0f8ca20…        # 内容指纹，用于判断资料是否被换过版本
converted_by: pandoc                    # 谁转的
converted_at: 2026-07-30T11:26:13+08:00
kind: document
---
```

CSV 不加 frontmatter（会破坏解析），元数据在同目录的 `_manifest.md` 里。

`source_sha256` 的实际用途：对方团队第二次发来「最终版」时，指纹一比就知道内容到底改没改，
不用逐页读。脚本也靠它做幂等——没变化的文件不重转。

## 常见情况

**扫描版 PDF**：先加 `--ocr` 让 MinerU 走 OCR，多数情况能救回来。
如果连 OCR 都识别不出内容，产物 frontmatter 会带 `warning`——这类资料 AI 实际读不到，
要找对方要电子版，不要假装它已经进来了。

**同一份文档多个版本**：都放进来，在 `INDEX.md` 的「人工批注 → 权威版本」里写明以哪份为准。
版本冲突本身就是接手阶段要暴露的风险。

**资料涉密**：在 `.gitignore` 里取消 `input/raw/` 那行的注释，原始件就不会入库，
但转换产物仍在版本控制内——按需要一并处理。
