# workspace-agent-boundary

## Purpose

工作空间智能体只读公开 GitHub 仓库、不写看板源码；看板缺陷和可推广改进都经 `output/feedback/` 反馈单交接，由看板仓库会话闭环；新建工作空间时生成禁写看板源码（含 `templates/`）的规则。

## Requirements

### Requirement: 工作空间智能体对看板源码只读，且从 GitHub 读

模板 `templates/pm-aispace/AGENTS.md` SHALL 规定：工作空间智能体查看板怎么渲染时，缺省读公开仓库
`https://github.com/STArtppt/aispace-kanban`（网页或 `raw.githubusercontent.com`），
不去读本机的看板仓库或 npm 包目录，也 MUST NOT 修改看板的任何源码。

仅当模板更新脚本的本机条件成立（`runtime.json` 的 `launch` 为 `source`，且 `instances` 含本工作空间）时，允许两件事：

- `scripts/template_update.py` 读取 `repoRoot` 下的模板目录；
- 智能体阅读这份正在运行的源码，以核对当前看板行为。

除此以外 MUST NOT 读取本机看板仓库或 npm 包目录。任何情况下 MUST NOT 修改看板源码（含 `templates/`）。
模板里凡是提到看板源码文件的地方，SHALL 写成 GitHub 链接，不写本机路径。

#### Scenario: 模板里没有指向本机看板源码的引用

- **WHEN** 在 `templates/pm-aispace/` 下搜索 `src/server/`、`src/app/`
- **THEN** 每一处都出现在 GitHub 链接里，或出现在「去哪查」表格的路径列（表头已说明要拼到 GitHub 地址上）

#### Scenario: 智能体发现显示不对

- **WHEN** 本机条件不成立，智能体按模板说明排查某份文档在看板上的显示问题
- **THEN** 它先对照「现在可用 / 不要依赖这些」改文档写法；需要看渲染逻辑时读 GitHub，不在工作空间外发起读或写

#### Scenario: 本机条件成立时核对正在跑的版本

- **WHEN** 本机条件成立，智能体要核对看板当前怎么渲染
- **THEN** 它可以读 `repoRoot` 所指的源码目录，且不修改该目录里的任何文件

#### Scenario: 本机条件成立也不写看板仓库

- **WHEN** 本机条件成立，智能体确认要改看板才能修好显示
- **THEN** 它只在工作空间写反馈单，源码目录没有任何变化

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

看板仓库的 `AGENTS.md` SHALL 写明怎么处理反馈单：当作需求输入，按本仓的流程处理（是否立 change、验证、提交），
写进本仓的产物之前先按公开仓库脱敏红线处理。

`runtime.json` 的 `launch` 为 `source` 时，源码仓库里的会话 SHALL 直接读取 `instances` 所列工作空间中的 `output/feedback/`，
用户不必先把文件拷来，也不必发邮件。`launch` 不是 `source` 时，仍按用户把反馈单带过来处理。

贡献单 SHALL 另按 `template-contribution` 的步骤合并进 `templates/pm-aispace/`。

处理完给出一段回执，由用户转给工作空间智能体，智能体回写状态：

- 缺陷单：结论 + 提交号，或不修的理由；智能体回写后撤掉临时绕法；
- 贡献单：结论 + 模板里的位置 + 提交号，或不收的理由；智能体回写后补记上游编号。

看板仓库这边的会话 MUST NOT 直接写工作空间文件。唯一例外：`launch` 为 `source` 时，在用户确认计划之后运行该实例自己的 `scripts/template_update.py apply --plan <计划文件>`（写盘的是工作空间脚本）；MUST NOT 运行 `apply --resolved`，冲突与 seedOnly 新版交回工作空间智能体。

#### Scenario: 修复完成

- **WHEN** 看板仓库这边修好了缺陷单描述的问题，并且已经提交
- **THEN** 会话给出一段可以直接转发的回执；工作空间里的反馈单由那边的智能体改成「已修复」，并记下提交号

#### Scenario: 收下一份贡献

- **WHEN** 看板仓库这边收下了一份贡献单并提交
- **THEN** 回执写明模板里的位置和提交号；这边的会话没有写工作空间里的任何文件

#### Scenario: 源码启动时直接读实例里的反馈单

- **WHEN** `runtime.json` 的 `launch` 为 `source`，某个已登记实例的 `output/feedback/` 里有一份待处理反馈单
- **THEN** 源码仓库里的会话直接读该文件并按反馈单流程处理；它不写这份反馈单；回执仍是给用户转发的文字

#### Scenario: 源码侧代跑模板更新

- **WHEN** `launch` 为 `source`，用户在源码仓库里确认了某个实例的更新计划
- **THEN** 会话运行该实例自己的 `template_update.py apply`；除脚本按计划写入的「新增」「覆盖」文件与 lock 外，工作空间没有其它变化

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
