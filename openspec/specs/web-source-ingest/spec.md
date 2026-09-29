# web-source-ingest

## Purpose

约定工作空间 `scripts/web_ingest.py` 的两条入口:URL 模式把公开网页转成可分析的 Markdown,
收件箱模式把丢进 `visualization/references/` 根上的散装 `.html` / `.htm` 收成标准参考目录
(子目录 + `index.html` + `meta.json`)再抽正文。落点、命名与忽略清单复用 `layout.py`;
URL 模式不向 `visualization/` 写任何文件,收件箱模式只把根上散装文件移进**新的**参考目录,
不覆盖、不删除已有目录。抓取与入库一律由用户或 agent 显式发起,没有后台任务;
看板只允许 `spawn --inbox` 这一种调用,不接受任何 URL 或路径参数。

## Requirements

### Requirement: 网页资料有独立入口,产物与文档转换同构

工作空间 MUST 提供 `scripts/web_ingest.py`,把一个网页 URL 转成
Markdown 落进 `input/converted/`,使它与 docx / PDF 产物一样能被分析、被溯源、
被看板的树形视图收录。

落点、`_manifest_` 命名、忽略清单解析 MUST 复用既有 `scripts/layout.py`,
MUST NOT 另起一套目录规则 —— 两套落点规则会让「按批次删除产物」这个
既有性质失效。

#### Scenario: 转换一个网页

- **WHEN** 执行 `python3 scripts/web_ingest.py <URL>`
- **THEN** 在 `input/converted/` 下生成一份 `.md`
- **AND** 该文件带 front-matter,能在看板的输入资料视图里打开并显示溯源信息

#### Scenario: 落点与文档产物同构

- **WHEN** 检查生成文件的位置与命名
- **THEN** 它遵循 `layout.py` 的同一套规则,与 docx / PDF 产物在同一棵目录树下

### Requirement: 提取的输入是本地渲染后 HTML

正文提取 MUST 以**本地 HTML 文件**为输入，MUST NOT 让提取工具自己去取 URL ——
提取工具拿到的是初始 HTML，正文靠水合渲染出来的站点会被抓成空壳。

取 HTML 的顺序：

- **URL 模式**：① 该 URL 已有对应的 `visualization/references/<slug>/index.html` 就直接用它；② 没有就用 `single-file` 抓一份到**临时目录**，提取完即弃。此模式 MUST NOT 向 `visualization/` 写入任何文件。
- **收件箱模式**：输入就是工作空间里已经存在的本地 HTML（根上散装文件，或已有参考目录的 `index.html`）。此模式允许把根上散装文件**移入**新的参考目录，MUST NOT 覆盖已有参考目录，MUST NOT 改已有目录里的 `index.html`。

`single-file` 是 AGPL-3.0，MUST 只以子进程方式调用，MUST NOT 以库的形式引入。

#### Scenario: 复用已有参考

- **WHEN** 该 URL 此前已通过看板采集成参考
- **THEN** 脚本直接读那份 `index.html` 提取正文，不重新抓取网络
- **AND** 说明本次用的是哪份参考

#### Scenario: 没有现成参考

- **WHEN** URL 模式且该 URL 没有对应的参考目录
- **THEN** 脚本用 `single-file` 抓到临时目录并在提取后清理
- **AND** `visualization/` 下没有新增任何文件

#### Scenario: 水合渲染的站点

- **WHEN** 目标页面的正文由前端脚本渲染而非直出
- **THEN** 产物里是渲染后的正文，不是空壳

#### Scenario: 收件箱模式不抓网

- **WHEN** 执行 `--inbox`
- **THEN** 脚本不调用 `single-file`、不请求任何 URL
- **AND** 只读工作空间里已经存在的 HTML

### Requirement: 网页产物的溯源字段记 URL 与抓取时刻

网页没有 `input/raw/` 下的原件,因此 front-matter MUST 用 URL 充当来源标识,
并 MUST 记录抓取时刻。front-matter MUST 保持扁平,字段名 MUST 与既有转换脚本
(`source` / `converted_at` / 工具标识)保持同名同义,不为网页另造一套词汇。

由于网页内容会在原地变化,产物 MUST 记录**提取到的正文**的摘要值,
使「这份产物对应当时抓到的哪一版」可判定。

正文若取自某份已有的参考采集,front-matter MUST 额外记一条指向
`visualization/references/<slug>/` 的相对路径 —— 那份自包含 HTML 就是这份产物的原件,
人要核对时能直接打开。该路径是线索而非依赖:参考目录后来被删也不影响产物本身可读。

#### Scenario: 溯源字段齐备

