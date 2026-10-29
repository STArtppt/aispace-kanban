## MODIFIED Requirements

### Requirement: 提炼的写入边界

采集与生成（能力标识 `docx-template-refine`）MUST 满足以下边界：看板只 spawn `scripts/docx_template.py`，自己不写字节；
由用户点「开始分析」「生成模板」明确发起，文件变化不自动重跑；环回且非跨站，否则 403；请求只带 `docKey`、模板名基名与决定 JSON，
`docKey` 反查不到或决定 JSON 超过 256KB、含路径字段时 400；脚本只写 `output/docx-template/<模板名>/`。
工作空间没有该脚本、找不到 Python 3 时接口 400，界面说明出路（复制提示词让工作空间 AI 从模板补齐脚本）。

#### Scenario: 非环回监听

- **WHEN** 看板以 `--host 0.0.0.0` 启动，从另一台机器点「开始分析」
- **THEN** 接口返回 403，工作空间没有新文件；按钮置灰并说明原因，已有模板仍可浏览

#### Scenario: 重名未确认

- **WHEN** 「客户甲」已存在，有人不带 `regenerate: true` 直接调用 build
- **THEN** 接口返回 409，模板目录不变

#### Scenario: 旧工作空间缺脚本

- **WHEN** 工作空间是本 change 之前建的，没有 `scripts/docx_template.py`
- **THEN** 「开始分析」返回 400，界面说明「这个工作空间还没有 docx 工具链」并提供「复制提示词」
