# prototype-preview

## Purpose

约定「视觉呈现」视图里「原型」tab 的取数口径与展示规则:只扫 `visualization/prototypes/` 一个根,
条目分 `bundle`(已构建的可点击 HTML 包,含扫描根上的 zip)与 `url`(云端发布链接)两种形态;
未构建的源码包一律不认,看板不安装依赖、不执行构建。工作空间根上的旧 `prototypes/` 只探测不扫描,
由用户在空态按提示自行搬迁。原型与参考分 tab 互不混列,「视觉呈现」视图的内部路由键仍是
`prototypes`,概览那句「原型」进度改叫「视觉呈现」。看板对本能力全程只读。

## Requirements

### Requirement: 原型只扫 visualization/prototypes/

「视觉呈现」视图的「原型」tab MUST 只扫 `visualization/prototypes/`,且 MUST 只有这一个扫描根。
看板 MUST NOT 再扫描工作空间根上的 `prototypes/`,也 MUST NOT 把它搬到新位置
(看板对工作空间只读)。

#### Scenario: 旧位置的包不被列出
- **WHEN** 工作空间根上还有 `prototypes/旧包/index.html`,
  而 `visualization/prototypes/` 不存在或为空
- **THEN** 原型清单为空(那份包 MUST NOT 出现在卡片里)
- **AND** 工作空间里的文件一个都没被移动或改动

#### Scenario: 没有 visualization/prototypes/ 时不报错
- **WHEN** 工作空间没有 `visualization/prototypes/`
- **THEN** 原型清单为空并带说明,扫描其余部分照常返回

### Requirement: 原型条目有 bundle 与 url 两种形态

一条原型 MUST 是 `visualization/prototypes/` 下的一个子目录(或扫描根上的 zip / index.html),
形态按下列规则判定:

- 目录根上有 `index.html` → `bundle`。
- 目录根上没有 `index.html`,但有 `meta.json` 且其 `kind` 为 `url` → `url`。
- 两者都没有 → 不是一份原型,MUST 被忽略,MUST NOT 产生占位卡片。

`bundle` 的识别规则 MUST 与改动前逐条一致:子目录根上有 `index.html`、扫描根上直接有
`index.html`、扫描根上的 zip(包内能解析到 `index.html`)都算一份。
zip MUST 解压到看板自家缓存,MUST NOT 写回工作空间。
`bundle` 卡片点击 MUST 打开看板伺服的那份 `index.html`。

`url` 形态的 `meta.json` MUST 带 `kind: "url"`、`title`、`target`(目标地址),
可选 `capturedAt`、`source`;同目录下可选一张 `cover.png` 当封面。
**这份 `meta.json` 既可以由用户手写,也可以由看板的 URL 导入写入
(此时 `source` MUST 是 `url-capture`)—— 两者形状完全一致,扫描侧 MUST NOT 区别对待。**
`url` 卡片点击 MUST 在新窗口直接打开 `target`,MUST NOT 经看板伺服、MUST NOT 试图抓取它。
`target` 不是 `http` / `https` 时该条目 MUST 不可点击,并在卡片上说明地址不合法。

#### Scenario: 导入写进来的 url 原型和手写的一样被展示
- **WHEN** 一条 `url` 原型由看板导入写入(`source: url-capture`),另一条由用户手写
  (无 `source` 字段)
- **THEN** 两张卡片行为一致,都点击直开 `target`,扫描侧不因来源不同而区别处理

#### Scenario: 子目录原型
- **WHEN** `visualization/prototypes/方案页/index.html` 存在且 `<title>` 为「方案页」
- **THEN** 原型 tab 出现标题为「方案页」的卡片,点击在新窗口打开看板伺服的该包
- **AND** `sourcePath` 为 `visualization/prototypes/方案页`,`kind` 为 `bundle`

#### Scenario: zip 原型不解压进工作空间
- **WHEN** `visualization/prototypes/demo.zip` 根上(或唯一子目录里)有 `index.html`
- **THEN** 原型 tab 列出这一份,形态为 `bundle`
- **AND** 工作空间里不出现解压出来的文件夹,解压目录在看板缓存下

#### Scenario: 云端发布的原型
- **WHEN** `visualization/prototypes/线上版/meta.json` 内容是
  `{ "kind": "url", "title": "线上版", "target": "https://example.com/p/abc" }`
- **THEN** 原型 tab 出现「线上版」卡片,点击在新窗口打开该 URL
- **AND** 看板不请求该 URL、不在本地留下这个页面的任何副本

#### Scenario: url 原型有封面
- **WHEN** 同一目录下还有 `cover.png`
- **THEN** 卡片预览区显示这张封面,而不是窗框占位

#### Scenario: 目标地址不合法
- **WHEN** 某条 `url` 原型的 `target` 是 `file:///etc/passwd` 或空串
- **THEN** 该卡片不可点击,并说明地址不合法;看板不打开它

#### Scenario: 空目录被忽略
- **WHEN** `visualization/prototypes/草稿/` 里既没有 `index.html` 也没有 `meta.json`
- **THEN** 原型清单里不出现「草稿」,也不出现任何占位卡片

### Requirement: 只支持已构建的原型产物

原型 tab MUST 只支持已经构建好、能直接在浏览器里打开的产物,以及云端发布链接。
未构建的源码包(如 figma make 的源码导出、axhub-make 的「导出源码」包)MUST NOT 被展示,
看板 MUST NOT 为它们安装依赖或执行构建。
空态与服务端 `note` MUST 说清这条,并指路:用工具的「导出 HTML」,或用云端发布链接。

