# deai-workbench

## Purpose

看板只读展示去 AI 味规则库与交付稿版本。工作台有「去 AI 味」模块；阅读器对有交付稿的原稿显示版本条，可对比、批注和转 Word。复制提示词只写剪贴板。本能力由 `docx-front-matter-and-deai` 变更落地。

## Requirements

### Requirement: 服务端只读读取规则库

服务端 SHALL 提供 `GET /api/projects/:id/deai/rules`：读工作空间 `.claude/skills/pm-deai-writing/rules/`，返回
`installed`（技能目录是否存在）、`version`、`updated`、`rules`（每条：编号、短名、类别、状态）、`versions`（`history/` 下已有的版本号及文件修改时间，按版本倒序）、
`changelog`（`CHANGELOG.md` 原文）。另提供 `GET /api/projects/:id/deai/rules/versions/:n` 返回某一版快照原文，`:n` MUST 是正整数，否则 400。
两个接口只读，路径 MUST 过 `resolveInside()`；规则库解析不出来的条目跳过并在 `warnings` 里说明，不让整个接口失败。

#### Scenario: 旧工作空间

- **WHEN** 工作空间没有 `.claude/skills/pm-deai-writing/`
- **THEN** 接口返回 200 与 `installed: false`，其余字段缺省

#### Scenario: 非法版本号

- **WHEN** 请求 `…/deai/rules/versions/..%2F..%2Fproject`
- **THEN** 接口返回 400，不读任何文件

### Requirement: 服务端列出交付稿版本

服务端 SHALL 提供 `GET /api/projects/:id/delivery?docKey=<原稿 docKey>`：用 `docKey` 在产出三组的 `.md` 里反查出原稿，
读 `output/delivery/<对应目录>/` 下的 `v<序号>.md`，返回每一版的 `version`、`path`、`docKey`、`created`、`basedOn`、`notes`、`rulesVersion`、`hits`、`note`，
以及两个判定：`sourceChanged`（原稿当前全文摘要与 `source_sha` 不同）、`directlyEdited`（当前正文摘要与 `body_sha` 不同，即有人绕过批注直接改了文件）。
没有交付稿时返回空列表。接口只读，不接受路径参数。
扫描 SHALL 给 `output/delivery/**` 下的 `v<序号>.md` 下发 `docKey`，这些文件不进入产出列表、全局搜索和完整度统计。

#### Scenario: 原稿之后又改过

- **WHEN** `v001.md` 生成后，原稿又被 AI 改了一段
- **THEN** 这一版返回 `sourceChanged: true`

#### Scenario: 旧服务进程

- **WHEN** 前端已更新、服务进程是旧版，这个接口 404
- **THEN** 阅读器不显示版本条，不报错；产出条目的「去 AI 味…」照常可用（它只复制提示词）

### Requirement: 工作台「去 AI 味」模块

工作台 SHALL 有「去 AI 味」模块页，分三块：

1. **规则库**：顶部显示当前版本与更新日期；按类别分组列出规则（编号、短名、状态，停用的置灰），点开一条显示完整的判据、反例、正例；
2. **版本与变更**：左列是版本列表，右侧显示该版的 CHANGELOG 小节；任选两个版本可以查看两版全文的差异（按行对比，行内按字高亮）；
3. **提示词**：三张卡片。「给文档去 AI 味」可以从产出文档列表里选一份原稿，提示词里带上它的路径，未选时提示词让 AI 先问要处理哪一份；
   「规则库体检」直接复制；「批注 → 修改 → 沉淀」是说明卡：讲清这条工作流，列出还有待处理批注的交付稿，点一项跳到阅读器里那一版。
   规则详情里的「来源」若是批注编号，显示为可点的链接，跳到对应交付稿版本的批注清单。

复制提示词只写剪贴板，MUST NOT 发出任何写请求。`installed: false` 时整页只显示说明与「复制提示词：从模板补齐技能」。

#### Scenario: 查看某次变更

- **WHEN** 用户在版本列表里点「v4」
- **THEN** 右侧显示 CHANGELOG 里「v4」那一节，来源里的批注编号可点；选择「与 v3 对比」后看到新增规则那几行以新增色高亮

#### Scenario: 复制去味提示词

