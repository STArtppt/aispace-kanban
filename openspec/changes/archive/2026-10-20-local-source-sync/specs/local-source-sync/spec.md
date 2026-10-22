## ADDED Requirements

### Requirement: 启动时区分源码与 npm 包

看板进程 SHALL 用安装根下有没有 `src/app` 区分启动方式。安装根是服务端源码向上两级（与查找内置 `templates/` 的相对关系相同）。有 `src/app` 为源码，没有为 npm 包。

`GET /api/health` SHALL 增加可选字段 `launch`，取值 `"source"` 或 `"package"`。响应 MUST NOT 包含源码仓库或工作空间的绝对路径。

#### Scenario: 源码目录起服务

- **WHEN** 从带有 `src/app` 的仓库目录启动看板，请求 `GET /api/health`
- **THEN** 响应里 `launch` 为 `"source"`，响应正文里没有绝对路径

#### Scenario: npm 包起服务

- **WHEN** 从没有 `src/app` 的安装目录启动看板，请求 `GET /api/health`
- **THEN** 响应里 `launch` 为 `"package"`

#### Scenario: 旧进程没有该字段

- **WHEN** 前端已更新，服务进程还是旧版，`/api/health` 没有 `launch`
- **THEN** 反馈单页与改动前一致，不出现「不必发邮件」的说明

### Requirement: 启动配置记下启动方式与实例清单

看板启动时 SHALL 在已有的 `runtime.json` 写入 `launch`、`repoRoot`、`instances`：

- 源码：`launch` 为 `"source"`，`repoRoot` 为安装根的绝对路径，`instances` 为注册表中每个项目的 `id`、`name`、`root`；
- npm 包：`launch` 为 `"package"`，`repoRoot` 为空串，`instances` 为空数组。

源码进程在注册表每次写入成功后（新建、登记、移出、改名、重新关联目录）SHALL 刷新 `instances` 与 `updatedAt`，其它字段保持不变。npm 包进程不刷新。

写失败 MUST NOT 阻止进程启动或注册表操作。已有的 `anydocBin`、`node`、`version` 字段保持不变。这份文件在看板配置目录，不在任何工作空间内。

#### Scenario: 源码启动后配置里能看到实例

- **WHEN** 注册表里有一个工作空间，并从源码启动看板
- **THEN** `runtime.json` 的 `launch` 为 `"source"`，`instances` 里有该工作空间的 `id` 与 `root`，`anydocBin` 仍指向可执行文件

#### Scenario: npm 包启动不记实例清单

- **WHEN** 从 npm 包启动看板，注册表里已有工作空间
- **THEN** `runtime.json` 的 `launch` 为 `"package"`，`instances` 为空数组，`repoRoot` 为空串

#### Scenario: 移出看板后不再列出

- **WHEN** 源码启动的看板上，用户把一个工作空间移出看板
- **THEN** `runtime.json` 的 `instances` 不再包含它，该工作空间目录里没有任何文件变化

### Requirement: 看板不为本机同步写工作空间

为本机同步，看板 MUST NOT 在任何工作空间内新建、修改或删除文件，包括 `.aispace/` 与 `.gitignore`。实例与源码仓库的互指信息只存在于看板配置目录的 `runtime.json`。不变量 1 的例外清单 MUST NOT 因本能力新增条目。

#### Scenario: 源码环回启动

- **WHEN** 从源码、环回地址启动看板，注册表里有若干工作空间
- **THEN** 这些工作空间里没有任何文件变化；是 git 仓库的，`git status` 与启动前一致

### Requirement: 源码仓库里的智能体按技能做本机同步

本仓库 SHALL 提供技能 `local-source-sync`。它 MUST 规定：

- `runtime.json` 的 `launch` 不是 `"source"` 时，本技能不适用，模板更新与反馈仍走 GitHub 和邮件；
- 适用时，读 `instances` 得到实例位置，不在磁盘上另找工作空间；
- 更新某个实例时，运行该实例的 `scripts/template_update.py`，工作目录是实例根，并显式传入 `--from`，指向 `repoRoot` 下该实例模板 id 的目录；用户确认计划之前不 `apply`；
- `apply` 之后剩下的冲突与 seedOnly 新版，列给用户并交回工作空间智能体处理；源码侧 MUST NOT 手改实例文件，MUST NOT 运行 `apply --resolved`；
- 不把源码仓库里的脚本副本当作工作空间根来跑；
- 处理反馈时直接读实例的 `output/feedback/`，不要求用户先发邮件；回执交给用户转发，本会话不写反馈单。

#### Scenario: 源码侧要更新一个实例

- **WHEN** `launch` 为 `"source"`，用户在源码仓库里要求把模板同步到某个已登记实例
- **THEN** 智能体先用该实例的 `template_update.py plan --from <本机模板目录>` 给出计划并等待确认；确认前实例里的模板文件没有变化

#### Scenario: 更新有冲突

- **WHEN** 源码侧代跑的 `apply` 结束后计划里还有冲突文件
- **THEN** 智能体列出这些文件，请用户到工作空间里让智能体合并；冲突文件与 lock 里它们的哈希都没有被源码侧改动

#### Scenario: npm 包模式不走这套技能

- **WHEN** `runtime.json` 的 `launch` 为 `"package"`，用户在源码仓库里要求同步实例
- **THEN** 智能体说明当前启动方式不是源码，不做本机覆盖

### Requirement: 文档推荐源码启动并提供贡献入口

仓库 `README.md` SHALL 在「用法」里并列给出源码启动与 npx 两种方式，把源码启动标为长期使用的推荐方式，并说明两者在模板更新与反馈上的差别。「从源码跑」SHALL 给出从 `git clone` 到起服务、以及拉新版后重新安装与构建的完整步骤。npx 入口 MUST 保留。

仓库根目录 SHALL 有 `CONTRIBUTING.md`，说明反馈单、GitHub Issue、GitHub PR 三条路各自适用的情形，以及改代码前要读的约定、验证闸、脱敏红线和提交信息写法。规则条文 SHALL 以链接指向 `AGENTS.md` 对应小节，MUST NOT 在 `CONTRIBUTING.md` 里复制不变量或验证闸的条文。`README.md` 的「改代码前」与 `AGENTS.md` 开头 SHALL 指向它。

npm 包首页 README SHALL 仍以 npx 为主线，只加一句指向仓库源码启动说明。

#### Scenario: 新用户读 README 选启动方式

- **WHEN** 用户打开仓库 README 的「用法」
- **THEN** 能看到源码启动和 npx 两种方式、各自适合谁，以及源码启动能本机更新模板、反馈不必发邮件

#### Scenario: 源码用户想交一个改进

- **WHEN** 用户已经从源码跑起看板，想把改动交回仓库
- **THEN** 从 README 能链到 `CONTRIBUTING.md`，里面写明走 PR、提交前过哪些验证闸、去 `AGENTS.md` 哪几节看规则

#### Scenario: 规则只有一份

- **WHEN** 在 `CONTRIBUTING.md` 里查找不变量 1 的例外清单或验证闸命令表
- **THEN** 只找到指向 `AGENTS.md` 的链接，没有复制的条文

#### Scenario: npm 包首页

- **WHEN** 用户在 npm 上打开包首页
- **THEN** 主线仍是 `npx` 起服务，另有一句说明想要本机更新与直接改进可以看仓库的源码启动
