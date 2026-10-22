## Context

实例更新模板走 `scripts/template_update.py`：缺省下载公开仓库的源码包，只有显式 `--from` 才读本地目录。基线在 `.aispace/template.lock.json`，来源写成 `github:<仓库>@<提交号>` 或 `local:<目录名>`，**不记绝对路径**（这份文件要入库）。`compare` 只认得 `github:` 来源，`local:` 来源取不回基线，只能两方对照。反馈单在 `output/feedback/`，看板上用 `mailto:` 发到公开邮箱，源码仓库里的会话不直接读实例。

看板每次启动已经把 anydoc 与 node 的位置写进本机配置目录的 `runtime.json`（与 `projects.json` 相邻），模板脚本 `scripts/anydoc.py` 已经在读它。注册表里已有每个实例的 `id` / `name` / `root`。npm 包不含前端源码 `src/app`（`scripts/build-npm-package.mjs` 只拷 `src/server`、`src/shared`、`dist`），源码仓库有。

工作空间里的 `template_update.py` 是铺设时复制出去的那一份。改模板里的脚本，要等一次成功的 `apply` 才会进到已有实例。

## Goals / Non-Goals

**Goals:**

- 源码启动时，实例能查到源码仓库，源码仓库能查到实例，模板更新和反馈都在本机完成。
- npm 包启动时，行为与现在一致：GitHub 拉取、邮件反馈。
- 看板不往工作空间写任何东西。互指信息只放在看板配置目录。
- 仍由工作空间自己的 `template_update.py` 落盘，仍须用户确认计划。
- 走本机来源时，冲突的三方对照仍然可用。
- 绝对路径不进 lock、不进会提交的模板文件、不进本变更的规划产物。

**Non-Goals:**

- 不自动 `apply`，不做定时同步，不因文件变化就更新。
- 不取消邮件路径，不让看板代发邮件或代发网络请求。
- 不把反馈单复制进源码仓库。源码侧直接读实例里的文件。
- 不让源码侧会话回写反馈单状态。回执仍由用户转交。
- 不覆盖用户自建模板（`~/.pmwork/templates/`）。源码仓库里没有那个模板 id 的实例照旧走 GitHub。
- 不让工作空间智能体改看板仓库。`settings.local.json` 的 deny 照旧。

## Decisions

### D1 · 用「有没有 `src/app`」区分源码和 npm 包

安装根是 `src/server` 向上两级（与现在找 `templates/` 的相对关系相同）。这一层存在 `src/app` 就是源码，否则是 npm 包。

- 不选「路径里有 `node_modules`」：源码用 pnpm 时自己也有 `node_modules`，会判反。
- 不选「有 `.git`」：没有 git 元数据的源码目录仍是源码。
- 不选环境变量开关：多一个要记得设的旗标，忘了就又走 GitHub。

`/api/health` 只多一个可选字段 `launch`：`"source"` 或 `"package"`。不返回仓库绝对路径。缺字段的旧进程，前端当 npm 包处理。

### D2 · 互指信息只放在 `runtime.json`，不往工作空间写

`runtime.json` 在已有字段（`anydocBin` / `node` / `version` / `updatedAt`）之外加：

| 字段 | 源码 | npm 包 |
| --- | --- | --- |
| `launch` | `"source"` | `"package"` |
| `repoRoot` | 安装根绝对路径 | 空串 |
| `instances` | 注册表里每个项目的 `id` / `name` / `root` | 空数组 |

实例这一侧的「登记」就是：脚本拿自己的工作空间根，去 `instances` 里找。模板 id 取 lock 的 `template`（没有 lock 时按 `pm-aispace`），模板目录拼成 `<repoRoot>/templates/<模板 id>`。这几样都能推出来，不需要在实例里再存一份。

- 不选「在每个工作空间写 `.aispace/dev-link.json`」（本 change 的初稿）：
  - 那是看板在**启动时、没有用户发起**的情况下写工作空间，还要改一份会入库的 `.gitignore`。不变量 1 现有九条例外都要求用户明确发起，这条会是第一个破例。工作空间是 git 仓库时，每次启动都可能让 `git status` 多出改动。
  - 它存的 `repoRoot` / `templateId` / `templateRoot` 都能从 `runtime.json` 和 lock 推出来，多一份只是多一处会过期的副本。
  - 实例被「移出看板」后，残留的关联文件仍会生效，与不变量 3「移出只删登记」的语义对不上。只看 `instances` 的话，移出就自动回到 GitHub。
