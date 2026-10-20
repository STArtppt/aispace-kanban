---
name: local-source-sync
description: 看板从源码启动时，把模板更新进已登记的工作空间实例，并直接读实例里的反馈单。当用户在本仓库里说「同步到实例」「更新某个工作空间的模板」「看看实例里的反馈单」「本机模板推过去」时使用。runtime.json 的 launch 不是 source 时不要用这个技能。
---

# 本机源码与实例同步

只在看板**从源码启动**时用。判定看 `~/.pmwork/dashboard/runtime.json`（与 `projects.json` 相邻）的 `launch`：

- 不是 `"source"`（是 `"package"`、没有这个字段、文件读不到）：本技能不适用。模板更新仍走 GitHub，反馈仍走邮件。向用户说明当前启动方式不是源码，不做本机覆盖。
- 是 `"source"`：按下面做。

`repoRoot` 是源码仓库根。`instances` 是当前登记的实例，每项有 `id`、`name`、`root`。这份文件在看板配置目录，不在任何工作空间里。

## 找实例

只读 `instances`。不要在磁盘上另找工作空间，不要扫用户目录。

实例不在清单里，就是没在这台看板上登记，或已经被移出。告诉用户，不要猜路径。

## 更新一个实例的模板

跑的是**实例里的** `scripts/template_update.py`，工作目录是实例根。不要跑本仓库 `templates/` 里的那份：脚本用自己的位置推断工作空间根，跑错副本会把模板目录当成工作空间。

模板目录是 `<repoRoot>/templates/<模板 id>`。模板 id 取实例 `.aispace/template.lock.json` 的 `template`；没有 lock 时用 `pm-aispace`。源码仓库里没有这个模板 id（用户自建模板）时，不要猜目录，告诉用户这条仍走 GitHub。

1. 出计划，显式带 `--from`。已有实例里的脚本可能还不认识 `runtime.json`，不带 `--from` 会去下 GitHub：

   ```bash
   python3 scripts/template_update.py plan --from <repoRoot>/templates/<模板 id>
   ```

2. 把计划摘要给用户。来源带 `+dirty`，或计划里有「来源有未提交改动，冲突对照的基线不精确」时，照实说明模板目录还有没提交的改动。
3. **用户确认之前不 `apply`。** 确认前实例里的模板文件没有变化。
4. 用户确认后：

   ```bash
   python3 scripts/template_update.py apply --plan <计划文件>
   ```

5. 脚本只写计划里的「新增」和「覆盖」，外加 lock。冲突文件和 seedOnly 新版不由这边改。
6. 把剩下的冲突和 seedOnly 新版列给用户，请用户到那个工作空间里让智能体合并。
7. **不要**手改实例里的任何文件。**不要**跑 `apply --resolved`。那等于替工作空间判定合并结果。

这是根目录 `AGENTS.md` 第 6.2 节允许的唯一一种跨目录写入：写盘的是实例自己的脚本，而且只在用户确认计划之后。不变量 1 不因此新增条目。

`apply` 成功后，新脚本进入实例。之后用户在工作空间里说「更新模板」，实例侧不带参数 `plan` 就会自己判定，不必再从这边带 `--from`。

## 读反馈单

直接读实例的 `output/feedback/F*.md`。不要等用户发邮件，也不要求用户把文件拷进本仓库。

按 `AGENTS.md` 第 6.2 节处理（缺陷单 / 贡献单、脱敏、验证、提交）。回执写成一段可以转发的文字，交给用户。本会话不写反馈单，不改 `status` / `receipt`。
