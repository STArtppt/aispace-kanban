## MODIFIED Requirements

### Requirement: 铺设与更新都留下基线

`templates/init_workspace.py` 新建工作空间时 SHALL 写 `<工作空间根>/.aispace/template.lock.json`。内容：
- 模板 id；
- 来源（`github:<仓库>@<提交号>`，或本机来源 `local:<目录名>`，不含绝对路径）；
- 铺设时间；
- 每个已铺文件的相对路径与 SHA-256。

本机来源 SHALL 在能取到时带上源码提交号：`local:<目录名>@<提交号>`；模板目录有未提交改动时为 `local:<目录名>@<提交号>+dirty`。取不到（没有 `git`、不在 git 仓库里）时为 `local:<目录名>`。

`template_update.py apply` 成功后 SHALL 用本次来源重写 lock，每个文件记本次模板版本的哈希；冲突文件的哈希 MUST NOT 前移。
lock 记的始终是**模板那一版**的哈希（三方合并的基线），不是工作空间文件的哈希。
模板 `.gitignore` MUST NOT 忽略 `.aispace/`。

#### Scenario: 新建工作空间

- **WHEN** 运行 `init_workspace.py --from templates/pm-aispace --name 示例 --path <目录>`
- **THEN** `<目录>/.aispace/template.lock.json` 存在，文件清单与实际铺出的文件一一对应，里面搜不到 `<目录>` 的绝对路径

#### Scenario: 看板不显示 lock

- **WHEN** 看板打开这个工作空间
- **THEN** 产出列表、搜索、原始资料里都没有 `.aispace/` 下的文件

#### Scenario: 本机来源带提交号

- **WHEN** 从 git 仓库里的模板目录更新，该目录没有未提交改动
- **THEN** lock 来源为 `local:<目录名>@<提交号>`，搜不到任何绝对路径

#### Scenario: 本机来源有未提交改动

- **WHEN** 从 git 仓库里的模板目录出计划，该目录有未提交改动
- **THEN** 计划来源以 `+dirty` 结尾，并带一条 warning 说明冲突对照的基线不精确

### Requirement: 从公开仓库取模板，本地目录只作显式选项

工作空间脚本 `scripts/template_update.py` SHALL 在同时满足以下条件时，缺省读取本机模板目录，不访问 GitHub：

- 没有传入 `--from` 或 `--ref`；
- 看板配置目录的 `runtime.json` 中 `launch` 为 `source`；
- 该文件的 `instances` 中有一项的 `root` 与本工作空间根是同一目录；
- `<repoRoot>/templates/<模板 id>/template.yaml` 存在（模板 id 取 lock 的 `template`，没有 lock 时为 `pm-aispace`）。

除此以外，没有 `--from` 时 SHALL 仍从 `https://codeload.github.com/STArtppt/aispace-kanban/tar.gz/<ref>` 下载（`--ref` 缺省为 `main`），只解出 `templates/pm-aispace/` 到系统临时目录，并记下解析出的提交号。
显式 `--from <目录>` 或 `--ref` 时 MUST 按参数执行，不受 `runtime.json` 影响。
`launch` 为 `source` 但后两条不成立时，脚本 MUST 说明哪条不满足之后走 GitHub，MUST NOT 静默使用别的目录。
`runtime.json` 读不到或没有 `launch` 字段时 MUST 按 npm 包处理。
脚本 MUST 只 import Python 标准库，且 MUST NOT 写工作空间以外的文件（系统临时目录除外）。

#### Scenario: 源码启动且本实例已登记

- **WHEN** `runtime.json` 的 `launch` 为 `source`，`instances` 含本工作空间，源码里有对应模板目录，运行 `python3 scripts/template_update.py plan`
- **THEN** 计划的来源以 `local:<模板目录名>` 开头，不访问 GitHub，工作空间没有文件变化

#### Scenario: 已移出看板

- **WHEN** `launch` 为 `source`，但 `instances` 里没有本工作空间，运行 `python3 scripts/template_update.py plan`
- **THEN** 输出说明本工作空间未在本机看板登记，然后从 GitHub 取模板

