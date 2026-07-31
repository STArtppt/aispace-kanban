# AGENTS.md —— 项目编码规范总则

> 本文件是 **aispace-kanban** 面向所有编码 Agent(Claude Code / Cursor / Codex / Copilot…)
> 与人类协作者的**唯一事实源**。`CLAUDE.md` 只是指针,内容不在两处重复。
> 改协作约定 / 项目说明,**只改本文件**。
>
> 面向用户的使用说明在 [README.md](./README.md),本文件不重复它。

---

## 1. 项目是什么 + 最硬的不变量

**aispace-kanban** 是 PM 工作空间的**只读看板**:
一个常驻本机的服务,指向若干工作空间目录,在浏览器里切换查看概览 / 输入资料 / 产出文档 / 原型。

工作空间**模板**([`template/`](./template))也在本仓一起维护 —— 看板"新建工作空间"调的
就是它的 `scripts/init_workspace.py`。模板是**另一套语境**(PM 业务流程、pm-* 技能),
本文件的编码规范只管看板三平面,**不适用于 `template/` 内部**;改模板见 [`template/AGENTS.md`](./template/AGENTS.md)。

**不变量(违反即为 bug,不接受任何"顺手写一下"):**

1. **对工作空间只读。** 服务端只 `read`,不 `write` / `rename` / `unlink` 工作空间里的任何文件。
   全仓仅两处例外,且都不碰工作空间内容:
   - 注册表 `~/.pmwork/dashboard/projects.json`(`src/server/config.mjs` 的 `writeProjects`)
   - 新建工作空间时调模板仓的 `scripts/init_workspace.py`(`src/server/http.mjs` 的 `runInit`)——
     铺骨架由模板仓负责,看板不自己造目录
2. **一切工作空间内路径必须过 `resolveInside(root, relPath)`**(`src/server/http.mjs`),挡 `../` 穿越。
   新增任何接收路径参数的接口,第一件事就是过它。
3. **"移出看板"只删登记信息**,不动本地目录和文件。文案与实现都必须保持这个承诺。

---

## 2. 技术栈

- **React 19** + **TypeScript**(`strict`,`noUnusedLocals` / `noUnusedParameters`,bundler 解析)
- **Vite 7** 构建 / dev server;**Tailwind CSS v4**(`@tailwindcss/vite`,**无 `tailwind.config.js`**)
- **服务端:瘦 Node**(原生 `node:http`,**无框架**),源码是 `.mjs`,**不参与类型检查**
- **UI 组件:[startist-ui](../startist-ui)** 经 shadcn registry copy-in 到 `src/app/components/ui/`
- 包管理器 **pnpm**;**无 ESLint、无测试框架**(闸门见第 4 节)

引入新依赖前先确认:它是给前端平面还是服务端平面用?给服务端用的必须进 `dependencies`
(`bin/` 会被当 CLI 直接跑,拿不到 devDependencies)。

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
│   │   └── prototypes.mjs  #   读 prototypes/.axhub/ → 原型清单
│   └── app/                # 平面 3 · 前端 SPA(TS,`@/` 指向这里)
│       ├── App.tsx         #   外壳:侧栏 + 四视图路由 + 主题
│       ├── components/     #   业务面板(*Panel.tsx)、阅读器、通用小件
│       │   └── ui/         #   @startist/* vendored 快照(shadcn add 生成)
│       ├── hooks/          #   useProjects / useScan(含 SSE 订阅)
│       ├── lib/api.ts      #   ★ 前后端契约:接口封装 + 全部响应类型
│       └── styles/globals.css  # ★ 设计令牌唯一源头
├── template/               # 平面外 · 工作空间模板,看板代码不 import 它
│   ├── scripts/init_workspace.py  #   ★ 唯一被看板调用的入口(runInit)
│   ├── .claude/skills/     #   pm-* 业务技能(会随新建工作空间一起铺过去)
│   └── input/ output/ prototypes/ project.yaml   # 骨架 + 说明文档
└── dist/                   # 构建产物(gitignore),serve 非 dev 模式伺服它
```

`template/` 是**另一个语境**:它是给 PM 用的工作空间骨架,不是看板的源码。
看板与它之间**只有一个接口** —— `src/server/http.mjs` 的 `runInit` 起子进程跑
`template/scripts/init_workspace.py`(路径由 `config.mjs` 的 `resolveTemplateRoot` 解析,
顺序:注册表 `templateRoot` > `PMWORK_TEMPLATE_ROOT` > 仓库内 `template/`)。
本文件第 2 / 5 节的技术栈与编码规范**不适用于 `template/` 内部**,那边自己有一份 `AGENTS.md`。

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
| 开发(接口 5180 + Vite 5181,浏览器开 5181) | `pnpm dev` |
| 只起常驻服务(5180,伺服 `dist/`) | `pnpm serve` |
| 构建前端 | `pnpm build` |
| 类型检查 | `pnpm typecheck` |

**交付闸门(缺一不可):**

1. `pnpm typecheck` 绿 —— 注意它**只覆盖 `src/app`**(见 `tsconfig.json` 的 `include`)
2. `pnpm build` 绿
3. **手动冒烟**:`src/server/**` 和 `bin/cli.mjs` 没有任何静态检查也没有测试,
   改动它们后必须重启 `pnpm serve` / `pnpm dev`,`curl -s localhost:5180/api/health`,
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
  (当前服务端只用到 `yaml`)。加新依赖要在改动说明里讲清理由。
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

---

## 6. Skills 体系:工程平面

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
| [`systematic-debugging`](.claude/skills/systematic-debugging/SKILL.md) | 查 bug、构建报错、行为不符预期 |
| [`verification-before-completion`](.claude/skills/verification-before-completion/SKILL.md) | 准备说「做完了」之前 |

来源与分层见 [`.claude/skills/README.md`](.claude/skills/README.md)(上游基线 + 本地特化,
**同一件事以本地为准**)。技能缺失或过时就**顺手补全**,让知识随项目生长。

---

## 7. 给 Agent 的协作守则

1. **先定平面再动手**:需求落在 CLI / 服务端 / 前端哪个平面?跨几个平面?
   跨平面就按 `dashboard-feature-flow` 的顺序走,不要东改一笔西改一笔。
2. **契约先行**:要改数据形状,先把 `src/app/lib/api.ts` 的 type 和服务端产出对齐,再写 UI。
3. **只读红线不碰**:任何往工作空间里写的想法,先停下来问人。
4. **改完必验**:`pnpm typecheck` + `pnpm build` + 重启冒烟,三样都做过再说完成。
5. **沉淀而非一次性**:踩过的坑补进对应 skill(尤其 `systematic-debugging` 的分诊启发),
   而不是只改完代码。
6. **保持事实源唯一**:协作约定只写在本文件,别复制进 `CLAUDE.md` 或 `README.md`。
