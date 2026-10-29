## MODIFIED Requirements

### Requirement: 原始资料可以重命名和移动

「输入资料 → 原始资料」里，每个文件行和树形视图里的每个目录行 SHALL 提供「重命名」和「移动到…」。重命名只改这一层的名字，文件或目录仍留在原目录。移动只改父目录，基名不变。移动一个目录时，其下的文件和子目录 MUST 一起移动。一次请求 MUST NOT 同时改名又换目录。

「移动到…」的目标目录 SHALL 以树展示：打开时只展开 `input/raw（根）` 一层，更深的目录收起；拖放带来的目标目录连同其祖先展开。
当前所在的目录 SHALL 显示但不可选；移动目录时，它自己和它的子目录 MUST NOT 出现在树里。
输入筛选词时只留命中的目录及其祖先，并全部展开。

资料台账行 MUST NOT 成为移动来源或放下目标。`input/raw` 本身 MUST NOT 被重命名或移走。

#### Scenario: 给文件改名

- **WHEN** 用户在原始资料某一文件行点「更多 → 重命名」，把基名改成新的一层名字并确认
- **THEN** 该文件仍在原来的子目录里，只有基名变成新名字

#### Scenario: 把目录拖进另一个目录

- **WHEN** 用户在树形视图里把目录 `input/raw/批次甲` 拖到目录 `input/raw/归档` 上并确认
- **THEN** 该目录连同其中的文件出现在 `input/raw/归档/批次甲/`，原位置不再有 `批次甲`

#### Scenario: 平铺列表用选择器移动

- **WHEN** 用户在平铺列表里对一份文件点「移动到…」，展开树选中 `input/raw/归档` 并确认
- **THEN** 文件出现在 `input/raw/归档/` 下，基名不变

#### Scenario: 目录树默认收起

- **WHEN** 用户对 `input/raw/归档/2024/说明.docx` 点「移动到…」
- **THEN** 树里只看得到根和第一级目录；`2024` 显示为「（当前所在）」且点了不会被选中

#### Scenario: 不能一次又改名又换目录

- **WHEN** 请求同时带了新基名和目标目录
- **THEN** 服务端返回 400，磁盘上没有文件被移动

### Requirement: 先预览再落盘

重命名和移动 SHALL 先展示预览：将移动的路径、将改写的台账行、产物和链接，以及每个文件的处数。排除范围内的命中 MUST NOT 出现在预览里。预览成功之前「确定」MUST NOT 可点。拖放到目录上 MUST NOT 写盘，只打开这份预览。

执行时脚本 MUST 重算计划并与预览指纹比对。指纹 MUST 覆盖被移动的原件（移动目录时是其下全部文件）的路径、大小和修改时间，以及将改写的文件。不一致时 MUST 一个字节都不改，并返回 409。

#### Scenario: 预览时磁盘不变

- **WHEN** 用户把 `input/raw/批次甲/说明.docx` 改名为 `说明-修订`，预览已经显示将更新的链接数
- **THEN** 磁盘上该文件仍叫 `说明.docx`，台账和产物都还是旧路径

#### Scenario: 预览之后文件被改过

- **WHEN** 用户打开预览后，该文件在看板之外被改过内容，再点「确定」
- **THEN** 服务端返回 409，路径和链接保持预览前的样子

#### Scenario: 预览之后目录里多了文件

- **WHEN** 用户打开「把 `input/raw/批次甲` 移到 `input/raw/归档`」的预览后，在看板之外往 `批次甲` 里放进一份新文件，再点「确定」
- **THEN** 服务端返回 409，`批次甲` 仍在原位置

#### Scenario: 拖放只打开预览

- **WHEN** 用户把一个目录拖到另一个目录上、尚未点「确定」
- **THEN** 弹出与「移动到…」相同的预览，两个目录仍在原来的位置

#### Scenario: 旧脚本仍给忽略规则

- **WHEN** 工作空间还是旧版 `move_raw.py`，预览结果带着 `ignore` 字段
- **THEN** 预览照常显示，不显示忽略规则相关的条目，不白屏

### Requirement: 关联在同一次确认里跟进

确认之后，脚本 MUST 在同一次操作里完成这些跟进，且 MUST NOT 为此运行 `ingest.py`：

