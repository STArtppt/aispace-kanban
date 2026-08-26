## Context

现在 `ingest.py` 的引擎分派长这样：

| 扩展名 | 引擎 | 图片 |
|---|---|---|
| `.pdf` | anydoc → MinerU 兜底 | MinerU 出图 |
| `.pptx` | anydoc | 无 |
| `.doc` `.ppt` | anydoc → 提示另存为 | 无 |
| **`.docx` `.odt` `.rtf` `.epub`** | **pandoc（硬依赖，没装就断流）** | `--extract-media` 出图 |

只剩最后这一行还挂着系统依赖。本轮调研把能替 pandoc 的开源件都实测了一遍（数据均来自本机实测：
anydoc 0.2.3、pandoc 3.9 本机 / 3.10 wasm、officeparser 7.8.0；语料为工作空间 `input/raw/` 下
6 份真实 docx 加 4 个自造合成件），结论是**候选里没有一个能直接顶上**：

- **anydoc CLI 直接换**：四种格式都能转，结构比 pandoc 干净（odt 不带 `<span id="anchor">` 噪音、
  epub 不满屏 `<div class="section level2">`、Word 自动编号能保住），但**图片全丢** ——
  一份 14 张图的 PRD，pandoc 抽出 14 张、anydoc CLI 抽出 0 张，正文里只剩裸的 alt 文本，
  且 alt 有空的、有重复的、有 `source.kind === "unavailable"` 的，**没有可靠锚点回填 `![]()`**。
- **`officeparser` 7.8.0**（MIT，覆盖四格式，图片位置比 pandoc 还准）：在真实中文文档上**标题全丢** ——
  6 份 docx 无一幸免，识别到 0 个标题。根因是这些文档由 WPS 导出、`w:styleId` 是纯数字，
  它按样式名匹配全 miss；RTF 中文还会炸成问号（`\uN` 后的 ANSI 兜底字符没吞掉）。
  外加 127MB `node_modules`（其中 tesseract + pdfjs 我们都用不上）。出局。
- **`docling.rs`**：只发布 linux 与 win32 构建，**没有 darwin**，本机装不上。出局。
- **某个 GitHub 上的 docx 图片抽取小工具**：只覆盖 `.docx`（四格式解决四分之一）、**无 LICENSE**
  （默认版权全保留，不能合法 vendored）、依赖 `python-docx` + `Pillow`（违反 `ingest.py`
  "零 Python 依赖"原则）。读源码还发现两个真 bug：图片位置索引用 `.//w:p` 建、插入时循环
  `doc.paragraphs`，两者在有表格的文档上差两倍多（实测 289 vs 134），越界的静默丢弃；
  表格统一在段落循环之后 append，全部脱离原位置堆到文末。出局。
- **`pandoc-wasm` 1.1.0**（内置官方 pandoc 3.10）：唯一零质量风险的路 —— 输出与本机 pandoc
  除 media 路径前缀外逐字节一致，`extract-media` 正常。但**包体积 +56MB**、
  **冷启 0.66s/文件**（anydoc 是 0.02s）、**`pandoc.wasm` 本体是 GPL-2.0-or-later**。
  用户明确要"彻底摘掉"，这两根刺留着不算摘干净，所以本方案不选它 —— 但把它留作退路（见 Decision 1）。

而 anydoc 的解析结果在本仓语料上**优于** pandoc：那份 WPS 导出的 PRD，pandoc 认出 19 个标题、
anydoc 认出 20 个，且保住了 Word 自动编号（`# 3 详细功能需求` vs pandoc 的 `# 详细功能需求`）。
字节和位置都在 `Document` 里，是 anydoc 自带的 Rust Writer 在渲染时扔掉的，而包的导出面是死的：

```
toDocument()      → AST，不带 writer
toMarkdown()      → 成品字符串，图已丢
```

两者中间没有接口，Writer 不导出也不给 hook。所以只能整段重写 Writer —— **但也仅此一段，
Reader 一行不碰**。这就是本方案的全部含义。

## Goals / Non-Goals

**Goals:**

- `.docx` `.odt` `.rtf` `.epub` 四种格式转 Markdown **不再需要任何系统依赖**，
  零配置的用户把文件丢进 `input/raw/` 就能转出带图的产物。
- **抽图不退步**：抽出的图片数必须与 pandoc `--extract-media` 相等，这是硬指标。
- **标题结构不退步**：标题数 ≥ pandoc 基线（预期会更高，这是走 anydoc Reader 的正收益）。
- 定死一个**引擎无关的 Python 调用契约**，让整条路随时可以换引擎而不惊动上层。

**Non-Goals:**

