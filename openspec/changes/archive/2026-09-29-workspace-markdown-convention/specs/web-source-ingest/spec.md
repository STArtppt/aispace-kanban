## ADDED Requirements

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

正文提取 MUST 以**本地 HTML 文件**为输入,MUST NOT 让提取工具自己去取 URL ——
提取工具拿到的是初始 HTML,正文靠水合渲染出来的站点会被抓成空壳。

取 HTML 的顺序 MUST 是:① 该 URL 已有对应的
`visualization/references/<slug>/index.html` 就直接用它;
② 没有就用 `single-file` 抓一份到**临时目录**,提取完即弃。

脚本 MUST NOT 向 `visualization/` 写入任何文件 —— 那是看板窄例外的地盘,
工作空间脚本不掺和;两个来源都写同一个目录会让「只新建不覆盖」这个性质失效。

#### Scenario: 复用已有参考

- **WHEN** 该 URL 此前已通过看板采集成参考
- **THEN** 脚本直接读那份 `index.html` 提取正文,不重新抓取网络
- **AND** 说明本次用的是哪份参考

#### Scenario: 没有现成参考

- **WHEN** 该 URL 没有对应的参考目录
- **THEN** 脚本用 `single-file` 抓到临时目录并在提取后清理
- **AND** `visualization/` 下没有新增任何文件

#### Scenario: 水合渲染的站点

- **WHEN** 目标页面的正文由前端脚本渲染而非直出
- **THEN** 产物里是渲染后的正文,不是空壳

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

这条链路有两个 PATH 上的依赖:`defuddle`(提取)与 `single-file`(取页)。
任一缺失且当次确实需要它时,脚本 MUST 打印安装命令并以非零码退出。

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
扁平 front-matter、唯一 H1。提取结果里的 Obsidian 禁用语法
MUST 被规整或剥除,不能原样落盘。

#### Scenario: 产物过校验

- **WHEN** 对新生成的网页产物跑写法校验
- **THEN** 不报错

#### Scenario: 提取结果有多个一级标题

- **WHEN** defuddle 抽出的正文含多个 H1
- **THEN** 脚本保留第一个作为文档标题,其余整体降级一层

### Requirement: 网页入口写在技能里,由人发起

`pm-doc-ingest` 技能 MUST 补充网页资料的处理路径,说明何时用这个入口。

抓取 MUST 由用户或 agent 在工作空间里显式发起,
MUST NOT 有后台自动抓取或定时任务。看板 MUST NOT 调用或 spawn 这个脚本 ——
若将来要在看板界面上触发它,那要另行按 `AGENTS.md` 不变量 1 的窄例外评估,
本能力不预留接口。

#### Scenario: 技能里能找到网页入口

- **WHEN** agent 读 `pm-doc-ingest` 技能
- **THEN** 能知道网页类资料走 `web_ingest.py`,而不是去 `visualization/references/` 采集

#### Scenario: 看板不触发抓取

- **WHEN** 在 `src/server/**` 与 `bin/cli.mjs` 里检索脚本名
- **THEN** 没有任何引用
