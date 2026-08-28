> **前置:** `visual-showcase-view`(条目形状、扫描、伺服、查看器)与
> `visual-capture-engine`(写入收口、slug 生成、来源判定函数、只读红线的窄例外)
> 都必须已经落地。本 change **不再动只读红线**,只复用那条已拍板的窄例外。
> **前置:** proposal 末尾那段「采集包落盘形态」必须已经拍板(第一个宿主定,要回流对面仓)。

## 1. 先实测,再写实现

- [ ] 1.1 **抓一次真实的投递请求**:装上 annotation-collect 扩展的 dist,
      在看板服务前面临时挂一段只打印请求头的处理,在任意页面点一次投递。
      记下 `Origin`、`Sec-Fetch-Site`、`Content-Type`、有没有预检 OPTIONS。
      **把结果写进 design 决策 4,再决定放行走哪条路** —— 没有这一步不许写 2.x
- [ ] 1.2 造两个样例包备用:一个含整页快照 + 两条批注,一个只有文字批注(用来验拒收路径)。
      从对面仓的 `examples/` 合成页面上采,不用真实业务页面

## 2. 服务端:端点与契约校验

- [ ] 2.1 新增 `src/server/capture-inbox.mjs`,注册 `POST /capture-package`
      (**路径与端口照扩展默认值,不加 `/api` 前缀**);先过 `rejectIfRemoteWrite`
- [ ] 2.2 契约校验放在最前:`format` 不认识 → 4xx;`version` 高于己知最高版本 → 4xx
      并说明只认到哪一版。**两种情况都不写盘、不留半截产物**。
      验证:重启服务后 `curl` 一个 `version: 2` 的包,看到明确拒绝且工作空间无变化
- [ ] 2.3 来源放行:在 `visual-capture-engine` 留的**共用来源判定函数**里加分支,
      **只对 `/capture-package` 这一条路径生效**。按 1.1 的实测结果实现;
      实测若表明头信息不足以区分扩展与任意网页,改走「用户在看板上显式开启一次性接收窗口」,
      **不得对所有来源敞开**。验证:同样的头打向 ingest / URL 采集接口仍然被拒
- [ ] 2.4 目标工作空间取登记表里最近打开的那个,写进响应的 `location`

## 3. 服务端:落盘

- [ ] 3.1 走 `visual-capture-engine` 的写入收口与 slug 生成,**不新写一套**;
      写入范围仍只有 `visualization/references/<slug>/`
- [ ] 3.2 `index.html` 取包里的整页快照;没有就取第一个元素片段;
      **两者都没有 → 4xx 拒收并说明,绝不自己造 `index.html`**
- [ ] 3.3 `manifest.json` 与 `summary.md` **原样落**,不改写、不重排、不补字段
- [ ] 3.4 清单里其余载荷文件按清单里的相对路径落在同目录;
      清单里的路径**先过 `resolveInside()`**,越界的条目丢弃并记进响应说明
- [ ] 3.5 写 `meta.json`:`source: plugin`、`scrubbed`(如实)、包自带免责声明**原文**、
      原包 `format` / `version`、投递时间、来源页面地址。
      **不许把措辞改强**(不写「已安全脱敏」这类说法)
- [ ] 3.6 包体积超过 64 MB(沿用 `visual-capture-engine` 的上限)→ 4xx 并说明
- [ ] 3.7 成功响应按契约 D:`{ accepted: true, location, hostItemId }`

## 4. 前端(很小)

- [ ] 4.1 参考卡片显示 `source: plugin` 的来源(来源页面地址),与 `url-capture`、`manual`
      三种来源各自可辨认
- [ ] 4.2 参考 tab 的说明里补一句:需要登录才能看的页面用采集插件投进来,
      贴 URL 采集只适合公开页面

## 5. 回流对面仓

- [ ] 5.1 给 annotation-collect 提一处改动:`packages/collect/src/format.ts` 里
      「包的物理形态刻意没定,等第一个宿主接入时再拍板」改成
      「第一个宿主(aispace-kanban)定为**目录形态**」,并在它的 `AGENTS.md` §6
      把 aispace-kanban 那一行的「宿主侧待办」标为已实现。
      **这是对面仓的改动,单独提交,不混在本仓的提交里**

## 6. 冒烟脚本

- [ ] 6.1 `scripts/smoke-package.mjs` 补:`version: 2` 的包被拒且不写盘;
      纯批注(无 HTML 载荷)的包被拒且不写盘;
      清单里夹带 `../` 路径的条目被丢弃而其余正常落盘;
      非环回时端点 403;放行只对 `/capture-package` 生效(同头打 ingest 仍 403)

## 7. 验收闸

- [ ] 7.1 `pnpm typecheck` 绿
- [ ] 7.2 `pnpm build` 绿
- [ ] 7.3 重启 `pnpm serve` 后,用**真实扩展**从一个需要登录的页面投一次:
      看板参考 tab 出现卡片、能打开、内容是登录后的那一版(不是登录页)
- [ ] 7.4 用 1.2 的两个样例包各 `curl` 一次:成功那份的目录里有
      `index.html` / `manifest.json` / `summary.md` / `meta.json` 四件;
      纯批注那份被拒且工作空间无变化
- [ ] 7.5 写入范围验证:成功、拒收、越界路径三种情况跑完后,
      `input/` `output/`、`project.yaml` 与 `visualization/prototypes/` 都没被改动
- [ ] 7.6 深色模式下三种来源的参考卡片都可读,orange 不用于「插件来源」这种中性信息
