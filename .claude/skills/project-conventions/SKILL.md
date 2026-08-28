---
name: project-conventions
description: 在 aispace-kanban 里新建文件、不确定代码该放哪个平面 / 该叫什么名字、或准备提交时使用 —— 目录分层、命名、路径别名、平面边界与提交前清单。
---

# 项目约定(Project Conventions)

## 何时使用

- 新建文件 / 目录,或不确定某段逻辑该放哪个平面。
- 引入新依赖、新模式前,确认是否符合基线。
- 提交代码、整理改动说明前。

## 平面归属(先定这个,再谈命名)

| 这段逻辑在做什么 | 放哪 |
| --- | --- |
| 解析命令行参数、起/停进程、启动时的终端输出 | `bin/cli.mjs` |
| 读磁盘、算数据、给 JSON、伺服静态文件、SSE | `src/server/**` |
| 渲染、交互、前端状态 | `src/app/**` |
| 前后端共享的数据形状 | `src/app/lib/api.ts`(唯一契约) |

放错平面是本仓最贵的错误 —— 比如在前端重算服务端已经算好的统计,
或在服务端拼 HTML。跨平面的改动顺序见 [[dashboard-feature-flow]]。

## 命名与落位

**前端(`src/app/`)**

- 业务面板:`components/<视图名>Panel.tsx`(`OverviewPanel` / `InputPanel` / `OutputPanel` / `PrototypePanel`)
- 跨面板复用的小件:`components/Primitives.tsx`(`Stat` / `SectionTitle` / `EmptyState` / `Row`)
- 独立功能组件:`components/<PascalCase>.tsx`,一个文件一个主组件,文件名与组件同名
- registry 拉来的通用 UI:`components/ui/<kebab-case>.tsx` —— **由 `shadcn add` 生成,不手写**
- hooks:`hooks/`,`useXxx`;纯逻辑 / 类型:`lib/`
- 路径别名 **`@/` 指向 `src/app/`**,不写 `../../`

**服务端(`src/server/`)**

- 一个文件一个职责,小写单词 `.mjs`(`scan` / `meta` / `config` / `http` / `frontmatter` / `prototypes` / `references`)
- 导出用具名 `export function`;文件顶部用块注释写清这个模块负责什么
- 工作空间内的相对路径统一用 `/` 分隔(用 `scan.mjs` 的 `rel()`)

**通用**

- 常量 `UPPER_SNAKE` 放文件顶部(`SKIP` / `MIME` / `DEFAULT_PORT` / `LAST_PROJECT_KEY`)
- localStorage key 一律 `aispace-kanban:<用途>` 前缀
- 环境变量一律 `PMWORK_` 前缀(`PMWORK_DASHBOARD_PORT` / `PMWORK_API_PORT` / `PMWORK_TEMPLATE_ROOT`)

## 语言与注释

- 注释、界面文案、报错文案、提交信息**一律中文**,语气跟 README 一致:平实、说清后果。
  报错要告诉人下一步做什么(照 `api.ts` 里"重启 serve 再试"那条写)。
- 注释写**为什么**,特别是反直觉的兜底与降级。重述代码的注释不写。

## 依赖

- 服务端要用的包必须进 `dependencies`(`bin/` 会被当 CLI 直接跑,拿不到 devDependencies)。
- 服务端优先只用 `node:` 内置模块;当前唯一的第三方依赖是 `yaml`。加新的要讲清理由。
- 通用 UI 组件不装第三方组件库 —— 先查 [startist-ui](../../../../startist-ui) 的 registry。

## 提交前清单

- [ ] 文件落在正确的平面,命名符合上面的约定
- [ ] 没有新的 `any`、没有未使用的变量(`noUnusedLocals` 会拦)
- [ ] 视觉改动走了设计令牌([[design-tokens]]),没硬编码色值
- [ ] `pnpm typecheck` 绿
- [ ] `pnpm build` 绿
- [ ] 动过 `src/server/**` 或 `bin/cli.mjs` → 重启服务冒烟点过([[verification-before-completion]])
- [ ] 提交信息说明「为什么」,小步可回滚

## 参考

- 事实源:[AGENTS.md](../../../AGENTS.md) 第 3、5 节
- 关联:[[dashboard-feature-flow]]、[[react-component-authoring]]、[[design-tokens]]
