---
name: pm-doc-ingest
description: 把人类可读的项目资料（docx / PDF / xlsx / pptx / html 单文件原型 / 图片 / 网页 URL）批量转换成 AI 和 IDE 可读的 Markdown、CSV 或可预览 HTML 包，建立带溯源信息的资料台账，并对资料本身做一次可信度与缺口体检。只要用户说「把这些资料导进来」「我收到一批文档」「转换这个 docx / PDF / Excel」「整理项目资料」「资料都在 input 里了」「入库这个 HTML 原型」「把这个网页转成资料」「抓这个 URL 进 converted」，或者你发现 input/raw/ 下有文件还没转换、input/converted/ 是空的、用户丢来一个政策/标准/文档站链接要进分析链路，就使用这个技能。用户刚接手项目、刚拿到交接资料时，这是第一步。
---

# 资料入库

阶段一。目标不只是「格式转过去」，而是让后面的分析有一个**可信、可溯源、知道缺什么**的资料底座。

手写 Markdown 的写法（front-matter 形态、标题层级、文档间链接、哪些语法现在先别用）见工作空间 `AGENTS.md` 的「Markdown 写法」一节，这里不复述。

## 先转换

```bash
python3 scripts/ingest.py --dry-run   # 资料多或来源杂时，先看计划
python3 scripts/ingest.py             # 实际转换（幂等，只处理有变化的）
```

脚本按格式分派：

| 格式 | 产物 | 说明 |
| --- | --- | --- |
| docx / odt / rtf / epub | `.md` + 抽图 | **本地 anydoc** |
| **PDF** | `.md` | **本地 anydoc**（默认，不外发）。扫描件自动升级 MinerU OCR；要抽图 / 公式 / 复杂版式才 `--pdf-engine mineru` |
| **pptx** | `.md` + 抽图 | **MinerU 在线 API**；没配 key 时兜底本地 anydoc（不抽图） |
| **`.doc` / `.ppt`** | `.md` | **本地 anydoc**（老版二进制 Office，不抽图）。anydoc 不可用时才退回「请另存为」 |
| `.msg` | `.md` | markitdown（留着它的唯一理由） |
| xlsx / xlsm | 目录 + 各 sheet CSV + `_manifest.md` | 标准库 OOXML |
| **html / htm** | **目录 + 可预览 `.html` + `_manifest.md`** | **不转 md 正文**；校验后写配套说明 |
| md / txt 等纯文本 | 拷贝（txt→md） | — |
| 图片 | `input/assets/` | — |

产物写入 `input/converted/`，台账写入 `input/INDEX.md`。网页 URL 没有 raw 原件，走下面「网页资料」那一节，不经 `ingest.py`。

**产物落点镜像 `input/raw/`**（规则见 `AGENTS.md` 的「产物落点」一节、实现见 `scripts/layout.py`）：
一源一产物直接落在镜像目录，一源多产物的正文收进 `SplittingObject/<文件名>/`、
摘要 `_manifest_<文件名>.md` 留在镜像目录。**报告产物路径时按实际路径写，不要按 converted 根下平铺来说。**

### HTML 单文件原型（重要）

`.html` / `.htm` 在本工作空间里是 **PM 之间传递可点击原型的载体**，不是「再转一版 Markdown」的文档：

- **不要**期望转换脚本把页面交互转成可读需求正文；交互以 HTML 预览为准。
- 转换结果是「摘要 + 正文目录」，例如 `input/raw/SC-02_发电计划原型.html` →
  - `input/converted/_manifest_SC-02_发电计划原型.md` — 溯源 frontmatter + 体积/编码 +
    **可访问性与安全校验表** + 标题结构线索
  - `input/converted/SplittingObject/SC-02_发电计划原型/*.html` — 可直接预览
    （看板输入区按网页打开；本地也可双击）
- AI 默认读 `_manifest_<名>.md` 做台账与摘要；需要点评交互时再结合预览，**不要把整页 HTML 当 PRD 正文抄进去**。
- 正式、可维护的多页原型仍走阶段四 `visualization/prototypes/`（Axhub Make）；raw 里的 HTML 只是输入资料。

## 网页资料

政策文件、公开标准、友商文档站这类**网页**，不要去 `visualization/references/` 采集来充分析输入——
那是给人看的页面快照。要进分析链路、能被溯源引用的文本，走 `scripts/web_ingest.py`，两条入口：

```bash
python3 scripts/web_ingest.py <URL>     # 公开 URL
python3 scripts/web_ingest.py --inbox   # 丢进 visualization/references/ 根上的散装页面
```

- **公开 URL** 走 URL 模式：已有参考就复用那份 `index.html`，没有就临时抓一次、用完即弃。这条路径**不往 `visualization/` 写任何文件**。
- **浏览器另存 / 剪藏 / SingleFile 丢进来的散装 `.html`** 走 `--inbox`：先收成标准参考目录，再抽出 Markdown。看板参考 tab 的刷新按钮调的就是这一条；不要把这类文件丢进 `scripts/ingest.py`（那条路把 HTML 当原型包，不抽正文）。

