## Why

不做的话，工作台会一直是「两页 tab 的弹窗」：第三、第四类东西只能继续往标题栏塞 tab。
反馈单是上一个 change（`workspace-agent-kanban-readonly`）留下的尾巴：工作空间智能体会写反馈单，
但它放在隐藏目录 `.kanban-feedback/` 里，看板看不到，也发不出去，只能靠用户自己翻目录、手工转述。
当时说好「后续做看板查看」，这次就做。
「旧 docx 提炼成标准模板」也还没有入口，只停在仓库里的 `spike-docx-template/` 脚本原型里，
产物（客户 profile、reference.docx）也没有固定的存放位置。

## What Changes

- **模块浏览页（新）**：⌘K 打开工作台时先看到四张模块卡片：**问题单、记录单、反馈单、模版洗炼**。
  点卡片进入模块，标题栏有「← 工作台」可以返回。卡片上显示计数（未决问题数、记录总数、待发送反馈数），
  模版洗炼的卡片标「演示」。样式以第三方 shadcn block `@efferd/features-4` 为底稿，改成中文、换 lucide 图标、只用现有令牌。
  从文档里的问题链接点进来时，仍然直接进问题单，不经过浏览页。
- **反馈单迁到 `output/feedback/`，与问题单、记录单同构**（**BREAKING**，只影响工作空间约定）：
  - 一问一文件 `F<四位编号>.md`，扁平 front-matter，目录里放一份 `README.md` 作为字段契约，写法照 `output/questions/`、`output/records/`。
  - 字段分**AI 写区**和**人写区**：现象、期望、复现、改法、`status`（待处理 / 已修复 / 不修）、`receipt` 由工作空间智能体写；
    `sent_at` 和正文的「## 发送记录」由看板写。
  - 旧的 `.kanban-feedback/` 看板**不移动、不改名**：由工作空间智能体按模板 `AGENTS.md` 的说明自己迁移。
    看板在反馈单页检测到旧目录里还有文件时，提示用户迁移，并提供一段可复制的迁移提示词。
- **反馈单页（新）**：布局与问题单、记录单一致（左侧分组列表，右侧详情卡），分组是「待发送 / 已发送 / 已修复 / 不修」。
  详情卡提供**「邮件发送」**：先预览邮件，再用 `mailto:` 唤起本机邮件客户端，收件人是项目反馈邮箱 `aispace_kanban@163.com`，
  标题和正文由看板生成。用户在邮件客户端里发出后，回到看板点「已发送」，看板才把 `sent_at` 和一条发送记录写回这份反馈单。
  **看板自己不发任何网络请求**，真正发邮件的是用户的邮件客户端。
- **模版洗炼页（新）**：左侧模板列表，右侧新建模板的四步流程：
  ① 选来源（上传本地 .docx，或从工作空间 `input/raw/` 挑一份）→ ② 样式分析（查看 / 映射 / 管理样式）→
  ③ 大纲层级（同层级统一样式）→ ④ 模板补全输出（以 Markdown 文字规定呈现）。
  - 左侧列表**读真实目录** `output/docx-template/<模板名>/`（只读），同时附两条标「示例」的内置合成模板。
  - 四步流程**只做界面演示**：分析结果是前端内置的合成数据，文件不上传、不解析，「保存为模板」只存在内存里。
    真正的提炼和写盘在后续「.md 转 .docx」change 里做，那时复用 `spike-docx-template/` 的脚本。
- **工作空间模板新增 `output/docx-template/`**：带一份 `README.md`，约定每个模板一个子目录，
  放 `profile.json`（客户差异）、`reference.docx`、可选的 `cover.docx`、`spec.md`（写给写 md 的人的文字规定）和 `collect/`（采集报告）。
- **AGENTS.md 不变量 1 新增第八条窄例外**：看板写 `output/feedback/F<编号>.md` 的发送记录（见下文「写入工作空间」）。
- **工作台壳重构**：页类型从 `'questions' | 'records'` 扩成浏览页 + 四个模块；各模块照旧常挂、切回来保持原样。

## Capabilities

### New Capabilities

- `workbench-module-hub`：工作台的模块浏览页：入口、卡片与计数、进入与返回、深链跳过浏览页、各模块状态保持。
- `workbench-feedback`：`output/feedback/` 的字段契约、只读索引与详情、分组展示、邮件发送与「已发送」写回、旧目录迁移提示、自动刷新与降级。
- `docx-template-refine`：`output/docx-template/` 的目录约定与只读模板列表，以及四步新建流程的前端演示（不上传、不落盘）。