- **WHEN** 打开生成的产物
- **THEN** front-matter 里能读到来源 URL、抓取时刻、正文摘要值与生成工具
- **AND** 所有字段都是扁平的 `key: value` 形态

#### Scenario: 正文取自已有参考

- **WHEN** 本次提取复用了某份参考采集的 HTML
- **THEN** front-matter 里还有一条指向该参考目录的相对路径

#### Scenario: 同一 URL 重抓且内容未变

- **WHEN** 对同一个 URL 再跑一次
- **THEN** 摘要值一致,脚本跳过重写并说明跳过原因

#### Scenario: 同一 URL 重抓且内容已变

- **WHEN** 网页正文已经变化
- **THEN** 脚本说明内容已变,并按参数决定覆盖还是另存,不静默覆盖掉旧产物

### Requirement: 外部依赖缺失时明确失败,一律不静默降级

这条链路有两个 PATH 上的依赖:`defuddle`(提取)与 `single-file`(取页);脚本 MUST 在
当次确实需要的那一个缺失时打印安装命令并以非零码退出。

MUST NOT 静默降级成保存原始 HTML、直接请求 URL 或换用别的抓取方式 ——
静默降级会产出一份看着正常、实际塞满导航栏与广告、水合站点干脆是空壳的产物,
而它会一路流进后续分析。

`single-file` 是 AGPL-3.0,MUST 只以子进程方式调用,MUST NOT 以库的形式引入,
理由与做法见 `src/server/capture.mjs` 开头的「AGPL 边界」。

#### Scenario: 未安装 defuddle

- **WHEN** 环境里找不到 `defuddle`
- **THEN** 脚本打印安装命令并以非零码退出
- **AND** `input/converted/` 下没有产生任何文件

#### Scenario: 未安装 single-file 且需要抓页

- **WHEN** 环境里找不到 `single-file`,且该 URL 没有现成的参考可复用
- **THEN** 脚本打印安装命令并以非零码退出

#### Scenario: 未安装 single-file 但有现成参考

- **WHEN** 环境里找不到 `single-file`,但该 URL 已有对应的参考目录
- **THEN** 脚本正常完成提取 —— 这一次本来就不需要抓页

#### Scenario: 抓取失败

- **WHEN** URL 不可达、超时,或返回的不是可解析的网页
- **THEN** 脚本报告失败原因并以非零码退出,不留下半截产物
- **AND** 临时目录被清理干净

### Requirement: 网页产物守同一套写法规范

`web_ingest.py` 生成的 Markdown MUST 符合
`workspace-markdown-convention` 定义的可用语法子集:
扁平 front-matter、唯一 H1。

提取结果里的 wikilink、callout、行首标签、`%%注释%%`、段尾 `^id` 与数学公式
MUST 原样保留,MUST NOT 被规整或剥除 —— 看板已经能渲染它们
(见 `markdown-extended-syntax`)。唯一保留的规整是多个 H1 的降级。

#### Scenario: 产物过校验

- **WHEN** 对新生成的网页产物跑写法校验
- **THEN** 不报错

#### Scenario: 提取结果有多个一级标题

- **WHEN** defuddle 抽出的正文含多个 H1
- **THEN** 脚本保留第一个作为文档标题,其余整体降级一层

### Requirement: 网页入口写在技能里，由人发起

`pm-doc-ingest` 技能 MUST 补充网页资料的处理路径，说明何时用 URL 模式、何时用收件箱模式，以及它与 `visualization/references/` 采集的分工（可分析文本 vs 页面快照）。

抓取与入库 MUST 由用户或 agent 显式发起，MUST NOT 有后台自动抓取或定时任务。

看板 MUST 只允许 `spawn` `--inbox` 这一种调用（参考 tab 的刷新按钮）。看板 MUST NOT `spawn` 带 URL 参数的 `web_ingest.py` —— 公开页的页面快照走贴 URL 采集，文本转换由收件箱在参考落盘之后一并做，或由人在终端里对单条 URL 跑。

#### Scenario: 技能里能找到两条入口

- **WHEN** agent 读 `pm-doc-ingest` 技能
- **THEN** 能知道公开 URL 走 `web_ingest.py <URL>`，丢进 `visualization/references/` 的散装页面走 `web_ingest.py --inbox`
- **AND** 不会把网页当 HTML 原型丢进 `scripts/ingest.py`

#### Scenario: 看板只触发收件箱

- **WHEN** 在 `src/server/**` 与 `bin/cli.mjs` 里检索 `web_ingest.py`
- **THEN** 调用参数里能看到 `--inbox`
- **AND** 没有任何把客户端传来的 URL 传给这个脚本的路径

