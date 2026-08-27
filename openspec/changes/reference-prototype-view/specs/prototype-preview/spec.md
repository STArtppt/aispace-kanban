## ADDED Requirements

### Requirement: 原型只扫 visualization/prototypes/

「参考&原型」视图的「原型」tab MUST 按现有约定识别可预览 HTML 包：
子目录根上有 `index.html`、扫描根上直接有 `index.html`、扫描根上的 zip
（包内能解析到 `index.html`）都算一份。
zip MUST 解压到看板自家缓存，MUST NOT 写回工作空间。
「什么样的文件夹 / zip 算一份」的判定 MUST 与改动前逐条一致。

扫描根 MUST 是 `visualization/prototypes/`，且 MUST 只有这一个。
看板 MUST NOT 再扫描工作空间根上的 `prototypes/`，也 MUST NOT 把它搬到新位置
（看板对工作空间只读）。

#### Scenario: 子目录原型
- **WHEN** `visualization/prototypes/方案页/index.html` 存在且 `<title>` 为「方案页」
- **THEN** 原型 tab 出现标题为「方案页」的卡片，点击在新窗口打开看板伺服的该包
- **AND** `sourcePath` 为 `visualization/prototypes/方案页`

#### Scenario: zip 原型不解压进工作空间
- **WHEN** `visualization/prototypes/demo.zip` 根上（或唯一子目录里）有 `index.html`
- **THEN** 原型 tab 列出这一份，kind 为 zip
- **AND** 工作空间里不出现解压出来的文件夹，解压目录在看板缓存下

#### Scenario: 旧位置的包不被列出
- **WHEN** 工作空间根上还有 `prototypes/旧包/index.html`，
  而 `visualization/prototypes/` 不存在或为空
- **THEN** 原型清单为空（那份包 MUST NOT 出现在卡片里）
- **AND** 工作空间里的文件一个都没被移动或改动

#### Scenario: 没有 visualization/prototypes/ 时不报错
- **WHEN** 工作空间没有 `visualization/prototypes/`
- **THEN** 原型清单为空并带说明，扫描其余部分照常返回

### Requirement: 旧位置只探测不扫描，并给出迁移提示

扫描 MUST 探测工作空间根上是否还有非空的 `prototypes/`，探测结果 MUST 经
`Prototypes` 的可选字段（如 `legacyDir`）下发。
探测 MUST 只判断存在与非空，MUST NOT 读取其中内容、MUST NOT 产出卡片、MUST NOT 伺服它。
该字段存在且新位置没有可展示包时，原型 tab 的空态 MUST 显示迁移提示，
并给出可直接复制的命令。
看板 MUST NOT 提供代替用户搬迁的按钮或接口 —— 那是写工作空间。

#### Scenario: 升级后还没搬家
- **WHEN** 工作空间根上有非空的 `prototypes/`，`visualization/prototypes/` 不存在
- **THEN** 原型 tab 空态里除了常规提示，还显示「检测到旧位置的原型」和命令
  `mkdir -p visualization && mv prototypes visualization/prototypes`

#### Scenario: 搬完提示消失
- **WHEN** 用户执行完迁移命令，根上不再有 `prototypes/`
- **THEN** 原型 tab 列出这些包，迁移提示不再出现

#### Scenario: 探测不越界
- **WHEN** 根上 `prototypes/` 里有几十份包和一个大 zip
- **THEN** 扫描只判断该目录存在且非空，不读取任何文件内容、不解压任何 zip

### Requirement: 原型空态与注释不再提 axhub-make

原型 tab 的空态、服务端 `note`、源码注释、README 里描述该视图的句子 MUST 把原型说成
「可点击的 HTML 包（子目录根上有 index.html，或同样结构的 zip）」，
落点写成 `visualization/prototypes/`。
MUST NOT 再把 axhub-make 导出包写成唯一或默认来源。

#### Scenario: 空态文案
- **WHEN** `visualization/prototypes/` 里没有任何可预览包，用户打开原型 tab
- **THEN** 空态提示把带 `index.html` 的文件夹或 zip 放进 `visualization/prototypes/`
- **AND** 文案里不出现 `axhub-make`、`Axhub Make`、`axhub`

#### Scenario: 服务端 note
- **WHEN** 调用扫描接口且 `visualization/prototypes/` 为空
- **THEN** 返回的 `note` 同样不出现 axhub-make 口径，并指向 `visualization/prototypes/`

### Requirement: 原型与参考分 tab，互不混列

原型包 MUST 只出现在「原型」tab，MUST NOT 出现在「参考」tab。
`visualization/references/` 里的页面 MUST NOT 出现在「原型」tab。

#### Scenario: 只放了原型时参考 tab 仍为空
- **WHEN** `visualization/prototypes/bar/index.html` 存在，
  `visualization/references/` 不存在或其中无合法参考
- **THEN** 原型 tab 有一张卡片，参考 tab 走空态

#### Scenario: 旧服务进程下原型 tab 不炸
- **WHEN** 前端已换成带两个 tab 的新构建，服务进程尚未重启，
  scan 里只有 `prototypes`、没有 `references`、也没有 `legacyDir`
- **THEN** 原型 tab 按 `scan.prototypes` 渲染（旧进程扫的仍是旧位置），不白屏、不报错

### Requirement: 第四个视图叫参考&原型，默认落在参考 tab

侧栏第四项文案 MUST 是「参考&原型」。
视图的内部路由键 MUST 仍是 `prototypes`，MUST NOT 要求迁移用户「上次打开的视图」。
进入该视图时 MUST 看到「参考 / 原型」两个 tab；首次进入 MUST 停在「参考」。
概览进度里原来的「原型」一步 MUST 改成「参考&原型」：`visualization/references/` 或
`visualization/prototypes/` 任一有可展示项即算走过；
`references` 字段缺失时 MUST 退回只看原型。

#### Scenario: 导航文案
- **WHEN** 用户看侧栏
- **THEN** 第四项写着「参考&原型」，不再单独叫「原型」

#### Scenario: 默认 tab
- **WHEN** 用户第一次点进「参考&原型」
- **THEN** 当前 tab 是「参考」

#### Scenario: 上次视图不丢
- **WHEN** 用户在改动前把「上次打开的视图」停在原型视图，随后升级看板
- **THEN** 再次打开仍落在「参考&原型」这个视图，不掉回概览

#### Scenario: 概览进度
- **WHEN** 工作空间还没有原型包，但 `visualization/references/` 里已有一份带
  `index.html` 的参考
- **THEN** 概览「参考&原型」这一步标记为已完成
