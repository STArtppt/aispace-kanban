## Context

`workspace-markdown-convention` 定下了「文档间一律写相对路径链接」，并在决策二里写了
「`Reader.tsx` 会把它过一遍 `resolveRelative` 再转成 `api.fileUrl`，能直接点开」。
实际读代码后，「能点开」的意思是：

- `Reader.tsx` 给正文 `Markdown` 传的 `urlTransform` 把**所有**非直通地址
  （链接和图片不分）改写成 `/api/projects/:id/file?path=…`，也就是原始文件地址。
- `Markdown.tsx` 的 `a` 渲染器给**所有**链接加了 `target="_blank"`，站内站外一视同仁。

两者叠加，点一个指向另一份 markdown 的链接，结果是新开浏览器窗口、显示源码。
`#锚点` 链接走 `shouldPassthroughUrl` 直通，但同样带着 `_blank`，会新开一个看板首页；
而且标题的 `id` 是 `doc-h-<序号>`，本来就对不上锚点文本。

另外有两处遗漏：表格产物的台账摘要（`Reader.tsx` 里 `-table-manifest` 那个 `Markdown`）
和目录型转换产物的 `_manifest.md` 摘要都**没传 `urlTransform`**，里面的相对链接连原始文件都打不开。

已有、可以直接复用的零件：

- `useBoardSession.ts` 的 `findFileInScan(scan, path)`：刷新后恢复预览靠它按路径找回 `FileItem`，
  口径覆盖 raw / converted（含分表）/ assets（含图库）/ 三类 output / `project.yaml`。
- `useBoardSession` 的 `selectFile(item)`：切换预览并把路径写进按工作空间存的恢复记录。
- `Reader.tsx` 的 `resolveRelative(base, url)`：已处理 `..`、百分号解码。
- 问题清单（`useQuestions`）的每一条都带工作空间内 `path`。
- `src/shared/codeLang.mjs` 的 `CODE_LANG_BY_EXT`：前后端共用的代码扩展名映射。

约束：只动前端；`api.ts` 不动；看板只读。

## Goals / Non-Goals

**Goals:**

- 站内链接左键点击在当前预览区就地打开，用目标文件自己的阅读器渲染。
- 修饰键 / 中键、外链保持浏览器默认行为。
- 跳转可后退。
- 存量文档里用行内代码写的路径不改文档也能点。

**Non-Goals:**

- 别名链接（表名、概念名 → 台账）、`[[wikilink]]`、反向链接面板 —— 见 Open Questions。
- 跨文档锚点：`a.md#某节` 只打开 `a.md`，不滚到该节。
- 前进按钮、浏览器历史（`history.pushState`）集成。
- 帮助面板、工作台问题详情里的链接。
- 改服务端的扫描范围（例如把 `output/questions`、`scripts/` 收进扫描结果）。

## Decisions

### 决策一：在 `Markdown` 上加一个可选的 `onInternalLink`，而不是在 `Reader` 外层委托点击

**选择**：`Markdown` 新增两个可选参数：`resolveLink(url) → 工作空间内路径 | null`
与 `onInternalLink(path, event)`。`a` 渲染器用前者判定，是站内链接就挂 `onClick`：
无修饰键的左键 → `preventDefault` 并调后者；有修饰键就不管。
站内链接去掉 `target="_blank"`（修饰键点击由浏览器自己决定开新窗口）；外链保留。

**备选：在 `Reader` 正文容器上监听 click，从 `event.target.closest('a')` 读 `href` 反解路径。**
不选：`href` 已经是 `/api/…/file?path=…`，要再从查询参数里反解，绕一圈；
而且行内代码自动成链需要在渲染时就知道「这是不是个路径」，委托方案覆盖不到。
两条入口共用同一个判定函数，才不会出现「链接能点、行内代码点了去别处」的分叉。

两个参数都不传时，`Markdown` 行为与改动前完全一致 —— 帮助面板、问题详情不受影响。

