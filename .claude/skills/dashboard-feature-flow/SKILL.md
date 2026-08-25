---
name: dashboard-feature-flow
description: 在 aispace-kanban 里新增或修改任何功能时使用 —— 跨 CLI / 服务端 / 前端三平面的改动顺序、契约同步清单、常驻服务的兼容性要求;防止"改一半"导致接口 404、字段 undefined、界面白屏。
---

# 加功能的正确顺序(Feature Flow)

## 何时使用

- 要在看板上多显示一块数据、加一个视图、加一个操作按钮。
- 要改接口返回的形状(加字段、改字段名、拆结构)。
- 要动扫描逻辑(`scan.mjs` / `meta.mjs` / `prototypes.mjs`)。
- **只改样式、只改文案**时不必走全流程,但第 5 步的闸门照样要过。

## 为什么需要这个技能

本仓有三个平面(CLI / 服务端 `.mjs` / 前端 TS),而**只有前端被类型检查**。
服务端改错了,`pnpm typecheck` 依然全绿 —— 于是"看起来做完了,一跑就崩"。
再加上服务是**常驻进程不热更**,历史上绝大多数"加功能加出问题"都是下面五类之一:

| 症状 | 真实原因 |
| --- | --- |
| 接口报 `未知接口：/api/...` | 改了 `src/server/**` 但没重启 serve |
| 界面上某块是空的 / `undefined` | 只改了 `api.ts` 的 type,服务端没真的产出这个字段 |
| 整页白屏 | 前端把新字段当必填用了,旧服务进程没给 |
| 界面没变化 | 非 dev 模式下 serve 伺服 `dist/`,忘了 `pnpm build` |
| 改完数据不自动刷新 | 新数据源不在 SSE 监听范围内(见第 4 步) |

## 五步顺序(数据从磁盘流向界面,就按这个方向改)

### 步骤 0 · 先划影响面(动手前)

写下三句话:

1. 数据从哪来?(工作空间的哪个目录 / 文件,或纯前端状态)
2. 要经过哪几个平面?(只前端?还是 服务端 → 契约 → 前端?)
3. 成功长什么样?(界面上能看到什么、怎么验证)

只涉及前端渲染的,跳到步骤 3。涉及新数据的,从步骤 1 开始。
**不确定就问,别默认往下写** —— 见 [[disciplined-coding]]。

### 步骤 1 · 服务端先产出数据(`src/server/**`)

- 扫描 / 计算类:加在 `scan.mjs`(工作空间目录)、`meta.mjs`(`project.yaml`)、
  `prototypes.mjs`(Axhub 原型)里,沿用已有的 `listFiles` / `rel` / `stat` 工具与 `SKIP` 集合。
- 新接口:加在 `http.mjs` 的 `handleApi` 里,按现有 `head / id / action` 三段式匹配。
  - 返回统一走 `json(res, status, payload)`。
  - 出错 `throw new Error('中文说明')`,需要状态码就挂 `err.statusCode`,由 `createServer` 统一转 JSON。
  - **接路径参数的接口第一件事是 `resolveInside(project.root, 参数)`**(红线,防 `../` 穿越)。
  - 需要项目对象就用 `requireProject(id)`,别自己写"项目不存在"。
- **只读红线**:不 `writeFile` / `rename` / `unlink` 工作空间里的任何东西。
  想写?先停下来问人(唯一例外是注册表 `config.mjs` 与模板仓的 `init_workspace.py`)。
- 读失败降级成空值,别让进程崩(照 `readProjects` 的写法)。

### 步骤 2 · 同步契约(`src/app/lib/api.ts`)

这是唯一的跨平面契约。服务端产出什么形状,这里的 type 就写什么形状。

- **新增字段一律写成可选 `?`**,并在前端给兜底默认值。
  理由:用户可能跑着旧服务进程配新前端(改完代码没重启)。缺字段时必须**退回改动前的行为**,
  宁可少显示一块,不能白屏 —— `Scan.available?` 上的注释就是这条规则的实例,照它写。
- 新接口在 `api` 对象里加一个方法,别在组件里裸写 `fetch`(错误提示、header 都在 `request` 里统一处理)。
- 不要删已有字段。要改名就先加新的、旧的留一版。
- 不要引入新的 `any`(现存唯一例外是 `ProjectMeta.data`,因为 `project.yaml` 是用户自由结构)。

### 步骤 3 · 数据接进前端(`hooks/` → 组件)

- 走 `scan` 的数据**不用改 hook**:`useScan` 已经拉全量 + 订阅 SSE 自动刷新,
  面板直接从 `scan.xxx` 取。
- 需要独立请求(不属于 scan)才加 hook,放 `hooks/useWorkspace.ts`,沿用
  `loading` / `error` / `reload` 三件套的写法。
- 面板组件:业务面板是 `components/<X>Panel.tsx`,一个视图一个。新增视图要同时改
  `App.tsx` 的 `View` 联合类型和 `NAV` 数组(少一处就点不到)。
- 空态用 `Primitives.tsx` 的 `EmptyState`,统计块用 `Stat`,列表行用 `Row`,别重造。
- 视觉规范见 [[react-component-authoring]] 与 [[design-tokens]]。

### 步骤 4 · 检查自动刷新范围(涉及新数据源时)

SSE 由 `http.mjs` 的 `watchWorkspace` 提供,**只监听**:
`input/`、`output/`、`prototypes/.axhub`(递归)+ 根下的 `project.yaml` / `project.yml`。

新数据源在这些路径之外(比如工作空间根下另一个目录),它**不会自动刷新**。
要么把目录加进 `watchWorkspace` 的列表,要么在界面上说清"需要手动刷新"。别默认它会更新。

### 步骤 5 · 验证(三道闸,一道都不能省)

```bash
pnpm typecheck                      # 只覆盖 src/app —— 服务端全绿不代表没错
pnpm build                          # 非 dev 模式的 serve 伺服 dist/,不构建看不到新界面
pnpm dev                            # 重启!服务端不热更
curl -s localhost:7788/api/health   # 服务活着
curl -s "localhost:7788/api/projects/<id>/scan" | head -c 600   # 新字段真的在返回里
```

然后浏览器开 5180,把**受影响的视图**点一遍,包括:

- 没有 `project.yaml` 的工作空间(很多字段为空的情况)
- 目录被改名/移走的工作空间(`available === false` 的降级路径)
- 深色模式(右上角切一下)

下结论前的完整纪律见 [[verification-before-completion]]。

## 提交前清单

- [ ] 服务端真的产出了这个字段(`curl` 看过原始返回,不是"应该有")
- [ ] `api.ts` 的 type 与返回一致,新字段是可选的,前端有兜底
- [ ] 新接口过了 `resolveInside`,没往工作空间写任何文件
- [ ] 新视图同时改了 `View` 和 `NAV`
- [ ] 新数据源在 SSE 监听范围内,或界面上已说明需手动刷新
- [ ] `pnpm typecheck` 绿、`pnpm build` 绿、重启后冒烟点过
- [ ] 文案是中文、平实、说清后果

## 关联

- 事实源:[AGENTS.md](../../../AGENTS.md) 第 3、4、5 节
- 写之前的心法:[[disciplined-coding]];出问题:[[systematic-debugging]]
- 落位与命名:[[project-conventions]]
