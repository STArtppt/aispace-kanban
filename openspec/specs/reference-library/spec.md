# reference-library

## Purpose

约定「视觉呈现」视图里「参考」tab 的取数口径与打开方式:一份参考是
`visualization/references/<slug>/` 目录,根上有 `index.html` 才算数,`meta.json` 与
`screenshots/` 可选、坏了只退回缺省值,不让整次扫描失败。清单经 `Scan.references`(字段可选)下发,
工作空间没有 `visualization/` 时新进程返回空结构,旧进程缺该字段时前端退回提示态。
查看器是看板自己的壳页,原始页面被关进 CSP `sandbox` 的不透明源,截图浮在壳上。
`visualization/` 是可选平面,缺它不影响工作空间识别;启动后才创建的目录同样要推 SSE。
看板对本能力全程只读。

## Requirements

### Requirement: 参考落在 visualization/references/,一份参考一个目录

工作空间若要收参考页,MUST 使用 `visualization/references/`。
`visualization/` 是可选的视觉平面,与 `input/` `output/` 的文档平面并列;识别工作空间的判据
(有 `input/` 和 `output/`)MUST NOT 因为缺 `visualization/` 而失败。

每一份参考 MUST 是 `visualization/references/<slug>/` 子目录。
**判定「是不是一份参考」的唯一条件 MUST 是该目录根上有 `index.html`** ——
用户手工另存一份自包含 HTML 摆进去就能被认出来,不必先写 `meta.json`。
散装的 `某页.html` 扔在 `visualization/references/` 根上,看板 MUST 扫不到。

目录内其余文件都是可选的,形状固定如下:

```
visualization/references/<slug>/
  index.html                  # 必须。带交互的原始页面
  meta.json                   # 可选
  screenshots/hero.png        # 可选。桌面标准屏首屏
  screenshots/full.png        # 可选。完整页面
  screenshots/mobile.png      # 可选。移动端响应式
```

`meta.json` 的字段 MUST 是:`title`、`sourceUrl`、`capturedAt`、
`source`(`manual` / `url-capture` / `plugin`)、`scrubbed`、`screenshots`,
外加可选的 `degraded`(本次产出少了哪些档位及原因)。
`scrubbed` 只告知这页有没有经过脱敏,MUST NOT 被当作安全保证。
缺 `meta.json` 时 `source` MUST 退回 `manual`,标题 MUST 从 `index.html` 的 `<title>` 取。
`meta.json` 读不出或不是合法 JSON 时 MUST 退回同一套缺省值,MUST NOT 让该条目消失、
MUST NOT 让整次扫描失败。

**由看板采集得到的参考,`source` MUST 是 `url-capture`,且其 `meta.json` MUST 记着
源 URL、采集时间与 `scrubbed: false`。** 本能力自身(扫描与展示)仍然 MUST NOT
往工作空间写入任何文件 —— 写入是 `visual-capture` 的事。

#### Scenario: 采集来的参考带来源信息
- **WHEN** 用户采集了一个公开页面,随后打开参考 tab
- **THEN** 该卡片显示源 URL,其 `source` 为 `url-capture`,封面是 `screenshots/hero.png`

#### Scenario: 降级采集的参考照常显示
- **WHEN** 一次采集因为缺 Playwright 只产出了 `index.html` 与 `meta.json`
- **THEN** 卡片正常出现,预览区用窗框占位,不出现破图
- **AND** `meta.json` 里的 `degraded` 说明少了截图


#### Scenario: 没有 visualization/ 仍是合法工作空间
- **WHEN** 一个已登记工作空间只有 `input/` 和 `output/`,没有 `visualization/`
- **THEN** 扫描成功,参考清单为空,界面走空态,不报「目录丢失」

#### Scenario: 子目录有 index.html 才算一份参考
- **WHEN** `visualization/references/foo/index.html` 存在,
  同时 `visualization/references/bar.html` 直接躺在该目录根上
- **THEN** 清单里只有 `foo` 这一份,`bar.html` 不出现

#### Scenario: 手工放进去的参考
- **WHEN** 用户自己把一份自包含 HTML 摆成 `visualization/references/foo/index.html`,
  没有 `meta.json`、没有截图