#### Scenario: 源码包丢进来
- **WHEN** 用户把一个只有 `src/` 与 `package.json`、根上没有 `index.html` 的源码包
  解压进 `visualization/prototypes/`
- **THEN** 该目录不出现在原型清单里
- **AND** 看板不执行任何安装或构建命令

#### Scenario: 空态指路
- **WHEN** `visualization/prototypes/` 里没有可展示的原型
- **THEN** 空态说明只认已构建的 HTML 包(根上有 `index.html`)或云端发布链接,
  并提示源码包请先用工具导出 HTML

### Requirement: 旧位置只探测不扫描,并给出迁移提示

扫描 MUST 探测工作空间根上是否还有非空的 `prototypes/`,探测结果 MUST 经
`Prototypes` 的可选字段(如 `legacyDir`)下发。
探测 MUST 只判断存在与非空,MUST NOT 读取其中内容、MUST NOT 产出卡片、MUST NOT 伺服它。
该字段存在且新位置没有可展示包时,原型 tab 的空态 MUST 显示迁移提示,
并给出可直接复制的命令。
看板 MUST NOT 提供代替用户搬迁的按钮或接口 —— 那是写工作空间。

#### Scenario: 升级后还没搬家
- **WHEN** 工作空间根上有非空的 `prototypes/`,`visualization/prototypes/` 不存在
- **THEN** 原型 tab 空态里除了常规提示,还显示「检测到旧位置的原型」和命令
  `mkdir -p visualization && mv prototypes visualization/prototypes`

#### Scenario: 搬完提示消失
- **WHEN** 用户执行完迁移命令,根上不再有 `prototypes/`
- **THEN** 原型 tab 列出这些包,迁移提示不再出现

#### Scenario: 探测不越界
- **WHEN** 根上 `prototypes/` 里有几十份包和一个大 zip
- **THEN** 扫描只判断该目录存在且非空,不读取任何文件内容、不解压任何 zip

### Requirement: 原型空态与注释不再提 axhub-make

原型 tab 的空态、服务端 `note`、源码注释、README 里描述该视图的句子 MUST 把原型说成
「工具产出的可点击 HTML 包,或云端发布链接」,落点写成 `visualization/prototypes/`。
MUST NOT 再把 axhub-make 导出包写成唯一或默认来源 —— 它和 figma make 一样只是来源之一。

#### Scenario: 空态文案
- **WHEN** `visualization/prototypes/` 里没有任何可展示的原型,用户打开原型 tab
- **THEN** 空态提示把已构建的 HTML 包放进 `visualization/prototypes/`,或用 `meta.json` 记一条发布链接
- **AND** 文案里不出现 `axhub-make`、`Axhub Make`、`axhub` 作为唯一来源

#### Scenario: 服务端 note
- **WHEN** 调用扫描接口且 `visualization/prototypes/` 为空
- **THEN** 返回的 `note` 同样不出现 axhub-make 口径,并指向 `visualization/prototypes/`

### Requirement: 原型与参考分 tab,互不混列

原型 MUST 只出现在「原型」tab,MUST NOT 出现在「参考」tab。
`visualization/references/` 里的页面 MUST NOT 出现在「原型」tab。

#### Scenario: 只放了原型时参考 tab 仍为空
- **WHEN** `visualization/prototypes/bar/index.html` 存在,
  `visualization/references/` 不存在或其中无合法参考
- **THEN** 原型 tab 有一张卡片,参考 tab 走空态

#### Scenario: 旧服务进程下原型 tab 不炸
- **WHEN** 前端已换成带两个 tab 的新构建,服务进程尚未重启,
  scan 里只有 `prototypes`、没有 `references`、也没有 `legacyDir`
- **THEN** 原型 tab 按 `scan.prototypes` 渲染(旧进程扫的仍是旧位置),不白屏、不报错

### Requirement: 第四个视图叫视觉呈现,默认落在参考 tab

侧栏第四项文案 MUST 是「视觉呈现」。
视图的内部路由键 MUST 仍是 `prototypes`,MUST NOT 要求迁移用户「上次打开的视图」。
进入该视图时 MUST 看到「参考 / 原型」两个 tab;首次进入 MUST 停在「参考」。
tab 的选中状态 MUST 单独持久化,MUST NOT 影响「上次打开的视图」。
概览进度里原来的「原型」一步 MUST 改成「视觉呈现」:`visualization/references/` 或
`visualization/prototypes/` 任一有可展示项即算走过;
`references` 字段缺失时 MUST 退回只看原型。

#### Scenario: 导航文案
- **WHEN** 用户看侧栏
- **THEN** 第四项写着「视觉呈现」,不再单独叫「原型」

#### Scenario: 默认 tab
- **WHEN** 用户第一次点进「视觉呈现」
- **THEN** 当前 tab 是「参考」

#### Scenario: 上次视图不丢
- **WHEN** 用户在改动前把「上次打开的视图」停在原型视图,随后升级看板
- **THEN** 再次打开仍落在「视觉呈现」这个视图,不掉回概览

#### Scenario: 概览进度
- **WHEN** 工作空间还没有原型,但 `visualization/references/` 里已有一份带
  `index.html` 的参考
- **THEN** 概览「视觉呈现」这一步标记为已完成