#### Scenario: 已经改回 npm 包启动

- **WHEN** `runtime.json` 的 `launch` 为 `package`，本机访问不了 GitHub，运行 `python3 scripts/template_update.py plan`
- **THEN** 退出码非 0，输出 GitHub 不通时的出路，工作空间没有任何文件变化

#### Scenario: 网络不通且不是源码启动

- **WHEN** 没有 `runtime.json`，本机访问不了 GitHub，运行 `python3 scripts/template_update.py plan`
- **THEN** 退出码非 0，输出一句中文说明和两条出路（设置代理；用 `--from` 指向本地模板目录），工作空间没有任何文件变化

#### Scenario: 取不到提交号

- **WHEN** 源码包下载成功，但查询提交号的接口被限流
- **THEN** 计划照常生成，来源记为 `github:<仓库>@main`，并带一条 warning 说明基线不精确

#### Scenario: 显式指定版本

- **WHEN** 本机条件成立，运行 `python3 scripts/template_update.py plan --ref <标签>`
- **THEN** 脚本按该版本从 GitHub 取模板，不读本机模板目录

### Requirement: 更新由技能驱动，先让用户确认

模板 SHALL 提供技能 `pm-template-update`，规定顺序：

1. 运行 `plan`（不传 `--from` / `--ref`；本机条件成立时由脚本自己读本机模板）；
2. 把计划用非工程语言列给用户（新增了哪些能力、更新了哪些工具、哪些没覆盖、为什么）；
3. 用户确认后 `apply`；
4. 逐个处理冲突，合并前后给出差异摘要；
5. 处理 seedOnly 有新版的文件；
6. 汇报。

智能体 MUST NOT 跳过确认直接 `apply`。
来源是本机源码时，技能 SHALL 向用户说明这次来源是本机源码仓库，而不是 GitHub；来源带 `+dirty` 时 SHALL 说明模板有未提交改动。
智能体 MUST NOT 自己搜索本机看板仓库来拼 `--from`。本机路径只来自脚本的判定，或用户明确给出的目录。

#### Scenario: 用户说「更新一下模板」

- **WHEN** 用户在工作空间里对智能体说「把模板更新到最新」
- **THEN** 智能体先给出计划摘要并等待确认；用户确认前，工作空间里没有文件变化

#### Scenario: 本机条件成立时更新

- **WHEN** 本机条件成立，用户在工作空间里说「把模板更新到最新」
- **THEN** 智能体运行不带 `--from` 的 `plan`，摘要里说明来源是本机源码；用户确认前没有文件变化

## ADDED Requirements

### Requirement: 本机来源的冲突对照能取回基线

`template_update.py compare` 在没有 `--base-from` / `--base-ref` 时，若 lock 来源为 `local:<目录名>@<提交号>`（可带 `+dirty`），且本机条件成立，SHALL 用 `git -C <repoRoot> show <提交号>:templates/<模板 id>/<相对路径>` 取冲突文件的基线到系统临时目录，再给出三方对照。
取到的基线哈希与 lock 不一致时 SHALL 标为 `inexact` 并给 warning。
取不到（提交号不在本机仓库、没有 `git`、本机条件不成立）时 SHALL 退回两方对照，并说明原因。
lock 来源为不带提交号的 `local:<目录名>` 时，行为与改动前一致。

#### Scenario: 本机基线可取

- **WHEN** lock 来源为 `local:pm-aispace@<提交号>`，该提交在本机仓库里，某个文件处于冲突组，运行 `compare --plan <计划文件>`
- **THEN** 该文件的 `base` 为 `exact`，输出含「基线 → 工作空间」与「基线 → 模板新版」两份 diff

#### Scenario: 提交号不在本机

- **WHEN** lock 来源为 `local:pm-aispace@<提交号>`，本机仓库里没有这个提交
- **THEN** 输出两方对照，并说明取不回基线以及 `--base-from` / `--base-ref` 两条出路
