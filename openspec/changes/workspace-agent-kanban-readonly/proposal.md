## Why

不做的话，工作空间里的智能体会继续**直接改看板的本地源码**，而且改动没人审、没提交，也没过看板的验证。
一次真实的例子：某个智能体在补全 `project.yaml` 时，发现概览页「成果要求」被渲染成一张「列号 0–45、每格一个汉字」的表。
它顺着模板 AGENTS.md 里的源码路径找到本机看板仓库，直接改了 `src/app/components/MetaView.tsx`。
这个改动的方向其实是对的，但它是在一个**不知道看板不变量、验证要求和提交约定**的语境里做的，
改完只跑了 `tsc --noEmit`，就留在看板工作区里等人发现。

根因有两层：

1. 模板 `AGENTS.md` 给智能体指的是本机源码路径，而且「模板改动回同步源」一节允许它写看板仓库，却没划范围。
   写 `src/` 看起来和写 `templates/` 是同一回事。
2. 智能体真的发现看板缺陷时，没有一条正规的路可以上报，改源码就成了唯一能「把事办完」的办法。

## What Changes

- **模板规则**：`templates/pm-aispace/AGENTS.md` 明确规定看板源码只能读（读公开的 GitHub 仓库，不读本机），不能改。
  「看板显示不对时去哪查」一节收口成：先改文档写法绕过去 → 写反馈单 → 告诉用户。
- **收窄「模板改动回同步源」**：能写的只有看板仓库 `templates/pm-aispace/` 下、与工作空间内同名的文件；
  `src/`、`bin/`、`scripts/`、`package.json` 等其余一切都不能写。
- **反馈单（新）**：工作空间根目录下的隐藏目录 `.kanban-feedback/`，一个问题一份 Markdown，字段固定。
  看板扫描时本来就跳过根目录的 `.` 开头目录，所以看板**不读、不显示、不写**它。
  它是工作空间智能体和用户之间的交接物，由用户拿回看板仓库的会话里处理。
- **硬拦（新）**：`init_workspace.py` 新建工作空间时，在 `.claude/settings.local.json` 里生成 `deny` 规则，
  禁止 Edit / Write 看板根目录下除 `templates/` 以外的所有顶层条目。
  另外加一个只做这一步的开关，给已有的工作空间补上。
- **本次案例收尾**：按看板的验证要求重新审一遍工作区里遗留的那份 `MetaView.tsx` 改动，决定是否保留：
  字符串数组整行进单列、补上漏掉的「验收标准」列表。
  模板 `project.yaml` 的 `deliverables` 补上「形如」注释，`pm-project-meta` 技能补一条列表字段要写成对象数组。

## Capabilities

### New Capabilities

- `workspace-agent-boundary`：工作空间智能体与看板源码之间的边界：只读、读哪里、哪些能写、反馈单格式与闭环、新建工作空间时生成的禁写规则。
- `project-meta-view`：概览页渲染 `project.yaml` 列表字段的规则：原始值行怎么显示、哪些字段必须有渲染入口。

### Modified Capabilities

（无。现有 specs 里没有覆盖模板规则或概览页的条目。）

## Impact

- **templates**：`templates/pm-aispace/AGENTS.md`、`templates/pm-aispace/project.yaml`、
  `templates/pm-aispace/.claude/skills/pm-project-meta/SKILL.md`、`templates/pm-aispace/.gitignore`、`templates/init_workspace.py`。
  「放进去就是发出去」：新建的工作空间都会带上这些规则。**已有的工作空间不会自动更新。**
- **前端**：`src/app/components/MetaView.tsx`（只动渲染，不动 `project.yaml` 的读取与类型）。
- **服务端 / CLI**：不改。
- **`src/app/lib/api.ts` 契约**：不改。
- **依赖**：不引入新依赖。

### 需要人拍板：写工作空间

本 change 不放宽看板对工作空间只读的红线。看板服务端不新增任何写入，下面两处写入都不是看板发起的，单独列出来请确认：

1. **`.kanban-feedback/`** 由工作空间里的智能体写，看板不读也不写。它只是模板约定里多了一个目录，
   不属于 AGENTS.md 不变量 1 管的「看板写工作空间」。
2. **`.claude/settings.local.json`** 由 `init_workspace.py` 写：
   - 新建工作空间时写，属于已有的「新建工作空间」例外，写入范围多了这一个文件。
   - 给**已有**工作空间补规则时，是用户在命令行**手动**运行这个脚本，看板不 `spawn`，不给它加按钮。
     脚本只新建或合并这一个文件的 `permissions.deny`，不碰工作空间里的其他任何文件。
