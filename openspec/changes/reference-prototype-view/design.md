## Context

看板第四个视图现在叫「原型」，实现已经跟 Axhub 解耦：`prototypes.mjs` 认任何
`<子目录>/index.html` 或 zip，看板自己伺服。空态和注释还停在「axhub-make 导出包」。
工作空间判据只认 `input/` + `output/`，`prototypes/` 本来就是可选的顶层目录。

刚接手一个项目时，先出现的不是这些 HTML 包，而是线上系统、友商后台、公开文档站。
这和 `input/raw/` → `ingest.py` → `input/converted/` 不是同一条路：原始文档要转成
AI 可读的 Markdown / CSV；参考页要保持「当时看到的页面」，离线还能点。

相邻两个仓已经把这件事分成两条采集路：

- **公开页面**：acgogogo 的 daemon 用独立子进程 `spawn('single-file', …)` 抓自包含 HTML
  （AGPL-3.0 边界：不 import 源码）。登录后的 SPA 这条路会静默失败（token 在
  localStorage，注入 cookie 不够），所以它不是万能方案。
- **登录后的深层页面**：annotation-collect 规划成浏览器扩展，在页面自己的上下文里
  序列化，再经回环 POST 投递给宿主。插件仓只定契约，接收端由宿主自己做，并且已经
  写明会撞看板的只读红线。

本 change 是看板这边把「参考」立成一等公民：目录、扫描、展示、公开页采集、插件接收。
现有 `annotate-to-agent-loop`（预览里批注 markdown）是另一件事，互不阻挡。

## Goals / Non-Goals

**Goals:**

- 第四个视图改成「参考&原型」，两个 tab 分开展示两类 HTML。
- 视觉材料归到 `visualization/`，和 `input/` `output/` 的文档平面分开。
- 公开 URL 能从看板采下来，落进 `visualization/references/`，给人和 AI 共用。
- 给 annotation-collect 留一个环回接收口，包落到同一个目录。
- 原型识别规则（子目录 `index.html` / zip / 看板伺服）保持原样，落点改到 `visualization/prototypes/`；根上旧 `prototypes/` 只读兼容。只清 axhub-make 文案。
- 把「看板可以写 `visualization/references/`」写成窄例外，写进 `AGENTS.md`，避免下次当成 bug。

**Non-Goals:**

- 不搬 acgogogo 的 Playwright、ffmpeg、品牌令牌、多状态、登录态 cookie 注入。
- 不实现 annotation-collect 插件，不把那份契约的 TypeScript 类型 vendored 进来
  （插件仓自己还没写完 `deliver.ts`）。看板定义一份足够小的 JSON 接收形状，两边对齐。
- 不把参考送进 `ingest.py`，不把 HTML 转 Markdown。
- 不在参考页上做批注（那是插件或后续 change）。
- 不改 `inspectWorkspace` 的判据。
- 不为了封面图引入 Playwright。v0 没封面就用现成的浏览器窗框占位。

## Decisions

### 1. 视觉平面用 `visualization/`，下面再分 `references/` 和 `prototypes/`

工作空间根上的材料分成两类：`input/` `output/` 是文档（要转换、要写、要给 AI 读正文）；
「参考&原型」是给人看、能点开的页面。用一个顶层目录把这件事说清楚，两个 tab
各自对应一个子目录：

```
visualization/
  references/     # 采下来的页面
  prototypes/     # 自己做出来的可点击包
```

参考是「当时的页面」，原型是「自己做出来的可点击产物」，两者生命周期不一样，
所以在 `visualization/` 里仍然分开，不混扫。

**备选 A：`input/references/`。** 不选。`input/` 的契约是 raw → converted → assets，
看板在那里的写入只有 spawn `ingest.py` 和追加 `.ingestignore`。把采集塞进去等于
让「转换管线」和「页面快照」共用一套忽略 / 待处理逻辑，空态和统计都会被污染。

**备选 B：根上并列 `references/` 和 `prototypes/`。** 不选。这是本 change 初稿。
两个顶层目录看不出它们和文档平面的差别，也撑不起「参考&原型」这个视图名 ——
视图谈的是可视化，目录却和 `input/` 平级、彼此无关。

**备选 C：参考直接混在 `prototypes/` 或 `visualization/` 根上。** 不选。混放之后
「刚接手只有参考」和「已经有原型」分不开，zip 解压缓存也会误伤参考。

**备选 D：写到看板缓存，不进工作空间。** 不选。路线图里对「抓远端原型」曾经这么想，
那是为了保住只读红线。参考的读者包括本机 agent，必须能在工作空间里被找到。

代价：新建工作空间的骨架从根上 `prototypes/` 改成 `visualization/` 两棵空树。
老工作空间没有 `visualization/` 时参考走空态；根上旧 `prototypes/` 见决策 8，不搬家。

### 2. 看板进程自己写 `visualization/references/`，不经工作空间脚本

