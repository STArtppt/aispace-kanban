## Context

- **原型已跑通**：`spike-docx-template/`（未提交）有两个标准库脚本。`collect.py` 负责采集：计算每个段落实际生效的格式，报告脱敏；
  它也可以拿来反查生成的文档格式对不对。`build_template.py` 负责生成：清洗、按「通用规范 + 客户 profile」重建样式、补齐通用角色、输出 reference.docx。
  另有通用规范 `base-spec.json` 和合成样张 `sample.md`。
  用一份真实客户需求文档实测（细节只留在本地私有目录）：179 个样式里只有 19 个有效，43 套编号只用了 1 套；
  标题样式定义写 22 / 16pt，实际全部被手动设成 14pt；正文 100% 是手动格式；有两种行距、三种表格边框。
  生成的样张用 LibreOffice 渲染后，标题编号、表格、题注、代码块、提示框、脚注、客户页眉页脚都正确。
- **原型阶段踩过的坑**（实现时要保住）：`beforeLines` 优先于 `before`；显式字体要压掉继承来的主题字体；
  字体、字号、行距要写在 docDefaults，表格样式的字号才能生效；原文有同名样式时要沿用它的 styleId；
  `ET.tostring` 会改写命名空间前缀，不能在它的输出上做字符串匹配。
- **入口已就位**：`workbench-module-hub`（已实现、未归档）搭好了工作台浏览页和「模版洗炼」页。
  四步流程是演示，模板列表只读 `output/docx-template/`。它的 Open Questions 里把「spawn 脚本、上传落点、写模板目录」留给了本 change。
- **现有同类机制**：资料转换（`startIngest`，任务态、异步）和一次归档（`runArchive`，同步等待、带超时）都是「看板只 spawn，工作空间脚本写盘」；
  Python 解释器由 `platform.mjs` 的 `findPython` 查找。PDF 预览不改扫描契约：扫描仍标 `external`，由 `Reader.tsx` 按扩展名识别后用 iframe 直出。
- **系统依赖现状**：`rich-doc-convert` 当初专门去掉了 pandoc（docx → md 改用自带的 anydoc）；反方向的 md → docx 目前没有任何实现。

## Goals / Non-Goals

**Goals:**

- 一份客户旧 Word 经过工作台四步，得到 `output/docx-template/<模板名>/` 下的完整模板包，并能直接预览样张。
- 产出文档的任何 `.md` 能按选中的模板转成同目录的 `.docx`：看板里点一下就能转，也能复制提示词交给工作空间 AI。
- 看板里直接预览 `.docx`，用来核对成品和样张。
- 终端、工作空间 AI、看板三条触发路径跑的是同一份脚本，产物一致。

**Non-Goals:**

- 不做上传：来源文档必须先放进 `input/raw/`。
- 不生成 `cover.docx`，也不做封面的整节搬运（留给后续）。
- 不依赖 LibreOffice，也不在看板里做「刷新域」（目录、页码、SEQ 编号由用户在 Word 里更新）。
- 不做高保真的服务端渲染预览（如 LibreOffice 转 PDF）。
- 不把工具链改写成 Node，不引入 python-docx、PyYAML 这类第三方 Python 包。

## Decisions

### D1 · 写入走 spawn 一族，新开第九条窄例外

采集、生成、转换都由工作空间脚本写盘，看板只 spawn，同步等待，带超时。边界照 proposal 的六款写进 AGENTS.md 不变量 1。

- 备选 A：看板服务端直接写（像第四、六、八条那样）。**不选**：那几条是高频小写入，而且没有脚本能承接；
  这里是解析 OOXML、跑 pandoc 的重活，终端和工作空间 AI 也要能跑同一份逻辑，天然该放在工作空间脚本里。
- 备选 B：工具链放在看板自己的包里，以工作空间为 cwd 去 spawn。好处是旧工作空间不用补脚本。**不选**：工作空间 AI 走「复制提示词」那条路时，
  需要一个工作空间内稳定可见的脚本路径；而且脚本会跟着看板版本变，同一个工作空间的产物会因为看板升级而漂移。与 `ingest.py` 保持同一种做法。

### D2 · 用不透明键 `docKey` 指定文件，不收路径

扫描时，对产出三组里的 `.md` 和 `input/raw/` 里的 `.docx`，取相对路径的 SHA-256 前 16 位十六进制，作为可选字段 `docKey` 下发。
写接口只收 `docKey`：服务端重新扫描，在同类条目里反查出路径，查不到就 400，然后过 `resolveInside()` 交给脚本。

- 备选 A：收路径，但校验它必须在扫描清单里。**不选**：第七条第 ④ 款已经写明不接受「带路径但我们会校验」这种开法；
  这句话本身没有例外，才是它的价值所在。
