## 1. 模板脚本

- [x] 1.1 `docxkit/ooxml.py`：标记读写泛化为 `set_property` / `property_of`，`add_marker` / `marker_of` 保留为薄封装
- [x] 1.2 `md2docx.py`：成品写入 `aispace-docx-converted`；加 `--archive`，上一份带标记的成品改名为 `<基名>-<时间>.docx`，结果 JSON 带 `archived`
- [x] 1.3 工具链版本升到 1.3.0；脚本头注释写明归档规则
- [x] 1.4 `scripts/check-docx.mjs` 补断言：`--archive` 后旧文件改名、新文件就位、转换时间属性存在；无标记文件加 `--archive` 仍拒绝

## 2. 服务端与契约

- [x] 2.1 `docxTools.mjs`：载荷接受 `archive`；脚本不支持时 400 `old-script`
- [x] 2.2 `deai.mjs`：交付稿列表补 `sourceDocx` 与每版 `docx`（只读）
- [x] 2.3 `api.ts`：上述字段与转换结果的 `archived` 都写成可选

## 3. 前端

- [x] 3.1 版本条常驻、去掉「交付稿」字样、原稿态说明与「去 AI 味…」，产出列表行菜单移除「去 AI 味…」
- [x] 3.2 「转成 Word」/「预览 Word」随同名 `.docx` 变化，预览就地显示；「重新转换」与「预览 Word」同时常驻
- [x] 3.3 转换弹窗去掉「覆盖」开关，说明上一份的归档名；toast 写出归档到哪
- [x] 3.4 版本上去掉「原稿已更新」，原稿上标「被直接改过」

## 4. 文档与验证

- [x] 4.1 AGENTS.md 第九条 ⑤⑥ 改写
- [x] 4.2 `pnpm typecheck`、`pnpm build`、`pnpm test:docx` 通过；临时服务上点一遍原稿与交付稿两种状态
