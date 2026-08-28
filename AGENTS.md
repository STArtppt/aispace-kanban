# AGENTS.md —— 项目编码规范总则

> 本文件是 **aispace-kanban** 面向所有编码 Agent(Claude Code / Cursor / Codex / Copilot…)
> 与人类协作者的**唯一事实源**。`CLAUDE.md` 只是指针,内容不在两处重复。
> 改协作约定 / 项目说明,**只改本文件**。
>
> 面向用户的使用说明在 [README.md](./README.md),本文件不重复它。

---

## 1. 项目是什么 + 最硬的不变量

**aispace-kanban** 是**与 AI 反复对话完成知识工作**时用的**只读看板**:
一个常驻本机的服务,指向若干工作空间目录,在浏览器里切换查看概览 / 输入资料 / 产出文档 / 原型。
看板只认 `input/` + `output/` 的目录约定(判据见 `config.mjs` 的 `inspectWorkspace`),
**不绑定任何具体行业或岗位** —— 调研、方案、数据分析、内容创作、项目接手都落在同一套结构上。

工作空间**模板**([`templates/`](./templates))也在本仓一起维护 —— 看板"新建工作空间"调的
是共享的 `templates/init_workspace.py --from <模板目录>`。内置第一份是
[`templates/pm-aispace`](./templates/pm-aispace)(产品经理AI空间模板);
用户自建的落在 `~/.pmwork/templates/`。模板是**另一套语境**(角色自己的技能与约定),
本文件的编码规范只管看板三平面,**不适用于 `templates/` 内部**;改 PM 模板见
[`templates/pm-aispace/AGENTS.md`](./templates/pm-aispace/AGENTS.md)。

**不变量(违反即为 bug,不接受任何"顺手写一下"):**

1. **对工作空间只读。** 服务端只 `read`,不 `write` / `rename` / `unlink` 工作空间里的任何文件。
   真正改工作空间内容的,只能是**用户明确发起、由工作空间自己的工具执行**的子进程:
   - 注册表 `~/.pmwork/dashboard/projects.json`(`src/server/config.mjs` 的 `writeProjects`)—— 不碰工作空间
   - 新建工作空间时调 `templates/init_workspace.py --from <模板目录>`(`src/server/http.mjs` 的 `runInit`)——
     铺骨架由模板负责,看板不自己造目录
   - 资料转换时调工作空间的 `scripts/ingest.py`(`src/server/http.mjs` 的 `startIngest`)——
     看板只 `spawn`,写 `input/converted/` 的是脚本本身;`ANYDOC_BIN` 由看板注入本地 anydoc 路径,
     解析不到就不注入(用户可能自己装了,脚本走 PATH)
   - 忽略待转换资料时追加 `input/.ingestignore`(`src/server/http.mjs` 的 `addIgnore`)——
     用户在列表点「忽略此文件 / 忽略此目录」才写,只追加一行模式,不改原件。
     不经过 ingest.py:这不是转换,旧工作空间的脚本也没有写入入口;
     这份文件是看板和 ingest.py 共用的约定,改动会被 `input/` 的 SSE 捕获、两边同时生效
2. **一切工作空间内路径必须过 `resolveInside(root, relPath)`**(`src/server/http.mjs`),挡 `../` 穿越。
   新增任何接收路径参数的接口,第一件事就是过它。
3. **"移出看板"只删登记信息**,不动本地目录和文件。文案与实现都必须保持这个承诺。
4. **非环回监听时禁写。** `--host` 不是环回地址时,所有会起子进程 / 写注册表的接口一律 403
   (`createServer({ allowMutations })`,`bin/cli.mjs` 按 `LOOPBACK` 传入)。
   只读分享(扫目录、读文件、SSE)不受影响。

---

## 2. 技术栈

- **React 19** + **TypeScript**(`strict`,`noUnusedLocals` / `noUnusedParameters`,bundler 解析)
- **Vite 7** 构建 / dev server;**Tailwind CSS v4**(`@tailwindcss/vite`,**无 `tailwind.config.js`**)
- **服务端:瘦 Node**(原生 `node:http`,**无框架**),源码是 `.mjs`,**不参与类型检查**
- **UI 组件:[startist-ui](../startist-ui)** 经 shadcn registry copy-in 到 `src/app/components/ui/`
- 包管理器 **pnpm**;**无 ESLint、无测试框架**(闸门见第 4 节)

引入新依赖前先确认:它是给前端平面还是服务端平面用?给服务端用的必须进 `dependencies`
(`bin/` 会被当 CLI 直接跑,拿不到 devDependencies)。发 npm 包时
`scripts/build-npm-package.mjs` **按 `src/server` + `bin` 的 import 图重算依赖**,
服务端引了不在 `dependencies` 里的包,组包会直接报错拦下。

