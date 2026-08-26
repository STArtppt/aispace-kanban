## 1. 只读例外写进事实源

- [ ] 1.1 在 `AGENTS.md` 第 1 节不变量里补上窄例外：看板（及插件接收端）只允许往 `<工作空间根>/visualization/references/` 写；必须用户明确发起；必须环回；路径必须过 `resolveInside()`；其它目录（含 `visualization/prototypes/` 和根上旧 `prototypes/`）仍只读；看板不搬迁旧目录
- [ ] 1.2 把这条例外同步进 `Claude.md` 不需要 —— `Claude.md` 只是指针，确认它仍指向 `AGENTS.md`、没有复制一份会漂的红线
- [ ] 1.3 `AGENTS.md` 目录结构说明把根上 `prototypes/` 改成 `visualization/{references,prototypes}`，并写明这是视觉平面、与 `input/` `output/` 文档平面分开

## 2. 服务端：扫描与伺服视觉平面

- [ ] 2.1 新增 `src/server/references.mjs`：扫 `visualization/references/<slug>/index.html`，读 `<title>` / 可选 `meta.json` / 可选封面；没有目录或读失败降级成空清单 + `note`，不抛
- [ ] 2.2 改 `prototypes.mjs`：先扫 `visualization/prototypes/`，再扫根上旧 `prototypes/`；同 slug 时新位置赢；`sourcePath` 写成实际相对路径。包的识别规则（子目录 `index.html` / 根上 `index.html` / zip）保持原样
- [ ] 2.3 在 `scan.mjs` 把参考结果挂到 `scan.references`（与 `prototypes` 并列）；缺 `visualization/` 时该字段仍返回空结构，方便新前端区分「没有参考」和「旧进程没这个字段」
- [ ] 2.4 在 `http.mjs` 增加参考静态伺服（`/api/projects/:id/ref/:slug/…`），只从 `visualization/references/<slug>/` 往外读，路径过 `resolveInside()`，越界 403；HTML 直出供新窗口打开。原型伺服继续用现有 `/proto/`，解析时覆盖两个扫描根
- [ ] 2.5 `watchWorkspace` 监听 `visualization/`（递归覆盖两个子目录），并继续听根上 `prototypes/`（老工作空间）
- [ ] 2.6 清掉 `prototypes.mjs` 空态 `note`、文件头注释、`http.mjs` 里「伺服 axhub-make 导出包」那行注释，改成「可点击 HTML 包」，落点写成 `visualization/prototypes/`。验证：重启 `pnpm dev` / `serve` 后 `curl` 扫描，空原型的 `note` 不再出现 axhub

## 3. 服务端：写入（采集 + 接收）

- [ ] 3.1 写入收口：只允许在 `resolveInside(root, 'visualization/references/' + 服务端生成的 slug)` 下 `mkdir` / `writeFile`；slug 不接受客户端传入路径
- [ ] 3.2 采集任务表（仿 ingest：一项目一任务）：`POST` 采集接口走 `rejectIfRemoteWrite`；`spawn('single-file', …)` 永不 import；成功写 `index.html` + `meta.json`（`source: url-capture`）；失败删半成品并返回中文原因
- [ ] 3.3 PATH 上没有 `single-file` 时返回明确错误（缺的是这个命令行工具、需要自行安装），不写盘。验证：重启服务后对本机 `curl` 一次，看到这条说明
- [ ] 3.4 插件接收：`POST` JSON（`formatVersion` + 必填 `html` + 可选 title / sourceUrl / 封面 / summary / manifest），版本不认识或没有 HTML 则 4xx 且不写盘；成功落 `visualization/references/<slug>/`。同样走 `rejectIfRemoteWrite`，请求体设上限
- [ ] 3.5 验证写入范围：重启服务后，采集失败、接收非法包、非环回（若方便起 `--host`）三种情况都不改 `input/` `output/` `visualization/prototypes/` 和根上旧 `prototypes/`；路径穿越的伺服请求 403

