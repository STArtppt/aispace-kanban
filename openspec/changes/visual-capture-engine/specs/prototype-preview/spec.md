## MODIFIED Requirements

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
