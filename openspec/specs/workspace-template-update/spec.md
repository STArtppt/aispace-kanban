# workspace-template-update

## Purpose

工作空间用 `template.lock.json` 作基线，从公开仓库（或显式 `--from`）取模板，计划与执行分开，由 `pm-template-update` 技能驱动更新。

## Requirements

### Requirement: 铺设与更新都留下基线

`templates/init_workspace.py` 新建工作空间时 SHALL 写 `<工作空间根>/.aispace/template.lock.json`。内容：
- 模板 id；
- 来源（`github:<仓库>@<提交号>`，或 `local:<目录名>`，不含绝对路径）；
- 铺设时间；
- 每个已铺文件的相对路径与 SHA-256。

`template_update.py apply` 成功后 SHALL 用本次来源重写 lock，每个文件记本次模板版本的哈希；冲突文件的哈希 MUST NOT 前移。
lock 记的始终是**模板那一版**的哈希（三方合并的基线），不是工作空间文件的哈希。
模板 `.gitignore` MUST NOT 忽略 `.aispace/`。

#### Scenario: 新建工作空间

- **WHEN** 运行 `init_workspace.py --from templates/pm-aispace --name 示例 --path <目录>`
- **THEN** `<目录>/.aispace/template.lock.json` 存在，文件清单与实际铺出的文件一一对应，里面搜不到 `<目录>` 的绝对路径

#### Scenario: 看板不显示 lock

- **WHEN** 看板打开这个工作空间
- **THEN** 产出列表、搜索、原始资料里都没有 `.aispace/` 下的文件

### Requirement: 从公开仓库取模板，本地目录只作显式选项

工作空间脚本 `scripts/template_update.py` SHALL 缺省从 `https://codeload.github.com/STArtppt/aispace-kanban/tar.gz/<ref>` 下载源码包（`--ref` 缺省为 `main`），
只解出 `templates/pm-aispace/` 到系统临时目录，并记下解析出的提交号。
只有显式传 `--from <目录>` 时才读本地模板目录。脚本 MUST 只 import Python 标准库。

#### Scenario: 网络不通

- **WHEN** 本机访问不了 GitHub，运行 `python3 scripts/template_update.py plan`
- **THEN** 退出码非 0，输出一句中文说明和两条出路（设置代理；用 `--from` 指向本地模板目录），工作空间没有任何文件变化

#### Scenario: 取不到提交号

- **WHEN** 源码包下载成功，但查询提交号的接口被限流
- **THEN** 计划照常生成，来源记为 `github:<仓库>@main`，并带一条 warning 说明基线不精确

### Requirement: 按模板的 sync 段给文件分类

模板 `template.yaml` SHALL 有 `sync` 段，列出 `seedOnly`（只在新建时铺）与 `exclude`（不分发）两组路径模式。
其余被分发的文件都是「模板管理」。分类 MUST 从本次取到的模板版本里读，脚本里不写死。
`seedOnly` 至少包含 `project.yaml`、`.gitignore`、`input/.ingestignore`、`.claude/skills/pm-deai-writing/rules/**`。

#### Scenario: 规则库不被覆盖

- **WHEN** 实例的去 AI 味规则库已经演进到 v2，模板规则库是 v1 以后的新版
- **THEN** 计划里规则库文件出现在「seedOnly 有新版，未覆盖」组，附 diff；`apply` 后实例规则库一个字节没变

### Requirement: 计划与执行分开，判定以基线为准

`template_update.py plan` SHALL 只读，输出 JSON 计划，把模板管理的文件分成以下几组：

| 组 | 条件 |
| --- | --- |
| 新增 | 实例缺，lock 里也没有 |
| 覆盖 | 实例哈希等于 lock，模板有新版 |
| 保留 | 实例改过，模板没变 |
| 冲突 | 实例改过，模板也变了 |
| 模板已删除 | 模板删掉了，实例没改过的也不删 |

计划里 SHALL 带来源提交号与生成时各实例文件的哈希。

`apply --plan <文件>` SHALL 只执行「新增」和「覆盖」两组，逐个原子替换。
如果计划生成后任一涉及文件的哈希变了，MUST 拒绝执行、不写任何文件。
冲突文件 MUST NOT 被写入，也不写成带冲突标记的内容。
合并完成后，`apply --plan <计划文件> --resolved <文件>` SHALL 只把该文件在 lock 里的哈希登记为本次模板版本的哈希（「已合并到这一版」）。
不登记合并结果本身的哈希：否则下次更新会把合并结果当成「这边没改过」，直接用模板新版覆盖掉本地内容。

