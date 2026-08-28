## Why

`visual-capture-engine` 让看板能贴 URL 采集公开页面,但那条路有个走不通的地方 ——
**登录后的深层页面**。这是接手项目时最想收的一类:友商后台、内部系统、要登录才看得到的
功能界面。相邻仓 acgogogo 在这上面栽过:SPA 把 token 放 `localStorage`,而 single-file
只注入 cookies,抓下来的产物是登录页,任务却显示「采集完成」。它为此叠了 storageState 注入、
登录页检测、自动重走入口三层补丁,仍然只是降级。

annotation-collect 的**采集款 v0 已经落地**,它绕开了这个问题:扩展跑在页面自己的上下文里,
会话是真的、当前视图状态是真的,内联资源时 `fetch` 自带登录态。它已经能把整页快照、
元素片段和文字批注打成一个采集包,经**回环 POST** 投给宿主 —— 而它的默认投递目标就是
`http://127.0.0.1:7788/capture-package`,7788 正是本仓的默认端口。

**那边等的就是这条接收端。** 契约已经定稿(格式 C、投递 D,v0 冻结),
`visual-capture-engine` 的写入收口也已经在了。不做这件事,登录态那一半就一直收不进工作空间。

## What Changes

- **新增一条接收端 `POST /capture-package`**,路径与端口就用扩展默认值,
  **不自造 `/api/...` 前缀** —— 否则每个用户装完扩展第一件事是手改配置。
- **按契约 C 校验再落盘。** 先看 `format` 与 `version`:不认识的格式或高于己知的版本
  **明确拒绝**(扩展有 `refused-by-host` 分支在等这个响应),不解析到一半崩掉。
- **落盘走 `visual-capture-engine` 已经拍板的那个写入收口**,产物摆成
  `visualization/references/<slug>/` —— 和贴 URL 采下来的参考同一个形状、同一面墙、
  同一个查看器。包里的 `manifest.json` 与 `summary.md` 一起落,那正是这个包
  「一半读者是 AI」的设计目的。
- **`source: plugin`、`scrubbed: true`。** 扩展侧的脱敏默认开启,但那是尽力而为的模式匹配,
  **不是安全保证** —— 包自带的免责声明原样落进 `meta.json`,不改写、不加强语气。
- **放行扩展来源。** `visual-capture-engine` 那条「跨站一律拒绝」会把扩展一刀拒掉:
  它的请求来源是 `chrome-extension://<id>`,不是同源。本 change 在那个**共用的来源判定函数**
  里加一条分支,**先实测扩展请求实际带哪些头,再写 spec** —— 不凭猜。
- **响应按契约 D 回**:`{ accepted: true, location, hostItemId }`,`location` 是给人看的落点,
  扩展会把它显示出来。

v0 明确不做:接收样式改动载荷(P2,那边 v0 也不产)、把采集包塞进 `input/` 的转换管线、
在界面上删除条目、任何形式的自动接收(必须是用户在扩展里点投递)。

## Capabilities

### New Capabilities
- `capture-package-inbox`: 接收 annotation-collect 采集包的端点,包括契约校验与版本协商、
  载荷到参考条目的映射、来源放行、失败时怎么回。

### Modified Capabilities
- `reference-library`: 增加一条 —— 参考的 `source` 可以是 `plugin`,
  此时 `meta.json` 记着包的来源页面、投递时间、`scrubbed: true` 与那句免责声明。

## Impact

只落在服务端 + 契约的一小块 + 一处前端文案;不动 CLI 和模板。

| 平面 | 影响 |
| --- | --- |
| 服务端 `src/server/**` | 新增 `capture-inbox.mjs`(校验 + 落盘);复用 `visual-capture-engine` 的写入收口与 slug 生成;来源判定函数加一条分支 |
| 契约 `src/app/lib/api.ts` | **几乎不用改** —— 接收端不是给看板前端调的。参考条目的 `source` 已经预留了 `plugin` 取值 |
| 前端 `src/app/**` | 参考卡片显示 `plugin` 来源;参考 tab 的说明里提一句「需要登录的页面用采集插件」 |
| CLI `bin/cli.mjs` | 不动 |
| `templates/` | 不动 |

**依赖:** 不引任何新包。

**兼容性:** 端点是新增的;旧服务进程没有它时扩展会收到连接失败,
按它自己的 `target-unreachable` 分支提示用户并**保留批次不清空**,数据不会丢。

---

## 需要人拍板:采集包的落盘形态(第一个宿主定)

annotation-collect 的 `packages/collect/src/format.ts` 里写着:**包的物理形态
(zip 还是目录)刻意没定,等第一个宿主接入时再拍板。** 看板就是那个第一宿主。

**建议:目录形态,摊平进现有的参考条目。**

```
visualization/references/<slug>/
  index.html      # 包里的整页快照;没有整页快照时用第一个元素片段
  manifest.json   # 包的清单,原样落
  summary.md      # 包的人类可读摘要,原样落
  meta.json       # 看板这边的元数据:source: plugin、scrubbed、免责声明、原包版本
```

这样它天然被现有的扫描认出来(判据仍是「目录根上有 `index.html`」)、天然能点开、
天然进同一个查看器,**不用为采集包另开一套展示**。

⚠️ **一个包里可能一张页面都没有**(纯文字批注)。这时看板 MUST 拒收并说清原因,
**MUST NOT 自己造一个 `index.html` 出来** —— 看板写进工作空间的东西只能是包里带来的,
不能是自己生成的内容。

拍板通过后要回流一句到 annotation-collect 的 `AGENTS.md`,把「物理形态待定」改成
「第一个宿主定为目录形态」,免得下一个宿主再纠结一遍。

**只读红线不用再动。** 本 change 复用 `visual-capture-engine` 已经拍过的那条窄例外,
写入范围不扩大一寸:仍然只写 `visualization/references/<slug>/`、仍然只新建不覆盖、
仍然必须环回。唯一新增的是「用户在扩展里点投递」这个发起方式 ——
它同样是**用户每次明确触发**,符合那条例外的第 2 款。