- 不在源码仓库里再放一份实例清单：仓库文件离 `git add` 太近。

### D3 · 注册表变了就刷新 `instances`

`instances` 不只在启动时写。`config.mjs` 里 `writeProjects` 成功之后（新建、登记、移出、改名、重新关联目录都经过它），若本进程 `launch` 为 `source`，就重写 `runtime.json`，保留其它字段，只更新 `instances` 与 `updatedAt`。写失败吞掉，与现有 `writeRuntimeInfo` 一致。

npm 包进程不刷新，`instances` 始终是空数组。

### D4 · 脚本的判定条件

`template_update.py plan` 在既没有 `--from` 也没有 `--ref` 时：

1. `runtime.json` 的 `launch` 是 `source`；
2. `instances` 里有一项的 `root` 与本工作空间根是同一目录（两边都 `realpath`，Windows 上再 `normcase`）；
3. `<repoRoot>/templates/<模板 id>/template.yaml` 存在。

三条都成立才读本机模板。否则缺省仍下载 GitHub（`--ref` 缺省 `main`）。第 1 条成立、但 2 或 3 不成立时，stderr 给一句中文说明哪条不满足，再走 GitHub。不静默用错目录。

- `--ref` 的 argparse 缺省值要从 `"main"` 改成 `None`，否则分不出「没传」和「传了 main」。下载时仍按 `main` 兜底。
- `runtime.json` 读不到、解析失败、没有 `launch` 字段：按 npm 包处理。
- `runtime.json` 记的是**最后一次启动**，不是正在跑的进程。源码看板停了以后，实例仍走本机，直到下次用 npm 包启动。维护者的机器上这正是想要的；npm 用户不会有 `launch=source`。

### D5 · 本机来源带提交号，`compare` 能取回基线

本机来源串改为 `local:<目录名>@<提交号>`，模板目录有未提交改动时为 `local:<目录名>@<提交号>+dirty`。

- 提交号来自 `git -C <模板目录> rev-parse HEAD`；未提交改动用 `git -C <模板目录> status --porcelain -- .` 判断。只用 `subprocess` 调系统 `git`，仍只 import 标准库。
- 找不到 `git`、目录不在 git 仓库里：退回 `local:<目录名>`，与现在一样。显式 `--from` 走同一套函数，所以维护者手动 `--from` 也能受益。
- 带 `+dirty` 时，计划加一条 warning：「来源有未提交改动，冲突对照的基线不精确」。技能把这条 warning 原样告诉用户。
- `compare` 在没有 `--base-from` / `--base-ref` 时：lock 来源是 `local:<目录名>@<提交号>`（不论有没有 `+dirty`），且 D4 的本机条件成立，就用 `git -C <repoRoot> show <提交号>:templates/<模板 id>/<相对路径>` 取冲突文件的基线到临时目录。取不到（提交号不在本机仓库、`git` 不可用）就回到现在的「只能两方对照」warning。带 `+dirty` 的基线按哈希比对，对不上就标成 `inexact`，复用现有逻辑。
- 旧的 `local:<目录名>` 不带提交号，照旧只能两方对照。`apply --resolved` 里「lock 来源与计划来源相同」的比较是整串比较，不受影响。

lock 里只有目录名和提交号，仍不含绝对路径。

### D6 · 已有实例的第一跳用 `--from`，源码侧可以代跑但不合并冲突

实例里的脚本是旧副本，不认识 `runtime.json` 的新字段。源码仓库里的技能因此规定：对实例执行更新时，运行的是**实例里的** `scripts/template_update.py`（工作目录是实例根），并显式带 `--from <repoRoot>/templates/<模板 id>`。这条旧脚本已经支持。`apply` 成功后新脚本进入实例，之后实例侧不带参数 `plan` 就会自己判定。

源码侧会话能做的只有三件：

1. `plan --from …`，把计划摘要给用户；
2. 用户确认后 `apply --plan …`（只执行「新增」「覆盖」两组，脚本本身保证）；
3. 把剩下的冲突和 seedOnly 新版列给用户，说明「请到工作空间里让智能体处理」。

