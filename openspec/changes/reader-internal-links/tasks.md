> 本变更只落前端（`src/app/**`）。服务端、CLI、`src/app/lib/api.ts` 一律不动，
> 因此没有「重启服务 / 新老进程兼容」这一类任务；`pnpm build` 后刷新页面即生效。

## 1. 路径判定与导航（`useBoardSession` / `App`）

- [x] 1.1 在 `hooks/useBoardSession.ts` 抽出与 `findFileInScan` 同口径的「扫描路径集合」构造函数
      （raw / converted 含分表 / assets 含图库 / 三类 output / `project.yaml`），供行内代码判定复用
- [x] 1.2 实现按扩展名合成最小 `FileItem`：`.md` / `.markdown` → `markdown`；
      `.txt` 与 `CODE_LANG_BY_EXT` 的扩展名 → `text`；其余返回空（交给浏览器）
- [x] 1.3 新增 `openPath(path, { viaLink })`：扫描命中 → 问题清单命中 → 合成 `FileItem` → 交给浏览器，
      返回处理结果供调用方决定是否 `window.open`
- [x] 1.4 加后退链：`viaLink` 切换前压入当前路径；`selectFile`、关闭预览、切换工作空间清栈；
      `goBack()` 用最新 `scan` 重新解析，找不到就继续弹；只存内存，不写 `localStorage`
- [x] 1.5 `App.tsx` 接线：问题单命中时 `setWorkbenchPage('questions')` + 打开工作台 + 传入要选中的编号；
      把 `openPath` / `goBack` / 是否可后退 / 路径集合传给 `Reader`

## 2. 工作台选中指定问题

- [x] 2.1 `Workbench` / `QuestionsDialog` 新增可选参数「初始选中的问题编号」，
      有值时打开即选中并滚到该行；不传时行为与改动前一致
- [x] 2.2 同一编号连续点两次（中间关过工作台）也能再次选中 —— 用编号 + 请求序号，避免 effect 不触发

## 3. `Markdown` 组件

- [x] 3.1 新增可选参数 `resolveLink(url) → path | null` 与 `onInternalLink(path, event)`；
      都不传时渲染结果与改动前逐字一致（帮助面板、问题详情回归）
- [x] 3.2 `a` 渲染器：站内链接去掉 `target="_blank"`，无修饰键左键 `preventDefault` 并上报；
      ⌘ / Ctrl / Shift / Alt / 中键不拦截；`http(s)` / `mailto:` 保持 `_blank` + `noreferrer`
- [x] 3.3 `#锚点` 链接：不新开窗口，按规整后的标题文本在当前正文容器里查找并滚动，未命中不动
- [x] 3.4 行内 `code`（非围栏块）：文本去空白与开头 `./` 后交给 `resolveLink`，命中则包成站内链接，
      保留等宽样式；确认不影响批注的源码定位属性（`pickSourceAttrs`）
- [x] 3.5 确认 `urlTransform` 的 memo 包装同样适用于新参数（行内箭头函数不能让整棵正文每次重渲）

## 4. `Reader` 接入

- [x] 4.1 实现 `resolveLink`：直通协议返回空；`resolveRelative(base, url)`；越出根（结果以 `..` 开头或为空）返回空
- [x] 4.2 行内代码的解析顺序：先工作空间根、再当前文档目录，只认路径集合里的精确命中
- [x] 4.3 预览区三处 `Markdown`（正文、表格台账摘要、`_manifest.md` 摘要）统一传
      `urlTransform` / `resolveLink` / `onInternalLink`，基准目录取**摘要文件自身所在目录**
- [x] 4.4 `onInternalLink` → `openPath`；结果为「交给浏览器」时 `window.open(api.fileUrl(…), '_blank', 'noreferrer')`
- [x] 4.5 预览区头部加「后退」图标按钮（沿用头部既有按钮样式与 `title`/`aria-label`），链为空时隐藏
- [x] 4.6 核对 markdown / text 阅读器对合成 `FileItem` 的 `size: 0`、`mtime: ''` 是否有依赖（读取、字数、重读触发）

## 5. 验收闸

- [x] 5.1 `pnpm typecheck` 与 `pnpm build` 全绿
- [x] 5.2 用合成工作空间（`templates/pm-aispace` 起一份，不用真实资料）造一份分析文档，覆盖：
      指向转换产物台账、决策文档、问题单、`output/README.md`、`scripts/*.py`、`.sqlite` 的链接，
      一个 `#锚点`，一个外链，以及 `` `input/raw/…` `` 路径与一个表名形态的行内代码
- [x] 5.3 浏览器逐项点一遍：就地打开且阅读器正确；⌘ 点击与中键新开窗口；外链新开窗口；
      锚点滚动；问题单打开工作台并选中；`.sqlite` 新开窗口；指向已删文件显示错误态不白屏
- [x] 5.4 连续跳三级再逐级后退；中途从清单打开文件后「后退」消失；切换工作空间后「后退」消失；
      刷新页面后恢复的是最后一份、后退链为空
- [x] 5.5 表格产物台账摘要与 `_manifest.md` 摘要里的相对链接、图片都能正确解析
- [x] 5.6 回归：帮助面板与工作台问题详情里的链接行为不变；批注模式下点链接不误触发批注、
      批注锚点定位仍准确；预览区内检索高亮在成链的行内代码上仍正常
- [x] 5.7 边界：登记目录丢失（`scan.available === false`）时点链接不崩；
      工作空间没有 `project.yaml` 时正常；深色模式下行内代码链接与后退按钮的样式可辨、不引入新色值
- [x] 5.8 脱敏过一遍：本 change 的四份产物与验收用的合成件里没有真实客户名、本机绝对路径、内网地址、凭据

## 实现备注（与 design 的出入）

- `resolveLink` 的签名落成 `(url, kind: 'link' | 'code') → { path, href } | null`：
  链接与行内代码解析规则不同（前者按文档目录、只判越界；后者根优先、只认扫描集合），
  仍走同一个函数；多带 `href` 是为了让 ⌘ 点击拿到去掉 `#片段` 的原始文件地址。
- 问题单的判定放在 `App` 的 `openLinkedPath` 里、先于 `openPath`：`useBoardSession` 不持有问题清单；
  问题单不在扫描范围内，先后顺序不影响结果。
- 扫描查找与路径集合补认了转换产物的 `manifestPath`：文档里链的是 `_manifest_<名>.md`，
  而扫描条目的 `path` 是正文目录，不补就会被当普通 markdown 打开，达不到「按转换产物样式渲染」。
- 行内代码取文本要穿过批注用的 `data-source-text` 包裹 span；成链后的下划线画在 `code` 自身，
  颜色用 `muted-foreground/50`（`border` 色贴着 `muted` 底色看不出来）。
- 批注模式下 `Reader` 的回调直接放行，由批注层照旧 `preventDefault` 并选取元素，不跳转。
- 刷新恢复预览也走「扫描 → 按扩展名合成」的兜底，经链接打开过的 README / 脚本刷新后同样能回到那一份。