产物落 `input/converted/web/<host>/`，落点规则与 docx / PDF 相同（`scripts/layout.py`），
front-matter 用 URL（或读不到地址时用参考路径）充当 `source`、用抽出正文的摘要充当 `source_sha256`。

**和看板「采集为参考」怎么分：**

| | `web_ingest.py` | 看板采集为参考 |
| --- | --- | --- |
| 产物 | `input/converted/` 下的 Markdown | `visualization/references/<slug>/index.html` |
| 用途 | 给 AI 分析、被溯源引用的**可分析文本** | 给人看的**页面快照** |
| HTML 从哪来 | URL 模式：已有参考就复用；没有就临时抓。收件箱模式：工作空间里已经存在的本地 HTML | 看板 spawn `single-file` 写入参考目录 |

已经采集成参考的页面，再跑 URL 模式 **不会重新抓网**；收件箱会给还没有 Markdown 的参考目录补抽。
front-matter 里会记一条 `reference:` 指回参考目录。

缺 `defuddle`，或 URL 模式需要抓页却缺 `single-file`，会明确失败并打印安装命令，不降级成「随便抓一份 HTML」。
写法规范见工作空间 `AGENTS.md` 的「Markdown 写法」，这里不复述。

同一 URL 重跑且正文没变会跳过；正文已变时不静默覆盖（旧产物可能已被分析引用），
要覆盖加 `--overwrite`，要另存加 `--as-new`。

看脚本输出，这些情况必须处理，不要转完就当资料齐了：

- `⚠ 需另存为 .xxx` — 只剩 `.wps` / `.et` / `.dps`（金山私有格式）会必然走到这里。
  **告诉用户具体哪几个文件需要另存为新格式**，不要跳过不说。
  日志写「本地 anydoc 不可用」时是另一回事：`.doc` / `.ppt` 本来能转，是 anydoc 没装上，
  该修的是环境（见下面「找不到 anydoc」那条），不该让用户去手工另存为。
- `✗ 转换失败` / `✗ MinerU 失败` — 文件可能损坏、加密、超限，或 token 有问题。同样要报给用户。
- 产物 frontmatter 里有 `warning` — 文档类几乎是扫描件没抽出文字；**HTML 类则是校验失败或有告警**
  （打不开、外链脚本、缺 title 等）。要打开对应 `_manifest.md` 的校验表告诉用户，
  不能假装「已经能当可靠原型用了」。
- `⚠ 扫描件需 OCR` — 本地 anydoc 抽不出文字。没配 MinerU key 时台账记警告、退出码仍是 0；
  配了 key 会自动走 MinerU OCR。告诉用户这一点，不要当成转换失败。
- `⚠ 找不到本地 anydoc：PDF / PPTX 将上传到 MinerU 解析` — **这条最要紧，不要一带而过。**
  你在终端里跑 `scripts/ingest.py` 时没有看板注入 `ANYDOC_BIN`，脚本只能找 PATH；
  找不到、而 `.env` 里又配了 MinerU key，PDF 就会被传出去 —— 「默认不外发」这条保证
  在这条路径上是不成立的。看到它先停下来告诉用户，**别默认继续转涉密资料**。
  按顺序试：
  1. **起一次看板**（`npx -y @startist/aispace-kanban@latest`）。它会把自带 anydoc 的位置
     记进 `~/.pmwork/dashboard/runtime.json`，脚本自己会去读 —— 用户不用配任何东西。
  2. 还不行就 `npm i -g @firecrawl/anydoc`，让 `anydoc` 进 PATH。
  3. 特殊机器 / CI：在工作空间 `.env` 里钉死 `ANYDOC_BIN=<cli.js 路径>`（见 `.env.example`）。

  **不要建议用 npx 跑 anydoc 本身**（首次会联网下载，正好把要解决的问题请回来）。
- 提示「`.doc` / `.ppt` 要靠本地 anydoc 才能转」 — 同一个原因，同样按上面三步修。
  MinerU 不收这两个格式，所以这里没有在线兜底，装不上就只能请用户另存为。

## PDF 引擎阶梯

**默认不外发文件**，只有显式走 MinerU（或扫描件自动升级）才会上传。
这是这条链路对用户最重要的一句话 —— 但它有个前提：**本地 anydoc 得真的找得到**。
从看板点「转换」一定满足（看板注入 `ANYDOC_BIN`）；你在终端里自己跑则未必，
见上面「找不到本地 anydoc」那条。

```
PDF   ① anydoc（默认，本地，不联网）
      ② anydoc 报扫描件 → 配了 key 就自动升级 MinerU OCR；没配就记警告
      ③ --pdf-engine mineru → 直接走 MinerU（要抽图、要公式、版式复杂时）
PPTX  维持 MinerU；没 key 时兜底 anydoc
.msg  继续 markitdown
```

几个需要你判断的情况：

