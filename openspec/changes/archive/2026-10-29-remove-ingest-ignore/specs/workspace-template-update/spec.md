## MODIFIED Requirements

### Requirement: 按模板的 sync 段给文件分类

模板 `template.yaml` SHALL 有 `sync` 段，列出 `seedOnly`（只在新建时铺）与 `exclude`（不分发）两组路径模式。
其余被分发的文件都是「模板管理」。分类 MUST 从本次取到的模板版本里读，脚本里不写死。
`seedOnly` 至少包含 `project.yaml`、`.gitignore`、`.claude/skills/pm-deai-writing/rules/**`。
模板 MUST NOT 再分发 `input/.ingestignore`；实例里已有的这份文件更新时 MUST NOT 删除或改动，技能只提示它已不再生效。

#### Scenario: 规则库不被覆盖

- **WHEN** 实例的去 AI 味规则库已经演进到 v2，模板规则库是 v1 以后的新版
- **THEN** 计划里规则库文件出现在「seedOnly 有新版，未覆盖」组，附 diff；`apply` 后实例规则库一个字节没变

#### Scenario: 实例留着旧忽略清单

- **WHEN** 实例里有 `input/.ingestignore`，用户按技能更新到不再带它的模板版本
- **THEN** 更新后该文件仍在、内容不变；技能告诉用户它已不再生效，可自行删除
