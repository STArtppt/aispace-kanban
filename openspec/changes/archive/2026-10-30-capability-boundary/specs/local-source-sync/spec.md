## MODIFIED Requirements

### Requirement: 看板不为本机同步写工作空间

为本机同步，看板 MUST NOT 在任何工作空间内新建、修改或删除文件，包括 `.aispace/` 与 `.gitignore`。实例与源码仓库的互指信息只存在于看板配置目录的 `runtime.json`。AGENTS.md 的能力清单 MUST NOT 因本能力新增条目。

#### Scenario: 源码环回启动

- **WHEN** 从源码、环回地址启动看板，注册表里有若干工作空间
- **THEN** 这些工作空间里没有任何文件变化；是 git 仓库的，`git status` 与启动前一致
