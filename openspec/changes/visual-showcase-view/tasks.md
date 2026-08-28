> 本 change 全程只读,不需要拍板。往工作空间写入的部分在 `visual-capture-engine`
> 与 `capture-package-inbox`。
> **这是一次破坏性目录变更**:原型从工作空间根上的 `prototypes/` 搬到
> `visualization/prototypes/`,不留双根。已有工作空间需要用户手工 `mv`。

## 1. 服务端:扫描视觉平面

- [ ] 1.1 新增 `src/server/references.mjs`:扫 `visualization/references/<slug>/index.html`
      认条目,读 `<title>`、可选 `meta.json`、可选 `screenshots/{hero,full,mobile}.png`;
      `meta.json` 缺失或坏掉时退回 `source: manual` + `<title>` 标题,**条目不消失**;
      没有目录或读不到时降级成空清单 + `note`,不抛
- [ ] 1.2 `prototypes.mjs` 扫描根改成 `visualization/prototypes/`,
      **不再扫工作空间根上的 `prototypes/`**。`bundle` 的识别规则(子目录 `index.html` /
      扫描根上的 `index.html` / zip)与改动前**逐条一致**;同步改 6 处 `sourcePath` 与 note 文案
- [ ] 1.3 `prototypes.mjs` 支持 `url` 形态:目录里没有 `index.html` 但有
      `meta.json` 且 `kind === 'url'` → 一条 `url` 原型,读 `title` / `target` / 可选 `cover.png`;
      `target` 不是 http/https 时标记不可点击。两者都没有的目录**直接忽略,不产占位卡片**
- [ ] 1.4 `prototypes.mjs` 加旧位置探测:根上 `prototypes/` 存在且非空时,
      在结果里带可选的 `legacyDir`。**只 `existsSync` + 判空,不读内容、不列卡片、不伺服**
- [ ] 1.5 在 `scan.mjs` 把参考结果挂到 `scan.references`(与 `prototypes` 并列)。
      缺 `visualization/` 时该字段**仍然返回空结构**,让新前端能区分「没有参考」和「旧进程没有这个字段」
- [ ] 1.6 `http.mjs` 加参考静态伺服 `/api/projects/:id/ref/:slug[/...]`:
      只从 `visualization/references/<slug>/` 往外读,路径过 `resolveInside()`,越界 403;
      缺省文件 `index.html`。截图走同一条路径(`screenshots/*.png`),同样过 `resolveInside()`
- [ ] 1.7 `http.mjs` 加查看器壳页 `/api/projects/:id/ref/:slug/view`:看板自己的 HTML,
      `<iframe>` 铺满装 `index.html`,左下角浮缩略图 + 灯箱,附一个「直接打开原始页面」出口。
      **一张截图都没有时不渲染缩略图区域。** 壳页本身不带 sandbox 头(它是看板的页面),
      被它装载的 `index.html` 带
- [ ] 1.8 参考 `index.html` 与原型 `bundle` 两条伺服路径的响应都加
      `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups`
      (**不给** `allow-same-origin`,**不给** `allow-top-navigation`)。
      验证:重启 `pnpm serve`,打开一份参考,在 iframe 的控制台里 `fetch('/api/projects')`
      被拒、`parent.document` 拿不到
- [ ] 1.9 `watchWorkspace` 递归监听 `visualization/`(覆盖两个子目录),
      并监听工作空间根(非递归)以捕获 `visualization/` **启动后才被创建**的情况,
      创建时补挂递归 watcher。验证:重启服务后在一个还没搬家的工作空间里跑一遍 `mv`,
      界面不手动刷新就出现原型卡片
- [ ] 1.10 清 axhub-make 口径:`prototypes.mjs` 的空态 `note` 与文件头注释、
      `http.mjs` 里「伺服 axhub-make 导出的 HTML 包」那行注释,改成「工具产出的可点击 HTML 包」,
      并补一句「只认已构建产物,源码包请先导出 HTML」。
      验证:重启后 `curl` 扫描接口,空原型的 `note` 里不再把 axhub 写成唯一来源

