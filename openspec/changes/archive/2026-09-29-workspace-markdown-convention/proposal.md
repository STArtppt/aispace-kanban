## Why

工作空间里的 Markdown 现在没有任何成文写法规范,九个 `pm-*` 技能各写各的 ——
不做的后果是:等将来想把工作空间接进 Obsidian 式的知识网(双链、按属性建视图),
存量文档要**回头逐份翻修**;而且现在已经有具体损失 ——
front-matter 形态不统一,看板那个只认扁平 YAML 的解析器读不全;
文档间引用有的写裸文件名、有的写路径,看板里点不开。

同时工作空间有一个现成缺口:`input/` 只吃 docx / PDF / xlsx / pptx,
**网页类资料没有入口**。政策文件、公开标准、友商文档站只能走
`visualization/references/` 采集成视觉材料,那是给人看的页面快照,
不是能进 `input/converted/` 被分析、被溯源的文本。

这两件事现在一起做,是因为规范一旦成文,新的入口从第一天就守着它,
不用事后再迁一次。

## What Changes

**规范侧(阶段 0)**

- `templates/pm-aispace/AGENTS.md` 新增「Markdown 写法」一节:确立一个
  **Obsidian 与看板双向安全的语法子集** —— 现在就能用的(扁平 front-matter、
  唯一 H1、相对路径链接、mermaid 代码块)与现在先别用的
  (`[[wikilink]]`、`![[embed]]`、callout、行首 `#标签`、`%%注释%%`、块引用锚点、LaTeX)。
  分区适用:只管 `output/**` 与人写的 md,`input/converted/` 由转换脚本负责。
- 九个 `pm-*` 技能各加一句指向该节,不在技能里重复规范正文。
- 新增 `templates/pm-aispace/scripts/check_markdown.py`:校验闸,
  与既有 `check_questions.py` 同构,只读、只报告。
- 新增 `templates/pm-aispace/scripts/migrate_markdown.py`:存量工作空间迁移,
  **默认预演不落盘**,与既有 `migrate_questions.py` 同构。

**入口侧(阶段 1)**

- 新增 `templates/pm-aispace/scripts/web_ingest.py`:把一个网页转成干净 Markdown
  落进 `input/converted/`。正文提取用 `defuddle` CLI,**输入是本地渲染后的 HTML**:
  该 URL 已有 `visualization/references/<slug>/index.html` 就复用它,
  没有就用 `single-file` 抓一份到临时目录、用完即弃。
  落点、`_manifest_` 命名、溯源 front-matter 一律复用既有 `layout.py`,**不另起一套**。
- `pm-doc-ingest` 技能补充网页资料的处理路径。

**明确不做**

- 不动看板的 `src/app/components/Markdown.tsx` —— wikilink / callout 的
  remark 插件属于下一阶段,本 change 定的子集正是为了**不依赖**它。
- 不引入 `.base` / `.canvas` 这类 Obsidian 专属文件格式:看板扫描器不认,
  放进模板等于造一批只能在 Obsidian 里打开的死文件。
- 不迁 `input/converted/` 的存量产物 —— 那些由脚本生成,重跑即覆盖。
- 不引入需要常驻服务的抓取栈(Firecrawl 自建要四个常驻服务,
  而它最值钱的反爬与代理层恰恰是云端独有),也不做整站抓取 ——
  本变更的网页入口是**一次一页**,理由见 `design.md` 决策五。

## 需要人拍板:写入工作空间

本 change 新增的三个脚本都写工作空间,但**它们不是看板的写入**,
与只读红线不冲突 —— 这一点需要明确记录下来,避免后续被误引为先例:

- 三个脚本都住在 `templates/pm-aispace/scripts/`,即**工作空间自己的工具**,
  由用户或 agent 在工作空间里直接跑,看板服务端既不 `spawn` 也不调用它们。
- 其中 `web_ingest.py` 与既有 `ingest.py` 形态完全一致。将来若要让看板
  在界面上触发它,那是**另一件事**,要单独走 AGENTS.md 不变量 1 的窄例外评估,
  本 change 不预留、不顺手做。
- `migrate_markdown.py` 会改写既有 `output/**.md`,是本 change 里唯一
  **修改人类既有产物**的动作,因此强制默认预演、落盘需显式加参数。

## Capabilities

### New Capabilities

- `workspace-markdown-convention`: 工作空间 Markdown 写法规范本身 ——
  双向安全子集的具体条目、适用范围分区、校验闸与存量迁移的行为契约。
- `web-source-ingest`: 网页资料入口 —— URL 到 `input/converted/` 的落点、
  命名与溯源契约,以及 `defuddle` 不可用时的行为。

### Modified Capabilities

无。现有六份 spec 都是看板自身的能力(预览、扫描、转换、搜索),
本 change 的改动全部落在 `templates/`,不改看板任何既有行为。

## Impact

**平面**:只落 `templates/`(PM 工作空间模板)。
CLI(`bin/cli.mjs`)、服务端(`src/server/**`)、前端(`src/app/**`)**一律不动**,
`src/app/lib/api.ts` 契约不变,因此不需要考虑新老进程兼容。

**新增依赖**:`defuddle` CLI(`npm install -g defuddle`),供**工作空间的脚本**调用,
不进本仓 `package.json` 的任何一侧 —— 与既有 `ANYDOC_BIN` 的处理同理,
解析不到就明确报错并给出安装提示,不静默降级成抓原始 HTML。

网页入口还会用到 `single-file`,但它**不是新增依赖** ——
看板的参考采集(`src/server/capture.mjs`)本来就依赖它。
它是 AGPL-3.0,只能 spawn、永不 import,这条边界照旧。

**验收**:本 change 不改看板代码,`pnpm typecheck` / `pnpm build` 结果不应有变化;
真正的验证是在一个工作空间里跑通三个脚本,并在看板里点开迁移后的文档确认渲染正常。

**存量影响**:已注册的几个工作空间实例需要各自跑一次 `migrate_markdown.py`。
规模上真正要动的只有 `output/**` 的手写文档(数十份量级),
`input/converted/` 的产物不在迁移范围内。
