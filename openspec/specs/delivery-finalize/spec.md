# delivery-finalize

## Purpose

阅读器打开产出三组原稿时，可以从顶栏「定稿」选一份交出去的 Word，由工作空间脚本记到该原稿的交付稿镜像目录（`定稿.md` 与所用 `.docx`），版本条末尾多一个「定稿」标签。看板自己不写盘。
本能力由 `delivery-finalize` 变更落地。

## Requirements

### Requirement: 顶栏的「定稿」入口

阅读器打开产出三组（`analysis` / `docs` / `decisions`，含子目录与已归档项）的 `.md` 原稿时，顶栏「在访达中显示」之后 SHALL 出现「定稿」按钮，
图标为盖章（lucide `Stamp`），悬停提示「定稿：选一份交出去的 Word，记为这份文档的定稿」。
其他文件（`input/` 资料、交付稿目录下的文件被单独打开、非 `.md`）SHALL NOT 出现这个按钮。
按钮作用于**原稿**：无论版本条当前选中原稿、某一版还是「定稿」，定稿记录都挂在这份原稿的交付稿镜像目录下。
条目没有 `docKey`（旧服务进程）或服务端不认定稿接口（404）时，按钮 SHALL 置灰并提示「看板服务是旧版本，重启后可用」。

#### Scenario: 原稿上出现按钮

- **WHEN** 用户在阅读器里打开 `output/docs/方案/总体设计.md`
- **THEN** 顶栏「在访达中显示」右侧有盖章图标的「定稿」按钮

#### Scenario: 资料上不出现

- **WHEN** 用户打开 `output/converted/某份资料.md`
- **THEN** 顶栏没有「定稿」按钮

#### Scenario: 旧服务进程

- **WHEN** 前端已更新、服务进程还是旧的，用户点「定稿」
- **THEN** 不弹选文件框，提示「看板服务是旧版本，重启后可用」，工作空间不变

### Requirement: 系统选文件框默认打开镜像目录

点「定稿」后服务端 SHALL 在本机弹出系统原生选文件框，只允许选 `.docx`，默认定位到这份原稿的交付稿镜像目录
`output/delivery/<组>/<子路径>/`；镜像目录不存在时定位到原稿所在目录。用户可以在框里切到任何其他目录选文件。
接口 `POST /api/projects/:id/delivery/final/pick`，载荷只有 `{ docKey }`；服务端过 `findDocByKey` 反查原稿，查不到 400。
选中后服务端 SHALL 只返回 `{ picked: true, token, name, inMirror, copyAs?, nextCount }`：
`token` 是一次性令牌（10 分钟内有效，用一次即作废），`name` 是选中文件的基名，`inMirror` 表示它是否就在镜像目录里，
`copyAs` 是需要复制时将要使用的新文件名；**响应里不出现选中文件的完整路径**。用户取消返回 `{ picked: false }`。
同一时间只允许一个选文件框，第二个请求 409。非环回监听 403，跨站 403。
本机起不来选文件框（无桌面、命令不存在）时 SHALL 返回 400 说明原因，不退化成浏览器上传。

#### Scenario: 默认定位

- **WHEN** 原稿是 `output/docs/方案/总体设计.md`，镜像目录 `output/delivery/docs/方案/总体设计/` 已存在，用户点「定稿」
- **THEN** 系统选文件框打开在该镜像目录，`.docx` 以外的文件不可选

#### Scenario: 镜像目录还不存在

- **WHEN** 这份原稿从没去过 AI 味，镜像目录不存在
- **THEN** 选文件框打开在 `output/docs/方案/`

#### Scenario: 响应不带路径

- **WHEN** 用户从下载目录选了 `客户反馈版.docx`
- **THEN** 响应是 `{ picked: true, token, name: "客户反馈版.docx", inMirror: false, copyAs: "客户反馈版-202610221630.docx", nextCount: 3 }`，没有任何路径字段

#### Scenario: 远程只读分享

- **WHEN** 看板以非环回地址监听，有人 curl 这个接口
- **THEN** 返回 403，本机不弹框

### Requirement: 定稿前确认

