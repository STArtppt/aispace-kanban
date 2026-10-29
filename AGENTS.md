# AGENTS.md —— 项目编码规范总则

> 本文件是 **aispace-kanban** 面向所有编码 Agent 与人类协作者的**唯一事实源**。
> `CLAUDE.md` 只是指针;改协作约定 / 项目说明**只改本文件**。
> 使用说明在 [README.md](./README.md),人类贡献者入口在 [CONTRIBUTING.md](./CONTRIBUTING.md)。

---

## 1. 项目是什么 + 最硬的不变量

**aispace-kanban** 是**与 AI 反复对话完成知识工作**时用的**本机工作空间协作台**:常驻本机的服务,
指向若干工作空间目录,在浏览器里查看、管理与 AI 协作的产物(输入资料含资料台账、产出文档、原型与参考),
查看并简单维护原始输入。
只认 `input/` + `output/` 的目录约定(判据见 `config.mjs` 的 `inspectWorkspace`),**不绑定行业或岗位**。

工作空间**模板**([`templates/`](./templates))也在本仓维护,是**另一套语境**:本文件的编码规范
**不适用于 `templates/` 内部**,改 PM 模板见 [`templates/pm-aispace/AGENTS.md`](./templates/pm-aispace/AGENTS.md)。

**不变量(违反即为 bug,不接受任何"顺手写一下"):**

1. **写工作空间只走能力清单,清单以外一律只读。** 服务端对工作空间的任何写入(新建、改写、改名、移动,
   以及 spawn 会写工作空间的脚本)都必须属于下面清单里的某一项能力,并满足六条安全链路。
   代码里的镜像是 `src/server/capabilities.mjs` 的注册表:每个写接口先调 `guardCapability()`,
   `pnpm test:capabilities` 静态检查注册表、路由与本清单是否一致。
   各能力的写入面、请求形状、失败路径**以链接的 spec 为准**,这里不复述。

   **安全链路**(每项能力同时满足;偏离任一条必须在清单该行标出理由与补偿,由人拍板后才能合入):
   1. **发起**:只由用户在看板上的明确操作触发;没有后台任务、定时、文件变化自动重跑。
   2. **来源**:服务监听环回地址(`allowMutations`)且请求不是跨站或浏览器扩展来源,否则 403 ——
      判定只在 `guardCapability()` 里,不写第二份。
   3. **寻址**:请求不带工作空间路径;目标只用服务端下发的不透明键、编号或固定枚举,服务端反查后过 `resolveInside()`。
   4. **写入面**:事先写明可写的目录 / 文件 / 字段,其余只读;读写工作空间以外的任何文件都算偏离。
      看板**直写**有人写区与 AI 写区的文件时只写人写区;spawn 的脚本按其 spec 可改写 AI 写区里指向被改名 / 移动文件的路径。
   5. **执行者**:有工作空间脚本能承接的,看板只 spawn、自己不写;看板直写只做小写入,先写临时文件再原子替换。
      缺脚本或旧服务进程不支持时置灰或 400,不由看板代劳。
   6. **可回退**:不覆盖别人的内容 —— 用户写的、AI 写的、外部带进来的文件一律不覆盖,落点已存在 409;
      只有本能力自己生成、能从来源重新生成的派生文件可以整份重建(原型镜像、`定稿.md`、带生成标记的 `.docx`)。
      动多个文件的先出预览并带指纹确认。

   **删除**:任何能力要删除工作空间文件,只能移入工作空间内的回收区 `.aispace/trash/`(记原路径与时间,可还原),
   看板不做真删除(`unlink` / `rm` / `rmdir`)。清理本次操作自己建的临时文件不算删除,代码里以
   `// capability: tmp-cleanup` 标注。**目前清单里没有任何一项具备删除**;第一项删除能力要单独立 change。

   **新增写能力**:注册表登记 → 路由调 `guardCapability` → 本清单加一行 → 写 spec → 跑 `pnpm test:capabilities`。
   不要因为「反正已经能写了」顺手扩大某一项的写入面 —— 扩大也是改清单,要过同样的门槛。

   **能力清单**(写工作空间的全部能力):

