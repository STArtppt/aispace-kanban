## 1. 模板规则（templates/pm-aispace/AGENTS.md）

- [x] 1.1 「看板显示不对时去哪查」收口：写明看板源码只读、读 GitHub 不读本机、确认是看板缺陷时走反馈单；删掉「告诉用户」这类没有落点的说法，改成指向 1.2
- [x] 1.2 新增「看板反馈单」小节：目录 `.kanban-feedback/`、文件名 `YYYY-MM-DD-<短标题>.md`、必填字段（状态 / 现象 / 期望 / 最小复现 / 疑似源码位置 / 建议改法 / 临时绕法 / 回执）、复现必须是合成片段、写完告诉用户路径和绕法、收到回执后改状态并撤掉绕法；附一份空白样板
- [x] 1.3 收窄「模板改动回同步源」：只能写看板仓库 `templates/<本模板目录>/` 下的同名文件，列出 `src/` `bin/` `scripts/` `package.json` 等禁区；需要改看板代码就转到反馈单
- [x] 1.4 「不要做的事」清单补一条：不要读写本机看板仓库和 npm 包目录（模板同步那一条除外）
- [x] 1.5 全文搜 `src/server/`、`src/app/`，确认只出现在 GitHub 链接或「去哪查」表格里

## 2. 禁写规则生成（templates/init_workspace.py）

- [x] 2.1 新增函数：根据看板根目录（`HERE.parent`）和模板目录算出 deny 列表（除 `templates/` 外的顶层条目，加上 `templates/` 下除本模板外的条目；目录写 `Edit(//<abs>/**)`，文件写 `Edit(//<abs>)`）
- [x] 2.2 新增函数：合并写入 `<工作空间根>/.claude/settings.local.json` 的 `permissions.deny`，合并去重，保留其他字段；先写临时文件再替换
- [x] 2.3 新建流程末尾调用它；`--json` 输出里带上写了几条
- [x] 2.4 新增补规则开关（如 `--guard-only --path <工作空间>`）：只做 2.2，不要求 `--name`，不复制也不新建其他文件；工作空间目录不存在就报错退出
- [x] 2.5 模板 `.gitignore` 加 `.claude/settings.local.json`
- [x] 2.6 在临时目录验证：新建一次、对已有 allow 的 `settings.local.json` 补规则两次（结果一样），`--from` 指向仓库外的模板再新建一次；检查三次的 deny 内容，验证完删掉临时目录

## 3. 看板仓库这边的闭环（AGENTS.md）

- [x] 3.1 看板 `AGENTS.md` 加一小节「处理工作空间反馈单」：当作需求输入走本仓流程，写进产物前先脱敏，处理完给出回执（结论 + 提交号或不修理由），不直接写工作空间文件
- [x] 3.2 同一节写明已有工作空间怎么补：复制模板 `AGENTS.md` 的对应小节，运行 2.4 的开关；看板新增顶层目录后要提醒用户重跑

## 4. 本次案例收尾（前端 + 模板）

- [x] 4.1 审工作区里遗留的 `src/app/components/MetaView.tsx` 改动，对照 `project-meta-view` spec：原始值行进「内容」列、混写不崩、`ObjectTable` 的 props 类型写实（行不一定是对象）、「验收标准」列表为空时不显示
- [x] 4.2 模板 `project.yaml` 的 `deliverables` 注释改成 `形如 { 名称: , 类型: , 阶段: }`，并保留原来的说明
- [x] 4.3 `pm-project-meta` 技能的字段规格补一条：表格类列表字段写成对象数组，同一字段各行键一致
- [x] 4.4 准备一份合成的 `project.yaml`（放在临时目录，不入库），`deliverables` 同时有字符串行和对象行，`acceptance.标准` 有两条，用来做第 5 组的浏览器验证

## 5. 验收

- [x] 5.1 `pnpm typecheck` 通过
- [x] 5.2 `pnpm build` 通过
- [x] 5.3 重启 `pnpm dev` 后在浏览器点概览页：合成件的「成果要求」不拆字、混写正常、「验收标准」显示；没有 `project.yaml` 的工作空间、目录已丢失的工作空间照常显示空态；深色模式下表格和列表显示正常
- [x] 5.4 新建一个工作空间，确认 `.claude/settings.local.json` 有 deny 规则、`.kanban-feedback/` 不出现在看板任何视图里（手动建一个带文件的空目录试）
