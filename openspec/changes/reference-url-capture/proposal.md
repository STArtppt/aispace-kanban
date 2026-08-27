## Why

`reference-prototype-view` 把「参考」立成了看板里的一等公民，但那一版全程只读 ——
参考得由用户自己把网页另存成自包含 HTML、再手工摆成 `visualization/references/<名字>/index.html`。
浏览器的「另存为」存出来的是一个 `.html` 加一个同名资源目录，摆不成这个形状；
真按约定摆一份要好几步。结果就是：目录立好了，没人往里放东西，接手阶段
「看别人怎么做」这件事还是散在各人的下载目录里。

在看板上贴一个 URL 就能把公开页面收进当前工作空间，是让这个目录真正被用起来的最短路径。

## What Changes

- **参考 tab 顶部加 URL 输入 + 「采集」按钮。** 用户贴一个公开可访问的 URL，
  服务端用独立子进程调用 PATH 上的 `single-file`，把页面存成自包含 `index.html`，
  连同 `meta.json` 落进 `visualization/references/<slug>/`。
- **采集任务仿 ingest 的任务表**：同一工作空间同一时刻最多一个进行中的采集；
  前端能看到「进行中 / 成功 / 失败原因」；落盘后靠 SSE 刷新清单。
- **所有 mutation 接口补跨站校验**：`Sec-Fetch-Site` / `Origin` 表明请求来自其它站点时一律拒绝。
  这条不只保护新接口 —— 现有的 ingest / 忽略 / 新建工作空间 / 移出看板同样暴露在
  「任意网页往 `127.0.0.1` POST」之下，一起补上。
- **`AGENTS.md` 第 1 节的不变量补上这条窄例外**，避免下一次会话把这处写入当成 bug。

v0 明确不做：登录态 / 友商后台的重抓（那是采集插件的事）、Playwright 降级、
截图与预览视频、品牌令牌提取、在界面上删除参考、接收 annotation-collect 的采集包
（等那边的契约落定后单独立 change，届时直接复用本 change 的写入收口）。

## Capabilities

### New Capabilities
- `reference-capture`: 从公开 URL 采集参考页并落进 `visualization/references/`，
  包括发起方式、失败时怎么说、写入边界、跨站防护。

### Modified Capabilities
- `reference-library`: 增加一条 —— 参考的 `source` 可以是 `url-capture`，
  且此时 `meta.json` 记着源 URL、采集时间与 `scrubbed: false`。

## Impact

落在服务端 + 契约 + 前端，不动 CLI 和模板。

| 平面 | 影响 |
| --- | --- |
| 服务端 `src/server/**` | `references.mjs` 增加写入收口；新增采集接口与任务表；`resolveInside` 提到共享模块；所有 mutation 接口加跨站校验 |
| 契约 `src/app/lib/api.ts` | **要改**：新增「发起采集」「查采集任务」两条 API 与其类型 |
| 前端 `src/app/**` | 参考 tab 的 URL 输入、采集按钮、任务状态与失败文案 |
| CLI `bin/cli.mjs` | 不动（写接口走现有 `allowMutations`，非环回 403） |
| `templates/` | 不动 |

**依赖：** **不**把 `single-file-cli` 写进 npm `dependencies` —— 它是 AGPL-3.0，
只能当独立可执行文件用。服务端在 PATH 上找、用子进程 `spawn`，永不 `import`；
找不到就明确告诉用户缺了什么、怎么装。前端不引新包。不引入 Playwright。

**兼容性：** 采集接口是新增的，旧前端不会调；新前端在服务进程还没重启（接口 404）时
禁用采集按钮并说明要重启，参考清单照常显示。

---

## 需要人拍板：放宽只读红线

这是本仓**第一次**让看板进程自己往工作空间里写文件（现有的 ingest 是 spawn 工作空间自己的
`scripts/ingest.py`，写盘的是脚本，不是看板）。

**建议拍板的范围（窄）：**

1. **只允许写 `<工作空间根>/visualization/references/`。** 其它目录（`input/` `output/` `visualization/prototypes/`、
   `project.yaml`）看板仍然只读。
2. **必须用户明确发起。** 只有一条入口：用户在看板上贴 URL 点采集。
   没有后台自动抓、没有定时任务、没有「顺便帮你存一份」。
3. **必须环回。** `--host` 不是环回时一律 403，跟现在的 ingest / 忽略 / 新建工作空间同一条闸。
   并且叠加跨站校验：环回不等于可信，任意网页都能往 `127.0.0.1` 发 POST。
4. **路径必须过 `resolveInside()`。** slug 由服务端生成，不接受客户端指定的相对路径。
5. **这是看板写工作空间的唯一场景。** 批注回流、文档修改、原型生成都不走这条口。
   将来的插件接收端可以复用这个收口，但不得扩大它的目录范围。

如果这条不批：参考只能手搓文件丢进目录，看板退回「只扫不采」——
`reference-prototype-view` 已经能独立工作，本 change 整体作废，不影响那一版。

拍板通过后，`AGENTS.md` 第 1 节的不变量清单要补上这一条。
