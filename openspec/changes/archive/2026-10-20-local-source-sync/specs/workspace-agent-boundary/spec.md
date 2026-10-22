## MODIFIED Requirements

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
