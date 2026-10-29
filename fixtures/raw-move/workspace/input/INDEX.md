# 资料台账 INDEX

由 `scripts/ingest.py` 于 2026-01-01 00:00 生成。**不要手改本文件的表格**，重跑脚本会覆盖；
要补充人工判断（是否权威版本、责任人、遗留疑问）请写在下方「人工批注」区。

| 原始文件 | 类型 | 产物 | 状态 |
| --- | --- | --- | --- |
| `input/raw/readme.docx` | richdoc | [`../output/converted/readme.md`](../output/converted/readme.md) | ✓ 已转换 |
| `input/raw/冲突/说明.docx` | richdoc | [`../output/converted/冲突/说明.md`](../output/converted/冲突/说明.md) | ✓ 已转换 |
| `input/raw/批次甲/说明.docx` | richdoc | [`../output/converted/批次甲/说明.md`](../output/converted/批次甲/说明.md) | ✓ 已转换 |
| `input/raw/测点表/` | 点表 ×2 | [`../output/converted/测点表/_manifest_测点表批量处理.md`](../output/converted/测点表/_manifest_测点表批量处理.md) | ✓ 已汇总为测点主表 |
| `input/raw/现场数据/实时.csv` | 现场实测数据 | [`../output/converted/现场数据/_manifest_实时.md`](../output/converted/现场数据/_manifest_实时.md) | ✓ 已建成时序库 |

## 人工批注

- 权威版本：以甲方最近一次发来的为准，批次甲的说明是权威版本。
- 待澄清问题：见 [说明原件](./raw/批次甲/说明.docx)。