### 决策二：判定与兜底放在 `App` 层的一个 `openPath(path)`，`Reader` 只负责上报

**选择**：`useBoardSession` 暴露 `openPath(path, { viaLink })`：
先 `findFileInScan`；找不到再查问题清单；再按扩展名合成一个最小 `FileItem`
（`reader: 'markdown' | 'text'`，`size: 0`，`mtime: ''`，与 `findFileInScan` 给 `project.yaml`
兜底的写法同构）；都不行返回「交给浏览器」，由 `Reader` 调 `window.open(api.fileUrl(…))`。
问题单那一支由 `App` 打开工作台并传入要选中的问题编号。

**备选：让 `Reader` 自己拿 `scan` 做判定。**
不选：`Reader` 现在不依赖 `scan`，为了链接把整份扫描结果穿进去，会把
「按路径找文件」的逻辑复制第二份。`findFileInScan` 已经在 `useBoardSession` 里，
判定跟着它走，口径天然一致。

**合成 `FileItem` 的扩展名表**：markdown 只认 `.md` / `.markdown`；文本认 `.txt` +
`CODE_LANG_BY_EXT`。**不照抄服务端 `readerKind`** —— 那里还有 csv / 图片 / html，
它们在扫描范围外时往往是工作空间里的杂项（比如 `visualization/` 下的产物），
贸然合成成表格或 iframe 反而容易踩到阅读器的其他前提。宁可少认，退回新窗口。

### 决策三：问题单交给工作台，而不是在预览区当 markdown 读

**选择**：目标是问题清单里的某条时，打开工作台「未决问题」页并选中它，预览区不动。

**备选：当普通 markdown 在预览区渲染。**
不选：问题单的价值在工作台里 —— 状态、人工反馈、结论回流都在那一页；
在预览区读它的源 markdown 只能看不能答，还会看到 front-matter 原文。
代价是 `Workbench` / `QuestionsDialog` 要多接一个「初始选中编号」的可选参数，
改动面小、默认值为空时行为不变。清单还没加载时退回 markdown 打开，不阻塞。

### 决策四：后退链放在 `useBoardSession`，只存路径，只在内存

**选择**：`useBoardSession` 里加一个路径栈。`openPath(…, { viaLink: true })` 成功切换前把当前路径压栈；
`selectFile`（清单等入口）、关闭预览、切换工作空间都清栈。后退时从栈顶弹出路径，
用**最新的** `scan` 重新 `findFileInScan`（或按决策二合成），找不到就继续弹。

**备选一：存 `FileItem` 对象。** 不选：回去时 `mtime` 可能已变，`Reader` 靠 `mtime` 触发重读；
存路径、回去时重新查，拿到的永远是当次扫描的条目。
**备选二：接浏览器历史（`pushState` + `popstate`）。** 不选：看板的视图、工作台、帮助面板
都不在 URL 里，只让预览进历史会让浏览器后退键的语义一半在看板里、一半在外面，
比没有更让人困惑。**备选三：持久化到 `localStorage`。** 不选：刷新后恢复的是
「最后看的那一份」，已经由现有的预览路径记录负责；后退链是一次阅读会话里的临时状态。

### 决策五：行内代码自动成链只做精确路径匹配

**选择**：`Reader` 用 `scan` 构造一个路径集合（与 `findFileInScan` 同口径），
`resolveLink` 对行内代码文本先按工作空间根、再按当前文档目录解析，精确命中集合才成链接。
渲染成 `<a>` 包 `<code>`，保留等宽样式，下划线用既有链接的弱化样式。

**备选一：按文件名模糊匹配（Obsidian 的 shortest-path 解析）。**
不选：`input/converted/` 满地 `_manifest_<名>.md` 与分表同名文件，按文件名必然歧义，
这正是 `workspace-markdown-convention` 禁用 wikilink 的同一个原因。
**备选二：只按当前文档目录解析（与普通相对链接一致）。**
不选：实际文档里提源文件时写的几乎都是工作空间根相对路径（`input/raw/…`），
只按文档目录解析等于这条功能落空。两种都认，根优先，因为人写行内路径时默认的就是根视角。