- **WHEN** 用户在「给文档去 AI 味」卡片里选中 `output/docs/方案/总体设计.md` 并点「复制提示词」
- **THEN** 剪贴板里有原稿路径、规则库路径与当前版本、下一版交付稿的路径、「不改原稿、事实数字不变、依据集中到文末」这些要求，以及写完后的自检清单；网络面板里没有写请求

### Requirement: 产出条目的「去 AI 味…」

产出视图里 `.md` 条目的「更多」菜单 SHALL 有「去 AI 味…」：点击后复制针对这份原稿的去味提示词，toast 提示「已复制，粘贴给工作空间 AI」。
技能未安装时提示词改为先补齐技能。

#### Scenario: 从列表发起

- **WHEN** 用户在 `output/docs/a.md` 行点「更多 → 去 AI 味…」
- **THEN** 剪贴板里是针对 `output/docs/a.md` 的去味提示词，toast 出现

### Requirement: 阅读器的交付稿版本条

阅读器打开产出三组里的某份原稿时，若它有交付稿，SHALL 在顶部显示版本条：「原稿 · v001 · v002 …」可切换阅读；
每个版本旁标出 `rules_version`、命中统计，以及由哪些批注修订而来；`sourceChanged` 的版本用 orange 标「原稿已更新」，
`directlyEdited` 的版本用 orange 标「被直接改过」（提醒改交付稿应走批注），还有待处理批注的版本用中性灰标「N 条待处理」。
版本条 SHALL 提供：「与原稿对比」「与上一版对比」（`based_on` 那一版与当前版本，看这一轮批注改了什么）、「批注」（进入批注模式，见下一条）、
「转成 Word」（作用于当前版本）。
差异视图按段对比、段内按字高亮，未变的长段落默认折叠；文档超过 2000 行时只做按段对比并说明。
没有交付稿时不显示版本条。

#### Scenario: 切换版本

- **WHEN** 原稿有 `v001`、`v002` 两版交付稿，用户在版本条点「v002」
- **THEN** 阅读区显示 `v002.md` 的渲染结果，版本条上 v002 为选中态，旁边显示「规则 v3 · 命中 57 处」

#### Scenario: 看这一轮批注改了什么

- **WHEN** `v002` 是按 `v001` 上的三条批注修订出来的，用户选中 v002 点「与上一版对比」
- **THEN** 差异视图左边是 v001、右边是 v002，版本条上 v002 旁写着「由 N0001–N0003 修订」

#### Scenario: 被直接改过

- **WHEN** 有人没写批注，直接改了 `v001.md`
- **THEN** v001 旁出现 orange 的「被直接改过」，悬停说明「改交付稿请走批注，直接改动不会沉淀成规则」

#### Scenario: 工作空间目录丢失

- **WHEN** 当前工作空间 `available === false`
- **THEN** 不请求交付稿接口，不显示版本条

### Requirement: 在交付稿上批注

阅读器正在显示某一版交付稿时，SHALL 可以进入批注模式，交互与产出文档上的批注一致（`preview-annotation`）。
落点由服务端按「镜像路径 → 原稿 → 原稿记录」解析（见 `annotation-status-loop`）；原稿没有记录时照现有规则退回看板缓存并说明。
这时组装出的提示词 SHALL 换成交付稿专用版本，在通用的批注提示词之外还写明：
批注针对的是哪一版；要以它为底改出下一版（给出下一版的路径），不改它本身；同一轮里判断哪些批注可推广并沉淀进规则库、只升一个版本；
回写时对沉淀过的批注在回执末尾加「沉淀为 R<编号>（规则库 v<版本>）」；最后跑一遍技能的自检清单。

#### Scenario: 在 v001 上批注

- **WHEN** 用户在版本条选中 v001、进入批注模式写两条批注并复制提示词，原稿的记录是 `I0007`
- **THEN** `output/records/notes/I0007.md` 末尾多出一批，批次里注明对象是交付稿 v001；剪贴板里的提示词要求改出 `v002.md` 并同步沉淀
- **AND** `v001.md` 与原稿一个字节都没变

#### Scenario: 原稿没有记录

- **WHEN** 原稿还没建记录，用户在它的交付稿上写批注并复制
- **THEN** 批注退回看板缓存，提示词不含回写段，并说明「让 agent 先给原稿建记录」
