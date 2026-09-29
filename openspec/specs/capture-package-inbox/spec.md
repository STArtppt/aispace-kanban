# capture-package-inbox

## Purpose

约定接收采集插件投递的采集包:`POST /capture-package`,路径与端口就用扩展默认值,
不自造 `/api/...` 前缀 —— 否则每个用户装完扩展第一件事是手改配置。登录后的深层页面靠
扩展在页面自身上下文里采集,本能力只负责按契约定校验(`format` / `version` 不匹配就明确拒绝,
不解析到一半崩掉)、再把包摊成 `visualization/references/<slug>/` 下的一份参考条目 ——
与贴 URL 采下来的参考同一形状、同一面墙、同一个查看器。免责声明原样保留,不加强语气。
落盘复用 `visual-capture` 已经拍板的写入收口;来源放行 MUST NOT 扩大写入面。

## Requirements

### Requirement: 按契约 D 在固定路径接收采集包

看板 MUST 提供 `POST /capture-package`,路径与默认端口 MUST 与 annotation-collect 扩展的
默认投递目标一致,MUST NOT 要求用户改扩展配置。
请求体 MUST 按契约 D 解析:`{ package, triggeredAt }`。
成功响应 MUST 是 `{ accepted: true, location, hostItemId }`,其中 `location` 是给人看的落点说明,
扩展会把它显示给用户。
接收端没有 `projectId`,MUST 投进登记表里最近打开的那个工作空间,并把它写进 `location`。
接收 MUST 只由用户在扩展里点投递触发,看板 MUST NOT 主动拉取、MUST NOT 后台接收。

#### Scenario: 投递成功
- **WHEN** 用户在扩展里选中看板并点投递,包里有一份整页快照
- **THEN** 返回 `accepted: true`,`location` 说明落进了哪个工作空间的哪个目录
- **AND** 参考清单出现这一条,点击能打开投进来的页面

#### Scenario: 落点可见
- **WHEN** 用户手上开着多个工作空间,投递成功
- **THEN** 响应的 `location` 里写明是哪一个工作空间,用户据此判断有没有投错

#### Scenario: 服务没在跑
- **WHEN** 看板服务没启动,用户点投递
- **THEN** 扩展侧显示目标未运行并保留批次,看板这边没有任何副作用

### Requirement: 格式与版本不匹配时明确拒绝

接收端 MUST 先校验 `format` 与 `version`,再解析其余内容。
`format` 不是 `annotation-collect.capture-package` 时 MUST 返回 4xx 并说明这不是采集包。
`version` 高于看板己知的最高版本时 MUST 返回 4xx 并说明看板只认到哪一版。
MUST NOT 在版本不匹配时「尽力解析」,MUST NOT 落下任何半截产物。

#### Scenario: 未来版本的包
- **WHEN** 扩展升级后投来 `version: 2` 的包,而看板只认到 1
- **THEN** 返回非 2xx 并说明宿主只认到 v1
- **AND** 工作空间里没有新增任何文件
- **AND** 扩展侧显示宿主拒绝的原因,批次保留不清空

#### Scenario: 根本不是采集包
- **WHEN** 有人往这个端点 POST 一段任意 JSON
- **THEN** 返回非 2xx 说明格式不认识,不写盘

### Requirement: 采集包摊成一份参考条目

落盘 MUST 走 `visual-capture-engine` 的写入收口,产物 MUST 摆成
`visualization/references/<slug>/`,与贴 URL 采下来的参考同一形状:

- `index.html` —— 包里的整页快照;没有整页快照时用第一个元素片段;
- `manifest.json`、`summary.md` —— 原样落,MUST NOT 改写内容;
- `meta.json` —— `source: plugin`、`scrubbed`、包自带的免责声明原文、
  原包的 `format` 与 `version`、投递时间、来源页面地址;
- 清单里其余载荷文件 MUST 按清单里的相对路径落在同一目录下。

看板 MUST NOT 生成包里没有的内容。
一个包里既没有整页快照也没有元素片段时 MUST 拒收(4xx)并说明原因,
MUST NOT 自己造一个 `index.html`。

#### Scenario: 带整页快照的包
- **WHEN** 收到一个含整页快照、两条文字批注的包
- **THEN** `index.html` 是那份快照,`manifest.json` 与 `summary.md` 原样落在同目录
- **AND** 两条批注不单独成文件(它们在清单与摘要里)

#### Scenario: 只有元素片段的包
- **WHEN** 包里没有整页快照,只有两个元素片段
- **THEN** 第一个片段成为 `index.html`,第二个按清单里的路径落在同目录

#### Scenario: 一张页面都没有的包
- **WHEN** 包里只有文字批注,没有任何 HTML 载荷
- **THEN** 返回非 2xx 说明这个包里没有可展示的页面
- **AND** 工作空间里没有新增任何文件,看板没有生成任何 HTML

#### Scenario: 落进来的条目和别的参考一样用
- **WHEN** 一个包已经落盘,用户打开参考 tab
- **THEN** 它和贴 URL 采来的参考并排显示、用同一个查看器打开,没有第二套展示

### Requirement: 免责声明原样保留,不加强语气

`meta.json` 里的 `scrubbed` MUST 如实反映包里的值。
包自带的脱敏免责声明 MUST 原样保存,MUST NOT 被改写成「已脱敏」「安全」一类说法 ——
脱敏是尽力而为的模式匹配,不是安全保证。
脱敏明细 MUST 留在 `manifest.json` 里,MUST NOT 另抄一份。

#### Scenario: 脱敏过的包
- **WHEN** 收到一个 `scrubbed: true`、带免责声明的包
- **THEN** `meta.json` 记 `scrubbed: true` 并原样带着那句免责声明
- **AND** 界面上不出现「已安全脱敏」这类说法

### Requirement: 接收端的来源放行不得扩大写入面

接收端 MUST 仍走 `allowMutations`:非环回监听时 MUST 403。
`visual-capture-engine` 的来源判定函数会拒绝非同源请求,而扩展的来源不是同源 ——
放行 MUST 在那个**共用函数**里加分支实现,MUST NOT 各接口各写一套。
放行 MUST 只对 `/capture-package` 这一条路径生效;其它 mutation 接口
(资料转换、忽略文件、新建工作空间、移出看板、URL 采集)MUST NOT 因此被放宽。
放行条件 MUST 依据对真实投递请求的实测结果确定;若实测表明请求头不足以把扩展和
任意网页区分开,MUST 改为由用户在看板上显式开启一次性接收窗口,
MUST NOT 对所有来源敞开这条路径。
写入范围 MUST 与已拍板的窄例外一致:只写 `visualization/references/<slug>/`,
只新建、不覆盖、不删除,路径过 `resolveInside()`。

#### Scenario: 非环回不接收
- **WHEN** 看板以非环回地址监听,有人 POST 这个端点
- **THEN** 返回 403,工作空间里没有任何新文件

#### Scenario: 放行不外溢
- **WHEN** 一个带同样来源头的 POST 打向资料转换或 URL 采集接口
- **THEN** 仍然被拒绝 —— 放行只对 `/capture-package` 生效

#### Scenario: 普通网页仍被拒
- **WHEN** 用户浏览器里的某个网站向这个端点发起跨站 POST
- **THEN** 返回 403,不写盘

#### Scenario: 客户端不能指定落点
- **WHEN** 包的清单里夹带 `../../output/docs` 一类路径
- **THEN** 该路径被忽略,文件只落在服务端生成的 `visualization/references/<slug>/` 下;
  `output/` 不被改动
