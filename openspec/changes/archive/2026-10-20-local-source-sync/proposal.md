## Why

维护者用源码跑看板时，实例要等模板进了公开仓库才能拉到新版，自己写的缺陷单和贡献单还得经邮件绕一圈才回到源码仓库，本机上的两份目录互相看不见。npm 安装的用户没有这份源码，这条慢路径必须原样留下。

## What Changes

- 看板启动时区分两种来源：**源码**（仓库里有前端源码 `src/app`）和 **npm 包**（发出去的包没有 `src/app`）。npm 包维持现在的行为：实例用 `template_update.py` 从 GitHub 取模板，反馈单仍用邮件发出。
- 看板自己的启动配置 `runtime.json`（在看板配置目录，不在任何工作空间里）多记三样：启动方式 `launch`、源码仓库位置 `repoRoot`、当前登记的实例清单 `instances`。注册表增删实例时同步刷新这份清单。
- 「实例知道源码在哪」靠查这份配置做到：实例的 `template_update.py` 读到「启动方式是源码、本工作空间在 `instances` 里、源码里有对应模板目录」时，缺省读本机模板目录，不再下载 GitHub 包。显式 `--from` / `--ref` 仍优先。条件不满足时缺省仍走 GitHub。**看板不往工作空间写任何东西，不变量 1 不新增例外。**
- 本机来源进 lock 时带上源码的提交号：`local:<目录名>@<提交号>`，工作树里该模板目录有未提交改动时再加 `+dirty`。冲突对照（`compare`）可以按这个提交号从本机仓库取回基线，三方对照不因走本机而失效。计划摘要会提示来源有未提交改动。
- 计划与确认再落盘的顺序不变。看板不把模板文件推进实例，也不在后台自动更新。
- 源码启动时，反馈单留在实例的 `output/feedback/`，源码仓库里的智能体按 `instances` 直接读，不必等邮件。回执仍由用户转给工作空间智能体回写（这一半仍是手动的）。邮件按钮仍在。
- 同一套规矩写成技能：源码仓库新增 `local-source-sync`；工作空间侧改已有的 `pm-template-update`，不另起一个要等模板更新才出现的新技能名。源码侧可以在用户确认后跑实例**自己的**脚本 `apply`，但冲突与 seedOnly 文件交回工作空间智能体处理。
- 文档跟上：
  - `README.md` 把源码启动写成长期使用的推荐方式（clone → 安装 → 构建 → 起服务 → 拉新版），说清它比 npx 多了什么（模板本机更新、反馈不必发邮件、能直接改和提交改进）；npx 仍保留为「先试一下」的入口。
  - 新增根目录 `CONTRIBUTING.md`：既然用户手里已经有源码，就告诉他们怎么把改进交回来——反馈单、Issue、PR 三条路，各自适合什么；改代码前读哪些约定、过哪些验证闸、公开仓库的脱敏红线。规则本身仍以 `AGENTS.md` 为准，这份只做人读的入口和链接，不复制条文。

## Capabilities

### New Capabilities

- `local-source-sync`：启动方式判定、`runtime.json` 的实例清单、源码侧技能怎么更新实例和读反馈单、反馈页在源码模式下的说明。

### Modified Capabilities

- `workspace-template-update`：缺省来源从「总是 GitHub」改为「源码启动且本实例已登记时用本机模板目录，否则 GitHub」；本机来源串带提交号，`compare` 能取回本机基线。
- `workspace-agent-boundary`：源码启动且本实例已登记时，允许工作空间脚本读本机源码里的模板目录；允许源码仓库里的智能体直接读实例里的反馈单，并在用户确认后运行实例自己的更新脚本。两边仍不手改对方的文件。
- `workbench-feedback`：源码模式下反馈页说明不必发邮件；`mailto:` 仍可用，看板仍不自己发网络请求。

## Impact

- **服务端**（`src/server/config.mjs`、`src/server/http.mjs`）：启动时判定来源；`runtime.json` 加字段；注册表写入后刷新 `instances`。`/api/health` 增加可选字段 `launch`。**不写任何工作空间文件。**
- **前端**（`src/app/lib/api.ts`、反馈单页）：契约增加可选 `launch`。缺字段时界面与现在一致。
- **CLI**：不改参数。判定用的是进程所在的安装目录，不是新旗标。
- **templates**：`scripts/template_update.py` 认 `runtime.json`、来源串带提交号、`compare` 取本机基线；`pm-template-update` 与模板 `AGENTS.md` 写明本机路径何时启用。不改 `.gitignore`。
- **工程技能**：`.claude/skills/` 新增 `local-source-sync`，根目录 `AGENTS.md` 第 6.2 节补源码模式的读反馈单与代跑更新。
- **文档**：改 `README.md`（「用法」「从源码跑」「改代码前」三节）；新增 `CONTRIBUTING.md`。npm 包首页的 README（`scripts/build-npm-package.mjs` 生成）只加一句指向仓库的源码启动说明，仍以 npx 为主。
- **契约**：动 `src/app/lib/api.ts` 的 `Health`，只加可选字段。
- **依赖**：无。脚本取提交号用系统 `git`，找不到 `git` 就退回不带提交号的旧来源串。
