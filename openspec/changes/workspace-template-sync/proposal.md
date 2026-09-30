## Why

不做的话，模板修好的东西到不了已有的工作空间，工作空间里攒下的改进也回不到模板。
工作空间是从 `templates/pm-aispace` 一次性铺出来的，之后没有任何更新路径：Word 工具链、去 AI 味技能这类新东西，旧工作空间只能靠人手工比对复制。
上一次手工同步四个实例，很多文件和模板任何一个历史版本都对不上，要逐个人工判断哪些是本地改动。没有记录铺设时的基线，用「最接近的历史版」做三方合并，会把旧模板原文当成本地改动合回去。
反方向也断着。实例里沉淀出的通用改进（技能文案、去 AI 味规则、脚本修复）现在靠智能体直接写本机的看板仓库。
这只在维护者自己的电脑上成立。换成通过 npm 安装看板的普通用户，本机没有可写的看板仓库，公开仓库也不该被各个工作空间直接写。

## What Changes

- **下行更新**：模板新增 `scripts/template_update.py`（只用标准库）和技能 `pm-template-update`。
  - 由工作空间里的智能体从公开仓库 `github.com/STArtppt/aispace-kanban` 拉取指定版本的 `templates/pm-aispace`，先出计划，确认后再落盘。
  - 默认不依赖本机看板仓库路径。维护者离线调试时可以显式传本地目录。
- **铺设基线**：新建工作空间、每次更新成功后，写 `.aispace/template.lock.json`，内容是来源版本和每个文件的哈希。
  - 下一次更新以它为三方合并的基线：
    - 实例缺的新增；
    - 实例没改过的（等于基线）覆盖；
    - 实例改过、模板也改过的列为冲突，交智能体合并；
    - 模板删掉的只列出，不删。
- **文件分三类**，写在 `template.yaml` 的 `sync` 段：
  - 模板管理：脚本、技能、目录说明，按上面的规则更新；
  - 只铺一次：`project.yaml`、`.gitignore`、`input/.ingestignore`、去 AI 味规则库。铺完归实例所有，更新时不覆盖，只报告模板那边有变化；
  - 不分发：`template.yaml`。
- **项目专有约定挪出 AGENTS.md**：写进 `AGENTS.local.md`，不随模板分发。AGENTS.md 引用它，Claude Code 通过 `@AGENTS.local.md` 引入。
  这样 AGENTS.md 能整份按模板更新，不用在里面找本地改动。
- **规则库合并**：模板新版带来的去味规则，由 `pm-deai-writing` 按「规则库怎么改」并入实例规则库。
  - 编号取实例里的下一个空号，规则里记 `上游：模板 R0xx`；
  - 实例规则库只升一个版本，CHANGELOG 来源写模板版本；
  - 实例已有的编号和批注回执里的沉淀标记都不变。
- **上行贡献走反馈单**：`output/feedback/` 的反馈单加一个字段 `kind`，取 `bug`（缺省，兼容旧单）或 `contribution`。
  - 贡献单有自己的一套节，携带可推广的改动：
    - 贡献了什么；
    - 为什么能推广；
    - 合成示例；
    - 涉及的模板文件；
    - 改动内容（diff 或全文）；
    - 实例里的对应编号。
  - 仍经邮件交给看板维护者，维护者按脱敏红线合并回模板源，回执写明模板里的编号和提交号。
  - 看板的反馈单页显示类型、按类型给邮件标题加前缀；服务端索引带出 `kind`。
- **BREAKING（对工作空间智能体的约定）**：删掉模板 AGENTS.md 的「模板改动回同步源」一节。工作空间智能体从此不写看板仓库的任何文件，包括 `templates/`。
  `init_workspace.py` 的禁写规则随之扩到 `templates/` 下本模板目录，也就是整个看板根目录都禁写。

### 需要拍板：往工作空间写入的范围

本变更涉及两处写工作空间，都不是看板服务端写。看板对工作空间只读的不变量不变，本变更不新增服务端写接口。

1. **`template_update.py` 写实例**：工作空间自己的脚本，由智能体在用户确认计划后执行。
   - 写模板管理类文件和 `.aispace/template.lock.json`；
   - 不碰只铺一次类、项目资料和产出；
   - 冲突文件不写，交给智能体合并。
2. **`init_workspace.py` 新建时多写一份 lock**：新建本来就在写整个工作空间，这里只是多一个文件。

## Capabilities

### New Capabilities

- `workspace-template-update`：从公开仓库把模板更新拉进已有工作空间。
  - 铺设基线（lock）、文件分类、三方判定与冲突交接；
  - 项目专有约定拆到 `AGENTS.local.md`；
  - 去 AI 味规则库与模板新规则的合并；
  - 首次接入无基线的旧实例。
- `template-contribution`：工作空间把沉淀出的通用改进作为贡献单交回看板源。
  - 贡献单的节与脱敏要求、什么算可推广；
  - 看板仓库这边的合并与回执、回执回写后实例侧的编号对应。

### Modified Capabilities

- `workbench-feedback`：反馈单契约加 `kind`（`bug` / `contribution`），贡献单另有一套内容节。
  - 索引与详情带出 `kind`，界面显示类型；
  - 邮件标题按类型区分前缀；
  - 旧单没有 `kind` 时按 `bug` 处理。
- `workspace-agent-boundary`：
  - 取消「模板同步回看板仓库」的写入范围，改为经贡献单交接；
  - 新建工作空间的禁写规则扩到整个看板根目录；
  - 看板仓库这边的闭环加上贡献单的处理。

## Impact

- **templates**（主要落点，放进去就是发出去）：
  - 新增 `scripts/template_update.py`、`.claude/skills/pm-template-update/`；
  - `template.yaml` 加 `sync` 段；
  - 改 AGENTS.md（删同步回源一节，加更新、贡献、`AGENTS.local.md` 三处说明）、CLAUDE.md（引入 `AGENTS.local.md`）；
  - 改 `output/feedback/README.md`（`kind` 与贡献单形状）、`pm-deai-writing` 技能（规则库合并上游规则）、`.gitignore`（`.aispace/` 入库与否见 design）；
  - `templates/init_workspace.py` 写 lock、禁写规则扩到 `templates/`。
- **服务端**：`src/server/feedback.mjs` 解析 `kind`、按类型给节排序，邮件标题前缀在 `src/shared/feedbackMail.mjs`。不新增写接口，第八条窄例外的边界不变。
- **前端**：`workbenchFeedback` 相关组件显示类型标签、贡献单的节名；旧服务不报 `kind` 时按 `bug` 显示。
- **契约 `src/app/lib/api.ts`**：`FeedbackItem` 加可选 `kind`。
- **CLI**：不动。
- **依赖**：无新依赖。`template_update.py` 只用 Python 标准库（`urllib` 取 GitHub 源码包，`tarfile` 解包）。
- **看板仓库文档**：AGENTS.md「反馈单在看板仓库这边闭环」一节加贡献单的处理步骤。
- **已有的四个实例**：本次手工同步后各补一份 lock，作为首个基线；其中一个实例的项目专有章节挪到 `AGENTS.local.md`。这一步在实施时由用户确认后做。