<!-- capabilities:begin -->
| 标识 | 名称 | 执行者 | 写入面 | 入口 | 偏离 | spec |
| --- | --- | --- | --- | --- | --- | --- |
| `workspace-init` | 新建工作空间 | spawn `templates/init_workspace.py` | 新目录下的模板骨架与 `.aispace/template.lock.json` | 侧栏「新建」→ 新建工作空间 | — | [workspace-template-update](openspec/specs/workspace-template-update/spec.md) |
| `raw-ingest` | 资料转换 | spawn `scripts/ingest.py` | `output/converted/`,只转点的那份或那个目录 | 原始资料行「转换」/ 目录「转这一整个目录」 | — | [raw-source-status](openspec/specs/raw-source-status/spec.md) |
| `db-schema-refresh` | 刷新 schema | spawn `scripts/db_ingest.py` | `output/converted/_sources/<源名>/` | 输入资料 → 数据库源「刷新 schema」 | — | [database-source](openspec/specs/database-source/spec.md) |
| `visual-capture` | 贴 URL 采集 | 直写 | `visualization/references/<slug>/` `visualization/prototypes/<slug>/`,只新建 | 参考 / 原型 tab 贴 URL | — | [visual-capture](openspec/specs/visual-capture/spec.md) |
| `capture-package-inbox` | 采集包接收 | 直写 | `visualization/references/<slug>/`,只新建 | 浏览器扩展投递到 `POST /capture-package` | **发起、来源**:由扩展投递触发,放行扩展来源。补偿:写入面同采集且只新建,包先过契约校验,其它接口照旧拒扩展 | [capture-package-inbox](openspec/specs/capture-package-inbox/spec.md) |
| `prototype-refresh` | 刷新原型 | spawn 原型工作区的 `workspace-sync.mjs` | `visualization/prototypes/<slug>/` 镜像与同级 zip,整份重建 | 原型 tab 已接入行「刷新」 | **写入面**:写工作空间外原型目录的 `.workspace-inbox.md`。补偿:原型目录须经 `.workspace-link.json` 回指本工作空间,脚本名与参数由服务端固定 | [prototype-refresh](openspec/specs/prototype-refresh/spec.md) |
| `question-feedback` | 保存未决问题 | 直写 | `output/questions/Q<编号>.md` 的人写区 | 工作台 → 问题单「保存」 | — | [open-questions-workbench](openspec/specs/open-questions-workbench/spec.md) |
| `reference-inbox-refresh` | 刷新参考收件箱 | spawn `scripts/web_ingest.py --inbox` | 散装页收成 `visualization/references/<slug>/`,正文进 `output/converted/` | 参考 tab「刷新收件箱」 | — | [reference-inbox-refresh](openspec/specs/reference-inbox-refresh/spec.md) |
| `record-status` | 保存产出物状态 | 直写 | `output/records/I<编号>.md` 的人写区,状态流水只追加 | 工作台 → 记录单「保存」 | — | [output-item-workbench](openspec/specs/output-item-workbench/spec.md) |
| `record-notes` | 批注落盘 | 直写 | `output/records/notes/I<编号>.md`,可新建,只追加 | 预览里批注后「复制提示词」 | — | [annotation-status-loop](openspec/specs/annotation-status-loop/spec.md) |
| `output-archive` | 一次归档 | spawn `scripts/archive_output.py` | 移进 `output/<组>/一次归档/` 并追加其 README | 产出行「归档」并确认 | — | [output-archive](openspec/specs/output-archive/spec.md) |
| `feedback-sent` | 反馈单发送记录 | 直写 | `output/feedback/F<编号>.md` 的 `sent_at` 与发送记录,只追加 | 工作台 → 反馈单「我已发出」 | — | [workbench-feedback](openspec/specs/workbench-feedback/spec.md) |
| `docx-template-refine` | 提炼 Word 模板 | spawn `scripts/docx_template.py` | `output/docx-template/<模板名>/` | 模版洗炼「开始分析」「生成模板」 | — | [docx-template-refine](openspec/specs/docx-template-refine/spec.md) |
| `md-docx-export` | 转成 Word | spawn `scripts/md2docx.py` | `output/delivery/` 镜像目录里的 `.docx`,带生成标记的上一份改名保留 | 原稿 / 交付稿 / 转换产物「转成 Word」 | — | [md-docx-export](openspec/specs/md-docx-export/spec.md) |
| `delivery-finalize` | 交付稿定稿 | spawn `scripts/finalize_delivery.py` | 原稿的交付稿镜像目录:复制进来的 `.docx` 只新建,`定稿.md` 与 `定稿.assets/` 整份重建 | 阅读器顶栏「定稿」→ 选文件 →「确认定稿」 | **写入面**:读用户在系统选文件框里亲手选中的一个工作空间外 `.docx`。补偿:路径只在服务端内存,前端只拿一次性令牌,不提供按路径读外部文件的接口,记录只写原文件名 | [delivery-finalize](openspec/specs/delivery-finalize/spec.md) |
| `output-rename` | 产出原稿重命名 | spawn `scripts/rename_output.py` | 改名原稿与其镜像,改写 `output/**` 里指向它的路径 | 产出行「重命名」→ 预览 →「确定」 | — | [output-rename](openspec/specs/output-rename/spec.md) |
| `converted-copy-to-output` | 转换产物复制到产出 | spawn `scripts/copy_converted.py` | 在 `output/<组>/` 下新建一份 `.md` | 转换产物行「复制到…」→ 预览 →「确定」 | — | [converted-copy-to-output](openspec/specs/converted-copy-to-output/spec.md) |
| `raw-source-organize` | 原始资料重命名 / 移动 | spawn `scripts/move_raw.py` | `input/raw/` 内改名或移动,跟进转换产物、台账与各处路径 | 原始资料「重命名」「移动到…」或拖放 → 预览 →「确定」 | — | [raw-source-organize](openspec/specs/raw-source-organize/spec.md) |
<!-- capabilities:end -->

   只动本机状态的接口(注册表 `~/.pmwork/dashboard/`、看板缓存、系统弹窗与定位)不写工作空间,不进本清单,
   但同样登记在注册表(`scope: 'local'`)并过 `guardCapability()`。
   去 AI 味这条线不新增任何写入(`deai.mjs` 只读);改交付稿走「批注 → AI 修改」,看板唯一的写入是 `record-notes`。

