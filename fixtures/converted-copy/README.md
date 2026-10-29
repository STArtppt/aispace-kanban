# converted-copy 回归语料

`scripts/check-converted-copy.mjs`(`pnpm test:converted-copy`)用它验证模板脚本
`templates/pm-aispace/scripts/copy_converted.py`:把一份转换产物 `.md` 复制进产出三组之一。

全部内容合成，不含任何真实资料。

| 文件 | 用途 |
| --- | --- |
| `output/converted/资料A/子目录/说明.md` | 主来源：有 front-matter,含指向 `input/assets/` 的图片(Markdown 与 `<img>` 两种)、同目录产物链接、外链、锚点、不存在的文件、代码块 |
| `output/converted/资料A/子目录/附录.md` | 没有 front-matter 的来源 |
| `output/converted/资料A/子目录/_manifest_表.md` + `SplittingObject/` | 目录型产物，必须被拒 |
| `output/converted/资料A/子目录/数据.csv` | 非 `.md`,必须被拒 |

图片 `input/assets/说明/p1.png` `p2.png` 不入库(工作空间模板忽略图片),由检查脚本运行时生成占位文件。
旧布局(`input/converted/`)由检查脚本把 `output/converted/` 搬过去后再跑一遍。
