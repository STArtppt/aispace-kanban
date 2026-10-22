## MODIFIED Requirements

### Requirement: 「转成 Word」入口

产出视图里每个 `.md` 条目（`analysis` / `docs` / `decisions` 三组，含组内子目录与已归档项）的「更多」菜单 SHALL 有「转成 Word」；
阅读器打开这些 `.md` 时，版本条上 SHALL 也有 Word 按钮，作用于当前选中的那一份（原稿或某一版交付稿）。
同目录同名的 `.docx` 不存在时按钮是「转成 Word」；存在时变成「预览 Word」，点击在阅读器里就地显示这份 Word、再点回到正文，
旁边常驻「重新转换」（同名文件没有生成标记时置灰并说明原因）。
入口可用的前提是该条目带有服务端下发的 `docKey`；没有 `docKey`（旧服务进程）时菜单项置灰，提示「看板服务是旧版本，重启后可用」。
非 `.md` 条目不出现这一项。

#### Scenario: 打开弹窗

- **WHEN** 用户在 `output/docs/方案/总体设计.md` 这一行点「更多 → 转成 Word」
- **THEN** 弹出「转成 Word」对话框，标题栏显示来源文件名，目标文件显示为同目录的 `总体设计.docx`

#### Scenario: 转换交付稿

- **WHEN** 用户在阅读器版本条上选中 `v002`，点「转成 Word」
- **THEN** 弹窗的来源是 `output/delivery/docs/方案/总体设计/v002.md`，目标文件是同目录的 `v002.docx`；原稿目录一个字节都不变

#### Scenario: 已转过的版本

- **WHEN** `v002.docx` 已存在，用户选中 `v002`
- **THEN** 版本条上是「预览 Word」与「重新转换」；点「预览 Word」，阅读区显示 `v002.docx` 的分页版式，不打开新标签页

### Requirement: 同名文件不被误覆盖

目标 `.docx` 已存在且带工具链生成标记 `aispace-docx-generator` 时，再次转换 SHALL 先把它改名为
`<基名>-<上次转换时间 YYYYMMDDHHmm>.docx`（同目录；重名追加 `-2`、`-3`），再写新成品 `<基名>.docx`；弹窗不再有「覆盖」开关，
而是写明上一份会改成的名字，载荷带 `archive: true`。上次转换时间取成品 `docProps/custom.xml` 的 `aispace-docx-converted`，
没有这项时取文件修改时间。每次转换 SHALL 把本次时间写进新成品的 `aispace-docx-converted`；`.md` 一个字节都不改。
已有文件没有生成标记时 MUST 拒绝转换，提示「同名的 Word 不是本工具生成的，为避免覆盖人工修改，请先改名或移走」。
服务端与脚本 MUST 各自再校验一次，不能只靠前端。工作空间的 `md2docx.py` 不支持归档时，服务端 MUST 返回 400（`kind: old-script`）说明先更新模板，
不得自己改名。命令行与旧前端仍可用 `--overwrite` / `overwrite: true` 直接替换。

#### Scenario: 重新转换保留上一份

- **WHEN** `v001.docx` 是 2026-10-22 09:18 转出来的，人在 Word 里改过并保存，用户点「重新转换」并选了另一个模板
- **THEN** 原文件改名为 `v001-202610220918.docx` 留在原处，新成品是 `v001.docx`；toast 写明上一份另存成了什么名字

#### Scenario: 同名文件是人手改过的

- **WHEN** `a.docx` 没有生成标记，有人用 curl 直接发 `archive: true` 或 `overwrite: true`
- **THEN** 接口返回 409，`a.docx` 不变

#### Scenario: 实例脚本是旧版

- **WHEN** 工作空间的 `md2docx.py` 还没有 `--archive`，用户点「重新转换」
- **THEN** 接口返回 400，弹窗说明先更新工作空间模板；`a.docx` 不变