## 2. 契约 `src/app/lib/api.ts`

- [ ] 2.1 新增 `ReferenceItem` / `References` 类型;`Scan.references?` 做成**可选**,
      注释写明旧进程缺字段时前端怎么退。`source` 取值先写全
      (`manual` / `url-capture` / `plugin`),后两个是下两个 change 用的
- [ ] 2.2 `PrototypeItem` 增加 `kind: 'url'` 与可选的 `target` / `cover`;
      原有 `'folder'` / `'zip'` 取值不动(它们是 `bundle` 的物理形态)。
      注释写明前端据此决定「开看板伺服的 url」还是「开外部 target」
- [ ] 2.3 `Prototypes` 增加可选的 `legacyDir`(旧位置探测结果),注释写明它只用于迁移提示
- [ ] 2.4 `api.references(id)` 单独接口(与 `api.prototypes` 对称),字段与服务端对齐后再写 UI

## 3. 前端:视图壳与两个 tab

- [ ] 3.1 侧栏第四项文案改为「视觉呈现」;`View` 键保持 `'prototypes'`,不迁 localStorage
- [ ] 3.2 用现成 `Tabs` 做「参考 / 原型」;首次默认「参考」,选中状态存
      `aispace-kanban:visual-tab`,**不影响「上次打开的视图」**
- [ ] 3.3 新增 `ReferencePanel`:卡片网格(16:10、`hero.png` 当封面、没有就窗框占位、
      标题、来源),复用 `PrototypePanel` 现有的占位与卡片结构;空态说明「一份参考一个目录,
      入口叫 `index.html`,放在 `visualization/references/<名字>/`」
- [ ] 3.4 `scan.references` 缺失(旧进程)时,参考 tab 显示「当前看板服务还没有参考能力,
      重启看板服务后即可」,**不白屏、控制台不报错**;原型 tab 照常
- [ ] 3.5 「原型」tab 复用现有 `PrototypePanel`:`bundle` 卡片行为不变;
      `url` 卡片点击直接 `window.open(target)`,`target` 非法时卡片不可点击并说明;
      空态 hint 改成 `visualization/prototypes/`,写明只认已构建产物 + 云端链接
- [ ] 3.6 原型 tab 空态在 `legacyDir` 存在时多显示一行迁移提示 + 可复制的命令
      (`mkdir -p visualization && mv prototypes visualization/prototypes`)。
      **这是提示,不是按钮** —— 看板不代替用户搬家
- [ ] 3.7 概览进度「原型」改为「视觉呈现」:`references.items` 或 `prototypes.items`
      任一非空即完成;`references` 缺字段时退回只看原型。`hint` 写成 `visualization/`

## 4. 模板

- [ ] 4.1 `templates/init_workspace.py` 的 `BASE_DIRS`:去掉 `prototypes`,
      改成 `visualization/references` 和 `visualization/prototypes`(空目录即可,不放示例 HTML)
- [ ] 4.2 `templates/pm-aispace/.gitignore` 的 `prototypes/**/node_modules|.axhub-cache|dist|.cache`
      全部改成 `visualization/prototypes/**/…`,注释里的 Axhub 口径一并清掉。
      **同时定采集产物的入库策略** —— 一份参考是「整页 HTML + 三张截图」,量级几 MB 到十几 MB
      (相邻仓单站实测 8.6MB)。默认忽略还是入库,在这里定死并写进注释。
      **漏改会让新工作空间把原型构建产物入库。** 验证:新建一个工作空间,看铺出来的 `.gitignore`
- [ ] 4.3 `templates/pm-aispace/AGENTS.md`(8 处)、`README.md`(3 处)、
      `.claude/skills/pm-prototype-brief/SKILL.md`(6 处)、`pm-doc-ingest/SKILL.md`(1 处)、
      `scripts/ingest.py`(1 处):路径改成 `visualization/prototypes/`,
      并说明 `visualization/` 是视觉平面、`references/` 放收下来的别人的页面。
      记住放进去就是发出去
