# input/ — 阶段一：资料入库

把人类可读的文档，变成 AI 和 IDE 可读的 UTF-8 文本。

## 怎么用

```bash
cp ~/Downloads/*.docx ~/Downloads/*.xlsx input/raw/   # 原样丢进来，不用整理
python3 scripts/ingest.py                             # 转换
```

不用手动分类、不用改文件名、不用先删掉没用的——先全部进来，`INDEX.md` 会列出清单，
之后再判断哪些是权威版本。

## 子目录与转换产物

- **`raw/`** — 原始文件。**只读**：不改名、不编辑、不删除。它是所有结论的溯源终点，
  评审时被质疑「这条需求哪来的」，答案必须能落到这里的某个文件。
- **转换产物在 `output/converted/`**（不在 `input/` 下）—— 脚本产物，**不要手改**（重跑会覆盖）。
  发现转换质量有问题，改脚本或在 `output/analysis/` 里记录修正，不要改产物。
  **目录结构镜像 `raw/`**：你在 `raw/` 里怎么分目录，产物就怎么分，删一批资料的产物只要删对应目录。
  一份源文件拆出多个产物时（xlsx 每个 sheet 一个 csv），正文收进 `SplittingObject/<文件名>/`，
  摘要 `_manifest_<文件名>.md` 留在外面；整个目录汇总成一份的（点表）收进 `MergedObject/`。
  规则写在 `scripts/layout.py`。产物还在 `input/converted/` 的旧工作空间先跑
  `python3 scripts/migrate_converted_to_output.py --dry-run` 看迁移计划。
- **`assets/`** — 图片资料，按来源分目录：`assets/<文档名>/` 是从那份文档里抽出来的图，
  `assets/未分类/` 是直接放进 `raw/` 的单张图片（附 `_manifest.md` 记来源）。
  Claude 用 Read 工具可以直接看图，流程图、界面截图这类信息量很大的资料别漏掉。

## 支持的格式

| 输入 | 产物 | 工具 |
| --- | --- | --- |
| `.docx` `.odt` `.rtf` `.epub` | 一个 `.md`，图片抽到 `assets/<名字>/` | **本地 anydoc** |
| `.pdf` | 一个 `.md` | **本地 anydoc**（默认）；扫描件自动升级 MinerU OCR |
| `.pptx` | 一个 `.md`，图片抽到 `assets/<名字>/` | **MinerU 在线 API**；没 key 时兜底 anydoc（不抽图） |
| `.doc` `.ppt` | 一个 `.md`（不抽图） | **本地 anydoc** |
| `.msg` | 一个 `.md` | markitdown |
| `.xlsx` `.xlsm` `.xls` | 每个 sheet 一个 `.csv`（进 `SplittingObject/`）+ `_manifest_<名>.md` 导航 | 脚本自带解析 |
| `.html` `.htm` | 单文件可点击原型：HTML 原件（进 `SplittingObject/`）+ `_manifest_<名>.md` 校验摘要 | 脚本自带解析 |
| `.md` `.csv` `.json` `.txt` `.yaml` `.xml` | 原样拷贝 | — |
| `.png` `.jpg` `.gif` `.webp` | 拷到 `assets/未分类/` | — |

**老格式**：`.doc` `.ppt` 由 anydoc 本地转换，不用另存为；`.xls` 走脚本自带的 BIFF8 解析器。
只有 `.wps` `.et` `.dps`（金山私有格式）会被跳过并在台账里标记，请先用 Office / WPS
另存为新格式。（anydoc 不可用时 `.doc` `.ppt` 也会退回这条提示。）

## PDF / PPTX 引擎

**PDF 默认走本地 anydoc**，不联网、不外发。anydoc 还原中文码位和标题层级，
也撑得住几百页的规程——MinerU 的 200 页上限在这条路径上不再挡路。

它做不到的三件事，就是 MinerU 必须留着的理由：PDF 里的图一张都拿不到、不做 OCR、
封面 / 目录 / 多栏这类页的版式启发式会翻车。所以：

- 扫描件：anydoc 报错后，配了 `MINERU_API_KEY` 就自动升级 MinerU OCR；没配就记 `⚠ 扫描件需 OCR`
- 要抽图、要公式、版式复杂：`--pdf-engine mineru`
- PPTX：默认仍走 MinerU（抽图）；没 key 时兜底 anydoc

配置 MinerU（可选）：

```bash
cp .env.example .env       # 然后把 token 填进 MINERU_API_KEY
```

Token 在 <https://mineru.net/apiManage> 创建。`.env` 已在 `.gitignore` 里，不会入库。

**没配 key 也能用**：PDF 走本地 anydoc。想明确控制用哪个引擎：