---

## 3. 三个平面与目录结构

```
aispace-kanban/
├── bin/cli.mjs             # 平面 1 · CLI:参数解析 + serve/add/list/relink/remove
├── src/
│   ├── server/             # 平面 2 · 常驻服务(.mjs,无类型检查)
│   │   ├── http.mjs        #   路由 + 静态伺服 + SSE + 系统调用(open)
│   │   ├── config.mjs      #   注册表读写 + 工作空间识别 + 重连候选
│   │   ├── scan.mjs        #   工作空间扫描 → 结构化 JSON(只读)
│   │   ├── meta.mjs        #   project.yaml 解析 + 完整度统计
│   │   ├── frontmatter.mjs #   frontmatter / 标题 / 字数
│   │   ├── prototypes.mjs  #   扫 visualization/prototypes/ → 原型清单(index.html / zip / url 形态)
│   │   ├── references.mjs  #   扫 visualization/references/ → 参考清单(子目录 index.html)
│   │   └── platform.mjs    #   ★ 三平台差异只写在这:开浏览器 / 定位文件 / 找 python
│   └── app/                # 平面 3 · 前端 SPA(TS,`@/` 指向这里)
│       ├── App.tsx         #   外壳:侧栏 + 四视图路由 + 主题
│       ├── components/     #   业务面板(*Panel.tsx)、阅读器、通用小件
│       │   └── ui/         #   @startist/* vendored 快照(shadcn add 生成)
│       ├── hooks/          #   useProjects / useScan(含 SSE 订阅)
│       ├── lib/api.ts      #   ★ 前后端契约:接口封装 + 全部响应类型
│       └── styles/globals.css  # ★ 设计令牌唯一源头
├── scripts/                # 平面外 · 仓库工具
│   ├── build-npm-package.mjs  #   组 npm 包(pnpm build:npm),产出 npm-package/
│   └── smoke-package.mjs      #   ★ 装包冒烟(pnpm smoke:npm),CI 三平台跑的就是它
├── openspec/               # 平面外 · 规划产物:changes/<name>/ 是提案与任务,specs/ 是已落地的能力
│   └── config.yaml         #   ★ 写产物的约束(中文、平面影响面、脱敏红线),自动注入给 AI
├── .github/workflows/      # 平面外 · CI:ci.yml(日常闸门) + release.yml(推 v* tag 发版)
├── templates/              # 平面外 · 工作空间模板,看板代码不 import 它们
│   ├── init_workspace.py   #   ★ 共享铺骨架入口(runInit --from)
│   ├── create-prompt.md    #   复制给 AI 的「创建模板」提示词
│   └── pm-aispace/         #   内置「产品经理AI空间模板」
│       ├── template.yaml   #     发现用的元信息(id / name / description)
│       ├── .claude/skills/ #     pm-* 业务技能 + skill-creator
│       └── input/ output/ visualization/ project.yaml
└── dist/                   # 构建产物(gitignore),serve 非 dev 模式伺服它
```

`templates/` 是**另一个语境**:每份模板是一套角色骨架,不是看板的源码。
看板与它之间**只有一个接口** —— `src/server/http.mjs` 的 `runInit` 起子进程跑
`templates/init_workspace.py --from <选中的模板>`。
内置模板根由 `config.mjs` 的 `resolveTemplateRoot` 解析
(注册表 `templateRoot` > `PMWORK_TEMPLATE_ROOT` > 仓库内 `templates/`);
用户自建模板扫 `~/.pmwork/templates/`,目录里有 `template.yaml` 即上架。
本文件第 2 / 5 节的技术栈与编码规范**不适用于 `templates/` 内部**,那边自己有一份 `AGENTS.md`。

**单页 HTML 产物落 `templates/pm-aispace/visualization/prototypes/<名字>/index.html`。**
在本仓库里生成的方案页、设计页、分析页,和工作空间里 AI 产出的成品页,走的是同一条约定:
一个东西一个子目录,入口必须叫 `index.html`(看板只认这个,散装 `.html` 扫不到),
`<title>` 就是看板里显示的名字,内联 CSS、不引外部字体和脚本。
注意这个目录**会随模板发给每个新建的工作空间** —— 放进去就是发出去,别放临时草稿。
完整规则见 `templates/pm-aispace/AGENTS.md` 的「阶段四:原型」。

**平面职责互斥,判据一句话:**

