## 1. 前端渲染

- [x] 1.1 加前端依赖 `remark-math`、`rehype-katex`、`katex`（不进服务端 import 图）。
- [x] 1.2 新增 remark 插件：wikilink / 图片嵌入 / 文档嵌入链接、callout、行首标签、`%%注释%%`、段尾 `^id`。解析规则以 design 决策一到三为准。
- [x] 1.3 `Markdown.tsx` 接入该插件、`remark-math`、`rehype-katex`（katex 在 `rehype-raw` 之前；非法公式不抛错）。
- [x] 1.4 `globals.css` 给 callout、标签、嵌入链接、公式加样式。需要注意的 callout 只用 `--destructive`，其余黑白灰。

## 2. 模板约定

- [x] 2.1 `templates/pm-aispace/AGENTS.md`「Markdown 写法」：七项挪到现在可用，写明三条做不到的事。
- [x] 2.2 `scripts/check_markdown.py` 不再把这七项报成错误；扁平 front-matter 与标题层级不动。
- [x] 2.3 `scripts/web_ingest.py` 的 `sanitize_markdown` 不再剥这七项；多个 H1 降级保留。

## 3. 验收

- [x] 3.1 `pnpm typecheck` 与 `pnpm build` 都绿。
- [x] 3.2 浏览器打开一篇含 wikilink、callout、标签、注释、公式的 Markdown：链接点到约定路径，`[!type]` / `%%` / `^id` 不露在正文里，`# 标题` 仍在目录里，`#标签` 不在目录里。深色模式看一遍 callout。
- [x] 3.3 服务端与 `api.ts` 未改，这次不用为新字段重启服务。预览走现有 dev / 已构建的前端即可。
