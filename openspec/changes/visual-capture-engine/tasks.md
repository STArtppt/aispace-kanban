> **前置:** `visual-showcase-view` 必须已经落地(`visualization/` 目录约定与两种条目形状、
> 扫描、伺服、CSP `sandbox` 隔离、SSE 能捕获后建目录)。先做采集、后做隔离是不可接受的顺序。
> **前置:** proposal 末尾那段只读红线的窄例外必须已经拍板。没拍板就别开始第 1 组。

## 1. 只读例外写进事实源

- [ ] 1.1 `AGENTS.md` 第 1 节不变量补上**第二条窄例外**(第一条是现有的 `addIgnore` 写
      `input/.ingestignore`,按同一个模子写):看板只允许往
      `<工作空间根>/visualization/references/<slug>/` 与 `visualization/prototypes/<slug>/` 写;
      必须用户明确发起;必须环回且非跨站;路径必须过 `resolveInside()`;
      只新建、不覆盖、不删除;`input/` `output/` `project.yaml` 仍只读
- [ ] 1.2 确认 `CLAUDE.md` 仍只是指向 `AGENTS.md` 的指针,没有复制一份会漂的红线

## 2. 服务端:写入收口与跨站防护

- [ ] 2.1 把 `resolveInside` 从 `http.mjs` 提到 `src/server/paths.mjs`,
      `http.mjs` 与 `capture.mjs` 都从那里引。**不复制第二份**
- [ ] 2.2 唯一的写入函数:入参是服务端生成的 slug、目标平面(references / prototypes)与
      文件内容,先 `resolveInside(root, 'visualization/<平面>/' + slug)` 再 `mkdir` / `writeFile`;
      slug 做安全化,客户端传来的任何路径片段一律忽略;目标目录已存在时换 slug,**不覆盖**
- [ ] 2.3 来源判定写成**一个共用函数**:`Sec-Fetch-Site` 不是 `same-origin` / `none` 时拒绝;
      无该头但 `Origin` 与本机服务不符时也拒绝。所有会写盘 / 起子进程的接口都调它 ——
      **覆盖现有的** ingest、忽略、新建工作空间、移出看板。
      注释里写明:下一个 change 要放行浏览器扩展来源时,**只在这个函数里加分支**。
      验证:重启服务后用 `curl -H 'Sec-Fetch-Site: cross-site'` 打一遍这几条接口,全部被拒

## 3. 服务端:采集引擎

- [ ] 3.1 新增 `src/server/capture.mjs`,文件头写明:移植自 acgogogo `daemon/capture/index.ts`,
      只搬「single-file 子进程 + 三档截图」两段,**不搬**登录态注入 / 预览视频 /
      多状态截图 / 品牌提取 / 分析线。AGPL 边界与 Playwright 探测策略也写在这里
- [ ] 3.2 `spawn('single-file', …)`,**永不 import**,不进 `dependencies`;
      子进程超时 120s 杀掉;产物超过 64MB 判失败。
      **把相邻仓那段「退出码 0 但没产物」的重试逻辑连注释一起搬过来**
- [ ] 3.3 截图:动态 `import('playwright')`,失败即整体降级(不报错、不阻塞)。
      三档各自 try —— hero 1920×1080 视口、full 1280 宽 fullPage、mobile 390×844 fullPage;
      **不做响应式探测,三张都截**;单档失败只丢那一档;整体超时 90s;
      每次采集起一个 browser,`finally` 里必关(超时也要关)
- [ ] 3.4 采集任务表(仿 ingest:一项目一任务);`POST` 采集 / 导入接口先过
      `rejectIfRemoteWrite` 再过 2.3 的来源判定;进行中再点返回明确拒绝原因
- [ ] 3.5 临时文件写在目标 slug 目录之外,成功再整体移入;
      失败 / 超时 / 被杀一律删干净,不留缺 `index.html` 的半成品目录
- [ ] 3.6 参考成功时写 `index.html` + `screenshots/*.png` + `meta.json`
      (源 URL、标题、采集时间、`source: url-capture`、`scrubbed: false`、
      实际截图列表、`degraded` 原因)