- **不碰解析**。不自己读 OOXML / ODF / RTF 控制字 / EPUB 容器，那是几万行、要靠年头喂脏文档
  才磨得出来的东西。
- **不追求与 pandoc 逐字节一致**。要那个就该选 pandoc-wasm，本方案的取舍恰恰是放弃它换来
  零体积零 GPL。
- **不动 PDF / PPT 链路**，不动 `api.ts` 契约，不动前端。
- **不自动重转已有产物**。老产物留在原地，用户手动重转才会看到新格式。

## Decisions

### 决策 1：先定 Python 侧接缝，再写 Writer

```python
# templates/pm-aispace/scripts/anydoc.py 新增，与现有 to_markdown() 并列
def to_markdown_with_assets(
    src: Path,          # 源文件
    assets_dir: Path,   # 图片落盘目录（绝对路径，由 ingest.py 算好）
    link_prefix: str,   # 正文里图片链接的前缀，已过 layout.md_link() 转义
) -> str:               # → Markdown 正文（不含 frontmatter）
```

实现复用 `anydoc.py` 里现成的 `find_bin()` 四级查找链（`ANYDOC_BIN` → 工作空间 `.env` →
`runtime.json` → PATH）、`_argv()` 的 node 解析、`_run()` 的 UTF-8 强制，只把 argv 换成：

```
node scripts/anydoc_writer.mjs <src> \
  --anydoc-module <从 find_bin() 推出的 index.js 路径> \
  --assets-dir <绝对路径> --link-prefix <转义过的相对前缀>
# stdout = Markdown 正文；stderr = 诊断
# exit 0 成功 / 1 转换失败（映射 anydoc 的 ConvertErrorCode）/ 2 用法错
```

**为什么这条要排在最前**：Writer 万一做砸了（或者哪天 anydoc 升级把模型改了），
把这个函数体原地换成 pandoc-wasm 就行，`ingest.py` 及以上完全无感。
**顺序反了退路就没了** —— 先写 Writer 再想接缝，接缝一定会长成 Writer 的形状。

*备选*：让 Writer 直接吐 JSON 回 Python、Python 侧落盘。**不选** —— 一份 14 张图的 PRD
转成 data URI 是 11.8MB（拿 officeparser 实测的），走管道等于把图片在内存里复制两遍。
Writer 直接写文件、正文只留路径，Python 侧沿用 `convert_pandoc()` 的做法数文件个数填
frontmatter 的 `extracted_images`。

*已验证*：helper **不需要自己装** `@firecrawl/anydoc`。`runtime.json` 里 `anydocBin` 指向 `cli.js`，
同目录 `index.js` 就是 API 入口，`import(pathToFileURL(...))` 侧载在任意 cwd 下都成功 ——
看板注入和终端直跑共用同一个二进制，与现在行为一致。

### 决策 2：表格跨行列 —— 留空，`--span=fill` 留作开关

GFM 表格没有 rowspan / colspan。anydoc 把跨格表达成 `covered` 槽回指 origin，必须选一种拍平方式。
真实语料里 `covered` 格有 **2091 个**，选错影响面很大。

**选留空**（与 pandoc 一致）。*备选*：把 origin 内容复制进每个被覆盖格 —— **不选**，
2091 个格子翻倍会让 AI 做需求分析时把同一条统计两遍，这是实打实的后果，比留空丢一点冗余更糟。
*备选*：整表退回 HTML `<table>` —— **不选**，那正是本仓 `Markdown.tsx` 要挂 `rehype-raw` 的
历史包袱，好不容易借这次换引擎甩掉，不该自己再造一份。

保留 `--span=fill` 开关，P2 阶段拿真实文档两种都跑一遍再把默认值定死。

### 决策 3：复合编号（`markerLabel`）—— 整个 list 降级成缩进段落

源文档里 `1-a)`、`（3）` 这类编号，GFM 有序列表的 `1.` 表达不出来。真实语料里有 **448 处**。

**选**：某个 list 只要出现 `markerLabel`，整个 list 降级成带缩进的段落序列，label 原样写在行首
并转义，防止被 Markdown 重新解析成列表。没有 label 的列表正常走 `-` / `1.`。

*备选*：像 pandoc 那样把编号转义成普通文本（`1\. 第一`）—— **不选**，pandoc 那个做法是
逐项转义、列表语义整个丢掉且视觉上还乱；我们至少能保住缩进层级。
*备选*：忽略 label 直接用 `1.` —— **不选**，源文档的编号常常是被正文引用的（"见 3.1-a"），
改掉编号等于制造错误交叉引用。

### 决策 4：Writer 对未知 kind 走 fallback，不抛错