- 备选 B：沿用第七条的「组名 + 基名」。**不选**：产出文档常在组内子目录里（如 `docs/方案/总体设计.md`），基名不能唯一定位。
- 备选 C：给每个文件发一个服务端内存里的临时 id。**不选**：服务一重启 id 就全部失效，还要再维护一张表；用路径摘要做键是确定的，不需要任何状态。

### D3 · 工具链只用 Python 标准库，规范用 JSON

原型已经证明 `zipfile` 加 `xml.etree` 就够用。通用规范 `base-spec.json` 与客户 `profile.json` 都用 JSON。

- 备选：python-docx / PyYAML。**不选**：工作空间只保证有 Python 3，装包在 Windows 上最容易出问题；python-docx 也读不到 `w:eastAsia` 字体、表格样式层叠这些关键信息，最后还是要直接操作 XML。
- YAML 更好读，但为了它引入 PyYAML 不划算。`profile.json` 由脚本生成、界面编辑，人很少直接改。

### D4 · pandoc 作为系统依赖，查找顺序与 anydoc 同构

`md2docx.py` 查找 pandoc 的顺序是 `PANDOC_BIN` → 工作空间 `.env` → `PATH`，并要求版本 ≥ 3。
服务端在 `platform.mjs` 实现同一查找顺序，`/api/health` 增加可选字段 `docxTools: { python, pandoc, pandocVersion }`；
缺失时「直接转换」置灰，「复制提示词」照常可用。生成模板里的样张转换同样需要 pandoc：缺失时模板照样生成，只是跳过样张，结果里给出 warning。

- 备选 A：自己写 docx writer（Node 的 docx.js 或 Python 手写 OOXML）。**不选**：样式继承、列表、脚注、代码高亮、图片、表格对齐这些 pandoc 都已经处理好，自己重写要好几周，质量也追不上。
- 备选 B：随看板打包 pandoc 二进制。**不选**：三平台加起来一百多 MB，npm 包会翻好几倍。
- 与 `rich-doc-convert` 的关系：那边去掉 pandoc 是因为 anydoc 能替代它；这边没有替代品，所以明确声明为可选的系统依赖，只影响「直接转换」这一项。

### D5 · 预览用 docx-preview，放进无脚本权限的隔离 iframe

阅读器识别到 `.docx` 后，以 `ArrayBuffer` 取回 `/file`，动态 `import('docx-preview')`，渲染进一个
`sandbox="allow-same-origin"`（不含 `allow-scripts`）的 iframe 的 body 里。纸张保持白色，外框跟随看板主题。

- 备选 A：mammoth（docx → 语义 HTML）。**不选**：它有意丢掉版式（字号、缩进、页面、页眉页脚），而预览的主要用途恰恰是核对模板版式。
- 备选 B：服务端调 LibreOffice 转 PDF，再复用 PDF 预览。保真度最高，**但不选**：它依赖一个可选的系统软件，转一份要几秒，
  而且 PDF 要落盘缓存，无论放工作空间还是 `~/.pmwork/` 都是新的写入决策。可以留作以后的「高保真预览」开关。
- 备选 C：Office 在线查看器。**不选**：需要把文件放到公网 URL 上，等于外发客户资料。
- 为什么要 iframe：docx-preview 会向文档注入全局 `<style>`，直接渲染会污染看板样式和深色模式；
  sandbox 不带 `allow-scripts`，文档里的 `javascript:` 链接也执行不了。看板以同源身份把渲染结果写进 iframe，不需要 iframe 自己跑脚本。
- 体积：docx-preview 和它依赖的 jszip 一共约 200KB，只在第一次打开 `.docx` 时加载。

### D6 · 同步 spawn + 超时，不做任务态

采集超时 60 秒，生成超时 120 秒（包括样张转换），转换超时 120 秒。照 `runArchive` 的写法收集 stdout，解析最后一行 JSON。
服务端按「模板名」和「目标 `.docx`」各维护一个内存里的进行中集合：同一目标的请求在前一个没结束时，直接返回 409。

- 备选：照 `startIngest` 做成任务态加轮询。**不选**：实测单份文档是秒级，配一套任务表和轮询只是在复制代码；以后真遇到超大文档，再单独升级。

### D7 · 用户决定经 stdin 传给脚本，由脚本生成 profile

第 ②③ 步的决定序列化成 JSON，内容包括：簇到角色的映射、合并、丢弃，层级到角色的映射，伪标题的去向，以及冲突值的取舍。
服务端只检查两件事：大小不超过 256KB；键名里没有 `path`、`file`、`dir` 之类的路径字段。
`docx_template.py build` 负责校验结构，并把决定和采集报告合成 `profile.json`，每项都带 `_src`。
这样终端和工作空间 AI 也能提供同一份决定文件（`--decisions <文件>` 或 stdin），走同一段逻辑。