- **THEN** 清单里出现「foo」,标题取自 `<title>`,`source` 为 `manual`,
  预览区用窗框占位而不是破图

#### Scenario: meta.json 坏了不拖垮条目
- **WHEN** `visualization/references/foo/meta.json` 内容不是合法 JSON
- **THEN** 「foo」仍然出现在清单里并可打开,元信息退回缺省值

#### Scenario: 参考不出现在原型 tab
- **WHEN** `visualization/references/foo/index.html` 存在,`visualization/prototypes/` 为空
- **THEN** 参考 tab 有一张卡片,原型 tab 走空态

### Requirement: 扫描结果经 Scan.references 下发,字段可选

`Scan` MUST 增加可选字段 `references`,形状与原型清单同类:`items`、`note`、`updatedAt`。
每条 item MUST 带 `itemKey`、`title`、可打开的 `url`(指向查看器壳页);
可选带 `sourceUrl`、`source`、`scrubbed`、`mtime`、`cover`、`screenshots`。

**`source` 为 `plugin` 的条目由 annotation-collect 的扩展投递而来,此时 `meta.json`
MUST 记着来源页面地址、投递时间、`scrubbed` 的真实值与包自带的免责声明原文。
卡片 MUST 能看出它来自采集插件,MUST NOT 把它和贴 URL 采来的参考混为一谈显示来源。**

工作空间没有 `visualization/` 时,新服务进程 MUST 仍然返回这个字段(空结构),
好让前端区分「没有参考」和「旧进程没有这个字段」。
旧服务进程不给这个字段时,前端 MUST 不白屏、不抛错。

#### Scenario: 新服务列出已有参考
- **WHEN** `visualization/references/example/index.html` 的 `<title>` 是「示例后台」,
  用户打开参考 tab
- **THEN** 卡片标题为「示例后台」,点击在新窗口打开该参考的查看器

#### Scenario: 旧服务进程缺 references 字段
- **WHEN** 前端已是带参考 tab 的新构建,常驻服务还是改动前的进程,
  `/api/projects/:id/scan` 没有 `references`
- **THEN** 参考 tab 显示「当前看板服务还没有参考能力,重启看板服务后即可」,
  原型 tab 仍按现有数据工作
- **AND** 页面不白屏、控制台不因为 `scan.references` 为 `undefined` 报错

#### Scenario: 插件投来的参考
- **WHEN** 用户用采集插件投了一个需要登录才能看的页面,随后打开参考 tab
- **THEN** 卡片显示来源页面地址,`source` 为 `plugin`
- **AND** 它和贴 URL 采来的参考并排显示,用同一个查看器打开

#### Scenario: 三种来源并存
- **WHEN** 同一个工作空间里同时有手工摆的、贴 URL 采的、插件投的三份参考
- **THEN** 三张卡片都正常显示,来源各自标明,行为一致

#### Scenario: 读不到 visualization/references/ 不拖垮整次扫描
- **WHEN** `visualization/references/` 存在但进程没有读权限
- **THEN** `references.items` 为空,`note` 说明读不到,
  扫描其余部分(资料、产出、原型)照常返回

### Requirement: 伺服的参考页必须落进不透明源

看板伺服 `visualization/references/<slug>/` 下的文件 MUST 走独立路径
(`/api/projects/:id/ref/:slug/…`),路径 MUST 过 `resolveInside()`,越界 MUST 403。
HTML 响应 MUST 带 `Content-Security-Policy: sandbox`(允许脚本 / 表单 / 弹窗,
但不给 `allow-same-origin`,也不给 `allow-top-navigation`),
使该页面无法访问看板的同源接口、cookie 与 `localStorage`,也无法把外层窗口跳走。
原型的 `bundle` 伺服路径 MUST 同样带这个头。

#### Scenario: 参考页拿不到看板接口
- **WHEN** 用户打开一份参考,页面里的脚本请求 `/api/projects`
- **THEN** 该请求被浏览器按跨源拒绝,拿不到工作空间列表

#### Scenario: 路径穿越被拦
- **WHEN** 有人请求参考静态文件,相对路径含 `../../output/docs/某.md`
- **THEN** 返回 403,该文档内容不被读出

