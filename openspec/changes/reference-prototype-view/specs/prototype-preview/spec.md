## ADDED Requirements

### Requirement: 原型 tab 扫 visualization/prototypes/，并兼容根上旧 prototypes/

「参考&原型」视图的「原型」tab MUST 按现有约定识别可预览 HTML 包：
子目录根上有 `index.html`、该扫描根上直接有 `index.html`、该扫描根上的 zip（包内能解析到 `index.html`）都算一份。
zip MUST 解压到看板自家缓存，MUST NOT 写回工作空间。

扫描根按这个顺序：

1. `visualization/prototypes/`（新约定，优先）
2. 工作空间根上的 `prototypes/`（旧位置，只读兼容）

同一 slug 两边都有时，MUST 采用新位置那一份。看板 MUST NOT 把旧目录搬到新位置。
包的识别规则（什么样的文件夹 / zip 算一份）MUST 与改动前一致。

#### Scenario: 新位置的子目录原型
- **WHEN** `visualization/prototypes/方案页/index.html` 存在且 `<title>` 为「方案页」
- **THEN** 原型 tab 出现标题为「方案页」的卡片，点击在新窗口打开看板伺服的该包

#### Scenario: 根上旧 prototypes/ 仍能列出来
- **WHEN** 工作空间没有 `visualization/prototypes/`，但根上 `prototypes/旧包/index.html` 存在
- **THEN** 原型 tab 仍列出「旧包」，`sourcePath` 指向 `prototypes/旧包`

#### Scenario: 两边同名时新位置赢
- **WHEN** `visualization/prototypes/demo/index.html` 与 `prototypes/demo/index.html` 都存在
- **THEN** 原型 tab 只展示新位置那一份，`sourcePath` 为 `visualization/prototypes/demo`

#### Scenario: zip 原型不解压进工作空间
- **WHEN** `visualization/prototypes/demo.zip` 根上（或唯一子目录里）有 `index.html`
- **THEN** 原型 tab 列出这一份，kind 为 zip
- **AND** 工作空间里不出现解压出来的文件夹，解压目录在看板缓存下

#### Scenario: 两个扫描根都没有时不报错
- **WHEN** 工作空间既没有 `visualization/prototypes/` 也没有根上 `prototypes/`
- **THEN** 原型清单为空并带说明，扫描其余部分照常返回

### Requirement: 原型空态与注释不再提 axhub-make

原型 tab 的空态、服务端 `note`、源码注释、README 里描述该视图的句子 MUST 把原型说成
「可点击的 HTML 包（子目录根上有 index.html，或同样结构的 zip）」，落点写成 `visualization/prototypes/`。
MUST NOT 再把 axhub-make 导出包写成唯一或默认来源。

#### Scenario: 空态文案
- **WHEN** 两个扫描根里都没有任何可预览包，用户打开原型 tab
- **THEN** 空态提示把带 `index.html` 的文件夹或 zip 放进 `visualization/prototypes/`
- **AND** 文案里不出现 `axhub-make`、`Axhub Make`、`axhub`

#### Scenario: 服务端 note
- **WHEN** 调用扫描接口且两个扫描根都为空
- **THEN** 返回的 `note` 同样不出现 axhub-make 口径，并指向 `visualization/prototypes/`

### Requirement: 原型与参考分 tab，互不混列

原型包 MUST 只出现在「原型」tab，MUST NOT 出现在「参考」tab。
`visualization/references/` 里的页面 MUST NOT 出现在「原型」tab。
`visualization/` 下任一子目录增删时，SSE MUST 能刷新对应清单；根上旧 `prototypes/` 增删时，原型清单也 MUST 刷新。

#### Scenario: 只采了参考时原型 tab 仍为空
- **WHEN** `visualization/references/foo/index.html` 存在，两个原型扫描根都为空
- **THEN** 参考 tab 有一张卡片，原型 tab 走空态

#### Scenario: 只放了原型时参考 tab 仍为空
- **WHEN** `visualization/prototypes/bar/index.html` 存在，`visualization/references/` 不存在或其中无 `index.html`
- **THEN** 原型 tab 有一张卡片，参考 tab 走空态

#### Scenario: 旧服务进程仍能看根上旧原型
- **WHEN** 前端已换成带两个 tab 的新构建，服务进程尚未重启，scan 里只有 `prototypes`、没有 `references`，且包仍在根上 `prototypes/`
- **THEN** 原型 tab 仍按 `scan.prototypes` 渲染现有卡片，行为与改动前一致
