## ADDED Requirements

### Requirement: 成品落在交付稿镜像目录

`md2docx.py` SHALL 按来源 `.md` 的位置决定成品落点，规则只此一套（脚本与服务端各实现一份，口径一致）：

| 来源 | 成品 |
| --- | --- |
| 产出三组原稿 `output/<组>/<子路径>.md`（含组内子目录与已归档项） | `output/delivery/<组>/<子路径>/<基名>.docx` |
| 交付稿 `output/delivery/<组>/<子路径>/v<序号>.md` | 同目录 `v<序号>.docx` |
| 输入转换产物 `input/converted/<子路径>.md` | `output/delivery/converted/<子路径>/<基名>.docx` |
| 以上都不是（只有命令行会传） | `.md` 同目录同基名，与改动前一致 |

镜像目录不存在时脚本 SHALL 按需创建。脚本 MUST NOT 往 `input/` 写任何文件；来源是输入转换产物而算出的落点不在
`output/delivery/converted/` 下时 MUST 退出 2，不写盘。结果 JSON 的 `target` / `written` SHALL 是实际落点的工作空间相对路径。
pandoc 的资源路径仍是来源 `.md` 所在目录，相对路径图片照常嵌入。

#### Scenario: 原稿转 Word

- **WHEN** 用户转换 `output/docs/方案/总体设计.md`
- **THEN** 生成 `output/delivery/docs/方案/总体设计/总体设计.docx`；`output/docs/方案/` 里没有新文件，`.md` 一个字节都没变

#### Scenario: 命令行转其他位置的 .md

- **WHEN** 在终端执行 `python3 scripts/md2docx.py notes/草稿.md --template @base`
- **THEN** 成品是 `notes/草稿.docx`，与改动前一致

### Requirement: 旧位置的成品兼认

原稿旁边已有的 `.docx`（改动前转出来的 `output/<组>/<子路径>/<基名>.docx`）SHALL 原地保留，看板与脚本都不搬动、不删除、不改名。
阅读器判断原稿「是否已转过」时 SHALL 先看镜像目录里的 `<基名>.docx`，没有再看原稿旁边的同名 `.docx`；
只有旧位置有成品时，「预览 Word」打开旧位置那一份，「重新转换」写到镜像目录（新位置没有同名文件，不触发归档、不碰旧文件），
弹窗的目标文件显示镜像目录路径。两处都有时只认镜像目录那份。

#### Scenario: 只有旧成品

- **WHEN** `output/docs/a.docx` 是改动前转出来的，镜像目录里没有 `a.docx`，用户打开 `output/docs/a.md`
- **THEN** 版本条显示「预览 Word」，打开的是 `output/docs/a.docx`；点「重新转换」后生成 `output/delivery/docs/a/a.docx`，`output/docs/a.docx` 不变

#### Scenario: 旧服务进程

- **WHEN** 前端已更新、服务进程还是旧的（交付稿列表的 `sourceDocx` 仍按原稿旁边给）
- **THEN** 界面按服务端给的 `sourceDocx` 显示，不报错、不白屏

## MODIFIED Requirements

### Requirement: 「转成 Word」入口

产出视图里每个 `.md` 条目（`analysis` / `docs` / `decisions` 三组，含组内子目录与已归档项）的「更多」菜单 SHALL 有「转成 Word」；
阅读器打开这些 `.md` 时，版本条上 SHALL 也有 Word 按钮，作用于当前选中的那一份（原稿或某一版交付稿）。
落点的 `.docx`（见「成品落在交付稿镜像目录」，原稿另按「旧位置的成品兼认」）不存在时按钮是「转成 Word」；存在时变成「预览 Word」，
点击在阅读器里就地显示这份 Word、再点回到正文，旁边常驻「重新转换」（目标文件没有生成标记时置灰并说明原因）。
入口可用的前提是该条目带有服务端下发的 `docKey`；没有 `docKey`（旧服务进程）时菜单项置灰，提示「看板服务是旧版本，重启后可用」。
非 `.md` 条目不出现这一项。

#### Scenario: 打开弹窗

- **WHEN** 用户在 `output/docs/方案/总体设计.md` 这一行点「更多 → 转成 Word」
- **THEN** 弹出「转成 Word」对话框，标题栏显示来源文件名，目标文件显示为 `output/delivery/docs/方案/总体设计/总体设计.docx`

