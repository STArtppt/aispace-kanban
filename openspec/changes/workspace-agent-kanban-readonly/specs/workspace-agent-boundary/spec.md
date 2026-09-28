## ADDED Requirements

### Requirement: 工作空间智能体对看板源码只读，且从 GitHub 读

模板 `templates/pm-aispace/AGENTS.md` SHALL 规定：工作空间智能体查看板怎么渲染时，读公开仓库
`https://github.com/STArtppt/aispace-kanban`（网页或 `raw.githubusercontent.com`），
不去读本机的看板仓库或 npm 包目录，也 MUST NOT 修改看板的任何源码。
模板里凡是提到看板源码文件的地方，SHALL 写成 GitHub 链接，不写本机路径。

#### Scenario: 模板里没有指向本机看板源码的引用

- **WHEN** 在 `templates/pm-aispace/` 下搜索 `src/server/`、`src/app/`
- **THEN** 每一处都出现在 GitHub 链接里，或出现在「去哪查」表格的路径列（表头已说明要拼到 GitHub 地址上）

#### Scenario: 智能体发现显示不对

- **WHEN** 智能体按模板说明排查某份文档在看板上的显示问题
- **THEN** 它先对照「现在可用 / 不要依赖这些」改文档写法；需要看渲染逻辑时读 GitHub，不在工作空间外发起读或写

### Requirement: 模板同步回看板仓库有明确的写入范围

「模板改动回同步源」一节 SHALL 把可写范围限定在看板仓库 `templates/<本模板目录>/` 下、与工作空间内同名的文件，
并 MUST 明确列出 `src/`、`bin/`、`scripts/`、`package.json` 等看板代码不在范围内。

#### Scenario: 智能体改了工作空间里的技能

- **WHEN** 智能体改了 `skills/pm-project-meta/SKILL.md`，按规则同步回模板
- **THEN** 它只写看板仓库的 `templates/pm-aispace/.claude/skills/pm-project-meta/SKILL.md`，然后提醒用户提交

#### Scenario: 智能体想顺手修看板代码

- **WHEN** 智能体判断问题要改 `src/**` 才能解决
- **THEN** 模板规则指向反馈单流程，而不是「模板改动回同步源」

### Requirement: 看板缺陷通过反馈单交接

模板 SHALL 定义反馈单：放在工作空间根目录 `.kanban-feedback/`，一个问题一份 `YYYY-MM-DD-<短标题>.md`。
它 MUST 至少包含这几个字段：状态（待处理 / 已修复 / 不修）、现象、期望、最小复现、疑似源码位置（GitHub 链接）、
建议改法（只写文本或 diff，不落到看板仓库）、临时绕法、回执。
最小复现 MUST 是合成的片段，不带工作空间里的真实资料内容。
智能体写完反馈单 SHALL 在回复里告诉用户反馈单路径，并说明已经用什么办法临时绕过。

#### Scenario: 真的需要改看板才能解决

- **WHEN** 智能体确认问题出在看板渲染上，改文档写法只能绕开、不能根治
- **THEN** 工作空间里的文档按绕法改好；`.kanban-feedback/` 下多了一份字段齐全的反馈单；看板仓库没有任何变化

#### Scenario: 看板不读反馈单

- **WHEN** 工作空间根目录下有 `.kanban-feedback/` 目录
- **THEN** 看板的各个视图、搜索和完整度统计都不出现它的内容（扫描本来就跳过根目录的 `.` 开头目录）

### Requirement: 反馈单在看板仓库这边闭环

看板仓库的 `AGENTS.md` SHALL 写明怎么处理用户带过来的反馈单：当作需求输入，按本仓的流程处理（是否立 change、验证、提交），
写进本仓的产物之前先按公开仓库脱敏红线处理；处理完给出一段回执（结论 + 提交号，或不修的理由），
由用户转给工作空间智能体，智能体回写状态、撤掉临时绕法。看板仓库这边的会话 MUST NOT 直接写工作空间文件。

#### Scenario: 修复完成

- **WHEN** 看板仓库这边修好了反馈单描述的问题，并且已经提交
- **THEN** 会话给出一段可以直接转发的回执；工作空间里的反馈单由那边的智能体改成「已修复」，并记下提交号

### Requirement: 新建工作空间时生成禁写看板源码的规则

`templates/init_workspace.py` 新建工作空间时 SHALL 在 `<工作空间根>/.claude/settings.local.json` 的 `permissions.deny` 里，
为看板根目录下除 `templates/` 以外的每个顶层条目各写一条 `Edit(//<绝对路径>/**)`（文件就写文件本身），
另外为 `templates/` 下除本工作空间所用模板以外的条目也各写一条。
文件已存在时 MUST 合并去重，不删除已有条目，也不改动其他字段。
脚本 SHALL 提供一个只做这一步的开关，给已有工作空间补规则；这个开关不复制或新建任何其他文件。
模板 `.gitignore` SHALL 忽略 `.claude/settings.local.json`，因为里面是本机绝对路径。

#### Scenario: 新建工作空间

- **WHEN** 在看板上点「新建」，或在命令行运行 `init_workspace.py --from templates/pm-aispace --name 示例 --path <目录>`
- **THEN** `<目录>/.claude/settings.local.json` 里有指向看板 `src`、`bin` 等条目的 deny 规则，没有指向 `templates/pm-aispace` 的规则

#### Scenario: 给已有工作空间补规则

- **WHEN** 对一个已有、并且已经有 `settings.local.json`（里面有用户自己的 allow）的工作空间运行补规则开关
- **THEN** deny 规则被合并进去，用户原来的 allow 不变；重复运行结果一样

#### Scenario: 模板来自用户自建目录

- **WHEN** `--from` 指向看板仓库以外的模板目录
- **THEN** 看板仓库 `templates/` 下的所有条目都写进 deny