#### Scenario: 实例没改过的脚本

- **WHEN** 实例的 `scripts/md2docx.py` 与 lock 记录一致，模板里它有新版
- **THEN** 计划把它放进「覆盖」组；`apply` 后它与新版逐字节相同，lock 里是新哈希

#### Scenario: 两边都改过的技能

- **WHEN** 实例改过某个技能文件，模板也改了它
- **THEN** 计划把它放进「冲突」组；`apply` 后实例文件不变，lock 里仍是旧哈希；再次 `plan` 仍报冲突

#### Scenario: 合并完登记之后

- **WHEN** 智能体合并完冲突文件并 `--resolved` 登记，之后模板没再改它
- **THEN** 下一次 `plan` 把它放进「保留」组，合并结果不被覆盖

#### Scenario: 计划过期

- **WHEN** 出计划之后、`apply` 之前，用户手改了计划里要覆盖的一个文件
- **THEN** `apply` 拒绝执行并提示重出计划，工作空间没有任何文件变化

#### Scenario: 模板删掉了一个脚本

- **WHEN** 新版模板不再包含某个脚本
- **THEN** 计划在「模板已删除」组列出它，`apply` 不删除它

### Requirement: 首次接入没有基线的实例

实例没有 lock 时，`plan` SHALL 把与新版模板逐字节相同的文件记为一致，其余模板管理的文件一律列为冲突，并在计划里标明「首次接入」。
技能 SHALL 规定首次接入的判断步骤：找实例里有、模板新版里没有的内容，确认是项目专有的才保留，其余按模板新版。
合并完用 `--resolved` 登记，全部处理完后 lock 才完整。

#### Scenario: 旧实例第一次更新

- **WHEN** 一个几个月前铺出、从没更新过的工作空间运行 `plan`
- **THEN** 计划标明「首次接入」，没改过的文件大多出现在冲突组，没有任何文件在 `apply` 时被静默覆盖

### Requirement: 项目专有约定放在 AGENTS.local.md

模板 AGENTS.md SHALL 说明：本项目专有的约定写在工作空间根的 `AGENTS.local.md`，它不随模板分发、更新不覆盖。
模板 CLAUDE.md SHALL 以 `@AGENTS.local.md` 引入它。
模板 MUST NOT 自带 `AGENTS.local.md`。

#### Scenario: 没有 local 文件的实例

- **WHEN** 工作空间没有 `AGENTS.local.md`，在里面启动 Claude Code
- **THEN** 正常加载 AGENTS.md，没有报错

#### Scenario: 更新后项目约定还在

- **WHEN** 实例在 `AGENTS.local.md` 里写了本项目原型工程的位置，随后按新版模板更新了 AGENTS.md
- **THEN** `AGENTS.local.md` 不变，智能体仍能读到那段约定

### Requirement: 更新由技能驱动，先让用户确认

模板 SHALL 提供技能 `pm-template-update`，规定顺序：
1. 运行 `plan`；
2. 把计划用非工程语言列给用户（新增了哪些能力、更新了哪些工具、哪些没覆盖、为什么）；
3. 用户确认后 `apply`；
4. 逐个处理冲突，合并前后给出差异摘要；
5. 处理 seedOnly 有新版的文件；
6. 汇报。

智能体 MUST NOT 跳过确认直接 `apply`。

#### Scenario: 用户说「更新一下模板」

- **WHEN** 用户在工作空间里对智能体说「把模板更新到最新」
- **THEN** 智能体先给出计划摘要并等待确认；用户确认前，工作空间里没有文件变化

### Requirement: 去 AI 味规则库并入模板新规则

`pm-deai-writing` 技能 SHALL 有「并入模板新规则」的用法：按短名与判据逐条比对模板规则库与实例规则库，处理如下：
- 实例已有的只补记 `上游：模板 R<编号>`；
- 没有的按实例下一个空号新增，来源写模板版本与模板编号；
- 实例已停用的保持停用。

整批 SHALL 只升一个版本，并写快照与 CHANGELOG。实例已有规则的编号 MUST NOT 改动。

#### Scenario: 模板新增了一条实例没有的规则

- **WHEN** 实例规则库到 R013，模板新版带来一条实例里没有的模板 R012
- **THEN** 实例新增 R014，写着 `来源：模板 v<N> R012`；已有的 R012、R013 与批注回执里的「沉淀为 R012」都不变

#### Scenario: 模板收下了本实例贡献的规则

- **WHEN** 模板新版里的某条规则就是本实例贡献过去、已补记 `上游：` 的那条
- **THEN** 这条被判为已有，不新增
