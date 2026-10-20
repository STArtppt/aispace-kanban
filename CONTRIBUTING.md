# 参与贡献

看板从源码跑起来之后，改进可以从这里交回仓库。规则条文以 [AGENTS.md](./AGENTS.md) 为准，这份只说明走哪条路、到哪里看规则。

## 三条路怎么选

- **在工作空间里用着发现问题，或沉淀出换一个项目也成立的改进** → 反馈单。缺陷单写看板的缺陷，贡献单写想交回模板的通用改进。源码启动时，在这个仓库里直接处理（见 [AGENTS.md 第 6.2 节](./AGENTS.md#62-处理工作空间反馈单)）；用 npx 安装时，在看板反馈单页发邮件。
- **想报告问题或讨论想法，但不打算自己改** → [GitHub Issue](https://github.com/STArtppt/aispace-kanban/issues)。
- **已经在源码里改好了** → GitHub PR。

## 改代码前

先读 [AGENTS.md 第 1 节](./AGENTS.md#1-项目是什么-最硬的不变量)的不变量、[第 3 节](./AGENTS.md#3-三个平面与目录结构)的三个平面、[第 5 节](./AGENTS.md#5-编码规范总则)的编码规范。

加功能先读 [`dashboard-feature-flow`](./.claude/skills/dashboard-feature-flow/SKILL.md)。改模板读 [templates/pm-aispace/AGENTS.md](./templates/pm-aispace/AGENTS.md) 和 [template-contribution](./openspec/specs/template-contribution/spec.md)。

## 非平凡改动先立 change

跨平面、要动前后端契约、引新依赖，或要在几条路之间做取舍时，先立一个 change。判据和命令见 [AGENTS.md 第 6 节](./AGENTS.md#6-协作流水线openspec规划-→-实施-→-归档)。

## 提交前

过 [AGENTS.md 第 4 节](./AGENTS.md#4-常用命令与验证闸)的验证闸。改了服务端要重启服务并在浏览器里点一遍受影响的视图。改了模板的铺设或更新脚本，另跑那一节里对应的回归。

## 脱敏

仓库是公开的。规划产物和提交里不得出现真实客户名、本机绝对路径、凭据。红线见 [AGENTS.md 第 6.1 节](./AGENTS.md#61-公开仓库脱敏红线)。

## 提交信息

沿用现有写法：`feat:` / `fix:` / `tweak:` / `docs:`，加一句中文说明做了什么。

## PR 描述

写动机、影响的平面、验证方式。有对应的 change 就给出名字。
