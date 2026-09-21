## Context

上一份 `workspace-markdown-convention` 已经落地 `scripts/web_ingest.py`：吃一个 URL，优先复用 `visualization/references/<slug>/index.html`，没有就 `single-file` 抓到临时目录，再用 `defuddle` 抽 Markdown 进 `input/converted/`。它有一条硬约束——**不向 `visualization/` 写任何文件**，因为那是看板窄例外的地盘。

实际缺口不在 URL，在「文件已经在磁盘上了」。参考扫描（`src/server/references.mjs`）判定一份参考的条件只有一条：子目录根上有 `index.html`。散装 `.html` 直接躺在 `visualization/references/` 根上会被跳过，空态文案也写了这件事。浏览器插件另存、剪藏、SingleFile 默认就是这种散装文件。

登录后的深层页更走不通贴 URL 采集：看板的 `single-file-cli` 没有会话，抓下来会是登录页。官方采集扩展投递（`capture-inbox.mjs`）已经能落成合格目录，但那条路不抽 Markdown；通用 SingleFile / 浏览器另存连目录都没有。

所以现在缺的不是「再抓一次网」，是「把已经丢进来的本地 HTML 收成两份标准数据」：给人看的参考目录，给 AI 读的 Markdown。用户要的触发方式是参考 tab 链接输入右侧的刷新按钮，形状对齐原型 tab 的刷新。

约束：看板对工作空间只读；跨平面；`defuddle` 已是工作空间脚本的 PATH 依赖，不进看板 `package.json`；本仓已开源，产物里不写真实页面标题、本机路径、内网地址。

## Goals / Non-Goals

**Goals:**

- 用户把自包含 HTML 丢进 `visualization/references/` 根上，点一次刷新，就能在参考 tab 看到卡片、在输入资料里打开 Markdown。
- 已经合格的参考目录（贴 URL 采集、插件投递、手工建目录）若还没有对应 Markdown，同一次刷新一并抽。
- URL 模式保持原样，公开页仍然可以在终端里对单条 URL 跑。
- 写入面压进 AGENTS.md 一条新的窄例外，看板只 `spawn`。

**Non-Goals:**

- 不处理 `.mhtml`、浏览器「完整网页」另存出来的配套资源文件夹。
- 不补 `screenshots/`。收件箱处理的是已经另存的页面，Playwright 仍只属于贴 URL 采集那条可选降级。
- 不让看板 `spawn` 带 URL 的 `web_ingest.py`（公开页快照走采集栏，不在这里再做一条抓取入口）。
- 不改 `ingest.py` 把 HTML 当原型包的那条路——那是 PM 之间传递可点击原型用的，和参考页不是一类东西。
- 不做整站抓取、不定时自动入库。

## Decisions

### 决策一：给 `web_ingest.py` 加 `--inbox`，不另起脚本

**选择**：收件箱是同一条提取管线的第二种入口。规范化散装文件、调 defuddle、规整禁用语法、写扁平 front-matter、按 `layout.py` 落点，全部复用现有函数。

**备选：新建 `scripts/reference_inbox.py`。** 不选。sanitize、digest 幂等、`layout.py` 落点会立刻出现第二份实现，两套 front-matter 词汇是必然的结局。URL 模式「不写 visualization/」用「有没有 `--inbox`」就能分开，不必靠两个文件名来隔离。

### 决策二：看板只 spawn `--inbox`，参数写死

**选择**：`POST /api/projects/:id/web-ingest` 不读请求体里的任何路径或 URL，服务端固定 `spawn(python, [script, '--inbox'])`。脚本在不在用 `scripts/web_ingest.py` 是否存在判断，Python 走 `findPython()`，任务表与 ingest / proto-sync / capture 并列、不共用锁。

**备选一：复用 `/api/projects/:id/ingest`。** 不选。ingest 吃的是 `input/raw/`，前端轮询、409 文案、进行中提示都绑着「正在转换资料」。参考入库进行中不该挡住 PDF 转换。