2. **一切工作空间内路径必须过 `resolveInside(root, relPath)`**(`src/server/paths.mjs`),挡 `../` 穿越。
   新增接收路径参数的接口第一件事就是过它。**只此一份**,不许复制第二份实现。
3. **"移出看板"只删登记信息**,不动本地目录和文件。文案与实现都必须保持这个承诺。
4. **非环回监听时禁写。** `--host` 不是环回地址时,所有会起子进程 / 写盘的接口一律 403
   (`createServer({ allowMutations })`,`bin/cli.mjs` 按 `LOOPBACK` 传入;判定在 `guardCapability()`)。只读分享不受影响。

---

## 2. 技术栈

- **React 19** + **TypeScript**(`strict`,`noUnusedLocals` / `noUnusedParameters`,bundler 解析)
- **Vite 7**;**Tailwind CSS v4**(`@tailwindcss/vite`,**无 `tailwind.config.js`**)
- **服务端:瘦 Node**(原生 `node:http`,**无框架**),`.mjs`,**不参与类型检查**
- **UI 组件:[startist-ui](../startist-ui)** 经 shadcn registry copy-in 到 `src/app/components/ui/`
- 包管理器 **pnpm**;**无 ESLint、无测试框架**(闸门见第 4 节)

服务端用的新依赖必须进 `dependencies`(`bin/` 被当 CLI 直接跑,拿不到 devDependencies);
`scripts/build-npm-package.mjs` 按 `src/server` + `bin` 的 import 图重算依赖,漏了会直接报错。

**唯一的第三方补丁** `patches/micromark-extension-gfm-table@2.1.1.patch`(登记在 `pnpm-workspace.yaml`,
那份文件只为它存在):给 `EditMap.add` 加 `at → change` 索引,把大表格解析从平方级降下来
(833 行表格管线 146ms → 74ms),输出 HTML 逐字节不变。升级 `remark-gfm` / micromark 时补丁失效会当场报错,
那时重打(`pnpm patch <包>@<新版本>`)或确认上游已修后删掉;验证跑 `pnpm test:anchor` + 浏览器点开大表看长任务。

---

## 3. 三个平面与目录结构

