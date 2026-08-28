## Why

`visual-showcase-view` 把「视觉呈现」立成了看板的第四个视图,定死了参考条目和原型条目的
目录形状,但那一版全程只读 —— 东西得由用户自己摆进去。而参考的正确形状是
「一份带交互的原始页面 + 三张截图 + 一份元数据」,浏览器的「另存为」存出来的是一个
`.html` 加一个同名资源目录,摆不成这个形状,截图更是要手动截三次。结果就是:
目录立好了,没人往里放东西,接手阶段「看别人怎么做」这件事还是散在各人的下载目录里。

原型那边是同一个问题的另一半:axhub-make 发布到云端、figma make 的 publish / share
都只给一条链接,用户要么把链接记在别处,要么手写一份 `meta.json`。

**在看板上贴一个 URL 就能把它收进当前工作空间**,是让这两个目录真正被用起来的最短路径。
而且两件事共用同一套东西:一个 headless 浏览器截图、一个写入收口、一次只读红线的拍板。
分开做等于把地基砌两遍。

## What Changes

- **参考 tab 顶部加 URL 输入 + 「采集」按钮。** 用户贴一个公开可访问的 URL,服务端产出:
  - `index.html` —— 独立子进程调 PATH 上的 `single-file`,自包含、带交互;
  - `screenshots/hero.png`(桌面标准屏 1920×1080 首屏)、`full.png`(完整页面长图)、
    `mobile.png`(移动端响应式);
  - `meta.json` —— 源 URL、标题、采集时间、`source: url-capture`、`scrubbed: false`。

  整份落进 `visualization/references/<slug>/`,正是上一个 change 定死的形状。
- **原型 tab 加 URL 导入。** 贴一条云端发布链接,只截一张封面,落
  `visualization/prototypes/<slug>/` 下的 `cover.png` + `meta.json`(`kind: "url"`),
  **不抓页面本体** —— 那类原型是 SPA,抓下来既失真又没必要,点击就该开原站。
- **截图靠 Playwright,但它不进 `dependencies`。** 运行时探测:装了就出图,
  没装就降级(参考只出 `index.html`,原型只出 `meta.json`),任务仍算成功,
  界面明确说少了什么、怎么补。看板是 `npx` 起的轻量工具,不该为一个可选功能
  让所有人多下一个 Chromium。
- **采集核心是从相邻仓移植的,不是新写的。** acgogogo 的 `daemon/capture/` 已经趟过
  single-file 的坑,只搬「抓自包含 HTML」和「三档截图」两段,**不搬** 登录态注入、
  预览视频、多状态截图、品牌提取、agent 分析。
- **采集任务表仿 ingest**:同一工作空间同一时刻最多一个进行中的采集;
  前端能看到「进行中 / 成功(可能带降级)/ 失败原因」;落盘后靠 SSE 刷新清单。
- **所有 mutation 接口补跨站校验**:`Sec-Fetch-Site` / `Origin` 表明请求来自其它站点时一律拒绝。
  这条不只保护新接口 —— 现有的 ingest / 忽略 / 新建工作空间 / 移出看板同样暴露在
  「任意网页往 `127.0.0.1` POST」之下,一起补上。
- **`AGENTS.md` 第 1 节的不变量补上这条窄例外**,避免下一次会话把这处写入当成 bug。

v0 明确不做:登录态 / 友商后台的重抓(那是 `capture-package-inbox` 里浏览器插件的事)、
预览视频与多状态截图、品牌令牌提取、在界面上删除条目、接收 annotation-collect 的采集包
(单独立 change,直接复用本 change 的写入收口)。

## Capabilities

### New Capabilities
- `visual-capture`: 从 URL 把视觉材料收进 `visualization/`,包括发起方式、产物构成、
  截图分档与降级、写入边界、跨站防护。同时服务参考与原型两个入口。

### Modified Capabilities
- `reference-library`: 增加一条 —— 参考的 `source` 可以是 `url-capture`,
  且此时 `meta.json` 记着源 URL、采集时间与 `scrubbed: false`。
- `prototype-preview`: 增加一条 —— `url` 形态的原型可以由看板写入(而不只是用户手写)。

## Impact

落在服务端 + 契约 + 前端,不动 CLI 和模板。

| 平面 | 影响 |
| --- | --- |
| 服务端 `src/server/**` | 新增 `capture.mjs`(single-file 子进程 + Playwright 截图 + 任务表);`references.mjs` / `prototypes.mjs` 各增加写入收口;`resolveInside` 提到共享模块;所有 mutation 接口加跨站校验 |
| 契约 `src/app/lib/api.ts` | **要改**:新增「发起采集」「查采集任务」两条 API 与其类型(两种目标:参考 / 原型) |
| 前端 `src/app/**` | 参考 tab 与原型 tab 的 URL 输入、采集按钮、任务状态、降级说明与失败文案 |
| CLI `bin/cli.mjs` | 不动(写接口走现有 `allowMutations`,非环回 403) |
| `templates/` | 不动 |

**依赖:两个外部工具都不进 npm `dependencies`。**
- `single-file-cli` 是 AGPL-3.0,只能当独立可执行文件用:在 PATH 上找、用子进程 `spawn`,
  **永不 `import`**;找不到就明确告诉用户缺了什么、怎么装。
- `playwright` 体积大且要另外下浏览器,做成运行时探测(动态 `import`,失败即降级),
  不写进 `dependencies`,也不因为它缺席而让采集失败。

前端不引新包。

**兼容性:** 采集接口是新增的,旧前端不会调;新前端在服务进程还没重启(接口 404)时
禁用采集按钮并说明要重启,清单照常显示。

---

## 需要人拍板:放宽只读红线

看板要自己往工作空间里写文件了。

**这不是本仓第一次**:`AGENTS.md` 不变量 1 里已经有一条同形状的窄例外 ——
`addIgnore` 直接追加 `input/.ingestignore`(明确标注「不经过 ingest.py」)。
本 change 要立的是**第二条窄例外**,请按同一个模子审。

**建议拍板的范围(窄):**

1. **只允许写 `<工作空间根>/visualization/` 之下。** 具体是
   `visualization/references/<slug>/` 与 `visualization/prototypes/<slug>/` 两处。
   `input/` `output/` `project.yaml` 看板仍然只读。
2. **必须用户明确发起。** 只有一条入口:用户在看板上贴 URL 点采集。
   没有后台自动抓、没有定时任务、没有「顺便帮你存一份」。
3. **必须环回。** `--host` 不是环回时一律 403,跟现在的 ingest / 忽略 / 新建工作空间同一条闸。
   并且叠加跨站校验:环回不等于可信,任意网页都能往 `127.0.0.1` 发 POST。
4. **路径必须过 `resolveInside()`。** slug 由服务端生成,不接受客户端指定的相对路径。
5. **只新建,不覆盖、不删除。** 同一 URL 再采一次生成新 slug;看板没有 `unlink` 工作空间
   文件的权限,删除由用户自己在文件系统里做。
6. **将来的插件接收端可以复用这个收口,但不得扩大它的目录范围。**

如果这条不批:参考只能手搓文件丢进目录、原型链接只能手写 `meta.json`,看板退回「只扫不采」——
`visual-showcase-view` 已经能独立工作,本 change 整体作废,不影响那一版。

拍板通过后,`AGENTS.md` 第 1 节的不变量清单要补上这一条。
