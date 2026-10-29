## 0. 前置

- [x] 0.1 确认 `remove-ingest-ignore` 已提交（已归档于 8677794）

## 1. 细则归位到 spec（先补后删）

- [x] 1.0 从 http.mjs 全部非 GET 路由反推能力清单（含 AGENTS.md 漏登的「刷新 schema」`db_ingest.py`），与 AGENTS.md、`templates/help.md` 表格三方对齐
- [x] 1.1 列一张对照表（写在本 change 的 `notes.md`）：AGENTS.md 第 1 节每条基础写入 / 编号例外的每个 ①–⑥ → 对应 `openspec/specs/<能力>/spec.md` 的哪个 Requirement；没有着落的标"缺"
- [x] 1.2 对标"缺"的条款，在本 change 下写 `specs/<现有能力>/spec.md` 的 ADDED delta，只补写现状、不改行为
- [x] 1.3 给每项能力定标识（kebab-case，与 spec 目录名一致或可追溯），对照表补上标识列
- [x] 1.4 `openspec validate capability-boundary` 通过

## 2. 服务端：注册表与统一闸

- [x] 2.1 新建 `src/server/capabilities.mjs`：`CAPABILITIES` 对象字面量（标识、名称、`scope`、执行者、承载模块、spec、偏离、`allowExtensionOrigin`），覆盖 1.3 的全部工作空间能力与 `local` 作用域接口（项目登记 / 改 / 删、`pick-directory`、批注历史等）
- [x] 2.2 把 `rejectIfRemoteWrite`、`rejectIfForeignOrigin` 从 http.mjs 原样移入 `capabilities.mjs`，新增 `guardCapability(req, res, id, { allowMutations })`；未登记标识回 500 并打日志
- [x] 2.3 http.mjs 每个非 GET 分支把两行闸调用换成一行 `guardCapability`；`/capture-package` 的扩展放行改由注册表决定
- [x] 2.4 给临时文件 / 缓存清理处（`notes.mjs`、`patchMarkdown.mjs`、`prototypes.mjs`、`capture*.mjs` 等）加 `// capability: tmp-cleanup` 标注
- [x] 2.5 重启 `pnpm serve`，按 spec「收口后行为不变」场景在看板上逐项点一遍；再用 curl 带 `Sec-Fetch-Site: cross-site`、`Origin: chrome-extension://x`（对非采集包接口）各打一次写接口确认 403；`--host 0.0.0.0` 起一次确认写接口全 403、浏览正常

## 3. 检查脚本

- [x] 3.1 新建 `scripts/check-capabilities.mjs`：承载模块外的 fs 写 / spawn、非 GET 分支缺 `guardCapability`、未登记标识、工作空间模块里未标注的 `unlink` / `rm`、注册表与 AGENTS.md 能力清单不一致，任一命中即非 0 退出并给出文件:行
- [x] 3.2 package.json 加 `test:capabilities`
- [x] 3.3 人为制造三种违规（承载模块外加一处 `writeFileSync`、删掉一处 `guardCapability`、清单删一行）各跑一次确认报错，再还原

## 4. 文档与定位

- [x] 4.1 重写 AGENTS.md 第 1 节：协作台定位、"能力清单以外一律只读"、六条安全链路、回收区删除规则、能力清单表（标识 / 名称 / 执行者 / 写入面一句话 / 入口 / 偏离 / spec 链接），删除逐条细则；验证闸加 `pnpm test:capabilities`；目录结构里加 `capabilities.mjs`
- [x] 4.2 README 首段定位语与相关"只读"表述（第 7、306 行附近）改为协作台说法；只读分享那句保留
- [x] 4.3 CLAUDE.md 红线段改为指向安全链路与能力清单的指针，不复制内容
- [x] 4.4 `openspec/config.yaml`：项目说明与"只读红线"改为安全链路表述；proposal 规则改为"新增或放宽写入面、偏离安全链路的，单独成段留给人拍板"
- [x] 4.5 `.claude/skills/dashboard-feature-flow`、`disciplined-coding` 的"只读红线 / 只读看板"措辞改为"写入只走能力清单 + 安全链路"；`dashboard-feature-flow` 加"新增写能力：注册表登记 → `guardCapability` → 清单加一行 → spec → 跑 `test:capabilities`"
- [x] 4.6 `rg "只读看板|对工作空间只读"` 在 README / AGENTS / CLAUDE / config.yaml / skills 下无残留；specs 里描述具体视图"只读"的句子保留不动
- [x] 4.7 `templates/help.md`：
  - 首段改为协作台表述，去掉"原则上只读"和"范围见文末「看板会不会改我的文件」"
  - 删除常见问题里「看板会不会改我的文件？」整条及其表格
  - 在第 8 章之后、常见问题之前新增「9 · 在看板里管理文档」，按视图分节：**输入资料**（原始资料、转换产物、数据库源、参考 / 收件箱）与**产出**（原稿、交付稿、Word 模板）各写清入口在哪（哪个 tab、行上哪个按钮或菜单、能否拖放）和能做什么；入口与按钮名以 1.0 盘点和实际界面为准，逐项在浏览器里核对；工作台三件（问题、记录、反馈）已在第 8 章，只给一行指引
  - 章末一小段讲安全链路的用户可感部分：只在 `127.0.0.1` 打开时可用、每一步都要你点、动多个文件先给预览、不覆盖、删除只进回收区（目前没有删除）
  - 用 `local-source-sync` 推到已登记实例

## 5. 验收闸

- [x] 5.1 `pnpm typecheck` 绿
- [x] 5.2 `pnpm build` 绿
- [x] 5.3 `pnpm test:capabilities` 绿；现有 `test:*` 脚本全部跑一遍不回归
- [x] 5.4 重启 `pnpm serve` 后浏览器把受影响视图点一遍（输入资料、产出、记录、未决问题、反馈、原型、参考、采集），含无 `project.yaml`、工作空间目录丢失、深色模式三种情况
