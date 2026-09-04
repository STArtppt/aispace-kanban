## Context

预览窗的 markdown 正文一直是 `react-markdown` 组件在 render 里同步跑完整条管线
（remark 解析 → mdast→hast → `rehype-raw` → 清表格空白 → `rehypeSourcePos` 盖契约 A2 属性）
再转成 React 元素。文档小的时候没人察觉；整篇是表格的产物（数据库结构快照、点表清单）就顶不住了。

**实测（生产构建、本机 Chromium、一份 46 KB / 31 张表 / 833 行表格的产物）：**

| 阶段 | 主线程 longtask | 说明 |
| --- | --- | --- |
| 改动前 | 3 段共 497ms | 同一篇被解析 2–3 次 |
| memo 掉重复解析后 | 1 段 192ms | 本变更第一步，已落地 |
| 其中解析占 | ~100ms | 87ms 是 micromark GFM 表格扩展的平方级累积 |
| 其余 | ~90ms | hast→React 元素 + 提交 7.6k 个 DOM 节点 |

盖锚点会给每个文本节点包一层 span（这篇里 3255 个），DOM 节点数因此约 7.6k —— 这部分是
批注能力（契约 A2）的必要开销，不在本变更里动。

约束：

- 契约 A2（`data-source-file` / `data-source-range`）是对外协议，字节区间不能变；
- `rehype-raw` 不能删（MinerU 与旧 pandoc 产物的裸 HTML 图表靠它）；
- 只动前端平面，不碰 `api.ts` 契约，不碰工作空间只读红线；
- 本仓无测试框架，闸门是 `pnpm typecheck` / `pnpm build` / `pnpm test:anchor` + 浏览器实测。

## Goals / Non-Goals

**Goals:**

- 点开大表文档时主线程不再被解析阻塞，界面全程可响应（滚动、目录、关闭、切文档）。
- 渲染结果与改动前逐处等价：排版、裸 HTML、锚点字节区间、URL 消毒、危险标签过滤。
- worker 拿不到或解析失败时，行为退回改动前，不白屏。
- 只解析一次的约束不因异步化而丢失。

**Non-Goals:**

- 不削减 micromark GFM 表格扩展的平方级开销（`EditMap.add`）。挪进 worker 后它仍要烧 ~87ms，
  只是不再堵主线程。真要削掉得给第三方打 `pnpm patch`，单独立变更。
- 不减少锚点 span 带来的 DOM 节点数（那是批注能力的必要开销）。
- 不改预览窗的检索、批注、目录三条既有能力的行为。
- 不做正文的分片 / 虚拟滚动。

## Decisions

### 决策 1：worker 里手搭 unified 管线，主线程用 `hast-util-to-jsx-runtime` 出元素

worker 里跑 `unified().use(remarkParse).use(remarkGfm, {singleTilde:false}).use(remarkRehype,
{allowDangerousHtml:true}).use(rehypeRaw).use(rehypeStripTableWhitespace).use(rehypeSourcePos, …)`，
产出 hast；主线程把 hast 交给 `hast-util-to-jsx-runtime`，配上现有的 `components` 映射。

这四个包本来就是 `react-markdown` 的传递依赖，这里只是显式声明并自己接线 —— 等价关系可控。

**备选：worker 里直接产 HTML 字符串，主线程 `dangerouslySetInnerHTML`。**
不选：会丢掉 `components` 映射（表格外壳、代码块壳子、mermaid 块、图片高度纠正都在那里），
也丢掉 React 对这棵树的所有权，批注层和检索都得改成手写 DOM 操作。省下的那点转换时间不值。

**备选：整个 `react-markdown` 搬进 worker。** 不可能 —— 它出的是 React 元素，跨不了线程。

### 决策 2：跨线程传 hast 树，传之前剥掉 `position`

`postMessage` 传结构化克隆的 hast。实测这篇文档的 hast 序列化后约 2.2 MB，克隆约 12ms —— 相对
省下的 ~100ms 阻塞是划算的。`position`（每个节点的行列偏移）只在 worker 内部给 `rehypeSourcePos`
用，盖完 A2 属性就没用了，传之前剥掉可以显著缩小载荷。

**备选：传 JSON 字符串自己 parse。** 实测比结构化克隆快不了多少（9.6ms vs 11.8ms），
还多一次字符串拷贝，不值得为此手写序列化。

**备选：`Transferable` / SharedArrayBuffer。** hast 是普通对象树，转不成可转移对象；
SharedArrayBuffer 还要跨源隔离响应头，服务端得改，越界了。

### 决策 3：`urlTransform` 留在主线程，`disallowedElements` 挪进 worker

