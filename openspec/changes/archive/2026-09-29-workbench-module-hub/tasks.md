## 1. 规则先行：AGENTS.md 与脱敏说明

- [x] 1.1 `AGENTS.md` 不变量 1 新增第八条窄例外（照 proposal「写入工作空间」六款写），注明与第四、六条同形、为什么不走 spawn；第 3 节目录表补 `feedback.mjs`（含写入）、`docxTemplates.mjs`（只读）
- [x] 1.2 `openspec/config.yaml` 脱敏红线补一句例外：项目公开反馈邮箱 `aispace_kanban@163.com` 可以写进源码和产物，其它邮箱照旧不写

## 2. 服务端：反馈单与模板目录

- [x] 2.1 新建 `src/server/feedback.mjs`：`listFeedback`（解析 `output/feedback/F<编号>.md` 的 front-matter；`readdir` 统计 `.kanban-feedback/*.md` 得到 `legacyCount`，不读旧文件内容）、`readFeedback`（按 `## ` 拆节 + 发送记录）
- [x] 2.2 `markSent(root, id, at)`：校验只动 `sent_at` 和「## 发送记录」，只追加 `###` 子节；文件不存在 404，结构认不出 409；原子替换。先看 `questions.mjs` / `records.mjs` 的写法，能抽公共函数就抽，不复制第三份
- [x] 2.3 新建 `src/server/docxTemplates.mjs`：`listDocxTemplates`（一层子目录，跳过 `.` 开头，五样文件是否存在 + mtime）、`readDocxTemplate`（附带 `spec.md` 原文）
- [x] 2.4 `http.mjs` 加路由：`GET feedback`、`GET feedback/:fid`、`POST feedback/:fid/sent`（`allowMutations` + `rejectIfForeignOrigin`，载荷有 `sent_at` 以外的字段就 400）、`GET docx-templates`、`GET docx-templates/:name`；`:fid` 按 `^F\d{4}$` 校验，`:name` 做基名校验，都过 `resolveInside()`
- [x] 2.5 确认 `feedback/`、`docx-template/` 不进产出列表、搜索、溯源反链、完整度统计（`OUTPUT_GROUPS` 之外 + grep 搜索实现确认一遍）；确认 `output/` 递归监听能覆盖它们
- [x] 2.6 确认 `scripts/build-npm-package.mjs` 能带上两个新模块（`pnpm build:npm` 后检查 `npm-package/`）
- [x] 2.7 **重启 `pnpm dev`**。在 scratchpad 里建一个合成的临时工作空间（不入仓），用 `curl` 逐条验：空目录、正常解析、写歪的状态、`legacyCount`、非法编号 400、`POST sent` 只改两处（diff 前后文件）、带 `status` 的载荷 400、不存在的编号 404、`--host 0.0.0.0` 下写接口 403

## 3. 契约：`src/app/lib/api.ts`

- [x] 3.1 新增 `FeedbackItem` / `FeedbackIndex`（含 `legacyCount?`）/ `FeedbackDetail`、`DocxTemplateItem` / `DocxTemplateDetail`，新字段全部可选
- [x] 3.2 `api` 加 `feedbackIndex`、`feedbackDetail`、`feedbackMarkSent`、`docxTemplates`、`docxTemplate`；404 与问题单 / 记录单一样识别为 `unsupported`

## 4. 前端：工作台壳与模块浏览页

- [x] 4.1 `components.json` 加 `@efferd` registry，执行 `npx shadcn@latest add @efferd/features-4`，记录实际落下的文件
- [x] 4.2 block 改写成 `components/WorkbenchHub.tsx`：四张卡（中文、lucide、计数、「演示」标记、`button` 可键盘操作），计数取不到就不显示；删掉原 `feature-section.tsx`，`decor-icon.tsx` 留在 `components/`；grep 确认没有硬编码色值
- [x] 4.3 `Workbench.tsx`：页类型扩成五种；浏览页标题栏 / 模块页标题栏（「← 工作台」+ 四项 tabs）；四个模块常挂 + `hidden` + `inert`；更新文件头注释
- [x] 4.4 `App.tsx`：`workbenchPage` 初值改成 `'hub'`；深链仍然直接设 `questions`；反馈单索引接进来传给 `Workbench`
- [x] 4.5 不改 `QuestionsDialog.tsx`（工作区里有未提交改动），`QuestionsPane` 的 props 不变

