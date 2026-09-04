## Why

大表 markdown 产物点开就卡：一份数据库结构快照产物（46 KB、31 张表、833 行表格）点一下主线程连续忙
497ms，浏览器 longtask 记到 3 段（325ms + 173ms + …），点击到出内容之间界面完全不响应。
不做的话，随着数据库结构快照、点表清单这类"整篇都是表"的产物越来越多，预览窗会越来越像卡死。

已量到的两个成因：

1. **同一篇文档被解析 2–3 次**。`react-markdown` 是在 render 里跑完整条 markdown 管线的，
   父组件每重渲染一次（回传目录后 setState、批注层量完几何后 setState 等），整篇就重新解析一遍。
2. **解析本身在主线程**，且 833 行表在 micromark 的 GFM 表格扩展里触发平方级累积
   （`EditMap.add` 线性扫描，实测单这一处 87ms / 全部 183ms）。

成因 1 已按本变更的第一步修掉（`Markdown.tsx` 按源码 memo 整棵正文），点开耗时 497ms → 192ms、
长任务从 3 段变 1 段。本提案处理成因 2 的结构面：**把解析搬离主线程**。

## 实测结论（2026-09-04）：第一步已落地，worker 那步**先搁置**

第一步（去掉重复解析）已实现并验证：点开耗时 **497ms / 3 段长任务 → 约 200ms / 1 段**。

第二步（worker）按下面的设计**做出来量过了，结果是净亏，因此没有合入**：

| 版本 | 点开到出内容 | 主线程被占住 |
| --- | --- | --- |
| 原始 | ~500ms | 3 段共 497ms |
| 只去重复解析（已合入） | ~340ms | 1 段 174–229ms |
| 加 worker（未合入） | **~800ms** | 2 段共约 200ms |

worker 版把一次约 190ms 的卡顿拆成两段约 100ms，代价是内容晚了近 600ms 才出来。原因有两块：
① 跨线程回来的 HAST 有 2.2 MB，反序列化 + 在主线程把它转成 7.6k 个 React 元素并提交 DOM
本身就要 ~200ms，主线程并没省下多少；② 同一条管线在 worker 里跑要 ~600ms，而
`react-markdown` 在主线程只要 ~150ms —— 这个 4 倍差距**没有查清**（已排除:worker 线程本身
不慢，纯 CPU 循环主线程 63ms / worker 64ms；两边打包进去的也都是 micromark 的生产构建）。
不查清这一条，worker 这条路就不值得合入。

要继续做,先解掉这个 4 倍;要更快见效,见下面「不在本变更范围内」那段的第三方补丁。

## What Changes

- markdown 预览的解析管线（remark → rehype → hast）挪进 **Web Worker**；主线程只把 hast 转成
  React 元素并提交 DOM。点开大文档时主线程不再有 100ms 量级的解析阻塞，界面（滚动、目录、侧栏、
  关闭按钮）全程可响应。
- `Markdown.tsx` 不再直接用 `react-markdown` 组件渲染，改为「worker 出 hast + 主线程
  `hast-util-to-jsx-runtime` 出元素」。**现有渲染结果必须逐字节等价**：同一套 `components` 映射、
  `rehype-raw`、`rehypeStripTableWhitespace`、`rehypeSourcePos`（契约 A2 属性）、
  `remark-gfm { singleTilde: false }`、`disallowedElements`、`urlTransform` 一个不少。
- 解析期间预览窗给出「正在排版」的过渡态；worker 不可用 / 解析失败时**同步降级**到当前的
  `react-markdown` 渲染路径，不白屏。
- 已完成：`Markdown.tsx` 按 `children` + 锚点参数 memo 整棵正文，父组件重渲染不再触发重复解析。

不在本变更范围内（记下来，另议）：micromark GFM 表格扩展 `EditMap.add` 的平方级问题。
挪进 worker 后它仍然要烧 ~87ms，只是不再堵主线程。真要削掉它得给
`micromark-extension-gfm-table` 打 `pnpm patch`（已在 node 里验证：产出 HTML 一字不差，
管线 146ms → 66ms），那是一次第三方 fork 的取舍，单独立变更。

## Capabilities

### New Capabilities
- `markdown-preview-render`: 约定 markdown 预览的渲染路径与主线程占用 —— 解析在 worker 里做、
  渲染结果与锚点属性与改动前等价、失败降级同步渲染、以及"同一篇文档只解析一次"的重复解析约束。

### Modified Capabilities

（无。`preview-search`、`table-scan-search`、`code-preview` 等的**要求**不变；它们依赖的是渲染完成后的
DOM，本变更只改"正文什么时候出现在 DOM 里"，不改出现的形状。）

## Impact

- **平面**：只动**前端**（`src/app/`）。CLI（`bin/`）、服务端（`src/server/`）、`templates/` 都不碰。
- **契约**：**不动** `src/app/lib/api.ts`。没有新接口、没有新字段，正文仍走
  `GET /api/projects/:id/file`。旧服务进程照常工作。
- **只读红线**：不涉及任何工作空间写入。
- **代码**：`src/app/components/Markdown.tsx`（渲染路径）、新增 worker 与调用它的 hook；
  `Reader.tsx` / `HelpPanel.tsx` 作为调用方要能吃"正文晚一拍出现"。
  `src/app/lib/sourceAnchor.ts` 的插件要能在 worker 里跑（不碰 `document`）—— 现状已满足，
  `collectLeavesFromDom` 那半边留在主线程。
- **依赖**（都给**前端**平面用，且都已经是 `react-markdown` 的传递依赖，这里只是显式声明）：
  `unified`、`remark-parse`、`remark-rehype`、`hast-util-to-jsx-runtime`。
  `remark-gfm`、`rehype-raw` 已在 `dependencies` 里。服务端 / `bin/` 不引用它们，
  `scripts/build-npm-package.mjs` 按 import 图重算的依赖清单不受影响。
- **构建**：Vite 的 `new Worker(new URL(...), { type: 'module' })` 会多产出一个 worker chunk 进
  `dist/assets/`；`pnpm build` 后 `pnpm serve` 伺服 `dist/` 照常，npm 包组包也照常带上。
- **验证闸**：`pnpm typecheck`、`pnpm build`、`pnpm test:anchor`（第 5 项就是渲染开销闸），
  外加浏览器实测点开耗时与 longtask 段数。