#### Scenario: 原型伺服同样受隔离
- **WHEN** 用户在新窗口打开一份 `bundle` 原型
- **THEN** 响应同样带 sandbox 头,页面正常渲染,但拿不到看板接口

### Requirement: 参考查看器是看板自己的壳页,截图浮在壳上

点击一张参考卡片 MUST 在新窗口打开该参考的查看器,而不是直接打开原始 HTML。
查看器 MUST 是看板伺服的一个壳页(如 `/api/projects/:id/ref/:slug/view`),
壳页里 MUST 用 `<iframe>` 铺满窗口装载被隔离的 `index.html`。
截图缩略图 MUST 画在壳页上(左下角),MUST NOT 注入进原始页面,
MUST NOT 依赖原始页面配合 —— 原始页面在不透明源里,壳页也拿不到它的 DOM。
点击缩略图 MUST 用灯箱打开原图,可在三张之间切换,可关闭回到页面。
一张截图都没有时 MUST 不显示缩略图区域,MUST NOT 留下空占位或破图。
壳页 MUST 提供一个「直接打开原始页面」的出口,供 iframe 里渲染异常时使用。

#### Scenario: 带三张截图的参考
- **WHEN** 一份参考有 `screenshots/` 下的三张图,用户点开它
- **THEN** 新窗口里原始页面铺满可交互,左下角浮着三张缩略图
- **AND** 点任一张用灯箱打开原图,可切换、可关闭,关闭后原始页面状态不丢

#### Scenario: 没有截图的参考
- **WHEN** 一份手工摆进去的参考只有 `index.html`
- **THEN** 查看器只有铺满的页面,左下角不出现缩略图区域,不留空白占位

#### Scenario: 查看器里的页面仍被隔离
- **WHEN** 用户在查看器里打开一份参考,iframe 内的脚本尝试
  `fetch('/api/projects')` 或访问 `parent.document`
- **THEN** 两者都失败,看板接口与壳页 DOM 都拿不到

#### Scenario: 截图路径不可越界
- **WHEN** 有人直接请求截图路径,相对路径含 `../../../`
- **THEN** 返回 403

### Requirement: 参考 tab 用卡片网格展示

参考 tab MUST 用卡片网格:16:10 预览区 + 标题 + 来源(URL 或相对路径)。
有 `screenshots/hero.png` 时 MUST 用它当封面铺满预览区;没有时 MUST 用浏览器窗框占位,
不得留白、不得出现破图。
空态 MUST 说清放法:把自包含 HTML 放到 `visualization/references/<名字>/index.html`,
一份参考一个目录。
配色 MUST 只用语义令牌,预览区不上彩色装饰。

#### Scenario: 有封面的参考
- **WHEN** 一份参考有 `screenshots/hero.png`
- **THEN** 卡片预览区显示这张图,不显示窗框占位

#### Scenario: 没有封面的参考
- **WHEN** 一份参考只有 `index.html`
- **THEN** 预览区是浏览器窗框占位 + 标题首字,不出现破图图标

#### Scenario: 空态
- **WHEN** 工作空间没有可展示的参考
- **THEN** 空态说明还没有参考页,并写明放到 `visualization/references/<名字>/index.html`

### Requirement: 后来才创建的目录也要能推 SSE

看板 MUST 对启动时还不存在、之后才被创建的 `visualization/` 同样推送 SSE:
该目录(含两个子目录)内容变化时界面自动刷新,MUST NOT 要求用户重启服务。
这条覆盖用户手工把旧 `prototypes/` 搬进 `visualization/` 的那一刻,
也覆盖后续 change 里第一次采集才创建 `visualization/references/` 的那一刻。

#### Scenario: 启动后才建 visualization/
- **WHEN** 服务启动时工作空间没有 `visualization/`;用户随后创建该目录并放入
  `visualization/references/foo/index.html`
- **THEN** 界面不手动刷新也出现「foo」这张卡片

#### Scenario: 搬完原型立刻可见
- **WHEN** 用户对一个原型还在根上 `prototypes/` 的工作空间执行
  `mkdir -p visualization && mv prototypes visualization/prototypes`
- **THEN** 界面不手动刷新,原型 tab 就列出这些包,迁移提示消失