`urlTransform` 是调用方给的闭包（`Reader.tsx` 里要拼 `projectId` 和相对路径），跨不了线程；
放在主线程转换元素时做，行为与 `react-markdown` 一致 —— 包括**调用方没给时退回
`defaultUrlTransform`**，那道 `javascript:` 消毒不能丢。

`script` / `iframe` / `object` / `embed` 的过滤是纯树操作，放 worker 里一并做完，
主线程拿到的树已经是干净的。

### 决策 4：模块级单例 worker + 请求序号，切文档时旧结果作废

每次渲染新建 worker 有几十毫秒的启动开销，切文档会很难看。改成模块级单例，
每次请求带一个自增 id，回来的消息 id 对不上就丢弃。组件卸载不销毁 worker（它是全窗口共享的）。

StrictMode 下 effect 会双跑：请求幂等（同样的源码发两次只是多解析一次，结果一样），
不引入"第一次的结果被第二次覆盖"的顺序问题。

### 决策 5：小文档直接走同步路径

异步化对小文档是净亏：本来 5ms 解析完，现在要多等一次消息往返（外加克隆）。
按源码字节数设一个阈值（初值 32 KB，约等于"一次解析 30ms 以上"的规模），阈值以下同步渲染，
以上才进 worker。阈值只是常量，好调。

**备选：一律走 worker。** 不选：小文档（绝大多数产出文档）会因为多一次往返而多闪一帧过渡态，
体验反而退步。

### 决策 6：降级路径就是现有的同步 `react-markdown`

`new Worker(...)` 抛错、worker 报错、或消息超时（初值 8 s），都退回现有的同步组件渲染。
这条路径同时是 `pnpm test:anchor` 验的那条，天然有回归闸守着。

### 决策 7：等价性怎么验

在 `scripts/test-anchor.ts` 里加一项：**同一份源码，worker 管线（在 node 里直接跑那条 unified
管线，不起真 worker）与现有 `react-markdown` 管线产出的 HAST 必须等价** ——
节点数、A2 属性、文本 span 数量逐一比对。这样两条路径漂移会被闸门当场拦下，
而不是等到某天某篇文档的锚点错位。

## Risks / Trade-offs

- **两条渲染路径长期共存 → 行为漂移。** → 决策 7 的等价性闸；且降级路径本身就是原路径，
  漂移只会发生在 worker 侧，闸门正好盯着它。
- **`hast-util-to-jsx-runtime` 与 `react-markdown` 内部版本不一致 → 渲染细节差异。**
  → 显式声明依赖时对齐 `react-markdown` 锁定的版本区间；`pnpm why` 确认只有一份实例。
- **2.2 MB 的克隆在低端机上更贵。** → 剥 `position` 缩小载荷；阈值以下不走 worker；
  真出问题时阈值可上调。
- **过渡态闪烁：小文档若误入 worker 路径会多闪一下。** → 决策 5 的阈值；过渡态用低对比度的
  骨架而不是大块 spinner，短暂出现也不刺眼。
- **worker 里的解析仍然是平方级。** → 本变更明确不解决；它现在发生在后台线程，界面不再冻结，
  但"点开到出内容"的时间没变。要真正变快得另立变更给第三方打补丁。
- **Vite worker 产物进 npm 包。** → `pnpm build` 后确认 `dist/assets/` 里有 worker chunk，
  并用 `pnpm smoke:npm` 在干净目录装包实跑一次预览。

## Migration Plan

1. 第一步（已完成）：`Markdown.tsx` memo 掉重复解析 —— 独立生效，与 worker 无关。
2. 第二步：加 worker + 主线程转换 + 降级，阈值以上才启用。
3. 回滚：把阈值常量设成 `Infinity`，全部走同步路径，行为回到第一步的状态。

## Open Questions

- **（挡路的那个）同一条管线在 worker 里比主线程慢 4 倍,原因不明。** 实测:worker 里
  `remark-parse` 一步就要 530–580ms,而主线程整条 `react-markdown` 路径(解析 + 转元素 +
  提交 DOM)总共才 174ms。已排除的解释:worker 线程本身没被降频(纯 CPU 循环主线程 63ms /
  worker 64ms)、两个 chunk 里都是 micromark 的生产构建(dev 构建的断言字符串都搜不到)、
  重复跑不收敛(第 5 次仍 537ms)。把这条查清之前,worker 这条路不值得合入。
- **2.2 MB 的 HAST 跨线程回来之后,主线程仍要 ~200ms** 把它转成 7.6k 个 React 元素并提交 DOM。
  就算解析真的白拿,省下的也只有一半。要更大的收益,得连"元素数量"一起降(分片渲染 /
  表格虚拟滚动),那是另一个量级的改动。

- 阈值定 32 KB 是按本机实测拍的（约 30ms 解析）。真机分布怎样、要不要按"表格行数"而不是字节数
  判断，等实际用一阵再调。