**备选二：让按钮把选中的文件名传给服务端。** 不选。一传路径就要过 `resolveInside()`，还要防客户端伪造；脚本自己扫根目录更窄，也符合「请求不带路径」。

接口路径用 `web-ingest` 而不是 `ref-sync`：它跑的就是网页入库脚本，不是原型那种双向同步。

### 决策三：散装文件搬走，不复制

**选择**：`shutil.move` 到新目录的 `index.html`。复制会让下一轮刷新再处理同一份；留下原件当「备份」没有意义，SingleFile 另存本来就是那一份。

失败策略：先建空目录、写入 `meta.json`、再 move。move 失败则删掉这个新空目录（里面还没有 `index.html`，扫描本来就不认它）。**已经 move 成功的目录不回滚**——哪怕随后 defuddle 失败，看板也已经能打开这页，Markdown 可以下次再抽。

**备选：复制 + 在旁写 `.imported` 标记。** 不选。多一份状态文件，扫描器和脚本都要认，散装文件还会继续躺在根上干扰「待入库」计数。

### 决策四：一次刷新两件事，不只收散装文件

**选择**：`--inbox` 先收根上散装文件，再遍历**所有**合格参考目录，对还没有对应产物、或正文摘要已变的抽出 Markdown。插件投递和贴 URL 采集落下来的目录，同样缺 AI 可读文本。

**备选：只处理本轮新收的散装文件。** 不选。那会让「参考 tab 已经有卡片、AI 仍然两眼一抹黑」继续存在，用户会以为刷新坏了。

看板触发时不带 `--overwrite` / `--as-new`。正文已变就跳过并说明，整批不因这一份停掉。要覆盖去终端。这与 URL 模式的「不静默覆盖」是同一条，只是批量下把「整脚本失败」改成「这一份跳过」。

### 决策五：source 优先记 URL（含 fragment），没有就记参考路径

**选择**：能从 SingleFile 页头注释（`url: https://…`）或已有 `meta.json.sourceUrl` 读到合法 `http`/`https` 就用它，**保留 fragment**。读不到就用 `visualization/references/<slug>/index.html` 充当 `source`。摘要仍是正文的 sha256。

**备选一：沿用 URL 模式现有的 `normalize_url`（丢掉 fragment）。** 不选。SPA 的路由经常在 hash 里，丢掉之后同一站点的不同页会撞成同一个 `source`，幂等判定会串台。贴 URL 采集那边 `normalizeTargetUrl` 用的是 `URL.toString()`，fragment 本来就保留；`web_ingest.py` 丢掉它是既有缺口，本 change 一并修掉。

**备选二：没有 URL 就跳过提取，只做规范化。** 不选。剪藏 / 另存常常不带地址，那正是收件箱要吃的输入；跳过等于看板能看、AI 还是不能读。

### 决策六：`source: manual`，不冒充 plugin

**选择**：收件箱收进来的参考，`meta.json.source` 一律 `manual`。`plugin` 只属于走了 `POST /capture-package` 契约的采集包。

**备选：新增 `source: drop`。** 不选。契约已经有 `manual` / `url-capture` / `plugin` 三值，`manual` 的本意就是「用户手工摆进来」，散装文件被收成目录正是这件事。多一个取值要动扫描白名单、卡片文案、旧前端兜底，收益只是多一个徽章。

### 决策七：按钮做在 `CaptureBar` 的动作位上，只给参考 tab

**选择**：`CaptureBar` 在链接输入右侧加一个可选 `extraAction`。`ReferencePanel` 传入刷新按钮；原型 tab 不传，布局不变。

进行中用转圈替换图标，结果走 `CaptureBar` 下面已有的 Alert 条（成功中性、失败 orange）。待入库份数写在左侧 status 文字里，`pending > 0` 时用 `--destructive`，和「待转换资料」同一条配色约束。

