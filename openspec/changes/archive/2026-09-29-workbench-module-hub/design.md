## Context

- **工作台现状**：`src/app/components/Workbench.tsx` 是一个 ⌘K 弹窗，标题栏里用 segmented tabs 切换问题单和记录单。
  两页都常挂着，非当前页用 `hidden` + `inert` 藏起来，切回来时筛选和卡片位置都还在。
  页状态 `workbenchPage` 放在 `App.tsx`，关掉再打开还停在原来那页；点文档里的问题链接时，
  `App` 会把页设成 `questions`，再用 `focusQuestion` 定位到那条问题。
- **问题单 / 记录单的机制**：一条一文件（`Q<编号>.md` / `I<编号>.md`），扁平 front-matter，目录里的 `README.md` 是字段契约；
  字段分 AI 写区和人写区，物理隔开，这就是它们的并发方案，不用锁。
  看板写入走各自模块（`questions.mjs` / `records.mjs`）：只改已存在的文件、只带编号、原子替换。
  两者都不在 `OUTPUT_GROUPS` 里，所以不进产出列表。
- **反馈单现状**：来自 `workspace-agent-kanban-readonly`（已实现、未归档）。智能体写到 `<工作空间根>/.kanban-feedback/YYYY-MM-DD-<短标题>.md`，
  格式是 `# 标题` + `- 状态：` `- 回执：` + 六个 `##` 节。看板扫描会跳过 `.` 开头的目录，所以看不到。
- **docx 模板提炼现状**：`spike-docx-template/`（未提交）是 Python 原型。六步里「采集 / 清洗 / 统一 / 补充 / 萃取」已经跑通，
  「识别（生成计划给人确认）」和「写给写 md 的人的文字规定」还没做。客户产物目前放在仓库的私有目录里，没有工作空间内的位置。
- **监听**：`watchWorkspace` 已经递归监听 `output/`，所以 `output/feedback/`、`output/docx-template/` 的变化天然能通过 SSE 推给前端。
- **设计系统**：`components/ui/**` 是 startist-ui 的 vendored 快照（红线：不在本仓分叉）；`components.json` 目前只登记了 `@startist`。

## Goals / Non-Goals

**Goals:**

- 工作台以模块浏览页为入口，四个模块共用一个壳。以后加第五个模块，只需要加一张卡片和一个 pane。
- 反馈单与问题单、记录单在文件形态、字段分区、写入边界、界面布局四个层面都同构。
- 用户在看板上就能把一份反馈单发到项目反馈邮箱，并留下发送记录。
- `output/docx-template/` 成为模板产物的固定位置，看板能列出它；四步流程在界面上能完整走一遍，供用户对信息架构拍板。

**Non-Goals:**

- 看板不直连网络发信（不引入 SMTP、不管凭据）。
- 看板不移动旧的 `.kanban-feedback/`，不替智能体新建反馈单，也不改反馈单的 `status` / `receipt`。
- 模版洗炼不解析 docx、不 spawn Python、不上传，也不往 `output/docx-template/` 写任何东西。
- 不改问题单 / 记录单的内部行为与接口；不把 efferd 的 block 放进 `components/ui/`，也不回流到 startist。

## Decisions

### D1 · 浏览页是工作台的一「页」，不是另一个弹窗

页类型扩成 `'hub' | 'questions' | 'records' | 'feedback' | 'template'`，浏览页和四个模块同在一个 `DialogPopup` 里。
在浏览页，标题栏只显示「工作台 + 工作空间名」；进入模块后左侧多一个「← 工作台」，同时显示四项 tabs，模块之间可以直接横跳。
⌘K 打开时停在上次的页；首次打开时显示浏览页。深链（`focusQuestion`）直接进问题单。

- 备选 A：去掉 tabs，只能经过浏览页切换。**不选**：问题单和记录单之间来回看是高频操作，多点一次会很烦。
- 备选 B：浏览页做成弹窗外的独立视图。**不选**：⌘K 的心智是「一个快捷键到工作台」，拆开以后要记两个入口。

### D2 · efferd block 当底稿 copy-in，改完归本仓所有

