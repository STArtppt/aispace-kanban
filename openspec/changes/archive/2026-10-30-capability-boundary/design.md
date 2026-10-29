## Context

AGENTS.md 第 1 节现在是"对工作空间只读"加一份"全部例外"：三条不编号的基础写入 + 十三条编号例外，每条都有 ①–⑥ 细则，
合计 150 多行。逐条读下来，有五类约束在每一条里重复出现：用户明确点击发起、环回且非跨站、请求不带路径、
写入面白名单、不删不覆盖（含预览指纹、409）。

代码侧：
- http.mjs 有 20 多个非 GET 分支，每个都手写一对 `rejectIfRemoteWrite(res, allowMutations)` + `rejectIfForeignOrigin(req, res)`；
  `/capture-package` 额外传 `allowExtensionOrigin: true`。`/pick-directory` 不写文件但同级设闸。
- 直写工作空间的模块：`capture.mjs`、`capture-inbox.mjs`、`notes.mjs`、`patchMarkdown.mjs`（被 `questions.mjs` / `records.mjs` / `feedback.mjs` 复用）。
- 只写本机状态的模块：`config.mjs`（`~/.pmwork/dashboard/`）、`note-history.mjs`、`prototypes.mjs`（zip 解压缓存）。
- spawn 工作空间脚本：`http.mjs`、`docxTools.mjs`、`finalize.mjs` 经 `platform.mjs`、`capture.mjs`、`prototypes.mjs`、`version.mjs`。
- 服务端没有类型检查也没有测试；漏一道闸今天只能靠评审发现。

## Goals / Non-Goals

**Goals:**
- 定位改成协作台；不变量 1 改成"安全链路 + 能力清单"，新增能力的门槛清楚且统一。
- 把重复的来源判定收成一次调用，并让"注册表之外不许写"可被脚本检查。
- AGENTS.md 第 1 节缩到能一屏看完链路与清单。

**Non-Goals:**
- 不新增、不放宽任何写入面；不引入删除能力（回收区只立规则）。
- 不改前端、不动 `api.ts` 契约、不改 CLI、不改 templates。
- 不做运行时的写入面拦截（如包一层 fs 只允许白名单目录）。

## Decisions

### D1 安全链路取六条：发起 / 来源 / 寻址 / 写入面 / 执行者 / 可回退

全部从现有例外里归纳，不新增约束。"执行者"保留 spawn 与直写的区分，因为它决定看板自己要承担的原子性责任。
- 备选：只保留三条（发起、来源、寻址），写入面和回退交给各能力自定 —— 不选：写入面白名单和不覆盖正是最常被"顺手放宽"的地方，必须是公共约束。
- 备选：把 `resolveInside()` 并进链路 —— 不选：它是不变量 2，对只读接口同样适用，范围比写能力大，保持独立。

### D2 删除只进回收区 `.aispace/trash/`

规则：删除 = 移入 `.aispace/trash/<时间戳>-<安全化名>/`，旁边记录原相对路径，可还原；看板不真删。
`.aispace/` 已是看板与模板共用的元数据目录（`template.lock.json`），放这里不污染 `input/` `output/`，扫描也天然跳过。
- 备选：系统回收站（macOS 废纸篓）—— 不选：跨平台不一，且离开工作空间后 AI 侧看不到、也无法按原路径还原。
- 备选：维持"不删除" —— 人已拍板允许删除，但要求可回退。
- 本 change 只写规则与检查，不实现回收区的读写；第一项删除能力另开 change，届时把回收区的格式写进它的 spec。

### D3 细则以 spec 为准，AGENTS.md 只留链路与清单

清单列：标识、名称、执行者、写入面（一句话）、入口（用户点什么）、偏离、spec 链接。
- 备选：细则留在 AGENTS.md —— 不选：两处写同一件事必然漂移，spec 本来就随 change 归档更新。
- 风险是 spec 缺条款，见 D5 的迁移步骤：先比对补齐，再删 AGENTS.md 段落。

### D4 注册表 + `guardCapability()`，判定逻辑原样搬迁

`capabilities.mjs` 导出 `CAPABILITIES`（对象字面量，便于脚本静态读取）与 `guardCapability(req, res, id, { allowMutations })`。
`rejectIfRemoteWrite` / `rejectIfForeignOrigin` 从 http.mjs 移入该模块，函数体与文案不改；`allowExtensionOrigin`
不再由调用方传，而是由注册表里该能力的 `allowExtensionOrigin: true` 决定（只有采集包接收），偏离由此可见。
`/pick-directory`、项目登记等不写工作空间的接口以 `scope: 'local'` 登记，同样过闸。
- 备选：保留两函数各处直调，只加注释标能力 —— 不选：无法静态检查"每个写分支都过了闸"。
- 备选：引入路由框架做中间件 —— 不选：引新依赖、大改 http.mjs，收益只是少写一行。