选中文件后看板 SHALL 弹出确认框，写明：选中的文件名；「来自镜像目录，不复制」或「来自其他目录，将复制为 `<copyAs>`」；
「`定稿.md` 将被覆盖为这份 Word 的内容（第 N 次定稿）」——第一次定稿写「将生成 `定稿.md`」。
确认框另有一个**非必填**的单行「备注」输入（例如「发给甲方 · 第二轮评审」），≤60 字。
用户点「确认定稿」才发 `POST /api/projects/:id/delivery/final`，载荷只有 `{ token, note? }`；点取消不发任何写请求，令牌自然过期。
`note` 去首尾空白、换行与 `|` 换成空格后为空则视为没填；超过 60 字 SHALL 返回 400。
令牌不存在、已用过或过期 SHALL 返回 400，提示重新选一次。

#### Scenario: 取消

- **WHEN** 用户在确认框点「取消」
- **THEN** 工作空间一个字节都不变

#### Scenario: 带备注确认

- **WHEN** 用户在备注里填「发给甲方 · 第二轮评审」并确认
- **THEN** 本次 `history` 行末尾多一段 `| 备注 发给甲方 · 第二轮评审`，front-matter 的 `note` 是这段文字

#### Scenario: 令牌过期

- **WHEN** 用户选完文件 10 分钟后才点「确认定稿」
- **THEN** 接口返回 400「选择已过期，请重新点定稿选一次」，工作空间不变

### Requirement: 执行定稿

确认后服务端 SHALL spawn 工作空间脚本 `scripts/finalize_delivery.py`，同步等它退出、带超时；看板自己不写盘。脚本 SHALL：

1. 镜像目录不存在时建立它；
2. 选中文件就在镜像目录里 → 不复制，直接以它为本次定稿；来自其他目录 → 复制进镜像目录，命名 `<原基名>-<定稿时间 YYYYMMDDHHmm>.docx`，
   重名追加 `-2`、`-3`，**只新建、不覆盖**；
3. 用本地 anydoc 把这份 `.docx` 转成 Markdown，覆盖写 `定稿.md`，图片整目录替换为 `定稿.assets/`，正文里的图片链接指向它；
4. 先写临时文件 / 临时目录再原子替换，转换失败时 `定稿.md`、`定稿.assets/` 保持上一次的样子，已复制的 `.docx` 保留并在结果里说明。

脚本 SHALL NOT 写镜像目录以外的任何文件，SHALL NOT 改动镜像目录里已有的 `v*.md`、`v*.docx` 和其他 `.docx`。
同一份原稿的定稿正在进行时，第二个请求 409。

#### Scenario: 从其他目录定稿

- **WHEN** 用户选了下载目录里的 `客户反馈版.docx` 并确认，时间是 2026-10-22 16:30
- **THEN** 镜像目录多出 `客户反馈版-202610221630.docx`，`定稿.md` 是它的内容，下载目录里的原件不变

#### Scenario: 从镜像目录定稿

- **WHEN** 用户直接选了镜像目录里已有的 `v002.docx` 并确认
- **THEN** 镜像目录不新增 `.docx`，`定稿.md` 是 `v002.docx` 的内容，`v002.docx` 一个字节不变

#### Scenario: 再次定稿

- **WHEN** 已经定过一次，用户又从其他目录选了 `客户反馈版.docx`（同名）定稿
- **THEN** 镜像目录新增 `客户反馈版-<本次时间>.docx`，上一次复制进来的那份保留；`定稿.md` 与 `定稿.assets/` 被这次的内容替换，只有一份

#### Scenario: 转换失败

- **WHEN** 选中的文件扩展名是 `.docx` 但内容损坏，anydoc 报错
- **THEN** 接口返回错误并说明原因；`定稿.md` 保持上一次的内容；若已复制，结果里写明复制出的文件名

### Requirement: 定稿记录

`定稿.md` 的 front-matter SHALL 记录：`kind: delivery-final`、`source`（原稿相对路径）、`finalized_at`（本次时间，ISO 8601）、
`docx`（本次定稿所用 `.docx` 的工作空间相对路径，一定在镜像目录内）、`docx_sha`（该文件 SHA-256 前 16 位）、`count`（第几次定稿），
以及 `history:` 列表，每次一行 `<时间> | <镜像目录里的文件名> | 镜像目录` 或 `<时间> | <复制后的文件名> | 其他目录（原名 <原文件名>）`，
按时间先后排列，覆盖写时脚本 SHALL 读取上一份的 `history` 并追加本次。
本次填了备注时，该行末尾追加 `| 备注 <内容>`，front-matter 另写 `note: <内容>`（只记最近一次，没填不写）。
记录 SHALL NOT 出现工作空间以外的绝对路径。front-matter 之后是转换出来的正文。