#### Scenario: 转换交付稿

- **WHEN** 用户在阅读器版本条上选中 `v002`，点「转成 Word」
- **THEN** 弹窗的来源是 `output/delivery/docs/方案/总体设计/v002.md`，目标文件是同目录的 `v002.docx`；原稿目录一个字节都不变

#### Scenario: 已转过的版本

- **WHEN** `v002.docx` 已存在，用户选中 `v002`
- **THEN** 版本条上是「预览 Word」与「重新转换」；点「预览 Word」，阅读区显示 `v002.docx` 的分页版式，不打开新标签页

### Requirement: 直接转换

用户选好模板后点「转换」，前端 SHALL 调用 `POST /api/projects/:id/docx/convert`，载荷只有 `docKey`、`template`、`overwrite` 与可选的 `archive`。
服务端 SHALL 用 `docKey` 反查出来源 `.md`（产出三组、交付稿、输入转换产物三类），按落点规则算出目标，启动工作空间的 `scripts/md2docx.py`，
同步等待（超时 120 秒），返回写出的文件相对路径与 `warnings`。
成功后弹窗关闭，toast 显示「已生成 <文件名>」并带「预览」按钮，「预览」打开结果里的 `target`；交付稿目录变化经 SSE 让版本条刷新。

#### Scenario: 正常转换

- **WHEN** 用户选「通用规范」转换 `output/docs/a.md`，镜像目录里没有 `a.docx`
- **THEN** 几秒内 `output/delivery/docs/a/a.docx` 出现，点 toast 的「预览」在阅读器里看到分页版式；`a.md` 一个字节都没变

#### Scenario: md 里引用了相对路径图片

- **WHEN** `a.md` 里写着 `![架构](../assets/arch.png)`
- **THEN** 成品里嵌入了这张图（pandoc 以 `.md` 所在目录为资源路径，与成品落在哪无关）；图不存在时成品照常生成，结果里多一条 warning 指出缺哪张图

### Requirement: 同名文件不被误覆盖

落点上的 `.docx` 已存在且带工具链生成标记 `aispace-docx-generator` 时，再次转换 SHALL 先把它改名为
`<基名>-<上次转换时间 YYYYMMDDHHmm>.docx`（与它同目录；重名追加 `-2`、`-3`），再写新成品 `<基名>.docx`；弹窗不再有「覆盖」开关，
而是写明上一份会改成的名字，载荷带 `archive: true`。上次转换时间取成品 `docProps/custom.xml` 的 `aispace-docx-converted`，
没有这项时取文件修改时间。每次转换 SHALL 把本次时间写进新成品的 `aispace-docx-converted`；`.md` 一个字节都不改。
已有文件没有生成标记时 MUST 拒绝转换，提示「同名的 Word 不是本工具生成的，为避免覆盖人工修改，请先改名或移走」。
服务端与脚本 MUST 各自再校验一次，不能只靠前端。
工作空间的 `md2docx.py` 是不认识镜像落点的旧版时，服务端 MUST 对**所有来源**返回 400（`kind: old-script`）说明先更新模板，
不得 spawn（旧脚本会写到 `.md` 旁边，对输入转换产物就是写进 `input/`）；脚本不支持归档时同样 400，不得自己改名。
命令行与旧前端仍可用 `--overwrite` / `overwrite: true` 直接替换。

#### Scenario: 重新转换保留上一份

- **WHEN** `v001.docx` 是 2026-10-22 09:18 转出来的，人在 Word 里改过并保存，用户点「重新转换」并选了另一个模板
- **THEN** 原文件改名为 `v001-202610220918.docx` 留在原处，新成品是 `v001.docx`；toast 写明上一份另存成了什么名字

#### Scenario: 同名文件是人手改过的

- **WHEN** 镜像目录里的 `a.docx` 没有生成标记，有人用 curl 直接发 `archive: true` 或 `overwrite: true`
- **THEN** 接口返回 409，`a.docx` 不变

#### Scenario: 实例脚本是旧版

- **WHEN** 工作空间的 `md2docx.py` 还不认识镜像落点，用户点「转成 Word」
- **THEN** 接口返回 400，弹窗说明先更新工作空间模板；工作空间没有任何文件变化
