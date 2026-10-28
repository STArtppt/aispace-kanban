## Why

不做的话，「把同事发来的 Word 套成我的模板」只能绕路：原件放进 `input/raw/` → 看板「转 AI 易读」→
**手动**把转出的 `.md` 挪到 `output/docs/` → 再在产出列表「转成 Word」。挪文件这一步看板做不了，
而且挪过去之后，同事的稿子就混进了「我的产出」，参与搜索、完整度、产出记录，实际上它不是我写的。
另外，原稿直接转出的 `.docx` 现在落在原稿旁边（`output/docs/a.docx`），交付稿各版的 `.docx` 却在
`output/delivery/` 里：**交出去的 Word 分散在两处**，找「这份文档发出去的是哪个文件」要翻两个目录。

## What Changes

- **转 Word 的成品统一落交付稿镜像目录**。`md2docx.py` 按来源算落点：
  - 产出三组原稿 `output/<组>/<子路径>.md` → `output/delivery/<组>/<子路径>/<基名>.docx`（**改动**：原来落在原稿旁边）；
  - 交付稿 `output/delivery/<组>/<子路径>/v<序号>.md` → 同目录 `v<序号>.docx`（不变，本来就在镜像目录里）；
  - 输入转换产物 `input/converted/<子路径>.md` → `output/delivery/converted/<子路径>/<基名>.docx`（**新增**）；
  - 其他位置的 `.md`（只有命令行会传）→ 仍落在 `.md` 旁边，与现在一致。
  「重新转换」时把上一份改名归档的规则不变，只是发生在新落点。
- **原稿旁的旧 `.docx` 原地不动**，看板不搬、不删。阅读器判断「已转过」时**镜像目录优先，找不到再看原稿旁边**；
  只有旧位置有成品时，「预览 Word」打开旧的那份，「重新转换」直接写到镜像目录（新位置没有同名文件，不触发归档）。
- **输入转换产物的预览加一条交付稿栏**：阅读器打开 `input/converted/` 下的单文件 `.md`（如
  `input/converted/需求调研/调研结果交付件/<名>.md`）时，预览顶栏下出现交付稿栏，**只有「转成 Word / 预览 Word / 重新转换」**，
  沿用现有弹窗（选模板、复制提示词）。去 AI 味、批注、版本、定稿**本次不做**，按钮不出现。
- 产出列表「更多 → 转成 Word」与阅读器版本条的目标文件显示、成功 toast 的「预览」都改按新落点。
- 工作空间模板同步：`md2docx.py` 落点规则、模板 `AGENTS.md`、`output/delivery/README.md` 的目录说明；完成后推到已登记实例。

## ⚠ 修改一条工作空间写入例外（需要拍板）

改的是**不变量 1 第九条**（spawn 族，看板仍然只 spawn `md2docx.py`，自己不写一个字节），范围有两处变化：

- **④ 来源扩大**：可转换的 `.md` 增加 `input/converted/` 下的单文件 `.md`，仍只用扫描下发的 `docKey` 指定，请求不带任何路径。
  `_manifest_*.md`（新布局的摘要入口）、目录型产物、`.csv` 不在范围内。
- **⑤ 写入位置改变**：`md2docx.py` 从「只写 `.md` 同目录同基名的 `.docx`」改为「只写按上面规则算出的落点」。
  对输入转换产物，落点**必须**在 `output/delivery/converted/` 下 —— `input/` 一个字节都不写（这是硬约束，不是默认值）；
  脚本按需建镜像目录。归档改名、不覆盖别人的文件（生成标记判定）规则原样适用于新落点。
- **旧脚本保护**：工作空间的 `md2docx.py` 还是旧版（不认识新落点规则）时，服务端 MUST 先 400（`old-script`）说明先更新模板，
  不得 spawn —— 否则旧脚本会把输入资料的 `.docx` 写进 `input/converted/`。

## Capabilities

### New Capabilities

- `converted-docx-export`：输入转换产物在阅读器里的交付稿栏（只含 Word 三个按钮）、可转换范围、落点与降级。

### Modified Capabilities

- `md-docx-export`：「同目录同基名」改为「交付稿镜像目录」；增加旧位置兼认；旧脚本保护扩到所有来源。

## Impact

- **templates**：`templates/pm-aispace/scripts/md2docx.py`（落点规则、帮助文字）、`templates/pm-aispace/AGENTS.md`、
  `templates/pm-aispace/output/delivery/README.md`；合成回归语料（如有对落点的断言）。
- **服务端**：`scan.mjs`（`docKey` 第四类来源 `converted-md`、落点规则函数）、`docxTools.mjs`（反查范围、目标存在判定、旧脚本检测）、
  `deai.mjs`（交付稿列表的 `sourceDocx` 改为镜像优先 + 旧位置兜底；输入来源返回只含 Word 信息的列表）。
- **契约 `src/app/lib/api.ts`**：输入转换产物条目多一个可选 `docKey`；交付稿列表多一个可选 `sourceKind`；均为可选字段，旧服务缺字段时退回改动前行为。
- **前端**：`Reader.tsx`、`DeliveryBar.tsx`（Word-only 形态）、`DocxExportDialog.tsx`（目标文件显示）、`lib/deaiPrompt.ts` 或新的落点工具函数。
- **CLI**：不动。**新依赖**：无。
- **AGENTS.md**：不变量 1 第九条 ④⑤ 改写。
