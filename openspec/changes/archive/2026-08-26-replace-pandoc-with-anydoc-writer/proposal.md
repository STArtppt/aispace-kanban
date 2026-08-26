## Why

不做的话，`.docx` `.odt` `.rtf` `.epub` 这四种最常见的甲方资料，用户必须先 `brew install pandoc`
才能入库 —— 没装就是一句 `缺少 pandoc` 的硬报错、整批转换直接断流，而这四种格式恰恰是
"把资料丢进 `input/raw/` 就能开工"这个承诺里最该零配置的一段。看板已经自带
`@firecrawl/anydoc`（PDF / PPT 走的就是它），把这四种格式也接过来，系统依赖就真的清零了。

拦路的只有一件事：anydoc 的 CLI **不吐图片**。它的 README 写得很直白 —— Markdown 装不下字节，
嵌入图片渲染成 alt 文本，字节留在 `document.assets` 上。所以直接换 CLI 会让一份带十几张架构图的
PRD 只剩裸文字，对后续做需求分析等于丢掉一半内容。但字节和位置在模型层都在：
`toDocument()` 返回的 `Document` 里，图片是 `Inline{kind:'image'}`、字节挂在 `assets` 上，
**是 anydoc 自带的 Writer 在渲染那一刻主动扔掉的**，而那个 Writer 在 Rust 里，不导出也不给 hook。

结论：解析这段 anydoc 已经做完，而且在真实语料上比 pandoc 更准（WPS 导出、`w:styleId` 是纯数字的
文档，pandoc 靠样式名匹配会漏标题，anydoc 走 `w:outlineLvl` 认得出，还保住了 Word 的自动编号）。
我们缺的只是**把 `Document` 渲染成 Markdown 的那一段**。

## What Changes

- **新增 `templates/pm-aispace/scripts/anydoc_writer.mjs`**：读 anydoc 的 `Document` 模型，
  自己序列化成 GFM；图片按 `assets` 落盘到 `input/assets/<名字>/`，正文写成 `![](相对路径)`。
- **新增 `anydoc.to_markdown_with_assets(src, assets_dir, link_prefix) -> str`**：
  Python 侧调用契约。**这个签名先定死再写 Writer** —— Writer 做砸了可以把函数体原地换成
  pandoc-wasm 或别的引擎，`ingest.py` 及以上完全无感。顺序反了退路就没了。
- **`ingest.py` 的 `.docx/.odt/.rtf/.epub` 分派从 pandoc 改成新 Writer**：
  `PANDOC` 常量改名 `RICHDOC`，`convert_pandoc()` → `convert_richdoc()`，
  删掉 `has_cli("pandoc")` 那道闸和 `raise RuntimeError("缺少 pandoc")`。
- **BREAKING（对用户是好事，但产物会变）**：同一份源文件重新入库后，Markdown 正文与图片文件名
  跟 pandoc 时代不一致（标题层级可能更多、图片命名规则换成我们自己的）。已有产物不自动重转，
  但用户手动重转会看到 diff。
- **删掉 `src/server/http.mjs` 里 `缺少 pandoc` 的错误映射**（那条降级提示没有触发路径了）。
- **文档去 pandoc**：`templates/help.md`、`templates/pm-aispace/README.md`、
  `templates/pm-aispace/AGENTS.md`、`templates/pm-aispace/input/README.md`、
  `pm-doc-ingest` 技能、`templates/pm-aispace/.claude/settings.json` 里的 `Bash(pandoc:*)` 预授权，
  以及 `.claude/skills/systematic-debugging` 里那条"pandoc 转出裸 `<img>`"的分诊条目。

## Capabilities

### New Capabilities
- `rich-doc-convert`: `.docx` `.odt` `.rtf` `.epub` 四种富文档转 Markdown 的行为契约 ——
  用哪个引擎、图片怎么落盘与链接、表格跨行列与复合编号怎么降级、转换失败与引擎缺失怎么报错。
  含终端直跑 `ingest.py` 和看板点转换两条触发路径。

### Modified Capabilities
（无 —— `openspec/specs/` 目前为空，本仓还没有已建的能力规格。）

## Impact

**平面**：

- **templates/**（主战场）：`scripts/anydoc_writer.mjs` 新增、`scripts/anydoc.py` 加函数、
  `scripts/ingest.py` 改分派、`.claude/settings.json` 与四处文档去 pandoc。
  提醒：templates/ 是发给用户的工作空间模板，**放进去就是发出去**，本仓编码规范不适用于它内部，
  但它自己的注释密度与中文风格要跟齐 `anydoc.py` / `mineru.py`。
- **服务端**（`src/server/http.mjs`）：删一段错误映射，约 5 行。**改完必须重启 `pnpm serve` / `pnpm dev`**，
  这一层没有任何静态检查。
- **前端**：不动。
- **CLI**（`bin/cli.mjs`）：不动 —— `runtime.json` 里 `anydocBin` 与 `node` 两个字段已经写好了，
  Writer 直接复用，不需要新字段。
- **`src/app/lib/api.ts` 契约**：**不动**。

**依赖**：不引入任何新 npm / Python 包。Writer 从 `runtime.json` 的 `anydocBin` 推出同目录
`index.js` 侧载（已实测：任意 cwd 下 `import(pathToFileURL(...))` 都成功），看板注入和终端直跑
共用同一个二进制，跟现在行为一致。反向减少一个系统依赖（pandoc）。

**只读红线**：不放宽。Writer 只往**工作空间自己的** `input/assets/` 写图片 ——
这与 `convert_pandoc()` 的 `--extract-media` 和 MinerU 的 `write_mineru_result()` 是同一件事，
路径同样由 `ingest.py` 算好再传进去。看板对工作空间仍然只读，写盘的一直是脚本不是看板。

**风险**：anydoc 是 0.x，`Document` 模型无语义化保证，升级可能让 Writer 崩或静默丢内容。
缓解写进 design：未知 kind 走 fallback 吐纯文本而不抛错，`package.json` 里 pin 住版本，
验证脚本连同合成语料一起提交当回归基线。
