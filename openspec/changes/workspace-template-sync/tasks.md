## 1. 模板：文件分类与基线（templates）

- [x] 1.1 `templates/pm-aispace/template.yaml` 加 `sync` 段：`seedOnly`、`exclude`（design D3）
- [x] 1.2 `templates/init_workspace.py`：
  - 按 `sync` 段铺设；
  - 铺完写 `.aispace/template.lock.json`（来源、时间、逐文件 SHA-256，`local:` 只记目录名）。
- [x] 1.3 模板 `.gitignore` 确认不忽略 `.aispace/`；核对看板扫描跳过点目录，`.aispace/` 不进产出列表与搜索

## 2. 模板：更新脚本 `scripts/template_update.py`（只用标准库）

- [x] 2.1 取模板：
  - `--ref`（缺省 `main`）下载 codeload 源码包，只解 `templates/pm-aispace/` 到临时目录，查提交号（失败记 ref 并给 warning）；
  - `--from <目录>` 走本地；
  - 网络失败给中文出路。
- [x] 2.2 `plan`：读新版 `template.yaml` 分类，按 lock 三方判定出六组（新增 / 覆盖 / 保留 / 冲突 / 模板已删除 / seedOnly 有新版，附 diff），带来源与实例文件哈希；没有 lock 时标「首次接入」
- [x] 2.3 `apply --plan`：
  - 哈希有变就整体拒绝；
  - 只执行新增与覆盖，逐个原子替换；
  - 成功后重写 lock，冲突文件哈希不前移。
- [x] 2.4 `apply --resolved <文件>`：只把该文件在 lock 里的哈希登记为合并结果
- [x] 2.5 冲突对照：按 lock 的提交号取基线版本，只解冲突文件，输出三方 diff 供智能体参考
- [x] 2.6 与其它脚本一致的 `--json` 输出与退出码；文件头写清判定口径

## 3. 模板：技能与约定

- [x] 3.1 新增技能 `.claude/skills/pm-template-update/SKILL.md`：
  - 流程：plan → 用非工程语言列计划 → 用户确认 → apply → 逐个合并冲突（前后 diff 摘要）→ seedOnly 有新版的处理 → 汇报；
  - 包括「首次接入」一节。
- [x] 3.2 `pm-deai-writing`：
  - 新增「用法四 · 并入模板新规则」（按短名与判据判重，下一个空号新增，`上游：`、`来源：模板 v<N> R0xx`，整批升一版）；
  - 规则库格式里加可选项 `上游`。
- [x] 3.3 模板 AGENTS.md：
  - 删「模板改动回同步源」；
  - 加「模板更新」「贡献改进」两节，以及 `AGENTS.local.md` 的说明；
  - 技能表加 `pm-template-update`。
- [x] 3.4 模板 CLAUDE.md 加 `@AGENTS.local.md`；实测没有该文件时 Claude Code 正常启动
- [x] 3.5 `output/feedback/README.md`：`kind` 字段、贡献单六节与示例、什么算可推广、脱敏要求

## 4. 模板：禁写规则

- [x] 4.1 `init_workspace.py` 的 `guard_rules`：看板根目录下所有顶层条目都 deny，含 `templates/`；更新函数说明
- [x] 4.2 补规则开关在「已有旧版 deny + 用户 allow」的 settings 上合并去重，重复运行结果一致

## 5. 服务端（改完重启 `pnpm dev` / `pnpm serve`）

- [x] 5.1 `src/server/feedback.mjs`：
  - 解析 `kind`，缺省 `bug`，其它值原样返回；
  - 按 `kind` 选节顺序表，贡献单六节，未知节排后；
  - 索引与详情带出 `kind`。
- [x] 5.2 `src/shared/feedbackMail.mjs`：邮件标题按 `kind` 取前缀，正文按该类型的节拼接
- [x] 5.3 重启后 `curl` 验证：缺陷单、贡献单、无 `kind` 旧单、`kind` 写歪四种情况的索引与详情

## 6. 契约 `src/app/lib/api.ts`

- [x] 6.1 `FeedbackItem` 加可选 `kind?: string`

## 7. 前端

- [x] 7.1 反馈单列表项加「缺陷 / 贡献」标签；`kind` 写歪归「未识别」组
- [x] 7.2 详情卡显示类型，按贡献单节名渲染；邮件预览标题前缀随类型变化
- [x] 7.3 旧服务不报 `kind` 时一律按缺陷显示，不白屏

## 8. 看板仓库文档

- [x] 8.1 本仓 AGENTS.md「反馈单在看板仓库这边闭环」加贡献单的处理步骤与回执格式（design D8）
- [x] 8.2 本仓 AGENTS.md 不变量 1 相关描述核对：本变更不新增服务端写入，第八条边界不变

## 9. 回归

- [x] 9.1 新增 `scripts/check-template-update.mjs`（接进 `package.json`），在临时目录合成：
  - 铺设 → 改模板副本（新增 / 修改 / 删除文件、改 seedOnly）→ 实例本地改一个模板管理文件 → `plan` 六组断言 → `apply` → lock 断言；
  - 过期计划拒绝、冲突不落盘、`--resolved`、首次接入。
  - 全部用 `--from`，不联网。
- [x] 9.2 `init_workspace.py` 的禁写规则断言：新建含 `templates`；补规则开关幂等

## 10. 维护者本机实例迁移（用户确认后执行）

- [ ] 10.1 提交后，为本机四个实例各写首个 lock（来源为提交后的模板）
- [ ] 10.2 把那个带项目专有章节的实例的章节挪进 `AGENTS.local.md`，AGENTS.md 恢复模板原样
- [ ] 10.3 四个实例重跑补规则开关
- [ ] 10.4 用其中一个实例刚沉淀的规则库 v2（R001 修改、R012、R013）写一份贡献单，完整走一遍发送 → 本仓合并 → 回执 → 实例回写补 `上游：`

## 11. 验收闸

- [x] 11.1 `pnpm typecheck` 绿
- [x] 11.2 `pnpm build` 绿
- [x] 11.3 `pnpm test:docx` 与新回归脚本绿
- [x] 11.4 重启 `pnpm dev`，反馈单页点一遍：
  - 缺陷单、贡献单、旧单各看详情与邮件预览；
  - 「我已发出」写回只动 `sent_at` 与发送记录。
- [x] 11.5 三种情况：
  - 没有 `project.yaml`；
  - 目录丢失（`available === false`）；
  - 深色模式（类型标签与分组可读）。
- [x] 11.6 旧服务配新前端：不重启服务只换前端，反馈单页正常、全部按缺陷显示
- [ ] 11.7 在一个合成工作空间里按技能完整跑一次 `pm-template-update`（`--from` 本仓模板）与一次 GitHub 拉取（联网时）