- [ ] 3.7 原型 URL 导入:只写 `meta.json`(`kind: "url"`、`title`、`target` 原样、
      `capturedAt`、`source: url-capture`)+ 可选 `cover.png`;
      **绝不抓页面 HTML**;Playwright 不可用时仍写 `meta.json` 并判成功
- [ ] 3.8 同一 URL 再采一次生成新 slug(`<slug>-2`),不覆盖已有目录
- [ ] 3.9 缺工具的两条文案分开:PATH 上没有 `single-file` → **失败**,说清缺哪个命令行工具
      并给安装命令;`playwright` 引入失败 → **成功但降级**,同样给安装命令。
      验证:重启服务后本机各 `curl` 一次,两条说明都完整

## 4. 契约 `src/app/lib/api.ts`

- [ ] 4.1 新增「发起采集」「查采集任务」两条 API 与其类型;请求带目标平面
      (`reference` / `prototype`),任务状态是三态 + 降级列表 + 失败原因文案
- [ ] 4.2 字段与服务端 JSON 对齐后再写下一组 UI

## 5. 前端:两个入口

- [ ] 5.1 参考 tab 顶部加 URL 输入 + 「采集」按钮;输入非法 URL 时就地提示,不发请求
- [ ] 5.2 原型 tab 顶部加 URL 输入 + 「导入」按钮;文案说清这里收的是**云端发布链接**
      (axhub-make 发布 / figma make publish、share),本地包请直接放进目录
- [ ] 5.3 三态接上任务接口:进行中禁用按钮并显示进行中,成功后靠 SSE 刷新清单,
      失败把服务端返回的原因原样显示(不写「操作失败请重试」)
- [ ] 5.4 成功但降级时显示得跟成功一样(卡片出现),另给一行说明少了什么、装什么补上 ——
      **不要用失败的视觉语言**,orange 只给真正失败
- [ ] 5.5 接口 404(服务进程还没重启)时禁用按钮并说明要重启看板服务,
      两个清单照常显示,不白屏
- [ ] 5.6 参考入口旁写清适用范围:只适合不用登录就能看的页面(需要登录的系统请用采集插件);
      采下来的是页面当时的**全部内容**,不做脱敏

## 6. 说明文案

- [ ] 6.1 README 与 `templates/help.md` 写明:贴 URL 采集需要本机装 `single-file-cli`
      (必需)与 `playwright`(可选,缺了就没有截图),各附安装命令;
      说明它们是独立工具、看板只是调用它们,不随看板一起安装

## 7. 冒烟脚本

- [ ] 7.1 `scripts/smoke-package.mjs` 补:跨站头被拒(覆盖新旧五条 mutation 接口);
      无 `single-file` 时返回带安装命令的错误且不写盘;
      采集请求体里夹带 `../` 路径字段时只写进 `visualization/<平面>/<服务端 slug>/`;
      非环回(起一次 `--host`)时采集 403;
      原型 URL 导入后目录里**没有** `index.html`

## 8. 验收闸

- [ ] 8.1 `pnpm typecheck` 绿
- [ ] 8.2 `pnpm build` 绿
- [ ] 8.3 重启 `pnpm dev` / `serve` 后浏览器点一遍:贴一条公开 URL 采集 ——
      装了 `single-file` + `playwright` 走完整路径,确认三张截图都在、
      查看器里缩略图能开;只装 `single-file` 确认降级路径;都没装确认失败说明完整
- [ ] 8.4 贴一条云端原型链接导入,确认卡片出现、点击开的是原站、目录里没有 HTML 副本
- [ ] 8.5 用 `--host` 起一次非环回服务,确认采集 403、工作空间不被写入
- [ ] 8.6 写入范围验证:采集成功、采集失败、降级、非法请求四种情况跑完之后,
      `input/` `output/`、`project.yaml` 的文件列表与内容与开始前一致;
      新增文件只出现在 `visualization/` 之下
- [ ] 8.7 进程验证:连采五次(含一次超时),`ps` 确认没有残留的 headless 浏览器进程
- [ ] 8.8 深色模式下两个采集入口、降级说明与失败态都可读,orange 只用在失败态