### Requirement: 收件箱模式把散装页面收成标准参考再抽正文

`scripts/web_ingest.py` MUST 接受无 URL 的 `--inbox` 模式。该模式 MUST：

1. 只扫描 `visualization/references/` **根上**的散装 `.html` / `.htm`（不含子目录里的文件、不含 `.mhtml`）；
2. 每一份收成一个**新的**参考目录：入口叫 `index.html`，并写 `meta.json`（`source` 为 `manual`）。slug 由标题生成，撞名则 `-2`、`-3`，MUST NOT 覆盖已有目录；
3. 原散装文件 MUST 被移进新目录（不是复制），避免下一轮再处理同一份；
4. 然后对「还没有对应 Markdown、或正文摘要已变」的参考目录抽正文，落点与 URL 模式相同，复用 `layout.py`。

`meta.json` 的 `sourceUrl` MUST 仅在能从页面里读到合法 `http`/`https` 地址时填写（SingleFile 页头注释是其中一种来源）；读不到就留空，不编造。

URL 模式（`web_ingest.py <URL>`）的行为 MUST 保持不变：仍然不向 `visualization/` 写入。

#### Scenario: 收一份散装 HTML

- **WHEN** 根上有一份 SingleFile 另存的 `.html`，执行 `python3 scripts/web_ingest.py --inbox`
- **THEN** 该文件从根上消失，变成 `visualization/references/<slug>/index.html`
- **AND** 同目录有 `meta.json`，`source` 为 `manual`
- **AND** `input/converted/` 下有一份带扁平 front-matter 的 Markdown，`reference` 字段指向这个新目录

#### Scenario: 已有参考目录不被动

- **WHEN** `visualization/references/` 里已有合格的参考目录，根上没有散装文件
- **THEN** 这些目录的 `index.html`、`meta.json`、截图都原样保留
- **AND** 脚本仍会为其中尚未有 Markdown 的目录抽正文

#### Scenario: 撞名

- **WHEN** 散装文件收成的 slug 与已有参考目录同名
- **THEN** 新目录使用 `<slug>-2`（已有 `-2` 则继续加）
- **AND** 已有目录不被覆盖、不被删除

#### Scenario: 没有可处理的文件

- **WHEN** 根上没有散装 HTML，且所有参考目录都已有正文未变的 Markdown
- **THEN** 脚本以退出码 0 结束并说明跳过原因
- **AND** 工作空间内没有任何文件被修改

### Requirement: 没有 URL 的页面用参考路径充当 source

网页产物的 `source` 字段在能读到 `http`/`https` 地址时 MUST 记这个地址（含 fragment，SPA 的路由经常在 hash 里）。读不到时 MUST 记参考目录的相对路径，MUST NOT 写 `file:` URL，MUST NOT 留空——幂等判定需要一个稳定标识。

摘要值仍然记**提取出的正文**，不记整页 HTML。

#### Scenario: 能读到来源地址

- **WHEN** 散装 HTML 的页头注释里有一条 `http`/`https` 地址
- **THEN** 产物 front-matter 的 `source` 是这条地址，且保留 fragment
- **AND** `meta.json` 的 `sourceUrl` 与它一致

#### Scenario: 读不到来源地址

- **WHEN** 一份手工另存的 HTML 里没有任何 `http`/`https` 地址
- **THEN** 产物 `source` 为 `visualization/references/<slug>/index.html`
- **AND** `meta.json` 的 `sourceUrl` 为空字符串或缺省

### Requirement: 收件箱批量失败不连坐

`--inbox` 处理多份文件时，单份失败 MUST NOT 回滚已经成功的其它份。缺 `defuddle` 是整批失败：打印安装命令、非零退出、不留下半截目录。

正文已变的已有产物 MUST 跳过并说明，MUST NOT 静默覆盖。覆盖或另存只在终端显式加 `--overwrite` / `--as-new` 时发生；看板触发的收件箱 MUST NOT 带这两个参数。

#### Scenario: 三份里一份提取失败

- **WHEN** 根上三份散装 HTML，其中一份 defuddle 抽不出正文
- **THEN** 另外两份仍然完成规范化与提取
- **AND** 失败的那一份若已经收成参考目录就保留（看板能打开页面），不写 Markdown
- **AND** 脚本退出码非 0，输出里点名失败的那一份

#### Scenario: 看板触发时正文已变

- **WHEN** 某份参考对应的 Markdown 已存在且正文摘要不同，且这次是看板 `spawn --inbox`（没有覆盖参数）
- **THEN** 旧产物不被覆盖
- **AND** 输出说明已变、要覆盖请在终端加 `--overwrite`
