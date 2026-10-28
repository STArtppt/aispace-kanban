## ADDED Requirements

### Requirement: 可转换的输入转换产物

`input/converted/` 下**单文件形态**的 `.md`（一源一产物，文件自己就是全部）SHALL 带服务端下发的 `docKey`，作为「转成 Word」的来源。
以下 MUST NOT 带 `docKey`：`_manifest_*.md` 摘要入口、目录型产物及其内部文件、`.csv` 等非 `.md`、`input/raw/` 里的原件。
服务端用 `docKey` 反查时 SHALL 只在这一类里找，产出、交付稿、原件的键互相换不来路径。

#### Scenario: 单文件产物带键

- **WHEN** 扫描到 `input/converted/需求调研/调研结果交付件/实施方案.md`
- **THEN** 输入列表里这一条带 `docKey`

#### Scenario: 摘要入口不带键

- **WHEN** 扫描到 `input/converted/某资料/_manifest_某资料.md`
- **THEN** 这一条没有 `docKey`，阅读器里不出现交付稿栏

### Requirement: 输入转换产物的交付稿栏

阅读器打开带 `docKey` 的输入转换产物时，预览顶栏下方 SHALL 出现交付稿栏，与产出原稿的交付稿栏同一外观，但**只有** Word 相关按钮：
`output/delivery/converted/<子路径>/<基名>.docx` 不存在时是「转成 Word」，存在时是「预览 Word」与「重新转换」（无生成标记时置灰并说明原因）。
栏内 MUST NOT 出现版本标签、去 AI 味、批注、对比、定稿；说明文字写明成品放在哪个目录。
「转成 Word」打开与产出视图相同的弹窗（选模板、复制提示词），目标文件显示为镜像落点；
复制的提示词里的命令同样是 `python3 scripts/md2docx.py <来源路径> --template <模板>`，并说明成品落在 `output/delivery/converted/` 下。

#### Scenario: 转换同事的方案

- **WHEN** 用户在输入列表点开 `input/converted/需求调研/调研结果交付件/实施方案.md` 的 markdown 预览，在交付稿栏点「转成 Word」并选客户模板
- **THEN** 生成 `output/delivery/converted/需求调研/调研结果交付件/实施方案/实施方案.docx`；`input/` 下没有任何新文件；交付稿栏变成「预览 Word」与「重新转换」

#### Scenario: 预览成品

- **WHEN** 成品已存在，用户点「预览 Word」
- **THEN** 阅读区就地显示这份 Word 的分页版式，再点回到 markdown 正文

### Requirement: 输入侧交付稿栏的降级

输入转换产物的交付稿栏 SHALL 只在条件都满足时出现，否则不出现、不报错：
工作空间可用（`available !== false`）；条目带 `docKey`（旧服务进程不给）；服务端交付稿列表接口认这个键。
交付稿列表接口对输入来源 SHALL 返回 `sourceKind: 'input'`、空的 `versions`、`sourceDocx`，不返回 `final` / `recordId`。
服务端是旧进程、对输入的键返回 400 时，前端 SHALL 当作没有交付稿栏处理。
转换的失败与降级（缺脚本、缺 Python、缺 pandoc、模板不在、旧脚本、非环回）与产出视图一致。

#### Scenario: 旧服务进程

- **WHEN** 前端已更新、服务进程还是旧的，用户打开一份输入转换产物
- **THEN** 预览与改动前一样，没有交付稿栏，不白屏

#### Scenario: 工作空间目录丢失

- **WHEN** 当前工作空间 `available === false`
- **THEN** 阅读器不请求交付稿接口，不出现交付稿栏

#### Scenario: 旧脚本不会写进 input

- **WHEN** 工作空间的 `md2docx.py` 是旧版，用户对输入转换产物点「转换」
- **THEN** 接口返回 400 说明先更新模板，`input/converted/` 下没有出现 `.docx`