ingest 的模式是「看板 spawn 工作空间自己的脚本，脚本写盘」。采集做不到同一套：
`single-file` 是主机上的工具，不是工作空间模板里的脚本；插件投递更是 HTTP 进看板进程。
再套一层 `scripts/capture.py` 只会让每个老工作空间都缺脚本，插件还是得打到看板上。

所以这是比 ingest 更进一步的例外：**看板进程写工作空间**。proposal 里已经单独成段
等人拍板。实现上把写入收口到一个模块（例如 `src/server/references.mjs`），
只允许在 `resolveInside(root, 'visualization/references/' + slug)` 之下 `mkdir` / `writeFile`。

**备选：继续只 spawn 工作空间脚本。** 不选，理由见上 —— 插件接收没有脚本可 spawn，
老模板也没有采集脚本。

**备选：采集写缓存、只把一份指针写进工作空间。** 不选。指针对 AI 没用，拷贝工作空间
会丢参考本体。

### 3. 公开页采集只 spawn `single-file`，v0 不做 Playwright 降级

跟 acgogogo 同一条 AGPL 边界：`spawn('single-file', args)`，永不 `import`。
找不到二进制就失败并说明缺什么，不在 npm `dependencies` 里带它
（组包脚本会按 import 图重算依赖，带上会把 AGPL 传染进看板包）。

acgogogo 在 single-file 失败时降级 Playwright DOM 快照，还带截图 / 视频 / 登录态。
那是另一个产品的主链路。看板 v0 只做「公开页面、用户贴 URL」。
登录后的友商系统走插件 —— 那正是 annotation-collect 存在的原因。

**备选 A：把 Playwright 引进看板做降级和封面。** 不选。体积、平台安装、常驻进程里
再养一套浏览器，都超过这个视图该付的成本。封面缺失用现有占位即可。

**备选 B：扩展里 import SingleFile。** 不选，而且那是插件仓的决策，本仓根本不跑扩展。
法律上也不允许：扩展没有「独立子进程」这层隔离。

**备选 C：让用户先在 acgogogo 采完再手工拷过来。** 不选。刚接手时人不该为了存一张
页面先开另一个产品。公开 URL 这条看板自己做；复杂采集留给插件。

采集是慢操作，复用 ingest 的任务表：同一工作空间同时只跑一个，前端看进行中状态，
落盘后靠 SSE 刷新。临时文件写在目标 slug 目录外，成功再移入，失败就删干净。

### 4. 插件接收用小份 JSON，不跟尚未写完的契约 D 绑死

annotation-collect 的投递接口还停在「只定类型」的任务上，包是 zip 还是目录也没定。
看板 v0 接收：

```json
{
  "formatVersion": 1,
  "title": "可选",
  "sourceUrl": "可选",
  "html": "<!doctype html>…",
  "screenshotPngBase64": "可选",
  "summary": "可选 markdown",
  "manifest": {}
}
```

`formatVersion` 必须是看板认识的整数（v0 = 1）；更大就 4xx。
`html` 必填，写成 `index.html`；其它字段有就落盘、没有就缺省。
请求体设上限（建议 8MB JSON），超了明确拒绝，避免把常驻进程撑爆。

**备选 A：等插件仓把契约 D 写完再做接收端。** 不选。视图和 URL 采集不该被另一个仓
的进度堵住；先定落盘形状，插件以后按这个形状 POST 即可。zip 接收可以下个 change 再加。

**备选 B：v0 就收 zip 并解压。** 不选。看板已经有 zip → 缓存的路径，但那条**不写回
工作空间**。插件包必须进工作空间才能给 AI 读，解 zip 写盘的攻击面比 JSON 字段大，
留给契约稳定之后。

### 5. 展示复用 acgogogo 的交互，不复制它的组件和视觉

参考 tab：卡片网格、16:10 预览、标题 + 来源 URL、顶部贴 URL 采集。
封面有就用图，没有就用 `PrototypePanel` 已经在用的浏览器窗框占位。
tab 用现成的 startist `Tabs`（`CreateWorkspaceDialog` 用过 segmented）。
点击参考与点击原型一样：新窗口打开看板伺服地址。

不把 acgogogo 的 `CaptureGrid` 拷进来：那份有预览视频、品牌方块、28px 大圆角、
独立 i18n，和看板「黑白灰、无阴影、orange 只给需要注意」冲突。

**备选：iframe 缩略图当封面。** 不选。每张卡片一开就是一份完整 HTML，列表一长就卡。

**备选：参考在阅读器里打开，不新窗口。** 不选。自包含 HTML 常常自带脚本和样式，
塞进看板预览栏会和外壳抢布局；原型已经是新窗口，两条 tab 保持一致。

### 6. 视图路由键保持 `prototypes`（这是 UI 状态，不是目录名）

