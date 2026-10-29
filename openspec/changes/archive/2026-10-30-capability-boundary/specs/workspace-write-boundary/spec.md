## ADDED Requirements

### Requirement: 看板定位为本机工作空间协作台，写入只走能力清单

看板 SHALL 定位为"查看、管理本机工作空间里与 AI 协作的产物，查看并简单维护原始输入"的协作台。
看板服务端对工作空间的任何写入（含新建、改写、改名、移动、spawn 会写工作空间的脚本）
MUST 属于 AGENTS.md 第 1 节能力清单里登记的某一项能力；清单以外的工作空间文件一律只读。
README、AGENTS.md、CLAUDE.md、`openspec/config.yaml` 与工程技能 MUST NOT 再把看板称为"只读看板"。

#### Scenario: 定位语一致

- **WHEN** 在 README.md、AGENTS.md、CLAUDE.md、`openspec/config.yaml`、`.claude/skills/` 下搜索"只读看板"
- **THEN** 没有匹配；README 首段与 AGENTS.md 第 1 节写的是协作台定位与"写入走安全链路"

#### Scenario: 清单外的写入被当作 bug

- **WHEN** 有人在 `src/server/**` 新加一处写工作空间的代码，却没有在能力清单与注册表里登记
- **THEN** `pnpm test:capabilities` 失败并指出该文件与行号

### Requirement: 每项写能力满足六条安全链路

能力清单里的每一项 MUST 同时满足以下六条；偏离任何一条 MUST 在清单该行标"偏离"并写明理由，由人拍板后才能合入：

1. **发起**：只由用户在看板上的明确操作触发；没有后台任务、定时、文件变化自动重跑。
2. **来源**：服务监听环回地址（`allowMutations`）且请求不是跨站或扩展来源，否则 403。
3. **寻址**：请求不带工作空间路径；目标只用服务端下发的不透明键、编号或固定枚举，服务端反查后过 `resolveInside()`。
4. **写入面**：事先写明可写的工作空间目录 / 文件 / 字段，其余只读；读写工作空间以外的任何文件都算偏离。
   看板**直写**有人写区与 AI 写区的文件时，只写人写区；spawn 的脚本按其 spec 可改写 AI 写区里指向被改名 / 移动文件的路径。
5. **执行者**：有工作空间脚本能承接的，看板只 spawn 脚本、自己不写；看板直写只做小写入，先写临时文件再原子替换。
   缺脚本或旧服务进程不支持时置灰或 400，不由看板代劳。
6. **可回退**：不覆盖别人的内容 —— 用户写的、AI 写的、外部带进来的文件一律不覆盖，落点已存在 409；
   只有本能力自己生成、能从来源重新生成的派生文件可以整份重建（如原型镜像、`定稿.md`、带生成标记的 `.docx`）。
   动多个文件的先出预览并带指纹确认。删除见下一条要求。

#### Scenario: 不满足链路的请求被拒

- **WHEN** 用 curl 带 `Origin: https://example.com` 或 `Sec-Fetch-Site: cross-site` 调任一写接口
- **THEN** 返回 403，工作空间无任何文件变化

#### Scenario: 只读分享时写接口全部关闭

- **WHEN** 以 `--host 0.0.0.0` 启动服务后调任一写接口
- **THEN** 返回 403 且文案说明需在 127.0.0.1 上重启；扫描、读文件、预览照常可用

#### Scenario: 已登记的偏离

- **WHEN** 查看能力清单中"采集包接收""交付稿定稿""刷新原型"三行
- **THEN** 采集包接收标明偏离"发起"（由扩展投递触发，不在看板上点）与"来源"（放行浏览器扩展来源）；
  交付稿定稿标明偏离"写入面"（读用户在系统选文件框里亲手选中的一个工作空间外 `.docx`）；
  刷新原型标明偏离"写入面"（脚本写工作空间外原型目录的 `.workspace-inbox.md`）；各附理由与补偿措施