它 MUST NOT 手改实例文件，MUST NOT 跑 `apply --resolved`（那等于替工作空间判定合并结果）。这与根目录 `AGENTS.md` 6.2「这边不写任何工作空间文件」的关系：写盘的是工作空间自己的脚本、由用户确认发起，与不变量 1「由工作空间自己的工具执行」同构；6.2 要把这条明确写成唯一例外。

- 不选「直接运行源码仓库里那份 `template_update.py`」：脚本用自己的位置推断工作空间根，跑错副本会把模板目录当成工作空间。
- 不选看板在启动时把新脚本拷进实例：那是在确认计划之前改模板管理的文件。

### D7 · 反馈留在实例里，源码侧按 `instances` 去读

源码模式下，工作空间智能体照旧把单子写在 `output/feedback/`，并告诉用户不必发邮件。源码仓库里的智能体读 `runtime.json` 的 `instances`，打开对应的 `output/feedback/F*.md`，按根目录 `AGENTS.md` 第 6.2 节处理，回执交给用户转发。源码侧会话不写反馈单。

源码模式下没人点「我已发出」，`sent_at` 会一直为空。这不改：工作空间智能体按回执回写 `status`（`fixed` / `wontfix`）之后，单子自然离开待处理状态。反馈页的说明里写明这一点，免得用户以为必须点「已发出」。

- 不选把单子复制进源码仓库的收件箱：两份会分叉，也多一条写入。
- 不选拿掉「邮件发送」：npm 包用户和想留底的人仍要这条路。
- 不选让源码侧直接回写反馈单状态：那是跨目录写，6.2 明令禁止；回执转交这一步仍是手动，proposal 里如实写明。

### D8 · 技能分两侧入口，规矩只写一套

- 本仓库 `.claude/skills/local-source-sync/SKILL.md`：给在源码仓库里工作的智能体。何时适用（`launch` 是 `source`）、怎么从 `instances` 找实例、怎么按 D6 代跑更新、怎么按 D7 读反馈单。
- 模板技能 `pm-template-update` 增加一节：本机条件成立时 `plan` 不带参数，向用户说明来源是本机源码而不是 GitHub；计划带 `+dirty` warning 时照实说明；确认之前仍不 `apply`。不另起一个模板技能名——实例要等这次更新之后才看得到新文件，而「更新模板」已经会触发 `pm-template-update`。
- 模板 `AGENTS.md` 改边界叙述：缺省仍读 GitHub、仍禁止写看板仓库；只有本机条件成立时，模板更新由脚本读本机模板目录，查正在跑的看板源码也读这一份。文档里的源码链接继续用 GitHub 地址，不写本机路径。

### D9 · README 推荐源码启动，但不拿掉 npx

源码启动是本机同步的前提，README 要把它从末尾的「开发者附录」提到「用法」里，与 npx 并列，并标明适用场景：

- **源码启动（推荐长期使用）**：模板改进在本机就能更新到实例，反馈单不必发邮件，发现问题可以直接改、直接提 PR。代价是要装 git 和 pnpm，拉新版后要重新构建。
- **npx（先试一下）**：一条命令，不用装别的；模板从 GitHub 更新，反馈走邮件。

「从源码跑」一节补齐完整步骤：前置（Node ≥ 20、git、用 `corepack enable` 拿到 `package.json` 锁定的 pnpm）→ `git clone` → `pnpm install` → `pnpm build` → `pnpm serve`；拉新版是 `git pull` → `pnpm install` → `pnpm build` → 重启服务；再加一段「源码启动后实例怎么更新模板」，指向 `local-source-sync` 技能和第一跳的 `--from`。

- 不选把 npx 从首屏拿掉：只想看看效果的人不该先装 pnpm。
- npm 包首页 README 不改主线（装了包的人读它），只加一句「想要本机更新和直接改进，见仓库 README 的源码启动」。

### D10 · 新增 `CONTRIBUTING.md`，只做入口，不复制规则

`AGENTS.md` 是给人和 AI 共用的唯一事实源，但它长、偏向编码 Agent。用源码跑起来的人第一次想交改进时需要一个短入口。`CONTRIBUTING.md` 只写「怎么开始、走哪条路、在哪里看规则」，规则条文一律链接到 `AGENTS.md` 对应小节，不抄。

