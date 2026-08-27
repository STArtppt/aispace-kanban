## ADDED Requirements

### Requirement: 用户可贴 URL 采集公开页面

参考 tab MUST 提供 URL 输入和「采集」动作。
用户点采集后，服务端 MUST 用独立子进程调用 PATH 上的 `single-file`（即 single-file-cli），
把目标页存成自包含 `index.html`，连同 `meta.json` 写入 `visualization/references/<slug>/`。
看板 MUST NOT `import` single-file 的源码，MUST NOT 把它写进 npm `dependencies`。
slug MUST 由服务端生成，MUST NOT 接受客户端传入的相对路径。
同一工作空间同一时刻 MUST 最多一个进行中的采集任务；进行中再点采集 MUST 被拒绝并说明原因。
采集过程 MUST 能在界面上看到进行中状态；完成后靠 SSE 刷新清单。
界面 MUST 说清适用范围：只适合不用登录就能看的页面，且采下来的是页面当时的全部内容、不做脱敏。

#### Scenario: 采集公开页面成功
- **WHEN** 用户在参考 tab 贴一个可公开访问的 URL 并点采集，本机 PATH 上有 `single-file`
- **THEN** 任务结束后 `visualization/references/<slug>/index.html` 和 `meta.json` 存在
- **AND** `meta.json` 记着源 URL、标题、采集时间、`source: url-capture`、`scrubbed: false`
- **AND** 参考清单出现新卡片，点击能打开刚采下来的页面

#### Scenario: 未安装 single-file
- **WHEN** 用户点采集，但本机 PATH 上找不到 `single-file`
- **THEN** 界面说明缺的是 `single-file`（single-file-cli），**并给出可直接复制的安装命令**
- **AND** `visualization/references/` 下不留下半成品目录

#### Scenario: 目标页抓不到
- **WHEN** URL 无法访问或 single-file 非零退出
- **THEN** 界面用工具返回的原因说明失败，不写「操作失败请重试」这类空话
- **AND** 不留下缺 `index.html` 的目录

#### Scenario: 采集超时
- **WHEN** single-file 子进程超过 120 秒仍未结束
- **THEN** 子进程被杀掉，任务判失败并说明是超时
- **AND** 临时文件被清干净，`visualization/references/` 下不留下半成品目录

#### Scenario: 产物过大
- **WHEN** 采集产出的 HTML 超过 64 MB
- **THEN** 任务判失败并说明产物过大，不写入 `visualization/references/`

#### Scenario: 同一 URL 采第二次
- **WHEN** 用户对已经采过的同一个 URL 再点一次采集
- **THEN** 生成新的 slug（如 `<slug>-2`），原有目录内容不被覆盖、不被删除

#### Scenario: 已有任务进行中
- **WHEN** 同一工作空间已有一个采集任务在跑，用户又点了采集
- **THEN** 请求被拒绝并说明「已有采集在进行中」，不起第二个子进程

### Requirement: 写入范围只限 visualization/references/

采集的写路径 MUST 只在 `<工作空间根>/visualization/references/` 下创建目录和文件，
且 MUST 先经过 `resolveInside()`。
`input/`、`output/`、`visualization/prototypes/`、`project.yaml` MUST NOT 被这条路径改动。
看板 MUST NOT 删除或覆盖 `visualization/references/` 下已有的目录。
临时文件 MUST 写在目标 slug 目录之外，成功后再移入；失败 MUST 清干净。

#### Scenario: 客户端不能指定写入路径
- **WHEN** 采集请求体里夹带 `../../output/docs` 一类路径字段
- **THEN** 服务端忽略该字段，只写入自己生成的 `visualization/references/<slug>/`；`output/` 不被改动

#### Scenario: 采集失败不改其它目录
- **WHEN** 一次采集失败（缺二进制、目标不可达、超时或产物过大）
- **THEN** `input/` `output/` `visualization/prototypes/`、`project.yaml` 的文件列表与内容与采集前一致

#### Scenario: 采集不删已有参考
- **WHEN** `visualization/references/` 下已有若干参考，用户发起并完成一次新的采集
- **THEN** 已有的参考目录一个都没被删除或修改，只多出新采的那一份

### Requirement: 写接口必须环回且非跨站

采集接口 MUST 走 `allowMutations`：非环回监听时 MUST 返回 403。
除此之外，所有会写盘或起子进程的接口（含现有的资料转换、忽略文件、
新建工作空间、移出看板）MUST 校验请求来源：`Sec-Fetch-Site` 表明来自其它站点时 MUST 拒绝；
没有该头但 `Origin` 与本机服务不符时 MUST 拒绝。
只读接口（扫描、读文件、SSE）MUST NOT 受这条影响。

#### Scenario: 非环回禁止采集
- **WHEN** 看板以非环回地址监听，有人 POST 采集接口
- **THEN** 返回 403，工作空间里没有任何新文件

#### Scenario: 跨站请求被拒
- **WHEN** 用户浏览器里另一个网站向 `127.0.0.1` 的采集接口发起 POST
  （请求带 `Sec-Fetch-Site: cross-site`）
- **THEN** 返回 403，不起子进程、不写盘

#### Scenario: 跨站防护覆盖既有写接口
- **WHEN** 同样的跨站 POST 打向资料转换、忽略文件、新建工作空间、移出看板任一接口
- **THEN** 同样返回 403

#### Scenario: 只读接口不受影响
- **WHEN** 以只读分享方式（非环回监听）访问扫描、读文件、SSE
- **THEN** 照常返回数据，不因为这次改动被拒

### Requirement: 服务进程未重启时前端安全降级

参考 tab MUST 在采集接口还不存在时（新前端配上还没重启的旧服务进程）
禁用采集按钮并说明需要重启看板服务；参考清单 MUST 照常显示，MUST NOT 白屏或抛错。

#### Scenario: 采集接口还不存在
- **WHEN** 前端已是带采集入口的新构建，服务进程尚未重启，采集接口返回 404
- **THEN** 采集按钮禁用并提示重启看板服务，已有参考照常列出
