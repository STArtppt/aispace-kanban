## REMOVED Requirements

### Requirement: 模板同步回看板仓库有明确的写入范围

**Reason**：这条允许工作空间智能体写看板仓库 `templates/<本模板目录>/`，只在维护者本机有可写的看板仓库时成立。
通过 npm 安装看板的用户没有这个仓库，公开仓库也不该被各个工作空间直接写。

**Migration**：模板 AGENTS.md 删掉「模板改动回同步源」一节。实例里沉淀出的通用改进改为写 `kind: contribution` 的反馈单（见 `template-contribution`），由看板维护者合并回模板源。
已有工作空间重跑补规则开关，就会补上对 `templates/` 的禁写。

## MODIFIED Requirements

### Requirement: 看板缺陷通过反馈单交接

模板 SHALL 定义反馈单：放在 `output/feedback/`，一份一个 `F<四位编号>.md`，分缺陷单（`kind: bug`，缺省）与贡献单（`kind: contribution`）两种。

两种都 MUST 包含：
- 字段 `status`（`pending` / `fixed` / `wontfix`）、`receipt`、`sent_at`；
- 一节「## 发送记录」。

缺陷单 MUST 另有以下几节：
- 现象；
- 期望；
- 最小复现；
- 疑似源码位置（GitHub 链接）；
- 建议改法（只写文本或 diff，不落到看板仓库）；
- 临时绕法。

贡献单的节见 `workbench-feedback`。
最小复现与合成示例 MUST 是合成的片段，不带工作空间里的真实资料内容。
智能体写完 SHALL 在回复里告诉用户反馈单路径；缺陷单还要说明已经用什么办法临时绕过。
回执回写 MUST 只改 `status` 和 `receipt`，不改 `sent_at` 和发送记录。

#### Scenario: 真的需要改看板才能解决

- **WHEN** 智能体确认问题出在看板渲染上，改文档写法只能绕开、不能根治
- **THEN** 工作空间里的文档按绕法改好；`output/feedback/` 下多了一份字段齐全的缺陷单；看板仓库没有任何变化

#### Scenario: 看板只在工作台反馈单页读取

- **WHEN** 工作空间里有 `output/feedback/F0001.md`，根目录下还有旧的 `.kanban-feedback/`
- **THEN** 产出列表、搜索和完整度统计都不出现这些内容；工作台的反馈单页能打开 `F0001`，旧目录只显示份数、不显示正文

#### Scenario: 改进了一个模板技能

- **WHEN** 智能体在工作空间里给某个模板技能补了一条通用说明
- **THEN** `output/feedback/` 下多了一份贡献单；看板仓库没有任何变化

### Requirement: 反馈单在看板仓库这边闭环

看板仓库的 `AGENTS.md` SHALL 写明怎么处理用户带过来的反馈单：当作需求输入，按本仓的流程处理（是否立 change、验证、提交），
写进本仓的产物之前先按公开仓库脱敏红线处理。

贡献单 SHALL 另按 `template-contribution` 的步骤合并进 `templates/pm-aispace/`。

处理完给出一段回执，由用户转给工作空间智能体，智能体回写状态：
- 缺陷单：结论 + 提交号，或不修的理由；智能体回写后撤掉临时绕法；
- 贡献单：结论 + 模板里的位置 + 提交号，或不收的理由；智能体回写后补记上游编号。

看板仓库这边的会话 MUST NOT 直接写工作空间文件。

#### Scenario: 修复完成

- **WHEN** 看板仓库这边修好了缺陷单描述的问题，并且已经提交
- **THEN** 会话给出一段可以直接转发的回执；工作空间里的反馈单由那边的智能体改成「已修复」，并记下提交号

#### Scenario: 收下一份贡献

- **WHEN** 看板仓库这边收下了一份贡献单并提交
- **THEN** 回执写明模板里的位置和提交号；这边的会话没有写工作空间里的任何文件

### Requirement: 新建工作空间时生成禁写看板源码的规则

`templates/init_workspace.py` 新建工作空间时 SHALL 在 `<工作空间根>/.claude/settings.local.json` 的 `permissions.deny` 里，
为看板根目录下的每个顶层条目各写一条 `Edit(//<绝对路径>/**)`（文件就写文件本身），`templates/` 也在内，不再为本工作空间所用的模板留出例外。
文件已存在时 MUST 合并去重，不删除已有条目，也不改动其他字段。
脚本 SHALL 提供一个只做这一步的开关，给已有工作空间补规则；这个开关不复制或新建任何其他文件。
模板 `.gitignore` SHALL 忽略 `.claude/settings.local.json`，因为里面是本机绝对路径。

#### Scenario: 新建工作空间

- **WHEN** 在看板上点「新建」，或在命令行运行 `init_workspace.py --from templates/pm-aispace --name 示例 --path <目录>`
- **THEN** `<目录>/.claude/settings.local.json` 里有指向看板 `src`、`bin`、`templates` 等条目的 deny 规则

#### Scenario: 给已有工作空间补规则

- **WHEN** 对一个已有、并且已经有 `settings.local.json`（里面有用户自己的 allow，和旧版只放行本模板的 deny 规则）的工作空间运行补规则开关
- **THEN** 对 `templates` 的 deny 被合并进去，原有条目和用户的 allow 不变；重复运行结果一样

#### Scenario: 模板来自用户自建目录

- **WHEN** `--from` 指向看板仓库以外的模板目录
- **THEN** 看板仓库的所有顶层条目，包括 `templates`，都写进 deny