内容：

1. **三条路怎么选**：
   - 在工作空间里用着发现问题或沉淀出通用改进 → 反馈单（缺陷单 / 贡献单）。源码启动时在源码仓库直接处理，npx 时发邮件；
   - 想报告问题或讨论想法、但不打算自己改 → GitHub Issue；
   - 已经在源码里改好了 → GitHub PR。
2. **改代码前**：读 `AGENTS.md` 第 1 节不变量、第 3 节三个平面、第 5 节编码规范；加功能先读 `dashboard-feature-flow` 技能；改模板读 `templates/pm-aispace/AGENTS.md` 和 `template-contribution`。
3. **非平凡改动先立 change**：判据和命令链接 `AGENTS.md` 第 6 节，不重写。
4. **提交前**：第 4 节验证闸（`typecheck`、`build`、改服务端要重启并点一遍；改模板脚本跑对应回归）。
5. **脱敏红线**：仓库公开，规划产物和提交里不得出现真实客户名、本机绝对路径、凭据；链接 6.1。
6. **提交信息**：沿用现有写法，`feat:` / `fix:` / `tweak:` / `docs:` 加一句中文说明做了什么。
7. **PR 描述**：写动机、影响的平面、验证方式；有对应 change 就给出名字。

`AGENTS.md` 第 7 节以外不需要改；在 `AGENTS.md` 开头的「面向用户的使用说明在 README」旁边补一句「人类贡献者的入口在 CONTRIBUTING.md」。README 的「改代码前」一节改为指向 `CONTRIBUTING.md`。

- 不选把贡献指南写进 README：README 是使用说明，混进贡献流程会把首屏拉长。
- 不选在 `CONTRIBUTING.md` 里复述不变量：两份会漂移，`CLAUDE.md` 已经为同样的理由只做指针。

## Risks / Trade-offs

- [源码看板停了，实例仍走本机] → `runtime.json` 是最后一次启动的快照。维护者的机器上可以接受；改用 npm 包启动一次即恢复 GitHub。技能在本机模板目录不存在时说明并改走 GitHub。
- [工作树里没做完的模板改动被推进实例] → 来源串带 `+dirty`，计划里有 warning，技能要转述给用户；确认前不落盘。
- [两份源码先后启动，`repoRoot` 被后者盖掉] → 与现在 `anydocBin` 谁后启动谁生效相同。
- [旧实例第一次仍要有人在源码侧发起] → 技能把这一跳写死为 `--from`。不在启动时自动 `apply`。
- [源码侧代跑 `apply` 被理解成「源码侧可以写工作空间」] → 只允许跑实例自己的脚本、只在用户确认后、不跑 `--resolved`；6.2 写成唯一例外，`local-source-sync` 技能复述同一条边界。
- [远程打开看板时看到 `launch=source`] → 只暴露枚举，不暴露路径。
- [README 推荐源码后，不熟悉 git / pnpm 的用户卡在安装] → npx 仍在首屏，源码一节写清前置和 `corepack enable`；拉新版忘了 `pnpm build` 是最常见的坑，单独写一句。
- [`CONTRIBUTING.md` 与 `AGENTS.md` 漂移] → 只放链接和流程顺序，不放条文；改规则仍只改 `AGENTS.md`。
- [`runtime.json` 里多了实例绝对路径] → 它在看板配置目录，本来就记着 `anydocBin` / `node` 的绝对路径，和 `projects.json` 同级，不入任何仓库。

## Migration Plan

1. 合入源码侧的判定、`runtime.json` 字段与刷新、技能。已有实例行为不变，直到有人用 `--from` 更新。
2. 源码启动后，`runtime.json` 出现 `launch` / `repoRoot` / `instances`；工作空间里没有任何文件变化。
3. 在源码侧按技能对每个实例跑一次 `--from` 更新，新脚本进入实例。之后实例侧说「更新模板」即走本机。
4. 回退：用 npm 包启动一次即可，`launch` 变成 `package`，脚本走 GitHub。不需要迁移脚本，工作空间里没有要清理的残留。

## Open Questions

无。初稿里「是否允许看板启动时写 `.aispace/dev-link.json`」已改为不写（D2）。
