## MODIFIED Requirements

### Requirement: 服务端列出交付稿版本

服务端 SHALL 提供 `GET /api/projects/:id/delivery?docKey=<原稿 docKey>`：用 `docKey` 在产出三组的 `.md` 里反查出原稿，
读 `output/delivery/<对应目录>/` 下的 `v<序号>.md`，返回每一版的 `version`、`path`、`docKey`、`created`、`basedOn`、`notes`、`rulesVersion`、`hits`、`note`，
以及两个判定：`sourceChanged`（原稿当前全文摘要与 `source_sha` 不同）、`directlyEdited`（当前正文摘要与 `body_sha` 不同，即有人绕过批注直接改了文件）。
SHALL 另外返回原稿的 `sourceDocx` 与每一版的 `docx`：同目录同名 `.docx` 的 `path`、`size`、`mtime`、`generated`（带生成标记），不存在为 `null`。
没有交付稿时返回空列表。接口只读，不接受路径参数。
扫描 SHALL 给 `output/delivery/**` 下的 `v<序号>.md` 下发 `docKey`，这些文件不进入产出列表、全局搜索和完整度统计。

#### Scenario: 原稿之后又改过

- **WHEN** `v001.md` 生成后，原稿又被 AI 改了一段
- **THEN** 这一版返回 `sourceChanged: true`

#### Scenario: 旧服务进程

- **WHEN** 前端已更新、服务进程是旧版，这个接口 404
- **THEN** 版本条只有「原稿」，Word 按钮始终是「转成 Word」，不报错；「去 AI 味…」照常可用（它只复制提示词）

### Requirement: 阅读器的交付稿版本条

阅读器打开产出三组里的 `.md` 时 SHALL 常驻版本条：「原稿 · v001 · v002 …」可切换阅读，默认选中原稿；没有交付稿时只有「原稿」。
选中原稿时，左侧说明「若要作为交付稿，可以点右侧『去 AI 味』复制提示词，发给 AI 执行，以融入个人的写作风格。」，
右侧提供「去 AI 味…」（复制针对这份原稿的去味提示词）、「批注」、Word 按钮（见 `md-docx-export`）。
选中某一版时，左侧标出 `rules_version`、命中统计，以及由哪些批注修订而来；右侧提供「与原稿对比」「与上一版对比」「批注」、Word 按钮。
`directlyEdited` 的版本用 orange 标「被直接改过」（提醒改交付稿应走批注）；还有待处理批注的版本用中性灰标「N 条待处理」；
最新一版 `sourceChanged` 时，在「原稿」上用 orange 标「被直接改过」，版本上不再标「原稿已更新」。
差异视图按段对比、段内按字高亮，未变的长段落默认折叠；文档超过 2000 行时只做按段对比并说明。

#### Scenario: 还没去过味的原稿

- **WHEN** 用户打开 `output/docs/a.md`，它还没有任何交付稿
- **THEN** 版本条只有选中态的「原稿」，右侧有「去 AI 味…」「批注」「转成 Word」

#### Scenario: 切换版本

- **WHEN** 原稿有 `v001`、`v002` 两版交付稿，用户在版本条点「v002」
- **THEN** 阅读区显示 `v002.md` 的渲染结果，版本条上 v002 为选中态，旁边显示「规则 v3 · 命中 57 处」

#### Scenario: 看这一轮批注改了什么

- **WHEN** `v002` 是按 `v001` 上的三条批注修订出来的，用户选中 v002 点「与上一版对比」
- **THEN** 差异视图左边是 v001、右边是 v002，版本条上 v002 旁写着「由 N0001–N0003 修订」

#### Scenario: 被直接改过

- **WHEN** 有人没写批注，直接改了 `v001.md`
- **THEN** v001 旁出现 orange 的「被直接改过」，悬停说明「改交付稿请走批注，直接改动不会沉淀成规则」

#### Scenario: 原稿在最新一版之后改过

- **WHEN** `v002` 生成后原稿又被改了
- **THEN** 「原稿」旁出现 orange 的「被直接改过」，v001、v002 上没有「原稿已更新」

#### Scenario: 工作空间目录丢失

- **WHEN** 当前工作空间 `available === false`
- **THEN** 不请求交付稿接口，不显示版本条

## REMOVED Requirements

### Requirement: 产出条目的「去 AI 味…」

**Reason**: 入口移到阅读器版本条的原稿态，列表行的「更多」菜单不再放这一项。

**Migration**: 打开原稿，在版本条上点「去 AI 味…」；工作台「去 AI 味」模块的「给文档去 AI 味」卡片不变。
