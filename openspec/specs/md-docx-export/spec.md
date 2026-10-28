# md-docx-export

## Purpose

产出视图里把一份 `.md` 转成 Word：产出原稿落到交付稿镜像目录，交付稿版本仍在同目录。入口挂在 `.md` 条目的「更多」菜单上，
阅读器打开这些 `.md` 时，版本条上的 Word 按钮作用于当前选中的那一份（原稿或某一版交付稿）；
同名成品存在时变成「预览 Word」（就地显示），旁边常驻「重新转换」。
弹窗里选「通用规范」或客户模板、认 `docKey` 而不收路径；再次转换先把上一份带生成标记的成品改名归档。
转换走 spawn `scripts/md2docx.py` 并同步等待。转换前做格式过滤（标题平移、手写编号、批注块、加粗），
转换后做确定性后处理（有前置区时装配前置区、写生成标记、表头跨页重复、题注换 SEQ 域；
没有前置区时文档标题用 `Title` 样式）。文字上只允许去掉标题手写编号、批注标记和解除加粗。
本能力由 `md-to-docx`、`docx-front-matter-and-deai`、`delivery-bar-word-archive` 与 `docx-output-to-delivery` 变更落地。

## Requirements

### Requirement: 成品落在交付稿镜像目录

`md2docx.py` SHALL 按来源 `.md` 的位置决定成品落点，规则只此一套（脚本与服务端各实现一份，口径一致）：

| 来源 | 成品 |
| --- | --- |
| 产出三组原稿 `output/<组>/<子路径>.md`（含组内子目录与已归档项） | `output/delivery/<组>/<子路径>/<基名>.docx` |
| 交付稿 `output/delivery/<组>/<子路径>/v<序号>.md` | 同目录 `v<序号>.docx` |
| 转换产物 `output/converted/<子路径>.md`（旧布局 `input/converted/`） | `output/delivery/converted/<子路径>/<基名>.docx` |
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

### Requirement: 选择模板

弹窗 SHALL 列出可选模板：「通用规范」（`@base`，永远在第一位）以及 `output/docx-template/` 下每个带 `reference.docx` 的模板；
缺 `reference.docx` 的模板目录显示但不可选，并说明「还没生成模板」。默认选中上次在本工作空间用过的模板（记在 `localStorage`，
key 为 `aispace-kanban:docx-template:<工作空间 id>`），找不到就选「通用规范」。
弹窗 SHALL 提供「在模版洗炼里查看」跳转到工作台对应模板。

#### Scenario: 没有任何客户模板

- **WHEN** `output/docx-template/` 为空
- **THEN** 只有「通用规范」一项，下方提示可以去工作台「模版洗炼」提炼客户模板

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

### Requirement: 复制提示词

弹窗 SHALL 提供「复制提示词」：只写剪贴板，不发任何写请求。提示词包含：来源 `.md` 的工作空间相对路径、所选模板、
要执行的命令（`python3 scripts/md2docx.py <路径> --template <模板>`）、同名文件的处理规则、
以及转换后要检查的事项（标题编号、表格、图片、题注是否正常，有 warnings 就先修 md 再转）。
这条路径在 pandoc 缺失、非环回监听、脚本缺失时 MUST 仍然可用（脚本缺失时提示词改为说明如何从模板补齐脚本）。

#### Scenario: 交给工作空间 AI

- **WHEN** 用户点「复制提示词」并粘贴给工作空间 AI
- **THEN** 剪贴板里是完整可执行的说明；看板这一侧工作空间没有任何文件变化

### Requirement: 转换成品的后处理

`md2docx.py` SHALL 在 pandoc 之前挂上格式过滤器（标题平移、手写编号剥离、批注块、加粗，见 `docx-toolchain`「转换前处理」），
并在 pandoc 输出后做确定性的后处理：有前置区时装配前置区（见 `docx-toolchain`「前置区装配」）；写入生成标记；
表格首行设为跨页重复的表头；以「图 / 表 + 数字」开头的题注把手写编号换成 SEQ 域（打开 Word 更新域后自动编号，未更新时显示原数字）；
没有前置区时，文档标题渲染为 `Title` 样式的首段。
前后处理 MUST NOT 改动正文文字：只允许去掉标题开头的手写编号、批注块的 `[!类型]` 标记，以及解除加粗；
每一类处理的次数 SHALL 写进结果的 `log`，弹窗成功后的 toast 旁可展开查看。

#### Scenario: 手写编号的题注

- **WHEN** md 里表题写成 `Table: 表 3 功能清单`
- **THEN** 成品表题是「表 {SEQ 表} 功能清单」形式的域，未刷新时显示「表 3 功能清单」

#### Scenario: 处理记录可见

- **WHEN** 一次转换剥离了 12 处标题编号、转换了 3 个批注块、解除了 40 处加粗
- **THEN** 成功 toast 下可以展开看到这三行记录

#### Scenario: 保留加粗

- **WHEN** 通过复制提示词让工作空间 AI 执行 `md2docx.py … --keep-bold`
- **THEN** 成品里 md 的加粗全部保留，`log` 里没有「解除加粗」一行

### Requirement: 转换的失败与降级

以下情况接口 SHALL 返回 400 并给出中文出路，界面原样显示，且 MUST NOT 生成任何文件：
工作空间没有 `scripts/md2docx.py`（提示用复制提示词让 AI 从模板补齐，或手动复制脚本）；找不到 Python 3；找不到 pandoc 3；
所选模板不存在或缺 `reference.docx`；`docKey` 反查不到（提示列表已变化、请刷新）。
非环回监听时接口 403，「转换」按钮置灰并说明，「复制提示词」可用。脚本超时或非零退出时返回 500，附脚本给出的原因。

#### Scenario: 没装 pandoc

- **WHEN** `/api/health` 报告 pandoc 不可用
- **THEN** 弹窗里「转换」置灰，说明「本机没有 pandoc 3，装好后重启看板」；「复制提示词」可用

#### Scenario: 工作空间目录丢失

- **WHEN** 当前工作空间 `available === false`
- **THEN** 产出列表按现有方式降级，不出现「转成 Word」