### Requirement: 删除只进回收区

任何能力若要删除工作空间文件，MUST 把它移入工作空间内的回收区 `.aispace/trash/`，并记录原路径与时间以便还原；
看板 MUST NOT 对工作空间文件做真删除（`unlink` / `rm` / `rmdir`）。
清理本次操作自己创建的临时文件或空目录不算删除。
本要求只立规则；在单独的 change 引入第一项删除能力之前，能力清单中没有任何一项具备删除。

#### Scenario: 检查脚本拦下真删除

- **WHEN** `src/server/**` 某个工作空间写模块里出现对非临时路径的 `unlinkSync` / `rmSync`，且该行没有临时文件清理标注
- **THEN** `pnpm test:capabilities` 失败并指出位置

#### Scenario: 现有能力没有删除

- **WHEN** 阅读能力清单的"写入面"列
- **THEN** 没有任何一行包含删除；归档、重命名、移动都是改名，原件仍在工作空间内

### Requirement: 能力注册表与统一闸

服务端 SHALL 有唯一的能力注册表 `src/server/capabilities.mjs`，每项能力登记：标识、名称、作用域
（`workspace` 写工作空间 / `local` 只写本机状态，如注册表 `~/.pmwork/`、缓存）、执行者（`spawn` / `direct`）、
承载模块、对应 spec、偏离说明。
http.mjs 中所有非 GET 路由 MUST 先调用 `guardCapability(req, res, <标识>, { allowMutations })`，
由它统一执行环回与来源判定；判定逻辑与 403 文案与改动前一致，MUST NOT 另写第二份。

#### Scenario: 收口后行为不变

- **WHEN** 重启服务后在看板上依次执行转换资料、保存未决问题、改记录状态、复制提示词写批注、标记反馈单已发送、
  归档、重命名、复制转换产物、整理原始资料、刷新原型、刷新参考、采集 URL
- **THEN** 每一项成功路径与改动前相同；`--host 0.0.0.0` 下每一项都 403

#### Scenario: 未登记标识

- **WHEN** 路由调用 `guardCapability` 时传了注册表里没有的标识
- **THEN** 服务端按 500 返回并在日志写明标识未登记，不执行写入；`pnpm test:capabilities` 也会提前报出

### Requirement: 检查脚本把关边界

仓库 SHALL 提供 `pnpm test:capabilities`（`scripts/check-capabilities.mjs`），纯静态扫描、不起服务，检查：

- `src/server/**` 中 fs 写调用（`writeFile*` `appendFile*` `rename*` `mkdir*` `copyFile*` `rm*` `unlink*` `createWriteStream` 等）
  与 `spawn` / `execFile` 只出现在注册表登记的承载模块里；
- http.mjs 中每个非 GET 分支都调用了 `guardCapability`，且标识均已登记；
- 注册表中 `workspace` 作用域的能力与 AGENTS.md 能力清单一一对应（按标识比对）。

该命令 MUST 列入 AGENTS.md 的验证闸，改 `src/server/**` 后必跑。

#### Scenario: 全部通过

- **WHEN** 在本 change 实施完成的代码上运行 `pnpm test:capabilities`
- **THEN** 退出码 0，输出各能力的承载模块与路由数

#### Scenario: 清单与注册表不一致

- **WHEN** AGENTS.md 能力清单删掉一行而注册表保留
- **THEN** 退出码非 0，指出缺的标识

### Requirement: 能力细则以 spec 为准

AGENTS.md 能力清单每行 MUST 链接到一份 `openspec/specs/<能力>/spec.md`，该能力的写入面、请求形状、失败路径细则以 spec 为准；
AGENTS.md MUST NOT 再逐条复述细则。

#### Scenario: 清单行可追到 spec

- **WHEN** 点开能力清单任一行的 spec 链接
- **THEN** 该 spec 写有这项能力的写入范围、请求不带路径的寻址方式与拒绝条件