```
aispace-kanban/
├── bin/cli.mjs             # 平面 1 · CLI:参数解析 + serve/add/list/relink/remove
├── src/
│   ├── server/             # 平面 2 · 常驻服务(.mjs,无类型检查)
│   │   ├── http.mjs        #   路由 + 静态伺服 + SSE + 各 spawn 入口(含归档 runArchive、重命名 runRename、原始资料整理 runRawOrganize)
│   │   ├── capabilities.mjs #  ★ 能力注册表 + 统一闸 guardCapability(不变量 1、4)
│   │   ├── config.mjs      #   注册表读写 + 工作空间识别 + 重连候选 + 模板根解析
│   │   ├── scan.mjs        #   工作空间扫描 → JSON(只读);归档判据 outputPlacement
│   │   ├── meta.mjs        #   project.yaml 解析 + 完整度
│   │   ├── frontmatter.mjs #   frontmatter / 标题 / 字数
│   │   ├── records.mjs     #   产出物记录索引 + 状态写入(record-status)
│   │   ├── notes.mjs       #   批注读写(record-notes)
│   │   ├── feedback.mjs    #   反馈单索引 + 发送记录写入(feedback-sent)
│   │   ├── questions.mjs   #   未决问题索引 + 人工反馈写入(question-feedback)
│   │   ├── docxTemplates.mjs / docxTools.mjs / docxMarker.mjs  # Word 模板清单 / spawn(docx-template-refine、md-docx-export) / 生成标记
│   │   ├── deai.mjs        #   去 AI 味:读规则库、列交付稿版本(只读)
│   │   ├── finalize.mjs    #   交付稿定稿:选文件框 + 一次性令牌 + spawn(delivery-finalize)
│   │   ├── patchMarkdown.mjs # 问题 / 记录 / 反馈单共用的字段级替换与原子写
│   │   ├── prototypes.mjs / references.mjs  # visualization/ 两个 tab 的清单
│   │   ├── capture.mjs     #   ★ 采集写入的唯一收口(visual-capture、capture-package-inbox)
│   │   ├── paths.mjs       #   ★ resolveInside 的唯一实现(不变量 2)
│   │   └── platform.mjs    #   ★ 三平台差异只写在这
│   ├── app/                # 平面 3 · 前端 SPA(TS,`@/` 指向这里)
│   │   ├── components/     #   业务面板(*Panel.tsx)、阅读器、通用小件;ui/ 是 startist vendored 快照
│   │   ├── hooks/          #   useProjects / useScan(含 SSE 订阅)
│   │   ├── lib/api.ts      #   ★ 前后端契约:接口封装 + 全部响应类型
│   │   └── styles/globals.css  # ★ 设计令牌唯一源头
│   └── shared/             # 平面 2 与 3 共用的**纯函数**(.mjs + JSDoc)
├── scripts/                # 仓库工具:组 npm 包、装包冒烟(CI 三平台跑它)、各回归
├── openspec/               # 规划产物;config.yaml 是写产物的约束,自动注入给 AI
├── .github/workflows/      # ci.yml(日常闸门) + release.yml(推 v* tag 发版)
├── templates/              # 工作空间模板,看板代码不 import 它们
│   ├── init_workspace.py   #   ★ 共享铺骨架入口(runInit --from)
│   └── pm-aispace/         #   内置「产品经理AI空间模板」,自带 AGENTS.md
└── dist/                   # 构建产物(gitignore),serve 非 dev 模式伺服它
```

**看板与 `templates/` 只有一个接口**:`runInit` spawn `templates/init_workspace.py --from <模板>`。
内置模板根由 `config.mjs` 的 `resolveTemplateRoot` 解析(注册表 `templateRoot` > `PMWORK_TEMPLATE_ROOT` > 仓库内 `templates/`);
用户自建模板扫 `~/.pmwork/templates/`,有 `template.yaml` 即上架。

**单页 HTML 产物**(方案页、设计页、分析页)落 `templates/pm-aispace/visualization/prototypes/<名字>/index.html`,
规则同模板 AGENTS.md「阶段四：视觉呈现」。这个目录**随模板发给每个新工作空间**,别放临时草稿。

**平面职责互斥:**

| 需求 | 落在哪 |
| --- | --- |
| 命令行参数 / 进程生命周期 / 启动输出 | `bin/cli.mjs` |
| 读磁盘、算数据、给 JSON、伺服文件 | `src/server/**` |
| 渲染、交互、状态 | `src/app/**` |
| 服务端与前端**必须给出同一个答案**的纯计算 | `src/shared/**` |