- [ ] 4.4 `templates/help.md`(2 处)、`templates/create-prompt.md`(2 处)同上

## 5. 本仓自己的文档与 dogfood 目录

- [ ] 5.1 根 `AGENTS.md`:第 3 节目录树(2 处)与第 108 行「单页 HTML 产物落
      `templates/pm-aispace/prototypes/<名字>/index.html`」改成新路径
- [ ] 5.2 `README.md`(2 处,含第 101 行那句「自动读 `prototypes/.axhub/`」——直接删掉这个说法)
- [ ] 5.3 `.claude/skills/` 下 3 处(`dashboard-feature-flow` 的 SSE 监听范围、
      `systematic-debugging` 的排查表、`project-conventions`)路径更新
- [ ] 5.4 `git mv templates/pm-aispace/prototypes` → `templates/pm-aispace/visualization/prototypes`
      (内容是 git 跟踪的)。**顺带决定 `annotation-demo-html.zip`(2.1MB)该不该留** ——
      `scripts/build-npm-package.mjs` 把整个 `templates/` 拷进 npm 包,而 `COPY_ENTRIES`
      不含这个目录,新建工作空间时又不会铺过去。留着就是每个用户白装 2.1MB
- [ ] 5.5 `docs/路线图.md` 的「其余候选」已经指向本 change(改规划时一并写的),
      实施完再回去把那条的措辞从「见 changes」改成「已落地」

## 6. 冒烟脚本(装包路径)

- [ ] 6.1 `scripts/smoke-package.mjs` 补:新建工作空间带 `visualization/references/` 和
      `visualization/prototypes/`、**根上不再有 `prototypes/`**;扫描 JSON 带 `references`;
      `visualization/references/foo/index.html` 能被列出而 `references/bar.html` 不被列出;
      参考伺服与截图路径的穿越请求 403;参考与原型 `bundle` 的伺服响应都带 CSP sandbox 头;
      `meta.json` 记 `kind: url` 的目录被列成 `url` 原型且不被伺服;
      既无 `index.html` 又无 `meta.json` 的空目录不出现;
      根上放一份旧 `prototypes/` 包时 `legacyDir` 出现而清单**不**列它

## 7. 验收闸

- [ ] 7.1 `pnpm typecheck` 绿
- [ ] 7.2 `pnpm build` 绿
- [ ] 7.3 重启 `pnpm dev` / `serve` 后浏览器点一遍「视觉呈现」:参考空态、
      手工放一份参考后出现卡片并能打开查看器、原型 tab 列出
      `visualization/prototypes/` 里的包、手写一条 `url` 原型能点开外链、两个 tab 互不混列
- [ ] 7.4 查看器实测:放一份带三张截图的参考 —— 缩略图在左下角、灯箱能开能切能关、
      关掉后 iframe 里的页面状态没丢;再放一份没有截图的,确认不出现空占位
- [ ] 7.5 迁移路径实测:拿一个原型还在根上 `prototypes/` 的工作空间,
      确认原型 tab 空态显示迁移提示 + 命令;跑完那条命令后**不手动刷新**卡片就出现
- [ ] 7.6 拿三种真实导出包各试一次(本机 `assets/private/` 下备了样例,该目录不入库):
      axhub-make 的「导出 HTML」包 → `bundle` 能打开;
      figma make 的源码包、axhub-make 的「导出源码」包 → **不出现**在清单里,
      且看板没跑任何安装 / 构建命令
- [ ] 7.7 三种降级:工作空间没有 `project.yaml`、登记目录已丢失、深色模式 ——
      参考 tab 不白屏,orange 只用在真正需要注意的地方
- [ ] 7.8 隔离验证:打开一份参考,在 iframe 的控制台里 `fetch('/api/projects')`
      拿不到数据、`parent.document` 拿不到
- [ ] 7.9 只读验证:本 change 跑完全程后,工作空间里没有任何文件被看板改动或移动过
- [ ] 7.10 README / CHANGELOG 写明这是破坏性目录变更,附迁移命令