| 需求 | 落在哪 |
| --- | --- |
| 命令行参数 / 进程生命周期 / 启动输出 | `bin/cli.mjs` |
| 读磁盘、算数据、给 JSON、伺服文件 | `src/server/**` |
| 渲染、交互、状态 | `src/app/**` |

**跨平面的唯一契约是 `src/app/lib/api.ts`** —— 服务端产出的 JSON 形状必须与它的 type 一致。
改一侧就必须改另一侧,见 [`dashboard-feature-flow`](.claude/skills/dashboard-feature-flow/SKILL.md)。

---

## 4. 常用命令与验证闸

| 目的 | 命令 |
| --- | --- |
| 安装依赖 | `pnpm install` |
| 开发(接口 7788 + Vite 5180,浏览器开 5180) | `pnpm dev` |
| 只起常驻服务(7788,伺服 `dist/`) | `pnpm serve` |
| 构建前端 | `pnpm build` |
| 类型检查 | `pnpm typecheck` |
| 组 npm 包(发布用) | `pnpm build:npm` → `npm-package/` |
| 打 tgz + 装包冒烟 | `pnpm pack:npm && pnpm smoke:npm` |
| 看规划状态(active change / 已落地能力) | `openspec list` / `openspec list --specs` |

**交付闸门(缺一不可):**

1. `pnpm typecheck` 绿 —— 注意它**只覆盖 `src/app`**(见 `tsconfig.json` 的 `include`)
2. `pnpm build` 绿
3. **手动冒烟**:`src/server/**` 和 `bin/cli.mjs` 没有任何静态检查也没有测试,
   改动它们后必须重启 `pnpm serve` / `pnpm dev`,`curl -s localhost:7788/api/health`,
   再在浏览器里把受影响的视图点一遍。

> **改服务端代码必须重启进程。** 常驻服务不热更;前端才有 Vite 热更。
> 「接口返回 `未知接口：/api/...`」几乎总是忘了重启,不是路由写错(`lib/api.ts` 里已就此写了提示)。

目前**没有自动化测试**。新增无 IO 的纯逻辑模块时可以补,但别为现有代码大规模补测试 ——
先问人。

---

## 5. 编码规范总则

### 5.1 通用

- **改动最小化**:只动非动不可的地方,不重构没坏的代码,不做没要求的抽象。
  详见 [`disciplined-coding`](.claude/skills/disciplined-coding/SKILL.md)。
- **注释写"为什么"**,尤其是反直觉的兜底与降级(现有代码就是这个风格,照抄它)。
  纯粹重述代码的注释不要写。
- **中文优先**:注释、界面文案、报错文案、提交信息一律中文,语气与 README 一致 ——
  平实、说清后果,不说"操作失败请重试"这类空话。
- **提交**:小步可回滚;信息说明「为什么」而不只是「改了什么」。

### 5.2 前端平面(`src/app/**`)

- **路径别名 `@/` 指向 `src/app/`**(`vite.config.ts` 与 `tsconfig.json` 双向配置),不写 `../../`。
- **TypeScript**:不用 `any` 兜底。现存唯一例外是 `ProjectMeta.data`
  (`project.yaml` 是用户自由结构),不要再引入新的 `any`。
- **函数组件 + Hooks**;一个文件一个主组件,文件名与组件同名(`PascalCase`);
  hooks `useXxx`;工具函数 `camelCase`。
- **样式只用 Tailwind 工具类 + 语义令牌**,`cn()` 合并 className。
  详见 [`react-component-authoring`](.claude/skills/react-component-authoring/SKILL.md)。
- **通用组件先查 startist registry**,不要在业务组件里手写第二遍 button / dialog / input。
  `src/app/components/ui/**` 是 vendored 快照,**不做与上游分叉的语义修改**。

### 5.3 服务端平面(`src/server/**`、`bin/cli.mjs`)

- **原生 ESM `.mjs`**,不引入 TypeScript、不引入 Web 框架。类型靠 JSDoc 注释说清。
- **依赖克制**:只用 `node:` 内置模块 + 已在 `dependencies` 里的轻量包
  (当前服务端用到 `yaml` 和 `@firecrawl/anydoc`)。加新依赖要在改动说明里讲清理由。
- **错误用 `throw new Error(中文说明)` + 可选 `err.statusCode`**,由 `createServer` 统一转 JSON。
  不要在处理函数里各写一套错误响应。
- **读失败一律降级成空/默认值,不让进程崩**(参考 `config.mjs` 的 `readProjects`):
  看板是只读工具,少一个文件不该白屏。
