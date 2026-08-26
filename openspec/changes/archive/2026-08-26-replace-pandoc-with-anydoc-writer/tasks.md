## 0. 接缝先行（顺序不可调）

- [x] 0.1 在 `templates/pm-aispace/scripts/anydoc.py` 里加 `to_markdown_with_assets(src, assets_dir, link_prefix) -> str`，
      先只写签名 + docstring + 一句 `raise NotImplementedError`，复用现成的 `find_bin()` / `_argv()` / `_run()`
- [x] 0.2 加 `_writer_module()`：从 `find_bin()` 的结果推出同目录 `index.js` 的绝对路径，文件不在就抛 `AnydocError`
- [x] 0.3 建 `templates/pm-aispace/scripts/anydoc_writer.mjs` 骨架：解析 `--anydoc-module` / `--assets-dir` / `--link-prefix`，
      `import(pathToFileURL(...))` 侧载，跑通 `toDocument()` 并把节点种类计数打到 stderr
- [x] 0.4 验证：终端里 `python3 scripts/anydoc.py` 之外单独直跑 helper，确认在任意 cwd 下侧载都成功（不装 `@firecrawl/anydoc` 到本地）
- [x] 0.5 备好回归语料：4 个自造合成件（docx/odt/rtf/epub，各含标题/表格/列表/图片）提交进仓库；
      真实文档只在本机用，**不入库**（脱敏红线）

## 1. P1 — Writer 主干 + 图片落盘

- [x] 1.1 图片落盘：遍历 `document.assets`，按 `mediaType` 定扩展名、命名去重，写进 `--assets-dir`
- [x] 1.2 `renderInlines`：text / link / anchor / lineBreak / noteRef，加 `Style` 四个 bool 的包裹（bold/italic/strike/code）
- [x] 1.3 image inline → `![](链接前缀 + 文件名)`，前缀直接用 `--link-prefix` 传进来的值，**不在 mjs 里重写转义**
- [x] 1.4 `renderBlock` 主干：heading / paragraph / blockQuote / rule
- [x] 1.5 codeBlock / math / checkbox 落降级实现（原样吐文本），未知 kind 同样走 fallback 不抛错（设计决策 4）
- [x] 1.6 `notes` 数组渲染 + 文末收尾
- [x] 1.7 **P1 验收**：四个合成件转出正文与图，肉眼比对；此处是止损点 —— 质量明显不如 pandoc 就停下来换 pandoc-wasm

## 2. P2 — 表格、列表、转义（三个硬决策落地成开关）

- [x] 2.1 `renderTable`：规范网格 → GFM，`headerRows` 处理，格内块的拍平
- [x] 2.2 跨行列降级：默认留空，加 `--span=fill` 开关备用（设计决策 2）
- [x] 2.3 `renderList`：嵌套、`start`、`-` / `1.` 两种 marker
- [x] 2.4 `markerLabel` 降级：整个 list 转成带缩进的段落序列，label 原样写行首并转义（设计决策 3）
- [x] 2.5 转义：正文裸露的 `* _ [ ] < > \`、行首 `# - +` 与"数字+点"；表格格内 `|` 转义、换行转 `<br>`；
      `code` 内部反过来不转义、包反引号并处理内容自带反引号（设计决策 5）
- [x] 2.6 **P2 验收**：本机 6 份真实 docx 跑通不报错，标题数追平或超过 pandoc；
      跨行列两种策略各跑一遍、比对后把默认值定死

## 3. P3 — 三方回归对比

- [x] 3.1 写对比脚本（放 `templates/pm-aispace/scripts/` 之外的临时目录，**不入库**）：
      pandoc / anydoc CLI / 自研 Writer 三方并排，**只打统计不打全文**（这是控 token 的关键）
- [x] 3.2 跑验证闸六项：抽图数 == pandoc（硬指标）、标题数 ≥ pandoc、表格数 == pandoc、
      中文无问号残缺、`<img` 与 `<div` 计数为 0
- [x] 3.3 逐项修 diff，直到六项全绿
- [x] 3.4 把合成语料的期望统计写成一个可重跑的回归基线脚本，连同语料一起提交

## 4. P4 — 接线：templates 平面