```bash
python3 scripts/ingest.py --pdf-engine anydoc       # 强制本地，不外发文件（也是默认）
python3 scripts/ingest.py --pdf-engine mineru       # 强制在线（没 key 会明确报错）
python3 scripts/ingest.py --ocr                     # 扫描版 PDF，让 MinerU 走 OCR
python3 scripts/ingest.py --model-version vlm       # 版式特别复杂时换模型试试
```

MinerU 的实际限制：单文件 200MB / 200 页，免费额度 1000 页/天，一批最多 200 个文件。
超限脚本会在上传前就拦住并说清原因。整批解析是异步的，脚本会打印轮询进度。

**默认不外发文件。** 只有 `--pdf-engine mineru` 或扫描件自动升级才会把资料传到 MinerU 服务器。
涉密资料保持默认即可，或者先脱敏。这是这个模版里唯一会把资料外发的环节。

## 点表批量归一

电力 / 工控项目常会收到**成百上千个同构的点表小文件**（测点清单）。逐个转换没有意义，
价值在汇总后**能按测点检索**，所以点表走单独的 `scripts/pointtable.py`：

```bash
python3 scripts/pointtable.py                  # 自动发现 input/raw/ 下的点表目录（幂等）
python3 scripts/pointtable.py --dry-run        # 先看识别结果
python3 scripts/pointtable.py input/raw/集控点表 # 只处理指定目录
python3 scripts/pointtable.py --force          # 强制重建
```

靠**内容**识别而不是扩展名（parser 可插拔，见脚本里的 `PARSERS`）：

| parser | 形态 | 典型来源 |
| --- | --- | --- |
| `hydro_xls` | 表格型 `.xls`/`.xlsx`，首行表头 + 数据行，设备层级来自**目录路径** | 水电集控（模拟量/开关量/SOE量/温度量） |
| `scada_ini` | 分段型 `.txt`，`[RTU]`/`[遥信]`/`[遥测]` 分段，GBK 与 UTF-8 混杂 | 风电 / 光伏集中监控 |

产物在 `output/converted/<点表集名>/`：`_manifest_<点表集名>批量处理.md`（台账，看板预览点这个）、
`MergedObject/测点主表.csv`（全量 18 列，含源文件 + 源行号）、`MergedObject/分册/<厂站>.csv`、
`MergedObject/测点.sqlite`（建好索引，**按测点检索一律走 SQL**）：

```bash
sqlite3 output/converted/集控点表/MergedObject/测点.sqlite \
  "SELECT 厂站,设备分区,测点描述,测点地址 FROM 测点
   WHERE 测点描述 LIKE '%水位%' AND 是否备用='' LIMIT 20;"
```

`ingest.py` 识别到点表就让路；点表目录里的普通表格仍由 `ingest.py` 按 sheet 转 CSV。
整个目录被 `.ingestignore` 忽略时 `pointtable.py` 直接跳过，不逐个读文件头。

**边界**：只做格式归一，**不做**设备树绑定、间隔匹配、测点编码生成（那些依赖每个厂站的解析规则表，
属于工程侧数据接入）。分段型点表的「设备名」是启发式推断的，写进正式文档前按解析规则核对并标 `[推断]`。

## 产物里的 frontmatter

每个 `.md` 产物开头都有一段元数据，这是溯源链的关键：

```yaml
---
source: input/raw/需求规格说明书.docx   # 原始文件在哪
source_sha256: 2edc8fbb0f8ca20…        # 内容指纹，用于判断资料是否被换过版本
converted_by: anydoc 0.2.3 writer       # 谁转的
converted_at: 2026-07-30T11:26:13+08:00
kind: document
---
```

CSV 不加 frontmatter（会破坏解析），元数据在同目录的 `_manifest.md` 里。

`source_sha256` 的实际用途：对方团队第二次发来「最终版」时，指纹一比就知道内容到底改没改，
不用逐页读。脚本也靠它做幂等——没变化的文件不重转。

## 常见情况

**扫描版 PDF**：默认就会自动升级 MinerU OCR（配了 key 的话）；没配 key 时台账记
`⚠ 扫描件需 OCR`，不算失败。也可以加 `--ocr` 重跑。
如果连 OCR 都识别不出内容，产物 frontmatter 会带 `warning`——这类资料 AI 实际读不到，
要找对方要电子版，不要假装它已经进来了。

**同一份文档多个版本**：都放进来，在 `INDEX.md` 的「人工批注 → 权威版本」里写明以哪份为准。
版本冲突本身就是接手阶段要暴露的风险。

**资料涉密**：`input/raw/`、`input/assets/` 默认整目录不入库，Office 文档、PDF 与图片在任何目录都不入库；
但 `output/converted/` 下的 `.md` 转换产物仍在版本控制内——按需要一并处理。