- 扫描新目录时沿用 `scan.mjs` 的 `SKIP` 集合与 `rel()` 相对路径(统一用 `/` 分隔)。

### 5.4 视觉与配色(硬约束)

- **令牌唯一源头 `src/app/styles/globals.css`**:`@theme inline` 映射 + `:root` / `.dark` 双层变量。
  组件里严禁硬编码色值或 `zinc-*` / `stone-*` 原始色阶。
- **黑白灰为主色。orange(`--destructive`)只用于"需要注意"** —— 在本项目就是
  待转换资料、内容存疑、目录丢失这类需要人处理的状态。其余地方一律不上彩色。
- 层级靠边框和灰底,不靠阴影(见 `components/Primitives.tsx`)。
- 详见 [`design-tokens`](.claude/skills/design-tokens/SKILL.md)。

### 5.5 兼容性(常驻服务特有,最容易踩)

服务是**常驻进程**,用户完全可能用着旧进程 + 新前端(或反过来)。所以:

- **接口响应新增字段一律可选**,前端缺字段时**退回改动前的行为**;
  宁可少显示一块,不能白屏或报错。`Scan.available?` 的注释就是这条规则的实例。
- 前端不要假设新字段一定存在;服务端不要删已有字段(先加新的、旧的留一版)。

### 5.6 三平台与 npm 包(改服务端 / 改模板时的硬约束)

看板发成 `@startist/aispace-kanban`,在 macOS / Windows / Linux 上都要能跑。要求 **Node ≥ 20**
(Linux 上 `fs.watch` 的递归监听 —— 也就是 SSE 自动刷新 —— 从 20 才有)。

- **平台差异只写在 `src/server/platform.mjs`**:开浏览器、在文件管理器里定位、
  找 Python 解释器。别在别处再写第二次 `spawn('open', ...)`,那是本仓踩过的坑
  (reveal 接口曾经在非 macOS 上直接返 501)。
- **界面上跟操作系统有关的文案**(「在访达中显示」)从 `/api/health` 的 `platform` 取,
  经 `hooks/useFileManager.ts`;**不能用浏览器的 `navigator`** —— 定位动作发生在**服务所在的机器**上。
- **npm 打包会吃掉两类东西**,模板里有就得绕:
  - 任何叫 `.gitignore` 的文件(`files` 字段也救不回来)→ 组包时改名存成 `gitignore`,
    由 `templates/init_workspace.py` 认回来;
  - 软链接 → `templates/<id>/skills` 不进包,新建工作空间时由 `init_workspace.py` 现建**相对**链接
    (Windows 建不了就复制一份实体目录)。
- 包里**没有前端源码和 devDependencies**,所以 `serve --dev` 在包里会明确报错;
  `dist/` 必须是刚 `pnpm build` 出来的,否则装的人看到的是旧界面。
- 发布前的冒烟不能只在源码仓跑,但**不用手工点** —— `pnpm smoke:npm`
  (`scripts/smoke-package.mjs`)会在干净目录装 tgz 起服务,把新建工作空间、扫描、
  路径穿越拦截等 12 件事验一遍;CI 在 ubuntu / windows / macOS 上跑的就是它。
  它给子进程换了假 `HOME`,不会污染你自己的注册表。
- **发版与 CI 的完整流程见 `docs/private/发布与CI.md`**(推 `v*` tag 自动发 npm;私有文档不入库)。

---

## 6. 协作流水线:OpenSpec(规划 → 实施 → 归档)

**非平凡改动先规划再动手。** 跨平面、要动 `src/app/lib/api.ts` 契约、引新依赖、
或者要在几条路之间做取舍的,先立一个 change —— 把「为什么做、做什么、验收是什么」
落成**仓内文件**,而不是留在会话里或一次性的网页上。

```
/opsx:propose "<想做什么>"   → openspec/changes/<name>/ 下生成 proposal.md + specs/ + design.md + tasks.md
/opsx:apply <name>           → 按 tasks.md 逐条实现并勾选
/opsx:archive <name>         → 归档进 openspec/changes/archive/,把 delta 合并回 openspec/specs/
```

- **琐碎改动直接做**(改文案、调间距、修显式笔误),不套流程 —— 重量随任务大小伸缩。
- **bug 走 [`systematic-debugging`](.claude/skills/systematic-debugging/SKILL.md)**:
  小 bug 直接四阶段;大到要改数据形状或跨平面,才值得立 change。
- **OpenSpec 定「做什么」,skills 定「在这个仓怎么改不出事」**。立完 change 照样按
  [`dashboard-feature-flow`](.claude/skills/dashboard-feature-flow/SKILL.md) 的顺序改代码,
  两者叠加,不互相替代。