- 备选：前端直接算好 `profile.json` 交给服务端写。**不选**：那样服务端就得直接写工作空间，而且 profile 的推导逻辑会在 TS 和 Python 里各写一份。

### D8 · 覆盖只认生成标记

工具链写出的每一份 `.docx`，都在 `docProps/custom.xml` 里带 `aispace-docx-generator=<版本>`。
目标文件已存在时，只有带这个标记的文件才可以在用户确认后覆盖。没有标记的一律 409：它可能是人在 Word 里改过、另存成同名的，
也可能是客户给的原件。覆盖时先写临时文件再原子替换。

- 备选 A：永不覆盖，改为加时间后缀。**不选**：反复转换会堆出一串 `a-20260929-1.docx`，用户要自己清理。
- 备选 B：只要用户确认就覆盖。**不选**：人在 Word 里改过的成品一旦被误覆盖就找不回来；有了标记，这类误操作在技术上就挡住了。
- 已知漏洞：用户在 Word 里打开成品、修改后按原名保存，标记依然在。弹窗的确认文案要写明「会丢掉你在 Word 里做的修改」。

### D9 · 后处理范围只做确定性修补

`md2docx.py` 在 pandoc 之后只做四件事：写生成标记、把表格首行设为跨页重复的表头、把题注里的手写编号换成 SEQ 域、把 `title` 渲染成 `Title` 首段。
表格列宽、封面合并、TOC 注入都不在本期范围内。

- 备选：一次做全（列宽按内容比例分配、封面、TOC）。**不选**：每一项都需要按客户单独调参；先把主链路做成稳定可用，再按实际反馈逐项加。

### D10 · spike 退场，回归语料用合成件

脚本迁到 `templates/pm-aispace/scripts/` 后，删除 `spike-docx-template/`。它 README 里的结论和踩坑，挪到 `scripts/docxkit/README.md`（写给维护者）和本 design。
`fixtures/docx-template/make_messy_docx.py` 用标准库生成一份「格式很乱」的合成旧文档；`scripts/check-docx.mjs` 在临时目录里跑完采集、生成、转换、反查，由 `pnpm test:docx` 调用。
pandoc 缺失时，只跳过转换这一段，并在输出里说明，不算失败。

- 备选：把真实客户文档脱敏后入库。**不选**：版式本身（页眉 logo、单位名称）就是客户材料，脱不干净。

## Risks / Trade-offs

- **docx-preview 与 Word 的渲染差异**（域不刷新、浮动对象位置、分页点不同）→ 预览区底部常驻说明，保留「用系统应用打开」；样张的格式正确性以脚本反查为准，不以预览观感为准。
- **老工作空间没有新脚本** → 接口 400 并说明出路；「复制提示词」里附上补齐脚本的说明。看板不替用户复制脚本，否则就是在写工作空间。
- **模板脚本随看板版本升级，旧工作空间的副本会落后** → 生成标记里带版本号；`--json` 结果里带 `toolVersion`，界面在版本落后时提示（只提示，不自动升级）。
- **pandoc 版本差异导致样式名变化**（例如 3.x 之间题注样式改名）→ 要求 ≥ 3，反查会暴露「用到但未定义的样式」并写进 warnings；`test:docx` 固定跑一遍。
- **Windows 上 Python 的 stdout 编码**导致中文报告乱码 → 入口脚本启动时强制 stdout、stderr 为 UTF-8；看板按 UTF-8 解码。
- **大文档**：几百页的旧 Word 采集可能超过 60 秒 → 超时返回 500 并说明，建议改在终端里跑同一条命令；实测数据出来之前不调大超时。
- **客户资料外泄**：`output/docx-template/` 含客户版式 → README 与复制提示词都写明不外传；反馈单模板规则本来就要求使用合成内容；采集报告不含正文。

## Migration Plan

1. **先归档 `workbench-module-hub`**，让 `docx-template-refine` 和 `workbench-module-hub` 进入 `openspec/specs/`，本 change 的 MODIFIED / REMOVED 才有对象可以作用。
2. 模板和看板同一版本发布。新建的工作空间直接带工具链；已有工作空间看到「缺脚本」提示后，由用户或工作空间 AI 从模板复制 `scripts/docx_template.py`、`scripts/md2docx.py`、`scripts/docxkit/`。
3. 回滚：删掉三个写接口和菜单项即可。工作空间里已经生成的 `.docx` 和模板目录都是普通文件，不受影响。

## Open Questions

- `cover.docx`：客户封面常用浮动文本框，需要整节原样搬运，作为受保护区域；另开 change。
- 上传：如果以后要支持，需要决定落点（`input/raw/` 下的专用子目录），并在第九条之外再开一款写入。
- 是否提供「高保真预览」（LibreOffice 转 PDF）：等 docx-preview 的差异在实际使用中是否构成问题再定。
