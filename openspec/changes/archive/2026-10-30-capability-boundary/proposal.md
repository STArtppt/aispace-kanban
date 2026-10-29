## Why

不做的话，看板会一直顶着"只读看板"的名字，实际却已有十三条往工作空间写的"例外"；以后每加一项读写能力，
都要先论证"为什么破例"，再往 AGENTS.md 第 1 节追加一大段 ①–⑥，这份清单已经长到 150 多行，
而真正守住安全的公共约束（用户发起、环回同源、不带路径、写入面白名单、不删不覆盖）散落在每一条里重复书写，
服务端又没有任何静态检查，漏一道闸只能靠人眼发现。

看板现在的实际作用是：**查看、管理本机工作空间里与 AI 协作的产物，查看并简单维护原始输入**。
定位应该照实改过来，把"例外"变成"能力"，把重复的约束收成一条**安全链路**，并在代码里落成可检查的边界。

## What Changes

- **BREAKING（协作约定）定位改写**：看板从"只读看板"改为"本机工作空间协作台"。
  README 定位语、`openspec/config.yaml` 的项目说明与"只读红线"、CLAUDE.md 红线段、
  `dashboard-feature-flow` / `disciplined-coding` 技能里的"只读"措辞同步改。
- **不变量 1 重写**：从"对工作空间只读 + 全部例外清单"改为
  **安全链路**（六条：发起 / 来源 / 寻址 / 写入面 / 执行者 / 可回退）+ **能力清单**（一能力一行：
  名称、执行者、写入面、入口、对应 spec）。新增能力 = 加一行并满足六条链路；
  偏离任一条链路（如第十条读工作空间外文件、采集包接收端放行扩展来源）必须在那一行标"偏离"并写明理由。
- **细则归位**：各能力写入面的细则（现在的 ①–⑥）以对应 openspec spec 为准，AGENTS.md 不再重复；
  逐条比对现有 spec，缺的细则补进 spec 后再删 AGENTS.md 里的段落。
- **删除规则（新）**：可回退一条写成"不覆盖；删除一律先移入工作空间内回收区（`.aispace/trash/`），
  可还原，看板不做真删除"。清理本次操作自己建的临时文件不算删除。
  **本 change 只立规则，不新增任何删除能力。**
- **代码落地**：
  - 新增 `src/server/capabilities.mjs`：能力注册表 + 统一闸 `guardCapability()`，
    把 http.mjs 里每个写接口成对出现的 `rejectIfRemoteWrite` + `rejectIfForeignOrigin` 收成一次调用，
    并登记该接口属于哪项能力；
  - 新增 `scripts/check-capabilities.mjs`：静态扫描 `src/server/**`，
    拦下注册表之外模块里的 fs 写调用 / spawn、没过 `guardCapability()` 的非 GET 路由、
    注册表与 AGENTS.md 能力清单不一致；接进验证闸。

## 需要人拍板（往工作空间写 / 放宽只读红线）

本 change **不新增任何写入面**，现有十三项能力的写入范围一字不放宽；但它改变了"红线"的表述方式，
以后加写能力的门槛从"改例外清单"变成"满足安全链路 + 加一行能力"。以下三点已在会话中由人确认：

1. 定位改为协作台，"只读"不再是项目名片上的承诺，而是"能力清单以外一律只读"；
2. 删除允许，但只能进回收区，不做真删除；不覆盖保持不变；
3. 细则以 spec 为准，AGENTS.md 只留链路与清单。

## Capabilities

### New Capabilities

- `workspace-write-boundary`：看板写工作空间的统一边界 —— 安全链路六条、能力清单与注册表、
  回收区删除规则、检查脚本对边界的静态把关。

### Modified Capabilities

<!-- 现有十三项能力的行为不变。实施第一步逐条比对 AGENTS.md 细则与对应 spec，
     spec 缺的条款以 delta 形式补进本 change（只补写已有行为，不改行为）。 -->
- 暂无行为变更；细则比对后若发现 spec 缺条款，补成对应 spec 的 delta（如 `open-questions-workbench`、
  `output-item-workbench`、`workbench-feedback`、`raw-source-organize` 等），只补写现状。

## Impact

- **服务端**（`src/server/**`，无类型检查）：新增 `capabilities.mjs`；`http.mjs` 全部写接口改调 `guardCapability()`；
  `capture.mjs` / `capture-inbox.mjs` / `notes.mjs` / `patchMarkdown.mjs` 等写盘模块在注册表登记。
  行为不变（同样的 403 文案与判定），必须重启 `pnpm serve` 并点一遍各写入操作。
- **CLI**（`bin/cli.mjs`）：不改。
- **前端**（`src/app/**`）：不改；**不动 `src/app/lib/api.ts` 契约**。
- **templates/**：不改。模板里描述"看板只读"的地方（如 `templates/pm-aispace/AGENTS.md`、`templates/help.md`）
  若与新表述矛盾，单独列出、另行处理 —— 放进去就是发出去。
- **文档与规范**：AGENTS.md 第 1 节重写并大幅缩短、验证闸加 `pnpm test:capabilities`；README、CLAUDE.md、
  `openspec/config.yaml`、两份技能改措辞。
- **依赖**：不引新依赖。
- **前置**：进行中的 `remove-ingest-ignore` 也改 AGENTS.md 第 1 节与 http.mjs，**须等它提交后再实施**本 change。