anydoc 是 0.x，`Document` 模型无语义化保证。`BlockKind` / `InlineKind` 各 8 种，
真实语料里 `math` / `codeBlock` / `checkbox` 一次都没出现 —— 这三种先落降级实现（原样吐文本），
不影响上线。将来 anydoc 加了新 kind，Writer 吐纯文本而不是崩，**宁可少格式也不能断流**。
配套：`package.json` 里 pin 住 anydoc 版本。

### 决策 5：转义边界

- 正文里裸露的 `* _ [ ] < > \`、行首的 `# - +` 和"数字+点"要转义。
- 表格单元格里的 `|` 要转义，换行必须转 `<br>`。
- `code` 样式内部**反过来** —— 不转义，包反引号，并处理内容自带反引号的情况。
- **图片路径里的空格和括号直接复用 `layout.py` 的 `md_link()`，不要重写。**

这块最容易出隐蔽 bug，所以验证闸里专门有一条"裸 HTML 残留计数为 0"。

## Risks / Trade-offs

- **表格 span 降级选错** → 采购规范类文档读起来就废，2091 个格子的数据被读重或读丢。
  *缓解*：做成开关，真实文档两种都跑，P2 结束前定死。
- **anydoc 0.x 模型无语义化保证，升级后 Writer 崩或静默丢内容** →
  *缓解*：未知 kind 走 fallback 吐纯文本而非抛错（决策 4）；pin 版本；
  验证脚本连同**合成语料**一起提交当回归基线（真实语料不入库，脱敏红线）。
- **渲染质量长期由我们自己扛** → 这是与 pandoc-wasm 最本质的差别，**不可消除**。
  *缓解*：接缝（决策 1）就是为这一刻留的 —— 哪天扛不动了，换函数体即可。
- **产物格式与 pandoc 时代不一致** → 用户重转会看到 diff。
  *缓解*：不自动重转；frontmatter 的 `tool` 字段会如实写成 `anydoc <版本> writer`，
  一眼能看出是哪个引擎出的。
- **Token / 工期超预算** → 按 **400K 立预算、600K 划止损线**（顺利 200–280K / 2.5h，
  现实 350–500K / 3–4h，折人工 1.5–2 人日）。**P1 结束就有可判断的实物**，
  那时质量明显不如 pandoc 就止损，沉没成本只有 60–90K，接缝已定，换 pandoc-wasm 只改一个函数体。

## Migration Plan

分四阶段，每阶段都可停可验：

| 阶段 | 做什么 | 停下来能验证什么 |
|---|---|---|
| **P1** | helper 骨架 + 侧载 + 图片落盘 + block/inline 主干 | 四个合成件转出正文与图，肉眼比对 |
| **P2** | 表格 + 列表 + 转义（三个硬决策落地成开关） | 6 份真实 docx 跑通不报错，标题数追平或超过 pandoc |
| **P3** | 三方回归对比（pandoc / anydoc CLI / 自研 Writer），逐项修 diff，开关定死 | 下方验证闸全绿 |
| **P4** | Python 侧接线 + 服务端 + 文档去 pandoc + 验收闸 | `pnpm typecheck` / `pnpm build` 绿，重启后浏览器点一遍 |

**验证闸**（本仓 `verification-before-completion` 要求"没有刚跑出来的证据不许下完成结论"，
而 `src/server/**` 和转换脚本都没有静态检查，所以验证是脚本化的三方并排，不是看一眼）：

| 指标 | 基线 | 通过条件 |
|---|---|---|
| 抽出图片数 | pandoc `--extract-media` | **必须相等**（硬指标） |
| 标题数 | pandoc | ≥ 基线 |
| 表格数 | pandoc | 相等 |
| 中文完好 | — | 无问号残缺（officeparser 就死在这） |
| 裸 HTML 残留 | — | `<img` / `<div` 计数为 0 |
| 看板渲染 | — | 重启 `pnpm serve`，点开产物看图和目录层级 |

对比脚本**只打统计不打全文** —— 这也是控制 token 的关键。

**回滚**：`to_markdown_with_assets()` 签名不变，函数体换成调 pandoc-wasm（或退回
`subprocess.run(["pandoc", ...])`），`ingest.py` 及以上全部无感。

## Open Questions

- **表格 span 默认值**：留空 vs `fill`，P2 结束前拿真实文档两种都跑再定死。倾向留空。
- **`anydoc-writer-plan.html` 的归置**：当前它散落在 `templates/pm-aispace/prototypes/` 根下，
  而本仓约定是 `prototypes/<名字>/index.html`（散装 `.html` 看板扫不到）。
  另外它是**规划页，不该随模板发给用户** —— P4 一并处理，要么挪进 `<名字>/index.html`
  跟已有的 `pdf-engine-ladder/` 对齐，要么移出 templates/。这一条留给人拍板。
