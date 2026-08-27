> **前置：** `reference-prototype-view` 必须已经落地（`visualization/references/` 约定、扫描、伺服、
> CSP `sandbox` 隔离）。先做采集、后做隔离是不可接受的顺序。
> **前置：** proposal 末尾那段只读红线的窄例外必须已经拍板。没拍板就别开始第 1 组。

## 1. 只读例外写进事实源

- [ ] 1.1 `AGENTS.md` 第 1 节不变量补上窄例外：看板只允许往 `<工作空间根>/visualization/references/` 写；
      必须用户明确发起；必须环回且非跨站；路径必须过 `resolveInside()`；
      其它目录（含 `visualization/prototypes/`）仍只读；看板不删除、不覆盖已有参考
- [ ] 1.2 确认 `CLAUDE.md` 仍只是指向 `AGENTS.md` 的指针，没有复制一份会漂的红线

## 2. 服务端：写入收口与跨站防护

- [ ] 2.1 把 `resolveInside` 从 `http.mjs` 提到 `src/server/paths.mjs`，
      `http.mjs` 与 `references.mjs` 都从那里引。**不复制第二份**
- [ ] 2.2 `references.mjs` 增加唯一的写入函数：入参是服务端生成的 slug 与文件内容，
      先 `resolveInside(root, 'visualization/references/' + slug)` 再 `mkdir` / `writeFile`；
      slug 做安全化，客户端传来的任何路径片段一律忽略
- [ ] 2.3 所有会写盘 / 起子进程的接口加跨站校验：`Sec-Fetch-Site` 不是 `same-origin` /
      `none` 时拒绝；无该头但 `Origin` 与本机服务不符时也拒绝。
      **覆盖现有的** ingest、忽略、新建工作空间、移出看板。
      验证：重启服务后用 `curl -H 'Sec-Fetch-Site: cross-site'` 打一遍这几条接口，全部被拒

## 3. 服务端：采集

- [ ] 3.1 采集任务表（仿 ingest：一项目一任务）；`POST` 采集接口先过 `rejectIfRemoteWrite`
      再过跨站校验；进行中再点返回明确拒绝原因
- [ ] 3.2 `spawn('single-file', …)`，**永不 import**，不进 `dependencies`；
      子进程超时 120s 杀掉；产物超过 64MB 判失败
- [ ] 3.3 临时文件写在目标 slug 目录之外，成功再整体移入；
      失败 / 超时 / 被杀一律删干净，不留缺 `index.html` 的半成品目录
- [ ] 3.4 成功时写 `index.html` + `meta.json`（源 URL、标题、采集时间、
      `source: url-capture`、`scrubbed: false`）
- [ ] 3.5 同一 URL 再采一次生成新 slug（`<slug>-2`），不覆盖已有目录
- [ ] 3.6 PATH 上没有 `single-file` 时返回明确错误：**说清缺的是哪个命令行工具、
      给出安装命令**，且不写盘。验证：重启服务后本机 `curl` 一次，看到这条完整说明

## 4. 契约 `src/app/lib/api.ts`

- [ ] 4.1 新增「发起采集」「查采集任务」两条 API 与其类型（任务三态 + 失败原因文案）
- [ ] 4.2 字段与服务端 JSON 对齐后再写下一组 UI

## 5. 前端：采集入口

- [ ] 5.1 参考 tab 顶部加 URL 输入 + 「采集」按钮；输入非法 URL 时就地提示，不发请求
- [ ] 5.2 三态接上任务接口：进行中禁用按钮并显示进度中，成功后靠 SSE 刷新清单，
      失败把服务端返回的原因原样显示（不写「操作失败请重试」）
- [ ] 5.3 采集接口 404（服务进程还没重启）时禁用按钮并说明要重启看板服务，
      参考清单照常显示，不白屏
- [ ] 5.4 入口旁写清适用范围：只适合不用登录就能看的页面；采下来的是页面当时的**全部内容**，
      不做脱敏

## 6. 说明文案

- [ ] 6.1 README 与 `templates/help.md` 写明：贴 URL 采集需要本机装 `single-file-cli`，
      附安装命令；说明它是独立工具、看板只是调用它

## 7. 冒烟脚本

- [ ] 7.1 `scripts/smoke-package.mjs` 补：跨站头被拒；无 `single-file` 时返回带安装命令的错误
      且不写盘；采集请求体里夹带 `../` 路径字段时只写进 `visualization/references/<服务端 slug>/`；
      非环回（起一次 `--host`）时采集 403

## 8. 验收闸

- [ ] 8.1 `pnpm typecheck` 绿
- [ ] 8.2 `pnpm build` 绿
- [ ] 8.3 重启 `pnpm dev` / `serve` 后浏览器点一遍：贴一条公开 URL 采集
      （装了 `single-file` 走成功路径并点开采下来的页面确认能看；没装则确认错误说明完整）
- [ ] 8.4 用 `--host` 起一次非环回服务，确认采集 403、工作空间不被写入
- [ ] 8.5 写入范围验证：采集成功、采集失败、非法请求三种情况跑完之后，
      `input/` `output/` `visualization/prototypes/`、`project.yaml` 的文件列表与内容与开始前一致；
      新增文件只出现在 `visualization/references/`
- [ ] 8.6 深色模式下采集入口与失败态可读，orange 只用在失败态