- **跨平面的唯一契约是 `src/app/lib/api.ts`**:改一侧必改另一侧,见 [`dashboard-feature-flow`](.claude/skills/dashboard-feature-flow/SKILL.md)。
- **`src/shared/` 只放两侧共用的纯函数**:不碰 DOM / Node API、零依赖,`.mjs` + JSDoc(`allowJs`、不开 `checkJs`)。
  加文件前先问「两边真的必须同源吗」。
- **`src/server/` 或 `src/shared/` 新增文件,同步 `scripts/build-npm-package.mjs` 的拷贝清单**,否则装包即 `ERR_MODULE_NOT_FOUND`。

---

## 4. 常用命令与验证闸

| 目的 | 命令 |
| --- | --- |
| 安装依赖 | `pnpm install` |
| 开发(接口 7788 + Vite 5180,浏览器开 5180) | `pnpm dev` |
| 只起常驻服务(7788,伺服 `dist/`) | `pnpm serve` |
| 构建 / 类型检查 | `pnpm build` / `pnpm typecheck` |
| 组 npm 包 / 打包冒烟 | `pnpm build:npm` / `pnpm pack:npm && pnpm smoke:npm` |
| docx 工具链回归(改 `templates/pm-aispace/scripts/docxkit/` 必跑;仅本地,没 pandoc 3 时跳过转换段) | `pnpm test:docx` |
| 模板铺设与更新回归(改 `init_workspace.py`、`template_update.py` 或模板 `sync` 段必跑) | `pnpm test:template-update` |
| 写入边界检查(改 `src/server/**` 必跑) | `pnpm test:capabilities` |
| 规划状态 | `openspec list` / `openspec list --specs` |

**交付闸门(缺一不可):**

1. `pnpm typecheck` 绿 —— 它**只覆盖 `src/app`**
2. `pnpm build` 绿
3. `pnpm test:capabilities` 绿 —— 服务端写入边界的唯一静态检查
4. **手动冒烟**:`src/server/**` 与 `bin/cli.mjs` 没有静态检查也没有测试,改了必须重启 `pnpm serve` / `pnpm dev`,
   `curl -s localhost:7788/api/health`,再在浏览器把受影响视图点一遍。

> **常驻服务不热更。** 「`未知接口：/api/...`」几乎总是忘了重启,不是路由写错。

没有自动化测试;新增无 IO 的纯逻辑模块可以补,别为现有代码大规模补测试 —— 先问人。

---

## 5. 编码规范总则

### 5.1 通用

- **改动最小化**:只动非动不可的地方,不做没要求的抽象。详见 [`disciplined-coding`](.claude/skills/disciplined-coding/SKILL.md)。
- **注释写"为什么"**,尤其是反直觉的兜底与降级;不写重述代码的注释。
- **中文优先**:注释、界面文案、报错、提交信息一律中文,平实、说清后果,不说"操作失败请重试"。
- **提交**小步可回滚,信息说明「为什么」。

### 5.2 前端平面(`src/app/**`)

- 路径别名 **`@/` → `src/app/`**,不写 `../../`。
- 不用 `any` 兜底(唯一例外 `ProjectMeta.data`,不要再加)。
- 函数组件 + Hooks;一文件一主组件,文件名同组件名(`PascalCase`);hooks `useXxx`;工具函数 `camelCase`。
- 样式只用 Tailwind 工具类 + 语义令牌,`cn()` 合并。详见 [`react-component-authoring`](.claude/skills/react-component-authoring/SKILL.md)。
- 通用组件先查 startist registry;`components/ui/**` 是 vendored 快照,**不做与上游分叉的语义修改**。

### 5.3 服务端平面(`src/server/**`、`bin/cli.mjs`)

- 原生 ESM `.mjs`,不引 TypeScript、不引 Web 框架,类型靠 JSDoc。
- 依赖克制:`node:` 内置 + 已有轻量包(`yaml`、`@firecrawl/anydoc`);加依赖要讲清理由。
- 错误 `throw new Error(中文说明)` + 可选 `err.statusCode`,由 `createServer` 统一转 JSON。
- **读失败降级成空/默认值,不让进程崩**(参考 `config.mjs` 的 `readProjects`)。
- 扫描新目录沿用 `scan.mjs` 的 `SKIP` 集合与 `rel()`(统一 `/` 分隔)。

### 5.4 视觉与配色(硬约束)

