# converted-copy-to-output

## Purpose

产出文档的转换产物里，用户可以把一份单文件 `.md` 按原有子目录结构复制进分析产物、决策记录或交付文档，作为自己的底稿继续写。相对链接按新位置重算并继续指向原文件，front-matter 留下 `copied_from` / `copied_at`。看板先预览落点与重算数，确认后只 spawn 工作空间的 `scripts/copy_converted.py`，每次只新建一个文件；转换产物根本身一个字节都不改。
本能力由 `converted-copy-to-output` 变更落地。

## Requirements

### Requirement: 只有单文件 .md 转换产物提供「复制到…」

「产出文档 → 转换产物」中带 `docKey` 的条目(单文件 `.md`,与能「转成 Word」的范围相同)的「更多」菜单 SHALL 提供「复制到…」,可选目标只有三组：分析产物(`analysis`)、决策记录(`decisions`)、交付文档(`docs`)。非 `.md` 文件和目录型产物的菜单 MUST NOT 出现这一项，也不显示置灰项。列表视图和树形视图都适用。

#### Scenario: 单文件 .md 可用

- **WHEN** scan 返回 `canCopyConverted: true`,用户在一份单文件 `.md` 产物上点「更多」
- **THEN** 菜单里有可点的「复制到…」,点开后弹窗列出三个目标组

#### Scenario: 非 .md 与目录型产物不出现

- **WHEN** 用户在 `.csv`、图片、HTML 原型，或摘要 + `SplittingObject/` 的目录型产物上点「更多」
- **THEN** 菜单里没有「复制到…」

#### Scenario: 工作空间没有复制脚本

- **WHEN** scan 返回 `canCopyConverted: false`,用户在单文件 `.md` 产物上点「更多」
- **THEN** 「复制到…」置灰，悬停提示更新模板后可用，点了不弹窗

#### Scenario: 旧服务进程没给字段

- **WHEN** scan 结果里没有 `canCopyConverted`
- **THEN** 单文件 `.md` 产物上的「复制到…」置灰，提示重启看板服务，界面不白屏

### Requirement: 按子目录结构复制

脚本 SHALL 把转换产物根下的 `<子路径>/<名>.md` 复制到 `output/<组>/<子路径>/<名>.md`,中间目录按需新建。转换产物根 MUST 保持一个字节都不变。

#### Scenario: 子目录里的产物

- **WHEN** 把 `output/converted/资料A/子目录/说明.md` 复制到交付文档
- **THEN** 生成 `output/docs/资料A/子目录/说明.md`,`output/converted/` 下的文件不变

#### Scenario: 来源不是单文件 .md

- **WHEN** 脚本收到的 `--source` 是摘要 `_manifest_*.md`、落在 `SplittingObject/` 下，或者不是 `.md`
- **THEN** 退出码 1,服务端返回 400,不写盘

### Requirement: 复制件链接与留痕

复制件里按原位置解析后落在工作空间内且存在的相对链接和图片，SHALL 按新位置重算，继续指向原文件;其余链接(带协议、锚点、绝对路径、指向不存在的文件、出了工作空间)MUST 原样保留。复制件的 front-matter SHALL 追加 `copied_from` 与 `copied_at`,原有字段保留。

#### Scenario: 图片链接仍指向原图

- **WHEN** `output/converted/资料A/说明.md` 里有 `![](../../../input/assets/说明/p1.png)`,复制到 `output/docs/资料A/说明.md`
- **THEN** 落点与来源目录深度相同，这条链接在新位置照样指到原图，写法原样保留、不计入重算数;看板预览时图片照常显示，`input/assets/` 里没有多出文件

#### Scenario: 指回转换产物的链接重算

- **WHEN** `output/converted/资料A/说明.md` 里有 `[附录](附录.md)`(同目录的另一份转换产物),复制到 `output/docs/资料A/说明.md`
- **THEN** 复制件里这条链接变成 `../../converted/资料A/附录.md`,计入重算数，仍指向原来那份

#### Scenario: 留痕

- **WHEN** 复制完成
- **THEN** 复制件 front-matter 里有 `copied_from: output/converted/资料A/说明.md`,`source` 和 `source_sha256` 与原件相同

### Requirement: 先预览再执行，冲突拒绝

前端 SHALL 先调预览接口，展示落点路径和要重算的链接数，用户点「确定」后才执行。落点已存在时，预览 MUST 标出冲突、确定按钮禁用;执行时 MUST 再检查一次，冲突返回 409,不覆盖、也不留半份文件。

#### Scenario: 落点已存在

- **WHEN** `output/docs/资料A/说明.md` 已存在，用户选交付文档
- **THEN** 弹窗显示"已存在 output/docs/资料A/说明.md",确定按钮不可点

#### Scenario: 预览之后被人抢先建了同名文件

- **WHEN** 预览时没有冲突，执行前落点被建出来
- **THEN** `POST converted-copy` 返回 409,已有文件内容不变，落点目录里没有残留的临时文件

### Requirement: 写入边界

看板 SHALL 只 spawn 工作空间的 `scripts/copy_converted.py`,自己不写盘。请求 MUST 只带 `docKey` 和组名;服务端用种类 `converted-md` 反查，过 `resolveInside()` 后才 spawn。脚本每次 MUST 只在 `output/analysis/` `output/decisions/` `output/docs/` 之一下新建一个 `.md`(以及按需新建的中间目录),不覆盖、不删除、不改名已有文件。接口 MUST 守 `allowMutations` 与 `rejectIfForeignOrigin`。

#### Scenario: 请求带路径或组名非法

- **WHEN** 请求体带 `path` 字段，或者组名不是三组之一
- **THEN** 返回 400,不 spawn

#### Scenario: 键查不到

- **WHEN** `docKey` 不是扫描下发的转换产物 `.md` 的键(比如拿产出原稿的 docKey 来请求)
- **THEN** 返回 400,不 spawn

#### Scenario: 非环回监听

- **WHEN** 看板以非环回 `--host` 启动
- **THEN** 预览和执行接口都返回 403

### Requirement: 复制后界面跟到复制件

复制成功后，前端 SHALL 提示落点路径，切到目标组，并在阅读器中打开复制件。

#### Scenario: 复制到决策记录

- **WHEN** 复制成功，目标组是决策记录
- **THEN** 产出文档切到「决策记录」,阅读器打开复制件