### D5 检查脚本用正则静态扫描

`scripts/check-capabilities.mjs`：动态 `import()` 注册表取承载模块列表；逐文件正则找 fs 写调用与 spawn；
在 http.mjs 里按 `req.method === 'POST' | 'PUT' | 'PATCH' | 'DELETE'` 定位分支，检查分支起始若干行内有 `guardCapability(`；
读 AGENTS.md 能力清单表格的标识列与注册表 `workspace` 作用域比对。
临时文件清理处（如 `notes.mjs` / `patchMarkdown.mjs` 的 `unlinkSync(tmp)`、`prototypes.mjs` 清缓存）用行尾注释 `// capability: tmp-cleanup` 标注放行。
- 备选：AST 解析（acorn 等）—— 不选：要引依赖；现有代码风格统一，正则足够，误报可用标注消解。
- 已知局限：抓不到经变量间接调用的 fs 方法；靠"写盘只出现在承载模块"兜住范围。

## Risks / Trade-offs

- [定位放宽被理解成"可以随便写"] → AGENTS.md 开头明确"能力清单以外一律只读"，新能力必须满足六条链路，偏离须人拍板；检查脚本兜底。
- [搬迁闸函数时改错判定] → 函数体整体移动不改写；实施后按 spec 场景用 curl 带跨站头、`--host 0.0.0.0` 各打一遍写接口。
- [删 AGENTS.md 细则后信息丢失] → 先逐条比对补进 spec 再删；删前在 tasks 里列出每条细则落到哪份 spec 的哪个 Requirement。
- [与 `remove-ingest-ignore` 冲突] → 本 change 等它提交后实施，从它的结果改。
- [正则检查误报 / 漏报] → 误报用标注放行并在脚本输出列出全部标注处；漏报由承载模块白名单限制范围。

## Migration Plan

1. 等 `remove-ingest-ignore` 提交。
2. 比对细则 → 补 spec delta。
3. 加注册表与 `guardCapability()`，逐个替换 http.mjs 的闸调用，重启服务点一遍。
4. 加检查脚本并接进 package.json 与验证闸。
5. 重写 AGENTS.md 第 1 节与各处定位语。
回滚：代码改动是纯重构，`git revert` 即可；文档同理。

### D6 「不覆盖」按内容归属界定，偏离如实登记

逐条对照现有能力后发现，字面的"不覆盖"现有能力并不都满足：刷新原型整份覆盖镜像、定稿覆盖 `定稿.md`、
带生成标记的 `.docx` 可替换。它们覆盖的都是**本能力自己生成、能从来源重新生成**的派生文件，丢了可以再生成。
所以第 6 条写成"不覆盖别人的内容"（用户写的、AI 写的、外部带进来的），派生文件允许整份重建。
同理第 4 条区分直写与 spawn：重命名、整理原始资料的脚本必须改写 AI 写区里的路径，否则引用断掉。
- 备选：保持字面"不覆盖"，把上述能力都标偏离 —— 不选：偏离会多到失去警示作用，"偏离"应只留给真正越过安全假设的地方。
真正的偏离只有三处：采集包接收（发起 + 来源）、交付稿定稿（读工作空间外文件）、刷新原型（写工作空间外文件）。

### D7 清单盘点以代码为准

盘点发现 AGENTS.md 漏登了一项已有写入：「刷新 schema」spawn `scripts/db_ingest.py`，写 `output/converted/_sources/`；
而 `templates/help.md` 的"看板会不会改我的文件"表格缺重命名、复制转换产物、整理原始资料三项。
能力清单从 http.mjs 的非 GET 路由反推，不从现有文档抄，检查脚本保证以后不再漏。

## Open Questions

（已决）`templates/help.md` 同步改：首段改成协作台表述；删掉常见问题里"看板会不会改我的文件"的表格 ——
它按"写哪里"组织，是给开发者看的清单，用户关心的是"去哪点、能做什么"；
改为新增「9 · 在看板里管理文档」，按输入 / 产出两个视图写管理入口与能力，章末用几句话讲用户能感知到的安全保证。
改完走模板更新同步到实例。
