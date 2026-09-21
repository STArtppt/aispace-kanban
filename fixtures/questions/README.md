# 未决问题字段契约的回归语料

`templates/pm-aispace/scripts/check_questions.py` 的基线用件。
跑 `pnpm test:questions`（= `node scripts/check-questions.mjs`）比对两头：
`valid/` 必须零错误，`invalid/` 必须**每一类非法组合各被检出一条**。

**只放合成件。** 真实客户资料一律不入库 —— 本仓已开源，进了 git 历史删不干净。
下面这些条目里的电站名、指标、日期都是照着真实工作空间的**形状**编的，内容全是假的。

字段契约本身在
[`templates/pm-aispace/output/questions/README.md`](../../templates/pm-aispace/output/questions/README.md)。
**契约变了，这里的语料和 `scripts/check-questions.mjs` 里的 `EXPECTED_BAD` 要一起改。**

## `valid/` —— 八份，覆盖全部取值

| 文件 | `status` | `evidence` | `human_answer` | 还覆盖什么 |
| --- | --- | --- | --- | --- |
| `Q0001.md` | `open` | — | `ask` | `due` 已填；正文四节齐全 |
| `Q0002.md` | `pending_ai` | — | `verify` | 闭环枢纽状态 |
| `Q0003.md` | `answered` | `资料实证` | `verify` | `ai_source` 是**列表**形态；`flows_to` 空 = 结论未回流正文 |
| `Q0004.md` | `answered` | `客户确认` | `ask` | `flows_to` 已填；`due` 已过 |
| `Q0005.md` | `answered` | `我方决策` | `decide` | 指向 `output/decisions/` 的决策记录 |
| `Q0006.md` | `dropped` | — | `drop` | `blocks: backlog`（不在主视图露面） |
| `Q0007.md` | `conflict` | — | — | `blocks` **空值**（迁移出来的待归类）；正文里嵌了一张带 `|` 的原始表格 |
| `Q0008.md` | `open` | `我方推断` | `verify` | 推断停在 `open` 当待验证假设 —— 合法的那一半 |

## `invalid/` —— 每份一类非法组合

| 文件 | 故意犯的错 |
| --- | --- |
| `Q9001.md` | `我方推断` + `answered` —— 拿推断关掉问题，整份契约就是为了防它 |
| `Q9002.md` | 缺必填字段 `asked_of` 与 `source`（一份文件里两条错） |
| `Q9003.md` | `human_answer: ask` 却没填 `due` |
| `Q9004.md` | `status` 写了枚举外的中文 |
| `Q9005.md` | `evidence` 写了四值之外的东西 |
| `Q9006.md` | `answered` 却没写 `evidence` |
| `Q9007.md` | `id` 与文件名对不上 |
| `Q9008.md` | `due` 用了 `YYYY/MM/DD` |
| `Q9009.md` | 整份没有 front-matter |
| `Q9010.md` | `human_answer` 写了四值之外的值 |
| `随手记的笔记.md` | 文件名不是 `Q<四位编号>.md` —— 只警告，不算错误 |

## 加一类校验时

1. 在 `invalid/` 加一份合成件，文件名接着 `Q90xx` 往下编；
2. 在 `scripts/check-questions.mjs` 的 `EXPECTED_BAD` 里加一行；
3. `pnpm test:questions`。

漏了第 2 步会被「多检出一条没预期的」挡下来 —— 那道断言是双向的，
既防漏检也防校验脚本乱报。