- [x] 4.1 `anydoc.py`：把 0.1 的 `NotImplementedError` 换成真实实现（spawn helper、退出码 0/1/2 映射、
      UTF-8 强制、失败时把 stderr 原样抛成 `AnydocError`）
- [x] 4.2 `ingest.py`：`PANDOC` 常量改名 `RICHDOC`（值仍是扩展名 → anydoc 认的格式串）
- [x] 4.3 `ingest.py`：`convert_pandoc()` → `convert_richdoc()`，函数体换成算好 `img_dir` 与
      `md_link(rel_path(img_dir, target.parent))` 后调 `to_markdown_with_assets()`；
      `extracted_images` 沿用数文件个数的做法；frontmatter 的 `tool` 写成 `anydoc <版本> writer`
- [x] 4.4 `ingest.py`：`plan()` 分派的 `"pandoc"` 改成 `"richdoc"`；删掉 `has_cli("pandoc")` 那道闸
      和 `raise RuntimeError("缺少 pandoc")`
- [x] 4.5 `ingest.py`：顶部 docstring 第 6 行的引擎表、第 33 行"零 Python 依赖"那句里的 pandoc 去掉
- [x] 4.6 `templates/pm-aispace/.claude/settings.json`：删掉 `Bash(pandoc:*)` 预授权
- [x] 4.7 验证：终端里对四个合成件跑一遍 `python3 scripts/ingest.py`，产物与 P3 的一致

## 5. P4 — 接线：服务端

- [x] 5.1 `src/server/http.mjs`：删掉 `/缺少 pandoc/i` 那段错误映射（约 5 行）
- [x] 5.2 **重启 `pnpm serve`**（服务端不热更），在看板上点一次转换，确认失败提示里不再出现 pandoc 字样

## 6. P4 — 文档去 pandoc

- [x] 6.1 `templates/help.md` 第 40 行附近
- [x] 6.2 `templates/pm-aispace/README.md` 第 75、98 行附近
- [x] 6.3 `templates/pm-aispace/AGENTS.md` 第 188 行附近
- [x] 6.4 `templates/pm-aispace/input/README.md` 第 33、90 行附近
- [x] 6.5 `templates/pm-aispace/.claude/skills/pm-doc-ingest/SKILL.md` 第 21 行附近
- [x] 6.6 `templates/pm-aispace/CLAUDE.md` 里的 pandoc 提及
- [x] 6.7 `.claude/skills/systematic-debugging/SKILL.md` 第 37 行那条"pandoc 转出裸 `<img>`"分诊条目改措辞
      —— 新 Writer 出的是 `![]()`；`Markdown.tsx` 的 `rehype-raw` **保留**（MinerU 仍可能出 HTML）
- [x] 6.8 归置 `templates/pm-aispace/prototypes/anydoc-writer-plan.html`：当前散在 prototypes 根下，
      看板扫不到，且它是规划页不该随模板发给用户 —— 要么挪成 `<名字>/index.html` 跟 `pdf-engine-ladder/` 对齐，
      要么移出 templates/。**先问人再动**

## 7. 验收闸

- [x] 7.1 `pnpm typecheck` 绿
- [x] 7.2 `pnpm build` 绿
- [x] 7.3 重启 `pnpm dev`，浏览器把受影响视图点一遍：待转换列表 → 点转换 → 产物预览看图和目录层级；
      含**无 `project.yaml`**、**工作空间目录丢失**、**深色模式**三种情况
      —— 已点：待转换 2→0、转换产物 2、预览里图片经 `/api/projects/…/file` 加载成功（8×8）、
      目录层级 6 级正确、表格 4×3、字母编号与 `|` 转义正常、深色模式正常。
      **未单独验证**「无 `project.yaml`」与「工作空间目录丢失」：注册表里没有这样的工作空间，
      造一个要写用户的注册表；本次改动也没碰这两条降级路径（只删了 `http.mjs` 的一段错误映射）。
- [x] 7.4 `grep -rn pandoc` 全仓（排除 `node_modules` / `openspec/changes/archive`）确认只剩本 change 自己的规划产物
- [x] 7.5 在一台**没装 pandoc** 的环境（或临时把 pandoc 从 PATH 挪开）跑一遍完整入库，确认零系统依赖成立
