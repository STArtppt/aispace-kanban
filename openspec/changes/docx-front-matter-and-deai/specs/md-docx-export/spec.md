## MODIFIED Requirements

### Requirement: 「转成 Word」入口

产出视图里每个 `.md` 条目（`analysis` / `docs` / `decisions` 三组，含组内子目录与已归档项）的「更多」菜单 SHALL 有「转成 Word」；
阅读器里打开某份交付稿（`output/delivery/**` 下的 `.md`）时，版本条上 SHALL 也有「转成 Word」，作用于当前选中的那一版。
入口可用的前提是该条目带有服务端下发的 `docKey`；没有 `docKey`（旧服务进程）时菜单项置灰，提示「看板服务是旧版本，重启后可用」。
非 `.md` 条目不出现这一项。

#### Scenario: 打开弹窗

- **WHEN** 用户在 `output/docs/方案/总体设计.md` 这一行点「更多 → 转成 Word」
- **THEN** 弹出「转成 Word」对话框，标题栏显示来源文件名，目标文件显示为同目录的 `总体设计.docx`

#### Scenario: 转换交付稿

- **WHEN** 用户在阅读器版本条上选中 `v002`，点「转成 Word」
- **THEN** 弹窗的来源是 `output/delivery/docs/方案/总体设计/v002.md`，目标文件是同目录的 `v002.docx`；原稿目录一个字节都不变

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