不在扫描集合里的文件（`scripts/…`、问题单）不自动成链 —— 集合判定只用扫描结果，
不为行内代码去试探服务端文件是否存在。这是有意的保守：误成链比漏成链更伤。

### 决策六：顺手补上两处摘要 `Markdown` 的链接处理

台账摘要与 `_manifest.md` 摘要现在连 `urlTransform` 都没传，里面的图片和链接都按
页面相对地址解析，本来就是坏的。本变更给预览区里全部三处 `Markdown` 统一传
`urlTransform` / `resolveLink` / `onInternalLink`，基准目录是**摘要文件自己的目录**
（不是产物目录），否则 `_manifest_<名>.md` 与正文分居两地的新布局下相对路径会差一层。

## Risks / Trade-offs

**[拦截点击后，用户想「对照着看」反而不方便] →** ⌘ / 中键仍新开窗口；
另有后退按钮，点错了一步回来。

**[行内代码误成链接] →** 只做完整路径精确相等，且只认扫描结果里的文件。
能误中的只有「文本恰好就是某个真实文件的完整路径」，这时成链本来就是对的。

**[合成的 `FileItem` 缺字段，某个阅读器分支依赖 `size` / `mtime`] →**
`findFileInScan` 给 `project.yaml` 兜底时已经在用同样的最小形态，markdown / text 阅读器
走得通；实现时逐一核对这两个阅读器对 `size`、`mtime`、`words` 的使用，并把
「点一个扫描外的 `.md` 与 `.py`」列入验收。

**[后退链与「刷新恢复预览」互相干扰] →** 两者职责分开：恢复记录照旧只记当前路径，
后退链不落盘；`openPath` 最终仍经 `selectFile` 的同一条写恢复记录的路径，只是多了压栈。

**[问题清单加载慢，点问题链接时还没数据] →** 退回 markdown 阅读器打开，不等、不报错。

**[大文档里行内代码很多，每段都做两次路径解析] →** 集合查找是 O(1)，
解析是纯字符串操作；且 `Markdown` 已按内容 memo 整棵正文，不会在滚动时重算。

## Migration Plan

纯前端改动：`pnpm build` 后刷新页面即生效，不需要重启服务，也没有新老进程兼容问题
（没有新接口、没有新字段）。回滚即撤销提交。存量文档一份都不用改。

## Open Questions

- **别名链接（第三层）**：数据库表名、概念名这类不是路径的行内代码，怎么点到它的台账？
  倾向在模板里约定台账 front-matter 写 `aliases:`（与 Obsidian properties 同名同义），
  服务端扫描时把它收进 `ConvertedItem`（可选字段），前端建「名字 → 路径」表，
  命中的行内代码成链。这会动服务端与 `api.ts`，需要单开 change。
  短期替代：在 `templates/pm-aispace/AGENTS.md` 的「Markdown 写法」里补一句
  「提到数据表 / 数据源时链接到它的台账」，由写的一侧解决。
- **`[[wikilink]]` 渲染**：依赖上面的名字表与消歧规则（`input/converted/` 同名文件太多，
  必须强制写带目录的形态）。别名先落地，wikilink 解禁才有意义。
- **反向链接面板**（「谁引用了这份文档」）：需要服务端全量扫描正文里的链接建索引，
  与内容检索的扫描开销一起评估。
- **跨文档锚点**：`a.md#某节` 打开后滚到该节。要先把标题 `id` 从序号改成可由文本推出的形态，
  会牵动批注锚点与目录定位那两套自写 rehype 插件，单独评估。
- **工作台问题详情里的链接**：问题正文也常引用分析文档，点了是否应关闭工作台并在预览区打开？
  交互上要和工作台的模态语义一起想，本变更不做。