## 4. 契约 `src/app/lib/api.ts`

- [ ] 4.1 增加 `ReferenceItem` / `References` 类型；`Scan.references?` 做成可选，注释写明旧进程缺字段时前端怎么退
- [ ] 4.2 封装采集、查任务、接收三条 API；字段与服务端 JSON 对齐后再写下一项 UI

## 5. 前端：视图壳与两个 tab

- [ ] 5.1 侧栏第四项文案改为「参考&原型」；`View` 键保持 `'prototypes'`，不迁 localStorage
- [ ] 5.2 用现成 `Tabs` 做「参考 / 原型」；首次默认「参考」，选中状态可另存 localStorage
- [ ] 5.3 「参考」tab：卡片网格（16:10、封面或窗框占位、标题、来源）、空态（指向 `visualization/references/`）、URL 输入 + 采集按钮；`scan.references` 缺失时禁用采集并提示重启服务，不白屏
- [ ] 5.4 采集进行中 / 成功 / 失败状态接上任务接口；成功后靠现有 SSE 刷新清单，卡片点击新窗口打开伺服地址
- [ ] 5.5 「原型」tab 复用现有 `PrototypePanel` 逻辑，空态 hint 改为 `visualization/prototypes/`，去掉 axhub-make
- [ ] 5.6 概览进度「原型」改为「参考&原型」：`references.items` 或 `prototypes.items` 任一非空即完成；`references` 缺字段时退回只看原型

## 6. 模板与说明文案

- [ ] 6.1 `templates/init_workspace.py` 的 `BASE_DIRS`：去掉根上 `prototypes`，改成 `visualization/references` 和 `visualization/prototypes`（空目录即可，不放示例 HTML）
- [ ] 6.2 在 PM 模板约定里说明 `visualization/` 是视觉平面：`references/` 是采集来的页面，`prototypes/` 是自己做的可点击包，都不是 ingest 产物（改 `templates/pm-aispace/AGENTS.md` 阶段说明，记住放进去就是发出去）
- [ ] 6.3 README / `templates/create-prompt.md` / `templates/help.md` 里「原型」口径改成「参考&原型」，路径写成 `visualization/` 下两个子目录；删掉「自动读 `prototypes/.axhub/`」这种过时说法

## 7. 冒烟脚本（装包路径）

- [ ] 7.1 `scripts/smoke-package.mjs` 补：新工作空间带 `visualization/references/` 和 `visualization/prototypes/`、不再强制根上有 `prototypes/`；参考伺服路径穿越 403；采集 / 接收在允许写入时能建出 `visualization/references/<slug>/index.html`（采集可在无 `single-file` 时断言错误信息，不必真抓网）；扫描 JSON 带 `references`；根上旧 `prototypes/` 里放一份包仍能出现在扫描结果里

## 8. 验收闸

- [ ] 8.1 `pnpm typecheck` 绿
- [ ] 8.2 `pnpm build` 绿
- [ ] 8.3 重启 `pnpm dev` / `serve` 后浏览器点一遍「参考&原型」：空参考、贴一条公开 URL 采集（有 `single-file` 时走成功路径，没有时确认错误说明）、原型 tab 仍列出原有 HTML 包（含根上旧 `prototypes/` 里的）、两个子目录互不混列
- [ ] 8.4 三种情况：工作空间没有 `project.yaml`、登记目录已丢失、深色模式 —— 参考 tab 不白屏，orange 只用在真正需要注意的失败态
- [ ] 8.5 用 `--host` 起一次非环回服务，确认采集和接收都是 403、工作空间不被写入
- [ ] 8.6 确认 `input/` `output/` `visualization/prototypes/`、根上旧 `prototypes/`、`project.yaml` 在本 change 的写路径下始终没被改动；采集产物只出现在 `visualization/references/`