- 把该原件对应的转换产物移到新的镜像位置，并改写产物的 `source`（清单类产物还包括 `sources`）。
- 产物换目录后，正文里指向 `input/assets/` 或其他产物的相对链接按新位置重算。
- `input/assets/` 里的图片文件 MUST 留在原地。`input/assets/未分类/_manifest.md` 里对得上的原件路径改成新路径。
- `input/INDEX.md` 表格里对得上的行改为新原件路径和新产物链接。`## 人工批注` 整段保留，其中只改解析后指向旧路径的链接。
- `output/` 下的 `.md` / `.yaml` / `.yml`、根 `project.yaml` / `project.yml`，以及 `output/docx-template/` 下的文本中，解析后指向旧原件或旧产物的链接和「整个字段等于旧路径」的值，改为新路径。交付稿 `v*.md` 只改 front-matter，正文不改。
- 产出三组的原稿因此内容变了时，其交付稿里原本对得上的 `source_sha` MUST 换成新摘要。

`input/.ingestignore` MUST NOT 被读取或改写。

转换产物的 Word 成品（`output/delivery/converted/…`）MUST NOT 移动或改名；产物换位置后它显示为「未转 Word」，旧成品留在原处。

原件字节 MUST NOT 改变。整理前是「已转」的资料，整理后 SHALL 仍是「已转」，MUST NOT 因为这次整理变成「改动」。没有产物的资料只移动原件并改写对得上的链接。

#### Scenario: 已转换的文件改名后仍然已转

- **WHEN** `input/raw/批次甲/说明.docx` 已有镜像产物，用户把它改名为 `说明-修订` 并确认
- **THEN** 列表里该行路径已更新，标签仍是「已转」
- **AND** 台账里该行的原件路径和产物链接都指向新位置
- **AND** 产物 front-matter 的 `source` 是新的原件路径
- **AND** `input/assets/` 里原来的图片文件路径不变，产物里的图片链接仍能打开

#### Scenario: 遗留忽略清单不动

- **WHEN** 工作空间还留着 `input/.ingestignore`，其中有一行 `raw/批次甲`，用户把该目录移动到 `input/raw/归档/` 下并确认
- **THEN** `.ingestignore` 一个字节没变

#### Scenario: 交付稿不误报原稿已变更

- **WHEN** 产出原稿 `output/analysis/需求梳理.md` 有一份交付稿，其 `source_sha` 与原稿一致，原稿里有一条指向 `input/raw/批次甲/说明.docx` 的链接，用户把该文件改名并确认
- **THEN** 原稿里的链接指向新路径
- **AND** 那份交付稿的 `source_sha` 等于原稿的新摘要，看板不显示「原稿已变更」

#### Scenario: 人工批注保留

- **WHEN** `input/INDEX.md` 的「人工批注」里有一句不带链接的说明，表格里有被移动的那一行
- **THEN** 确认之后那句说明原文还在，表格里对得上的行改为新路径

### Requirement: 不能整理时退回今天的列表

scan 可选字段 `canOrganizeRaw` 不为 true 时，「重命名」和「移动到…」MUST 置灰并说明原因，树形视图 MUST NOT 接受拖放。字段含义：

- 没有 `canOrganizeRaw`：看板服务是旧版本，提示重启。
- `false` 且 `organizeRawBlock` 为 `no-script`：工作空间没有整理脚本，提示更新模板。
- `false` 且 `organizeRawBlock` 为 `legacy-converted`：产物仍在旧位置，提示先迁移。
- 工作空间目录丢失：提示重新关联。

上述任一情况下，列表、状态标签和转换 MUST 与本变更之前相同。没有 `project.yaml` 时，整理操作 SHALL 仍然可用（在脚本存在且产物不在旧位置的前提下），MUST NOT 因此白屏。

#### Scenario: 旧服务进程

- **WHEN** 前端已更新，扫描结果里没有 `canOrganizeRaw`
- **THEN** 「重命名」置灰，提示重启看板服务
- **AND** 原始资料列表仍按状态显示，不白屏

#### Scenario: 工作空间没有脚本

- **WHEN** scan 返回 `canOrganizeRaw: false` 且 `organizeRawBlock` 为 `no-script`
- **THEN** 菜单置灰，提示更新模板后可用，不能拖放

#### Scenario: 目录丢失

- **WHEN** 工作空间目录找不到了
- **THEN** 整理动作置灰，提示重新关联之后才能整理

#### Scenario: 没有 project.yaml

- **WHEN** 工作空间没有 `project.yaml`，且 scan 返回 `canOrganizeRaw: true`
- **THEN** 用户仍可对一份原始资料打开重命名预览