### Modified Capabilities

（`openspec/specs/` 下没有相关条目。）

> 与未归档的 `workspace-agent-kanban-readonly` 有冲突：它的「看板缺陷通过反馈单交接」和「看板不读反馈单」两条写的是
> `.kanban-feedback/`、看板不读。本 change 改了这两点：位置换成 `output/feedback/`，看板改为在工作台读取、发送。
> 那个 change 已经实现、但还没归档，本 change 会**直接改它的 spec 文本**，让两边在归档前保持一致（见 tasks 第 7 组）。

## Impact

- **服务端**：新增 `src/server/feedback.mjs`（扫描、解析、发送记录写入）和 `src/server/docxTemplates.mjs`（只读列出模板目录）；
  `http.mjs` 新增三个只读接口和一个写接口。`output/` 本来就在递归监听范围内，**不用改 `watchWorkspace`**。
  服务端没有类型检查，改完必须重启 `pnpm dev` / `pnpm serve`。
- **`src/app/lib/api.ts` 契约**：**要改**。新增反馈单与 docx 模板的类型和 `api.*` 方法，新字段全部可选、前端兜底。
- **前端**：`Workbench.tsx`（壳）、`App.tsx`（页状态与深链）；新增 `WorkbenchHub.tsx`、`FeedbackPane.tsx`、
  `TemplateRefinePane.tsx` 及演示数据；`components.json` 增加 `@efferd` registry。
- **CLI**：不改。
- **templates（「放进去就是发出去」）**：`templates/pm-aispace/` 新增 `output/feedback/README.md`、`output/docx-template/README.md`；
  改 `AGENTS.md` 的反馈单一节（新位置、新格式、旧目录迁移步骤、回执怎么回写）、`CLAUDE.md` 的指针、`output/README.md` 的子目录说明。
  已有工作空间不会自动拿到新目录和新规则，旧反馈单要靠智能体迁移。
- **扫描 / 搜索**：`feedback/` 和 `docx-template/` 都不在 `OUTPUT_GROUPS` 里，不会进产出列表、全局搜索和完整度统计。实现时要确认一遍。
- **依赖**：不新增 npm 包。`@efferd/features-4` 和它依赖的 `@efferd/decor-icon` 是 shadcn copy-in 的前端源码。
- **公开信息**：反馈邮箱 `aispace_kanban@163.com` 是项目对外公开的反馈地址，会写进源码常量和本仓产物。
  `openspec/config.yaml` 的脱敏红线里写了「不写邮箱」，要给它补一句例外说明。

## 写入工作空间（已拍板）

用户已同意在 AGENTS.md 不变量 1 **新开第八条窄例外**。它与第四条（人工反馈）、第六条（记录状态）同形：
看板服务端自己写盘，不 `spawn`。边界如下，写进 AGENTS.md 时照抄：

1. 只允许**改已存在**的 `output/feedback/F<编号>.md`，不新建、不删除、不改名；编号不存在一律 404 —— 写反馈单是工作空间智能体的事。
2. 只允许写**人写区**：front-matter 的 `sent_at`，以及正文「## 发送记录」小节（只追加 `###` 子节，不改写已有条目）。
   载荷里出现 AI 写区字段（`status` / `receipt` / `title` / `id` / `created` 等）一律 400，不落盘。
3. 必须由用户在看板上点「已发送」明确发起。唤起 mailto 本身**不写盘**；没有后台任务、定时，也不从任何信号自动推断「已发送」。
4. 必须环回（`allowMutations`）且非跨站（`rejectIfForeignOrigin`），否则 403。
5. 请求**只带编号**（`F0003` 这种形态），不接受任何路径；落盘路径由服务端用 `resolveInside()` 自己拼。
6. `output/feedback/` 下的其它文件、`.kanban-feedback/`、`output/docx-template/`、`input/`、`project.yaml`、`visualization/` 仍然只读。
   写入走「先写临时文件再原子替换」，失败不留半截文件。

**对外发送**：看板不连网发信，邮件由用户的邮件客户端发出。发送前必须让用户看到完整的邮件内容；
预览里提示用户，反馈单可能被带进公开仓库，发之前检查一遍，别夹带真实资料。