- **令牌唯一源头 `src/app/styles/globals.css`**;组件里不硬编码色值,不用 `zinc-*` / `stone-*` 原始色阶。
- **黑白灰为主。orange(`--destructive`)只用于"需要注意"**(待转换资料、内容存疑、目录丢失)。
- **唯一的彩色例外:两版文本对比(`DiffView`)用 `--diff-*` 令牌的绿增红删**(git 习惯)。只在对比视图里用,不拿去做别处的强调。
- 层级靠边框和灰底,不靠阴影。详见 [`design-tokens`](.claude/skills/design-tokens/SKILL.md)。

### 5.5 兼容性(常驻服务特有,最容易踩)

用户完全可能用着旧进程 + 新前端(或反过来):

- **接口新增字段一律可选**,前端缺字段时**退回改动前的行为**,宁可少显示不白屏(实例:`Scan.available?`)。
- 服务端不删已有字段(先加新的,旧的留一版)。

### 5.6 三平台与 npm 包

发成 `@startist/aispace-kanban`,macOS / Windows / Linux 都要能跑,**Node ≥ 20**(Linux 递归 `fs.watch`)。

- **平台差异只写在 `platform.mjs`**(开浏览器、定位文件、找 Python / pandoc),别处不许再写 `spawn('open', ...)`。
- 与操作系统有关的文案(「在访达中显示」)取 `/api/health` 的 `platform`(经 `hooks/useFileManager.ts`),
  **不用 `navigator`** —— 动作发生在服务所在机器上。
- **npm 打包会吃掉** `.gitignore`(组包改名 `gitignore`,`init_workspace.py` 认回)和软链接
  (`templates/<id>/skills` 不进包,建工作空间时现建相对链接,Windows 不行就复制)。
- 包里没有前端源码和 devDependencies(`serve --dev` 会明确报错);`dist/` 必须是刚 build 的。
- 发布前冒烟跑 `pnpm smoke:npm`(干净目录装 tgz、假 `HOME`,验新建、扫描、穿越拦截等),CI 三平台跑的就是它。
  发版流程见 `docs/private/发布与CI.md`(私有,不入库)。

---

## 6. 协作流水线:OpenSpec(规划 → 实施 → 归档)

**非平凡改动先规划再动手**:跨平面、动 `api.ts` 契约、引新依赖、要在几条路之间取舍的,先立 change。

```
/opsx:propose "<想做什么>"   → openspec/changes/<name>/ 下生成 proposal / specs / design / tasks
/opsx:apply <name>           → 按 tasks.md 逐条实现并勾选
/opsx:archive <name>         → 归档,delta 合并回 openspec/specs/
```

- **琐碎改动直接做**(文案、间距、笔误)。bug 走 [`systematic-debugging`](.claude/skills/systematic-debugging/SKILL.md),
  大到要改数据形状或跨平面才立 change。
- OpenSpec 定「做什么」,skills 定「怎么改不出事」,两者叠加:立完 change 照样按 `dashboard-feature-flow` 改。
- **产物写法约束只写在 [`openspec/config.yaml`](openspec/config.yaml)**(中文、平面影响面、安全链路、验收闸、脱敏),自动注入给 AI。
- `/opsx:*` 丢了跑 `openspec init --tools claude,pi` 重建(**不是** `openspec update`)。
  生成的 `.claude/commands/opsx/`、`.claude/skills/openspec-*/`、`.pi/prompts/` 入库但勿手改。

### 6.1 公开仓库脱敏红线

本仓已开源(`github.com/STArtppt/aispace-kanban`),**`openspec/` 随代码公开,进了 git 历史就删不干净**。
真实客户与业务方名称(含文件名里的)、本机绝对路径、内网地址与内部 Git 远端、凭据、真实资料正文与截图,
一律不进产物,要举证就化名或换合成件。最容易破防的是 `design.md` 的「现状」—— **拿不准就不写**。
完整清单在 `openspec/config.yaml` 的 `context`,改规则改那里。

### 6.2 处理工作空间反馈单

工作空间 agent **不许改看板源码**,发现问题写 `output/feedback/F<编号>.md`
(字段契约见模板 `output/feedback/README.md`),由用户发来或带来。
`~/.pmwork/dashboard/runtime.json` 的 `launch` 为 `source` 时,直接读 `instances` 所列实例的反馈单,
做法见 [`local-source-sync`](.claude/skills/local-source-sync/SKILL.md);否则等用户带过来。
旧目录 `.kanban-feedback/` 看板只数份数,不读、不动。