#### Scenario: 第三次定稿后的记录

- **WHEN** 同一份原稿已定稿三次
- **THEN** `定稿.md` 的 `count` 是 3，`history` 有三行，`docx` 指向第三次的那份文件

#### Scenario: 不泄露本机路径

- **WHEN** 用户从 `<家目录>/Downloads/` 选了文件定稿
- **THEN** `定稿.md` 里只出现原文件名 `客户反馈版.docx`，不出现 `Downloads` 或任何绝对路径

### Requirement: 交付稿列表下发定稿信息

`GET` 交付稿列表接口 SHALL 在原稿有 `定稿.md` 时多给可选字段
`final: { path, count, finalizedAt, sourceName, fromMirror, note?, docx: { path, size, mtime, generated } | null, history: string[] }`；
`docx` 取 front-matter 的 `docx` 字段且该文件仍在镜像目录内存在，否则为 `null`。
`定稿.md` 不在扫描结果和产出列表里单独成条，也不被当成交付稿的某一版。

#### Scenario: 有定稿

- **WHEN** 前端请求一份已定稿原稿的交付稿列表
- **THEN** 响应带 `final`，`final.docx.path` 是最近一次定稿所用的那份 `.docx`

#### Scenario: 记录指向的 Word 被删了

- **WHEN** `定稿.md` 记录的 `docx` 文件已被人删掉
- **THEN** `final.docx` 为 `null`，「定稿」标签照常出现，只是没有「预览 Word」

### Requirement: 版本条的「定稿」标签

版本条 SHALL 在有定稿时于最末追加「定稿」标签：`原稿 · v001 · v002 · 定稿`。选中「定稿」时：
正文显示 `定稿.md`（front-matter 不显示）；标签行下方的说明行显示「第 N 次定稿 · MM-DD HH:mm · 来源文件名」（来自其他目录时文件名后注「原名 …」；有备注时再接「· 备注」），
说明文字不跟在标签后面；右侧按钮是「预览 Word」（关联 `final.docx`，没有时不显示）与「与最新一版对比」（没有交付稿时为「与原稿对比」）。
选中「定稿」时 SHALL NOT 提供批注、去 AI 味、转成 Word、重新转换。标签与说明不用 orange。
定稿成功后版本条 SHALL 自动切到「定稿」并刷新列表。
接口没有 `final` 字段（旧服务、未定稿）时，版本条与改动前一致。

#### Scenario: 预览最新定稿的 Word

- **WHEN** 已定稿两次，用户选中「定稿」点「预览 Word」
- **THEN** 阅读区显示第二次定稿那份 `.docx` 的分页版式

#### Scenario: 看交出去之后的差异

- **WHEN** 定稿后又出了 `v004`，用户选中「定稿」点「与最新一版对比」
- **THEN** 显示 `定稿.md` 与 `v004.md` 的全文对比，front-matter 不参与

#### Scenario: 定稿上不能批注

- **WHEN** 选中「定稿」
- **THEN** 顶栏批注铅笔置灰，提示「定稿是交出去的记录，要改请回到原稿或交付稿」

### Requirement: 定稿的失败与降级

以下情况 SHALL 返回 400 并说清出路，工作空间不变：工作空间缺 `scripts/finalize_delivery.py`（提示更新工作空间模板）、
找不到 Python 3、找不到 anydoc 或 node、选中文件不是 `.docx`、选中文件在定稿前被移走。
看板 SHALL NOT 在脚本缺失时自己复制或转换。

#### Scenario: 实例还没有脚本

- **WHEN** 工作空间是旧模板，没有 `finalize_delivery.py`，用户点「定稿」
- **THEN** 不弹选文件框，提示「这个工作空间还没有定稿脚本，先更新工作空间模板」

#### Scenario: 选完后文件被移走

- **WHEN** 用户选完文件、确认前把它从下载目录删了，然后点「确认定稿」
- **THEN** 接口返回 400「选中的文件已经不在了，请重新选择」，工作空间不变