- **产物的写法约束不写在这里**,写在 [`openspec/config.yaml`](openspec/config.yaml) 的
  `context` / `rules`(中文书写、平面影响面、只读红线、验收闸、脱敏清单),
  它会被自动注入给 AI。**要改约束就改那个文件**,别在单个 change 里重复一遍。
- `/opsx:*` 用不了时(`.claude/` 丢了)跑 `openspec init --tools claude` 重建 ——
  **不是** `openspec update`,tool 注册记录一并丢失时它只报 `No configured tools found` 就退出。
  生成的 `.claude/commands/opsx/` 与 `.claude/skills/openspec-*/` **入库但勿手改**,重建会覆盖。

### 6.1 公开仓库脱敏红线

本仓已开源(`github.com/STArtppt/aispace-kanban`),**`openspec/` 下的一切都随代码公开发布,
进了 git 历史就删不干净**。所以规划产物里只写「公开仓库的读者也该看到」的信息:
真实客户与业务方名称(包括藏在文件名里的)、本机绝对路径、内网地址与内部 Git 远端、
任何凭据、真实资料的正文与截图,一律不进产物 —— 需要举证就化名或换成合成件。

最容易破防的是 `design.md` 的「Context / 现状」:调研阶段的实测数据经常带着真实文件名和
本机路径,搬进产物前先替换。**拿不准就不写**,细节留在会话里,产物里只写结论。

完整清单(连同替换写法)在 [`openspec/config.yaml`](openspec/config.yaml) 的 `context`,
那份是真正注入给 AI 的版本 —— 改脱敏规则改那里。

---

## 7. Skills 体系:工程平面

本项目只有**一个技能平面 —— 工程平面**:约束「Agent 怎么改这个看板」的纪律与规范,
不随产品交付。位置 **`.claude/skills/<name>/SKILL.md`**,**只此一份**(不做 `.agents/` 镜像,
避免两份漂移);非 Claude Code 的 Agent 通过本文件的链接进去读。

| 技能 | 什么时候读 |
| --- | --- |
| [`dashboard-feature-flow`](.claude/skills/dashboard-feature-flow/SKILL.md) | **加/改任何功能时先读它** —— 跨平面改动的顺序与契约清单 |
| [`project-conventions`](.claude/skills/project-conventions/SKILL.md) | 新建文件、不确定放哪 / 叫什么、提交前 |
| [`disciplined-coding`](.claude/skills/disciplined-coding/SKILL.md) | 写第一行代码前:先想再写、最小实现 |
| [`react-component-authoring`](.claude/skills/react-component-authoring/SKILL.md) | 新建或重构 React 组件 |
| [`design-tokens`](.claude/skills/design-tokens/SKILL.md) | 动颜色 / 字体 / 间距 / 主题 |
| [`design-system-loop`](.claude/skills/design-system-loop/SKILL.md) | 从 startist-ui 拉 / 升级组件、发现缺口回流真源 |
| [`systematic-debugging`](.claude/skills/systematic-debugging/SKILL.md) | 查 bug、构建报错、行为不符预期 |
| [`verification-before-completion`](.claude/skills/verification-before-completion/SKILL.md) | 准备说「做完了」之前 |

来源与分层见 [`.claude/skills/README.md`](.claude/skills/README.md)(上游基线 + 本地特化,
**同一件事以本地为准**)。技能缺失或过时就**顺手补全**,让知识随项目生长。

---

## 8. 给 Agent 的协作守则

1. **非平凡改动先立 change**:跨平面、动契约、引依赖、要做取舍的,先 `/opsx:propose`,
   别一边聊一边改。琐碎改动不套流程(第 6 节)。
2. **先定平面再动手**:需求落在 CLI / 服务端 / 前端哪个平面?跨几个平面?
   跨平面就按 `dashboard-feature-flow` 的顺序走,不要东改一笔西改一笔。
3. **契约先行**:要改数据形状,先把 `src/app/lib/api.ts` 的 type 和服务端产出对齐,再写 UI。
4. **只读红线不碰**:任何往工作空间里写的想法,先停下来问人。
5. **改完必验**:`pnpm typecheck` + `pnpm build` + 重启冒烟,三样都做过再说完成。
6. **沉淀而非一次性**:踩过的坑补进对应 skill(尤其 `systematic-debugging` 的分诊启发),
   而不是只改完代码。
7. **保持事实源唯一**:协作约定只写在本文件,别复制进 `CLAUDE.md` 或 `README.md`;
   规划产物的写法约束只写在 `openspec/config.yaml`,别复制进单个 change。