`components.json` 加 `"@efferd": "https://efferd.com/r/{style}/{name}.json"`，执行 `npx shadcn@latest add @efferd/features-4`，
会落下 `feature-section.tsx`（block）和 `decor-icon.tsx`（角标 svg）。
block 改写成 `components/WorkbenchHub.tsx`（中文、lucide、卡片是 `button`、带计数），原文件删掉；`decor-icon.tsx` 原样留在 `components/`。

- 备选：原样保留 block，外面包一层。**不选**：block 本身是写死英文内容的示例页（`min-h-screen`、`IconPlaceholder`），不是原语。
- 不放 `ui/` 的理由：`ui/` 是 startist 的快照目录，混进别家的文件，下次 re-add 时就分不清来源了。
- 令牌：block 只用了 `bg-background` / `bg-border` / `bg-muted` / `text-muted-foreground` / `--theme(--color-foreground/.1)`，没有硬编码色值。

### D3 · 反馈单改成 `output/feedback/F<编号>.md`，照问题单的机制

字段契约写在 `templates/pm-aispace/output/feedback/README.md`，形如：

```markdown
---
id: F0003
title: 概览页成果要求被渲染成逐字表格
status: pending
created: 2026-09-29
receipt:
sent_at:
---

## 现象
## 期望
## 最小复现
## 疑似源码位置
## 建议改法
## 临时绕法

## 发送记录
```

| 区 | 字段 | 谁写 |
| --- | --- | --- |
| AI 写区 | `id` `title` `created` `status`（`pending` / `fixed` / `wontfix`）`receipt`，六个内容节 | 工作空间智能体 |
| 人写区 | `sent_at`，「## 发送记录」下的 `###` 子节（只追加） | 看板（用户点「已发送」） |

界面上的分组由两个字段推出，不新增状态值：`pending` 且 `sent_at` 为空 → 待发送；`pending` 且 `sent_at` 有值 → 已发送；
`fixed` → 已修复；`wontfix` → 不修；其它值 → 未识别（照原文显示）。

- 备选 A：保留 `.kanban-feedback/`，看板对它开特例。**不选**：用户要求与工作台机制一致。问题单、记录单都在 `output/` 下、都有编号，
  「只带编号、不接受路径」这条写入边界也只有在编号化以后才能成立（`YYYY-MM-DD-<短标题>` 是自由文本，拿它做参数就等于接受路径片段）。
- 备选 B：看板把「已发送」写进 `status`。**不选**：`status` 由智能体回写修复结论，两方写同一个字段就需要锁；分成 `status` 和 `sent_at` 两个字段，人写区和 AI 写区就能物理隔开。
- 备选 C：看板顺手帮用户把旧目录迁过来。**不选**：迁移需要新建、重编号、删除旧文件，全都超出第八条例外的范围；交给智能体按模板规则做。

### D4 · 发送走 `mailto:`，「已发送」由用户确认后再写回

点「邮件发送」后先弹预览，显示收件人、标题、正文，以及一句公开风险提示；确认后 `window.location.href = mailto:...` 唤起邮件客户端。
- 收件人：`aispace_kanban@163.com`（前端常量，只写一处）。
- 标题：`[aispace-kanban 反馈] F0003 <title>`。
- 正文：六个内容节的原文，末尾附看板版本号和发送日期；不带工作空间路径、工作空间名。
- 长度兜底：`mailto` URL 编码后超过约 1800 字符时（不少客户端会截断），正文换成一句「正文已复制到剪贴板，请粘贴」，同时把全文写进剪贴板，预览里说明这一点。

唤起之后界面出现「我已发出」按钮。点了才 `POST /api/projects/:id/feedback/:fid/sent`，服务端写 `sent_at` 并追加一条
`### <日期时间> 已发送至 aispace_kanban@163.com`。重复发送会再追加一条，`sent_at` 改成最近一次的时间。

- 备选 SMTP（nodemailer）：已被否决。它需要新增服务端依赖、管理凭据，而且是看板第一次主动往外发数据。
- 备选：唤起 mailto 的同时自动标记已发送。**不选**：唤起不等于发出，用户可能在邮件客户端里取消；自动标记会违反第八条第 3 款。

### D5 · 服务端模块与接口

- `src/server/feedback.mjs`：`listFeedback(root)`（解析 front-matter，同时 `readdir` 旧目录 `.kanban-feedback/` 统计份数、给出 `legacyCount`，不解析旧文件内容）、
  `readFeedback(root, id)`、`markSent(root, id, at)`。front-matter 的解析和写回，复用 `frontmatter.mjs`
  以及 `questions.mjs` / `records.mjs` 现有的原子写法；能抽公共函数就抽，不再复制第三份。
