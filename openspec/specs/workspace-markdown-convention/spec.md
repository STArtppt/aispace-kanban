# workspace-markdown-convention

## Purpose

约定工作空间里由人或 agent 手写的 Markdown 怎么写：语法子集以「Obsidian 与看板渲染器
同时支持」为界，写法规范只在 `templates/pm-aispace/AGENTS.md` 存一份，
`output/**` 走 `check_markdown.py` 校验与默认可预演的存量迁移。
`input/converted/**`（转换产物，重跑即覆盖）与 `input/raw/**`（原件）不在校验范围内。

## Requirements

### Requirement: 写法规范是成文契约,且只有一份

工作空间的 Markdown 写法规范 MUST 只写在 `templates/pm-aispace/AGENTS.md` 的
「Markdown 写法」一节里。各技能 MUST 只留一句指向它的引用,
MUST NOT 复述规范条目 —— 复述必然漂移,九个技能各存一份过期副本比没有规范更糟。

#### Scenario: 技能里不留副本

- **WHEN** 检查九个 `pm-*` 技能的 `SKILL.md`
- **THEN** 每份都能找到一句指向 `AGENTS.md` 那一节的引用
- **AND** 没有任何一份重复写出具体的语法允许项或禁用项

#### Scenario: 规范条目可被脚本读取

- **WHEN** `scripts/check_markdown.py` 执行校验
- **THEN** 它检查的条目与 `AGENTS.md` 那一节列出的条目逐条对应
- **AND** 脚本的文档字符串指明「契约变了这里要跟着变」

### Requirement: 语法子集必须双向安全

规范 MUST 把语法分成「现在可用」与「现在禁用」两档,
划分依据 MUST 是**Obsidian 与看板渲染器同时支持**。

现在可用:扁平 YAML front-matter、全文唯一 H1 且正文从 H2 起、
文档间相对路径链接与 wikilink(`[[目标]]`)、图片嵌入(`![[图.png]]`)、
`> [!type]` callout(含 `+` / `-` 折叠)、行首 `#标签`、`%%注释%%`、
段尾块锚点 `^id`、`$...$` 与 `$$...$$` 数学公式、
GFM 表格、围栏代码块、```mermaid 代码块。

现在禁用:本能力不列任何禁用项 —— 原先禁用的那批 Obsidian 语法已由
`markdown-extended-syntax` 逐条解禁,口径与 `templates/pm-aispace/AGENTS.md`
「Markdown 写法」一节的「现在可用」一致。规范另有一节「不要依赖这些」列出看板
**做不到**的三件事(全库裸文件名匹配、把文档正文嵌进来、打开后滚到某一节),
那是能力边界,不是禁用语法。

将来若出现看板渲染不了的语法,加进禁用档时 MUST 标明
「禁用是因为看板暂不渲染,而非永久排除」,以便看板补上后逐条解禁,
**存量文档不需要回头翻修**。

#### Scenario: 曾经禁用的语法已放行

- **WHEN** 某份 `output/` 下的文档正文里出现 `[[某文档]]`、`> [!note] 说明`、
  `#待确认`、`%%注释%%` 或 `$v=s/t$`
- **THEN** `check_markdown.py` 不报错,预览区按 `markdown-extended-syntax` 渲染

#### Scenario: 行首标签不再被当成标题

- **WHEN** 某份文档里有一行以 `#标签` 开头(`#` 后紧跟非空格字符),
  另有一行以 `# 标题` 开头(`#` 后有空格)
- **THEN** `check_markdown.py` 不报错,文档目录里只有后者

#### Scenario: 可用语法不报警

- **WHEN** 文档使用 GFM 表格、围栏代码块、mermaid 代码块与相对路径链接
- **THEN** `check_markdown.py` 不报任何错误或警告

### Requirement: front-matter 必须是扁平 YAML

所有手写 Markdown 的 front-matter MUST 只使用 `key: value` 与
`key:` + `  - item` 两种形态。MUST NOT 使用内联数组(`tags: [a, b]`)
或嵌套对象 —— 看板的解析器(`src/server/frontmatter.mjs`)只认这两种形态,
内联数组会被整体当成一个字符串,静默丢掉语义。

这条与 `output/questions/README.md` 已有的扁平约束是同一条,
本规范 MUST 把它的适用范围从 `questions/` 扩到全部手写 Markdown。

#### Scenario: 内联数组

- **WHEN** 某份文档的 front-matter 写 `tags: [需求, 计费]`
- **THEN** `check_markdown.py` 报错,并给出块状 list 的改写形态

#### Scenario: 嵌套对象

- **WHEN** 某份文档的 front-matter 出现缩进的二级键值对
- **THEN** `check_markdown.py` 报错,指出看板解析器读不出嵌套结构

### Requirement: 规范按目录分区适用

规范 MUST 声明适用范围:只管 `output/**` 与其它由人或 agent 手写的 Markdown。

MUST NOT 把 `input/converted/**` 纳入校验范围 —— 那里的文件由
`ingest.py` / `pointtable.py` / `realdata.py` 生成,重跑即覆盖,
要改它们的形态应该改转换脚本而不是产物。

`input/raw/**` MUST 完全不碰。

#### Scenario: 校验只扫手写区

- **WHEN** 在一个 `input/converted/` 下有数百份产物的工作空间里跑 `check_markdown.py`
- **THEN** 它只报告 `output/**` 下的问题
- **AND** 不读取、不报告 `input/converted/` 与 `input/raw/` 下的任何文件

### Requirement: 存量迁移默认预演

`scripts/migrate_markdown.py` MUST 默认只打印将要做的改动而**不落盘**,
落盘 MUST 需要显式参数。它是本变更里唯一会改写人类既有产物的动作。

迁移 MUST 只做两件事:补齐缺失的 front-matter 字段、
把裸文件名引用改写成相对路径链接。MUST NOT 改写正文措辞、
MUST NOT 调整标题层级 —— 那些需要人判断。

#### Scenario: 默认预演

- **WHEN** 不带参数运行 `python3 scripts/migrate_markdown.py`
- **THEN** 打印每份待改文件与逐条改动
- **AND** 工作空间内没有任何文件被修改

#### Scenario: 显式落盘

- **WHEN** 带落盘参数运行
- **THEN** 改动写入文件,并打印实际改了多少份
- **AND** 改写过程先写临时文件再原子替换,中断不留半截文件

#### Scenario: 无法自动判定的引用

- **WHEN** 某处裸文件名在工作空间里匹配到多份同名文档
- **THEN** 迁移脚本跳过它并列进「需人工处理」清单,不猜一个目标

### Requirement: 校验与迁移脚本只读工作空间自身

两个脚本 MUST 只在自己所在的工作空间内操作,
路径拼接 MUST 限制在工作空间根之内,不接受指向工作空间外的参数。

看板服务端 MUST NOT 调用、spawn 或以任何方式触发这两个脚本 ——
它们是工作空间自己的工具,与看板的只读红线互不相干。

#### Scenario: 看板不碰这两个脚本

- **WHEN** 在 `src/server/**` 与 `bin/cli.mjs` 里检索脚本名
- **THEN** 没有任何引用

#### Scenario: 目录缺失

- **WHEN** 工作空间里没有 `output/` 目录
- **THEN** 脚本打印说明并以「用法/目录问题」退出码结束,不创建目录