**缺陷单**(`kind: bug` 或不写):

1. 当作需求输入走本仓流程(要不要立 change → `dashboard-feature-flow` → 第 4 节闸门 → 提交);「建议改法」只作参考。
2. 进本仓前先按 6.1 脱敏,别默认复现已经是合成的。
3. 给一段可转发的**回执**:结论、提交号(不修写理由)、那边可撤掉的临时绕法。

**贡献单**(`kind: contribution`)是工作空间沉淀出的通用改进,当作对 `templates/pm-aispace/` 的需求:

1. 按 6.1 复查「合成示例」「改动内容」,带真实资料的改成合成件,拿不准不收;
2. 判据「换一个项目还成立吗」,只对个别行业 / 客户成立的不收;
3. 规则类写进模板规则库 `.claude/skills/pm-deai-writing/rules/` 下一版(取下一个空号、按「短名 + 判据」判重,
   版本、快照、CHANGELOG 按该技能「规则库怎么改」),其它类改对应模板文件;
4. 过第 4 节闸门(动 docxkit 跑 `test:docx`,动铺设 / 更新脚本跑 `test:template-update`),提交;
5. 回执写结论 + 模板位置 + 提交号,如「收为模板 R012(规则库 v2),提交 abc1234」。

**本会话不写工作空间文件**,回执由用户转给那边的 agent 回写。唯一例外:`launch` 为 `source` 且用户确认计划后,
运行该实例自己的 `scripts/template_update.py apply --plan <计划文件>`;不跑 `apply --resolved`,
冲突与 seedOnly 交回工作空间。能力清单不因此新增条目。

工作空间的 `.claude/settings.local.json` 由 `init_workspace.py` 写入 `deny`,禁止改本仓任何文件(含 `templates/`);
老工作空间用 `python3 templates/init_workspace.py --guard-only --path <工作空间>` 补。
**本仓新增顶层目录或文件后**,提醒用户对在用的工作空间重跑一次。它只拦 Claude Code 的写工具,主防线仍是规则本身。

---

## 7. Skills 体系:工程平面

技能约束「Agent 怎么改这个看板」,位置 **`.claude/skills/<name>/SKILL.md`**,只此一份(无 `.agents/` 镜像)。
来源与分层见 [`.claude/skills/README.md`](.claude/skills/README.md)(同一件事以本地为准)。缺失或过时就顺手补全。

| 技能 | 什么时候读 |
| --- | --- |
| [`dashboard-feature-flow`](.claude/skills/dashboard-feature-flow/SKILL.md) | **加/改任何功能时先读** —— 跨平面顺序与契约清单 |
| [`project-conventions`](.claude/skills/project-conventions/SKILL.md) | 新建文件、不确定放哪 / 叫什么、提交前 |
| [`disciplined-coding`](.claude/skills/disciplined-coding/SKILL.md) | 写第一行代码前 |
| [`react-component-authoring`](.claude/skills/react-component-authoring/SKILL.md) | 新建或重构 React 组件 |
| [`design-tokens`](.claude/skills/design-tokens/SKILL.md) | 动颜色 / 字体 / 间距 / 主题 |
| [`design-system-loop`](.claude/skills/design-system-loop/SKILL.md) | 从 startist-ui 拉 / 升级组件、缺口回流真源 |
| [`systematic-debugging`](.claude/skills/systematic-debugging/SKILL.md) | 查 bug、构建报错、行为不符预期 |
| [`verification-before-completion`](.claude/skills/verification-before-completion/SKILL.md) | 准备说「做完了」之前 |
| [`local-source-sync`](.claude/skills/local-source-sync/SKILL.md) | 源码启动时同步模板到实例、读实例反馈单 |

---

## 8. 给 Agent 的协作守则

1. **先定平面再动手**,跨平面按 `dashboard-feature-flow` 的顺序走;要改数据形状先对齐 `api.ts`。
2. **写入只走能力清单 + 安全链路**:清单外任何往工作空间写的想法,先停下来问人。
3. **改完必验**:第 4 节四道闸都过了再说完成。
4. **沉淀而非一次性**:踩过的坑补进对应 skill(尤其 `systematic-debugging` 的分诊表)。
5. **事实源唯一**:协作约定只写本文件,规划产物约束只写 `openspec/config.yaml`,不复制到别处。