- `src/server/docxTemplates.mjs`：`listDocxTemplates(root)` 列出 `output/docx-template/` 下的一层子目录（跳过 `.` 开头），
  返回名称，以及 `profile.json` / `reference.docx` / `cover.docx` / `spec.md` / `collect/` 是否存在和修改时间；
  `readDocxTemplate(root, name)` 额外返回 `spec.md` 原文。
- 接口：`GET /feedback`、`GET /feedback/:fid`、`POST /feedback/:fid/sent`、`GET /docx-templates`、`GET /docx-templates/:name`（都挂在 `/api/projects/:id/` 下）。
  `:fid` 必须匹配 `^F\d{4}$`；`:name` 必须是不含分隔符、不含 `..`、不以 `.` 开头的基名；两者都必须过 `resolveInside()`。
  写接口挂 `allowMutations` + `rejectIfForeignOrigin`。

- 备选：把两者塞进 `scan`。**不选**：`scan` 驱动概览、搜索和完整度统计，放进去会让它们出现在不该出现的地方；问题单、记录单也是独立接口。

### D6 · 模版洗炼：列表读真目录，流程用演示数据

- 左侧列表：先列 `output/docx-template/` 里的真实模板，再列两条标「示例」的内置合成模板。
  选中真实模板时，右侧显示它包含哪些文件，并用 `Markdown` 组件渲染 `spec.md`；选中示例模板时，显示演示概要。
- 四步流程：演示数据放在 `components/templateRefine/demoData.ts`，形状照着 `collect.py` 的 `report.json`（格式簇）和 `base-spec.json`（pandoc 样式名）来定，内容全部合成。
  第 ① 步「从工作空间挑」过滤现有 `scan` 的 `input/raw` 文件列表里的 `.docx`；「上传」只取文件名和大小。
  第 ②③ 步的修改是本地状态，实时反映到第 ④ 步生成的 Markdown 里；「保存为模板」只追加到内存列表，标「仅本次会话」。
  页顶常驻演示提示。
- 备选：demo 直接 spawn spike 脚本。**不选**：会一次引入 spawn、上传落点、写 `output/docx-template/` 三个写入决策，应该和「.md 转 .docx」放在一起定。

## Risks / Trade-offs

- [旧工作空间还在用 `.kanban-feedback/`] → 反馈单页显示「旧位置还有 N 份」和一段迁移提示词；模板 `AGENTS.md` 写明迁移步骤：按日期顺序编号，旧的回执和状态照搬，迁完删掉旧目录。
- [智能体把格式写歪] → 解析时宽松处理：front-matter 缺字段就当空，认不出的状态归到「未识别」，未知的节原样显示；写入前校验文件结构，校验不过就 409，并说明原因，不硬写。
- [mailto 在没配邮件客户端的机器上没有反应] → 预览里同时提供「复制收件人 / 标题 / 正文」，用户可以自己去网页邮箱粘贴发送，发完照样点「我已发出」。
- [邮件夹带真实资料被公开] → 预览必须展示全文，并附风险提示；模板规则本来就要求最小复现用合成数据。
- [第三方 registry 以后可能改动或下线] → 只 add 一次，产物归本仓所有；`components.json` 里的登记不在构建路径上。
- [demo 被误以为是真功能] → 卡片、页顶、示例模板三处都标「演示 / 示例」。
- [`QuestionsDialog.tsx` 工作区里有未提交改动] → 本 change 不改它，`QuestionsPane` 的 props 也不变。

## Migration Plan

1. 看板先上线：同时读新目录和旧目录的份数，旧工作空间在看板上能看到迁移提示。
2. 模板同时更新：新建的工作空间直接使用 `output/feedback/`。
3. 已有工作空间：用户把迁移提示词交给工作空间智能体，由它迁移。看板这一侧不需要回滚步骤；如果要撤回，删掉反馈单页即可，文件都还在工作空间里。

## Open Questions

- 模板包的真实生成（spawn spike 脚本、上传文件落点、写 `output/docx-template/`）留给「.md 转 .docx」change，届时还需要一条写入例外，或者走 spawn 那一族。