**备选：做成像原型行那样的独立「刷新」文字按钮。** 不选。用户指定了位置——链接输入右侧；参考 tab 的刷新是整页收件箱，不是某一张卡片。

**备选：跟资料转换共用 ingest 任务条。** 不选。见决策二。

### 决策八：收件箱与采集不共用锁

**选择**：独立的 `webIngestJobs`。采集写的是新 slug 目录，收件箱动的是刷新开始时已经在根上的散装文件，两者碰撞面很小。真碰上（刷新进行中用户又丢了一份），下一轮再收。

**备选：与 capture 互斥。** 更保守，但用户会看到「正在采集，不能刷新」——采集可能要两分钟等 Playwright。不值得为这个小窗口让刷新排队。

与 ingest 更不能互斥：转一份大 PDF 的时候仍应能把刚丢进来的页面收掉。

### 决策九：不写 `input/raw/`

**选择**：继续用 URL 模式已经采用的虚拟 raw 路径（`input/raw/web/<host>/<标题>.html`）只为了算 `layout.py` 的落点，磁盘上不建这个文件。没有 URL 时 host 用 `dropped`，标题用参考 slug。

**备选：把 HTML 拷进 `input/raw/` 再走 ingest。** 不选。`input/raw/` 是「人类给的原始资料且永不改动」；参考目录里那份 `index.html` 已经是原件。ingest 对 HTML 走的还是原型包路径，不抽正文。

## Risks / Trade-offs

**[散装 HTML 实际是 SPA 壳，defuddle 抽不出正文] → ** 目录仍然收下，看板能打开原页；Markdown 失败记进任务结果，不删已经收好的参考。这比「整份回滚、卡片也不见」更接近用户预期。

**[4 MB 级自包含 HTML 让 defuddle 变慢或把内存打满] → ** 沿用 64 MB 上限，单份超时沿用现有 60 秒。超了记失败、继续下一份。不在本 change 做流式提取。

**[move 之后原文件名带的日期戳丢失] → ** 日期进 `meta.json.capturedAt`（SingleFile 注释或文件 mtime）。slug 来自标题，本来就会丢掉另存时拼在文件名里的时间。

**[存量工作空间没有新脚本] → ** `canInbox: false`，按钮不出现。模板会带新脚本；旧实例要自己把 `templates/pm-aispace/scripts/web_ingest.py` 拷过去，或等下次用模板重建。本 change 不做自动把脚本灌进已有工作空间。

**[修 URL 规范化以保留 fragment，可能让「同一 URL 去掉 hash 再跑一次」变成两份产物] → ** 接受。那本来就是两份不同的 SPA 视图。对无 hash 的普通文档页，行为与改前一致。

## Migration Plan

1. 先改 `web_ingest.py` 的 `--inbox` 与 fragment 保留，在一个带散装 HTML 的工作空间里直接跑脚本验收。
2. 再改服务端扫描字段与 `web-ingest` 接口。
3. 同步 `api.ts`，前端接按钮。
4. 写 AGENTS.md 第五条窄例外、技能指针、`smoke-package.mjs` 的非环回 403 清单。
5. 存量工作空间：有模板脚本的，把更新后的 `web_ingest.py` 拷进去即可；看板进程必须重启。

回滚：删掉接口与按钮，脚本的 `--inbox` 留着也不影响 URL 模式。已经收下的参考目录和 Markdown 是用户数据，回滚代码不删它们。

## Open Questions

- 待入库提示要不要进概览页的缺口列表？倾向本 change 不做——参考 tab 自己能看见，概览再加一条要动 Overview 的缺口模型。
- 同一份参考刷新出「正文已变」时，要不要在卡片上标 orange？倾向不做，只出现在这一轮任务结果里。卡片橙色目前只给「需要人处理」的状态，产物过期是输入资料视图的事。