侧栏文案改成「参考&原型」，`useBoardSession` 的 `View` 仍是 `'prototypes'`。
上次打开的视图、概览 `onGoto`、localStorage 都不用迁移。
tab 自己的选中状态另存（例如 `aispace-kanban:refs-tab`），缺省为 `reference`。

**备选：改成 `'references'` 或 `'refs-and-protos'`。** 不选。收益只是名字更贴切，
代价是每个人的「上次视图」掉回概览，还要改一串类型。不值。

### 7. 契约新增可选字段，写接口走现有 mutation 闸

`Scan.references?` 可选，前端缺字段就显示「重启服务」。
采集、接收两条 POST 与 ingest 一样过 `rejectIfRemoteWrite`。
静态伺服仿原型：`/api/projects/:id/ref/:slug/…`，路径过 `resolveInside`，
只从 `visualization/references/<slug>/` 往外读。
SSE 的 `watchWorkspace` 监听 `visualization/`（递归覆盖两个子目录），
并继续听根上的 `prototypes/`（老工作空间还把包放在那儿）。

模板平面：`init_workspace.py` 的 `BASE_DIRS` 把根上 `prototypes` 换成
`visualization/references` 和 `visualization/prototypes`；PM 模板约定写明
`visualization/` 是视觉平面，两个子目录分别给参考和原型。
不在模板里放示例 HTML（放进去就是发给每个新工作空间）。

### 8. 根上旧 `prototypes/` 只读兼容，看板不搬家

已经在用的工作空间把 HTML 包放在根上 `prototypes/`。看板对工作空间只读
（写例外只覆盖 `visualization/references/`），所以 **不能** `rename` 到新位置。

扫描原型时两个根都认：

1. `visualization/prototypes/`（新约定，优先）
2. 工作空间根上的 `prototypes/`（旧位置）

同一 slug 两边都有时，新位置赢。卡片上的 `sourcePath` 写成实际相对路径，
人能看出这份包在哪。空态和新模板只提 `visualization/prototypes/`。

**备选 A：实施时自动把旧目录搬过去。** 不选。那是写工作空间，而且超出已拍板的
写入范围。

**备选 B：只认新路径，旧包从界面消失。** 不选。现有工作空间的原型 tab 会空掉，
这是回归。

## Risks / Trade-offs

- **只读红线被开一个口，以后容易被顺手加宽。** → 写入收口到一个模块；
  `AGENTS.md` 写明「只写 `visualization/references/`、必须用户发起、必须环回」；
  code review 时看到别的目录的 `writeFile` 就按 bug 拦。
- **同一工作空间里新旧原型目录并存。** → 扫描合并、新位置优先；不删不搬旧目录。
  空态只教新路径，避免新文件继续写到根上。
- **single-file 抓到的是登录页，任务却显示成功。** 这是已知坑。
  → v0 文案写清「只适合不用登录就能看的页面；登录后的系统请用采集插件」。
  不在看板里做登录态检测（那会把 Playwright 和会话存储引进来）。
- **自包含 HTML 体积大，JSON 接收能把进程打满。** → 请求体上限；采集子进程超时杀掉；
  失败不留半成品。
- **AGPL 边界稍有不慎就进包。** → 禁止 import；组包脚本扫的是 import 图，
  spawn 字符串不会把 single-file 打进 tgz。文档和注释写明这条。
- **旧进程 + 新前端。** → `references` 字段可选；采集按钮在字段缺失时禁用并说明要重启。
- **插件仓格式以后变了。** → `formatVersion` 硬拒绝未知版本，总比静默写坏目录好。

## Migration Plan

- 老工作空间什么都不用搬：没有 `visualization/` 时参考走空态；根上 `prototypes/`
  里的包仍出现在原型 tab。新建的带 `visualization/references/` 和
  `visualization/prototypes/` 两棵空树，不再铺根上的 `prototypes/`。
- 前端先上时如果忘了重启服务，参考 tab 自己说明，原型不受影响。
- 回退：停掉新服务、换回旧前端即可。已经采进 `visualization/references/` 的文件
  留在磁盘上，旧版本看不见它们，也不会删。根上旧 `prototypes/` 旧版本本来就会扫。

## Open Questions

1. **JSON 接收的体积上限取多少。** 倾向 8MB。单页 single-file 产物经常到两三 MB，
   再加 base64 封面会涨；定太小插件投不进来，定太大根进程。实施时按一条真实公开页
   的产物体积校准，写进接口报错文案。
2. **要不要在 `meta.json` 里记「未脱敏」。** URL 采集没有脱敏管线；插件包的脱敏由
   插件做。倾向 meta 里加 `scrubbed: boolean`，看板自己采的恒为 `false`，
   好让 AI 知道这页可能带页面上的原文。不是安全保证。
3. **采集任务要不要像 ingest 那样推日志流。** 倾向 v0 只要「进行中 / 成功 / 失败原因」，
   不接 SSE 日志。single-file 的 stderr 对用户几乎不可读。
