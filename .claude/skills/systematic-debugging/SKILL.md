---
name: systematic-debugging
description: 在 aispace-kanban 中定位 / 修复任何 bug、类型报错、构建失败、接口 404、界面空白或不刷新时使用 —— 强制"先找根因再动手",并附本仓高频故障的分诊清单。
---

# 系统化调试(Systematic Debugging)

> 上游来源:[obra/superpowers · systematic-debugging](https://github.com/obra/superpowers/tree/main/skills/systematic-debugging)。
> 本文件是 aispace-kanban 的本地化改写版(贴本仓的三平面结构与常驻服务特性)。

## 何时使用

- 任何 bug、`pnpm typecheck` 报错、`pnpm build` 失败、接口报错、界面空白 / 不刷新。
- 你正想说「先这样改一下试试」「我不太懂但这样可能行」—— **这正是必须用本技能的信号**。

## 铁律

**没有根因调查,就不许动手修。症状级修复 = 失败。**

## 先跑本仓分诊清单(30 秒排掉大半)

本仓有三个平面且只有前端被类型检查,故障高度集中。**先按这张表排除,再进四阶段。**

| 症状 | 先查这个 | 怎么确认 |
| --- | --- | --- |
| `未知接口:/api/...`(404) | **服务进程比代码旧** —— 改了 `src/server/**` 没重启 | 重启 `pnpm dev` / `pnpm serve` 再试;`api.ts` 的 `request` 已就此加了提示 |
| 界面上某块空白 / `undefined` | **服务端没真的产出这个字段** | `curl -s "localhost:7788/api/projects/<id>/scan"` 看原始返回,别信 type |
| 整页白屏 / 报 `cannot read property of undefined` | 前端把**可选字段当必填**用了 | 看该字段在 `api.ts` 里是不是 `?`,前端有没有兜底 |
| 界面改了没变化 | 非 dev 模式的 serve 伺服 `dist/` | `pnpm build`;或改用 `pnpm dev` 开 5180 |
| 前端 5180 打得开但接口全挂 | 代理指向的 7788 没起来 | `curl -s localhost:7788/api/health` |
| 文件变了但界面不自动刷新 | 数据源不在 SSE 监听范围 | `http.mjs` 的 `watchWorkspace` 只看 `input/`、`output/`、`prototypes/.axhub`、`project.yaml` |
| 某工作空间整个没内容 | 登记目录被改名 / 移走 | 侧栏有橙色警告;`node bin/cli.mjs list` 看 `status`;用 `relink` 接回 |
| 接口 403 路径超出范围 | `resolveInside` 拦住了(通常是相对路径拼错) | 打出传进去的 `relPath`,它必须是工作空间内的相对路径、`/` 分隔 |
| 服务端改动"没生效"且不报错 | **`.mjs` 不参与类型检查**,写错的属性名会静默返回 `undefined` | 在服务端 `console.log` 出真实对象,别靠推断 |
| 只有**某些**工作空间点进去全报"没有登记过的项目" | 那几个的 `id` 里有中文/空格 —— URL 路径段是百分号编码的,服务端忘了解码 | `curl "localhost:7788/api/projects/中文名/scan"` 对比 ASCII 名的;`handleApi` 的 `decodeSegment` 就是修这个的 |
| 明明已经转过的资料还挂在「待转换」 | 覆盖判据只认**产物里记着的来源** —— 没有 `.md` 产物的类型(图片)得另有出处:`assets/<组>/_manifest.md` 的 `sources` | `curl` 看 `input.pending`;再看该 raw 文件有没有出现在某份 frontmatter 的 `source` / `sources` 里。旧版工作空间的 `scripts/ingest.py` 不写这份清单,重跑一次即可 |
| markdown 正文图片空白 / 页面上露出裸 `<img>` | pandoc 从 docx 转出的是 HTML 图,不是 `![]()`;`react-markdown` 默认转义 HTML | 打开 converted `.md` 看是 `<img` 还是 `![](`;`Markdown.tsx` 必须接 `rehype-raw` |
| 装成 npm 包后才出的毛病(白屏 / 新建工作空间失败) | 包里缺东西:`dist/` 没构建、依赖没进 `dependencies`、模板文件被 npm 打包规则吃掉 | `pnpm smoke:npm` —— 它在干净目录装上真跑一遍,比在源码仓怎么试都准 |
| 点开预览后白屏，控制台 `Rendered more/fewer hooks` 或 `change in the order of Hooks` | 同一组件实例里有 `if (...) return` **之后**又调了 `useMemo` / `useState` / `useEffect`（典型：`TableReader` 单 sheet 提前返回、切到多 sheet 才补 hook） | 看堆栈里的组件名，把所有 hooks 挪到任何 early return 之前；切换条目时组件常被复用、不会自动卸载 |
| 表格 / html 包点「校验原件」报「产物不存在」 | 新布局 `item.path` 是正文目录（`SplittingObject/<名>/` 或 `MergedObject/`），溯源写在同级 `_manifest_<名>.md`；旧 `verifySource` 只在目录里找 `_manifest.md` | `curl` scan 看该条的 `path` vs `manifestPath`；校验应能吃正文目录或摘要文件。前端传 `manifestPath` 兼容旧进程 |

排不掉,继续:

## 四阶段(顺序执行,不可跳)

**阶段 1 · 根因调查**
- 完整读错误信息 / 堆栈,不扫一眼就猜。
- 稳定复现:哪个工作空间、哪个视图、哪个文件?(有 / 没有 `project.yaml`、目录是否健在,
  这两个维度经常是关键变量。)
- 查最近改动:`git diff` / `git log -3`。
- **判断故障在哪个平面**:`curl` 接口能否复现?
  能 → 服务端;不能 → 前端。这一步能砍掉一半搜索空间,别跳过。

**阶段 2 · 模式分析**
- 找一个**能正常工作**的同类例子读懂它:新面板出问题就对比 `OutputPanel`,
  新接口出问题就对比 `.../scan` 那条,新扫描逻辑就对比 `listFiles` 的既有用法。
- 对比坏的和好的差在哪,把依赖与假设列清楚。

**阶段 3 · 假设与验证**
- 提出**具体**假设("`scan.mjs` 里字段名拼成了 `mtime` 而返回里是 `updatedAt`"),
  不是"大概是数据没传过来"。
- **一次只改一个变量**,验证后再继续。

**阶段 4 · 实现修复**
- 只做针对根因的单一修复。
- 服务端的修复要在返回层与消费层**两边**确认(`curl` 看 JSON + 界面看渲染)。
- 涉及可选字段的,顺手确认**旧进程 / 缺字段**路径仍能退回原行为(常驻服务的兼容要求)。
- 收尾走 [[verification-before-completion]]。

## 三次规则

**同一个 bug 修了三次还没好 → 停。** 每修一处就冒出新问题,说明是结构问题,不是补丁能解决的。
停下来把现象和三次尝试讲清楚,先讨论再动。

## 危险信号(出现即回阶段 1)

- 「先 quick fix 顶一下」
- 「不管为什么,改改 X 看看」
- 「我没完全搞懂,但这样也许能行」
- 只改前端来"绕过"服务端返回的错数据

## 沉淀

修完一个非显然的 bug,**把分诊结论补进上面那张表**(症状 → 先查什么 → 怎么确认)。
这张表是本仓最省时间的资产,别让它停在今天的版本。

## 关联

- 收尾闸:[[verification-before-completion]];改动顺序:[[dashboard-feature-flow]]