- **扫描版 PDF** → 默认就会自动升级；也可以加 `--ocr --force` 重跑：`python3 scripts/ingest.py --ocr --force`
- **要抽图、要公式、版式特别复杂**（多栏、跨页大表、图文混排还原乱） → `--pdf-engine mineru`，复杂版式再加 `--model-version vlm`
- **资料涉密** → 默认的 anydoc 就是本地处理，不用再加开关。**只有 `--pdf-engine mineru` 或扫描件升级才会把文件上传到 MinerU 服务器**。
  但**先确认脚本开头没有喊「找不到本地 anydoc」** —— 喊了就说明这轮会走 MinerU，
  此时「默认不外发」不成立，先修环境再转，不要凭这句话打包票。
  看到明显涉密标注（"机密""内部""涉密"）的 PDF，主动提醒用户：默认不会外发；
  如果 TA 要抽图或 OCR，让 TA 决定要不要走 MinerU，不要默默传上去。
- **鉴权失败 / 超配额** → 免费额度 1000 页/天。报清楚原因，别反复重试撞频控。

MinerU 单文件上限 200MB / 200 页，超限脚本在上传前就会拦住并说明。anydoc 没有这个页数上限。

## 再体检

转换完成后通读一遍产物，然后在 `input/INDEX.md` 的「人工批注」区填三件事。
这一步是资料入库真正的价值所在——它决定后面的分析建立在什么地基上。

**权威版本**：同一主题有多份资料时，指明以哪份为准。
接手项目时最常见的坑是拿到三份内容互相矛盾的「需求文档」，谁都没说哪份有效。
判断线索：文件名里的版本号、文档内的修订记录、日期、是否有评审签字页。
判断不了就写「待确认」并列入待澄清问题——**不要自己挑一份当权威版本**。

**资料缺口**：对照项目类型想一遍「按理应该有但没收到」的东西。
一个能正常运转的项目通常应该有需求文档、接口说明、数据字典或表结构、
测试用例或验收标准、部署与环境说明、历史缺陷记录。缺哪类就写下来。
缺口清单是你向对方团队要资料的依据，越早提越好。

**待澄清问题**：资料里明显讲不通、前后矛盾、或者关键地方一笔带过的，逐条记下来。
台账里这份是给**资料本身**用的；同一批问题还要落一份到问题清单，那是给**分析阶段**用的。

### 发现未决问题怎么落

**走 [`pm-open-questions`](../pm-open-questions/SKILL.md)，不要自己发明格式。**
先看一眼 `output/`：

- 有 `output/questions/` 目录 → **一问一文件**，新建 `output/questions/Q<四位编号>.md`（编号取当前最大加一；**目录空不等于从 Q0001 起**，先查 git 历史用过的最大编号）
- 只有 `output/analysis/open-questions.md` → 旧工作空间，照旧往表格里追加，**不要擅自迁移结构**

新结构下每条必须填 `source`（触发这条问题的文档路径）与 `context`
（触发时在做什么，一句话）—— 溯源锚点挂在**条目**上，不挂在分节上。
`blocks` 填它阻塞的在途交付物，判断不了就写 `backlog`，不要瞎填。
`evidence` 与 `ai_*` 刚提问时留空；**查不到依据只能写 `我方推断`，且不能置 `answered`**。

**双通道：正文归正文，问题归问题。** 分析结论写进文档，延伸出的未决问题写进问题文件，
**两边不许互串** —— 文档里不再放「待确认问题」表格（要提就写一句「见 `questions/Q0134`」），
问题条目里也不抄分析正文。同一条问题两处存在，很快就会对不上。


## 汇报给用户

用户是 PM，关心的不是「转了几个文件」，而是「我手上的资料够不够开始干活」。所以这样汇报：

1. 资料构成：几份需求类、几份技术类、几份数据类、**几份 HTML 原型**，覆盖了项目的哪些部分
2. 明确的障碍：哪几个文件需要用户处理（老格式、扫描件、损坏、加密、**HTML 校验告警**）
3. 版本风险：有没有互相矛盾的多份资料；HTML 原型与文字需求是否明显对不上
4. 缺口：按理该有但没有的资料，按重要性排序
5. 下一步建议：资料够了就进 `pm-project-handover` 摸现状基线；不够就先去要资料

不要罗列每个文件的转换结果——台账里有，用户需要的是判断。
有 HTML 原型时，用一句话点明「可在看板/目录里直接预览」，并点出校验表里最严重的 1–2 条告警即可。

## 增量资料

对方后续补发资料是常态。直接把新文件丢进 `input/raw/` 重跑脚本即可，
没变化的文件会跳过。重点是判断新资料**是否推翻了已有结论**：

- 新版本覆盖了旧文档 → 更新台账的权威版本批注，并检查 `output/` 里受影响的分析和文档
- 回答了某个待澄清问题 → **走 [`pm-open-questions`](../pm-open-questions/SKILL.md) 关掉它**，
  不要只是划掉编号：关的时候要填 `evidence`（凭什么关的）与 `flows_to`（结论该回流到哪份正文）。
  查不到依据就只能写 `我方推断`，**那种情况下不能关**
- 与既有结论冲突 → 这是重要发现，明确告诉用户哪些已完成的分析需要返工