## 5. 前端：反馈单页

- [x] 5.1 反馈单 hook（`index / loading / error / unsupported / reload`），接 `changeToken` 静默重拉
- [x] 5.2 `components/FeedbackPane.tsx`：五组分组列表（由 `status` + `sent_at` 推出，可折叠）、详情卡（各节 `Markdown` 渲染、发送记录），布局照 `RecordsPane`
- [x] 5.3 「邮件发送」预览弹窗：收件人常量（只写一处）、标题、正文（六节 + 看板版本号）、公开风险提示、三个复制按钮；超长时切换成剪贴板方案并说明
- [x] 5.4 唤起 `mailto:` 后出现「我已发出」，点了才调 `feedbackMarkSent`，成功后 toast 并刷新；非环回时置灰并说明
- [x] 5.5 `legacyCount > 0` 时显示旧目录提示 + 「复制迁移提示词」
- [x] 5.6 降级：`unsupported` 提示重启；`workspaceAvailable === false` 用统一文案；空目录说明「反馈单由工作空间智能体写」

## 6. 前端：模版洗炼

- [x] 6.1 `components/templateRefine/demoData.ts`：合成的格式簇、大纲树、基础样式清单（pandoc 样式名，照 `spike-docx-template/base-spec.json` 的角色）、两条示例模板，不含任何真实客户内容
- [x] 6.2 `components/TemplateRefinePane.tsx`：左侧列表（真实模板 + 示例 + 仅本次会话），右侧概要（真实模板显示文件清单、渲染 `spec.md`）/ 四步流程；页顶常驻演示提示
- [x] 6.3 第 ① 步：上传（只取文件名和大小）/ 从 `scan` 的 `input/raw` 过滤 `.docx`；两种空态和目录丢失的降级
- [x] 6.4 第 ②③ 步：映射表与层级树，本地状态，同层级共用样式
- [x] 6.5 第 ④ 步：由本地状态生成 Markdown 文字规定，用 `Markdown` 组件渲染；「复制」「保存为模板（仅本次会话）」
- [x] 6.6 在网络面板确认整个流程没有写请求，也没有携带文件内容的请求

## 7. templates 与相关 change

- [x] 7.1 新增 `templates/pm-aispace/output/feedback/README.md`（字段契约、AI / 人写区、编号规则、分组推导、发送记录格式）
- [x] 7.2 新增 `templates/pm-aispace/output/docx-template/README.md`（子目录约定、五样产物、`profile.json` 的 `_src` 写法；说明客户资料别外传）
- [x] 7.3 `templates/pm-aispace/AGENTS.md` 反馈单一节：改到新位置和新格式；补旧目录迁移步骤；写明回执回写只改 `status` / `receipt`，不碰 `sent_at` 和发送记录；「不要做的事」一节同步
- [x] 7.4 `templates/pm-aispace/CLAUDE.md` 的指针、`output/README.md` 的子目录说明同步
- [x] 7.5 修改未归档的 `workspace-agent-kanban-readonly` 的 spec：「看板缺陷通过反馈单交接」改指 `output/feedback/`，「看板不读反馈单」改成「只在工作台反馈单页读取」，并注明由本 change 改动
- [x] 7.6 README 的工作台说明补上浏览页、四个模块和邮件发送

## 8. 验收闸

- [x] 8.1 `pnpm typecheck` 绿
- [x] 8.2 `pnpm build` 绿
- [x] 8.3 **重启 `pnpm dev`**，在浏览器里把工作台点一遍：浏览页、四个模块进出、tabs 横跳、关掉再开停在原页、文档问题链接深链、⌘K
- [x] 8.4 反馈单全流程（在合成工作空间里做）：待发送 → 预览 → 唤起邮件客户端（不真发，或者发一封标明是测试的邮件）→ 我已发出 → 移到已发送组，diff 确认只改了两处；旧目录提示
- [x] 8.5 三种情况各走一遍：没有 `project.yaml` 的工作空间、目录丢失的工作空间（`available === false`）、深色模式（检查卡片的装饰线和渐变）
- [x] 8.6 旧服务配新前端：不重启服务，只换前端，确认反馈单页和模版洗炼的真实列表显示重启提示，浏览页不白屏
