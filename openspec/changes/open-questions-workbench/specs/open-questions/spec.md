## ADDED Requirements

### Requirement: 一问一文件的布局

未决问题 SHALL 以「一问一文件」存放在 `<工作空间>/output/analysis/questions/` 下，
文件名为 `Q<四位编号>.md`（如 `Q0134.md`）。编号在一个工作空间内唯一且只增不减，
关闭的问题保留文件，不删除、不复用编号。

不再使用单个 `open-questions.md` 表格承载问题条目。迁移后该文件 SHALL 只保留一句指向
`questions/` 目录的说明，避免两处漂移。

#### Scenario: 新增一条问题

- **WHEN** 技能需要记录一条新的待澄清问题
- **THEN** 它在 `output/analysis/questions/` 下新建一个 `Q<编号>.md`，编号取当前最大编号加一
- **AND** 不往任何既有文件追加表格行

#### Scenario: 关闭一条问题

- **WHEN** 一条问题被回答或被消解
- **THEN** 该文件的 `status` 字段改变，文件本身保留
- **AND** 编号不被后续问题复用

### Requirement: 扁平 front-matter 字段

问题文件 SHALL 以扁平 YAML front-matter 承载全部结构化字段，正文承载长文。
字段形状 MUST 兼容 `src/server/frontmatter.mjs` 已有的扁平解析器 —— 即只使用
`key: value` 与 `key:` + `  - item` 两种形态，**不使用嵌套对象**。

必填字段：`id`、`title`、`status`、`blocks`、`asked_of`、`source`。
`title` MUST 是一句话，长文放正文 —— 清单只显示 `title`，这是「条目长度由结构管住」的落点。

不再使用 `高/中/低` 优先级字段。排序轴是 `blocks`（这条问题阻塞哪个在途交付物）。

#### Scenario: 解析器能读出字段

- **WHEN** 服务端用现有的 `parseFrontmatter` 读一个问题文件
- **THEN** 返回的 `meta` 包含全部必填字段，无需引入新的 YAML 依赖

#### Scenario: 不阻塞任何交付物的问题

- **WHEN** 一条问题不阻塞任何在途交付物
- **THEN** `blocks` 写 `backlog`
- **AND** 它不出现在主视图的分组清单里

### Requirement: 四态状态机

`status` SHALL 取以下五个值之一，且流转 MUST 遵守下表：

| 值 | 含义 | 可流转到 |
| --- | --- | --- |
| `open` | 未处理 | `pending_ai`、`answered`、`dropped` |
| `pending_ai` | 人已反馈，AI 还没更新 | `answered`、`dropped`、`open`（再问一轮） |
| `answered` | 已消解，有结论 | `open`（对结论不满意，重开） |
| `dropped` | 本期不做 / 不相关 | `open` |
| `conflict` | 正文与状态不一致，迁移时识别出的存量脏数据 | `open`、`answered`、`dropped` |

`pending_ai` 是整个闭环的枢纽 —— 它标记「prompt 已经可以发出去 / 发了还没回来」，
MUST 是一个可筛选的独立状态，不能只体现为一个计数。

#### Scenario: 人反馈后进入待 AI 更新

- **WHEN** 人选了「资料里应该有，待查证」并保存
- **THEN** `status` 变为 `pending_ai`
- **AND** 该问题出现在「待 AI 更新」筛选下

#### Scenario: 对结论不满意，再问一轮

- **WHEN** 一条 `answered` 的问题被人重新打开
- **THEN** `status` 回到 `open`
- **AND** 上一轮的结论与人工反馈保留在正文的轮次记录里，不被覆盖

### Requirement: 凭据分级，推断不能关闭问题

`evidence` SHALL 取 `客户确认`、`资料实证`、`我方决策`、`我方推断` 之一。

只有前三种可以把 `status` 置为 `answered`。**`evidence: 我方推断` 的问题 MUST NOT 置为
`answered`** —— 它只能停在 `open` 并被标记为待验证假设。

这条约束是针对「AI 把未知领域伪装成确定事实」的：把推断和实证放在同一栏里、长得一模一样，
正是存量数据里出现状态冲突的原因。

#### Scenario: AI 查不到依据

- **WHEN** agent 查证后找不到任何资料依据，只能给出推断
- **THEN** 它写 `evidence: 我方推断` 并保持 `status: open`
- **AND** 该问题在看板上带一个显眼的推断角标

#### Scenario: 试图用推断关闭问题

- **WHEN** 一个问题文件同时写着 `evidence: 我方推断` 与 `status: answered`
- **THEN** 迁移与校验脚本 SHALL 报出这条为非法组合
- **AND** 看板把它显示为 `conflict`

### Requirement: 人写字段与 AI 写字段分区

问题文件的字段 SHALL 划成两个互斥的写区：

- **人写区**：`status`、`human_answer`、`human_note`、`due`
- **AI 写区**：`ai_conclusion`、`ai_evidence`、`ai_source`、`flows_to`

看板 MUST NOT 写 AI 写区的任何字段；agent 约定上不写人写区。
并发不是意外而是常态 —— 流程本身就是「人保存后立刻把 prompt 发给 agent」，
两者会在几秒内改同一个文件。分区使它们物理上不冲突，不需要锁。

#### Scenario: 人与 agent 同时改同一条

- **WHEN** 人在看板上保存了 `human_note`，同时 agent 正在写 `ai_conclusion`
- **THEN** 两次写入落在不同字段，都不丢失

#### Scenario: 看板试图写 AI 字段

- **WHEN** 写入请求的载荷里带了 `ai_conclusion`
- **THEN** 服务端拒绝该请求，返回 400，并且不落盘任何改动

### Requirement: 确需对方答复必须带最迟答复日期

`human_answer: ask`（确需对方答复）的问题 SHALL 同时填写 `due`（最迟答复日期，`YYYY-MM-DD`）。
没有 `due` 的会议清单没有任何机制逼它到期，存量积压正是这样形成的。

其余三个标准答案 MUST NOT 要求 `due`。

#### Scenario: 选了确需对方答复但没填日期

- **WHEN** 人选「确需对方答复」并点保存，但没填最迟答复日期
- **THEN** 保存被拒绝，界面就地提示需要填写
- **AND** 不产生任何落盘改动

### Requirement: 技能产出的双通道契约

模板内生成分析文档的技能 SHALL 把正文与未决问题分成两个通道输出：
分析结论写进分析文档，延伸出的未决问题写进独立问题文件。**两个通道 MUST NOT 互串** ——
既不把问题清单抄进分析文档正文，也不把分析正文抄进问题条目。

每个写入方技能 SHALL 在生成问题时填上 `source`（触发这条问题的文档路径）
与 `context`（触发时在做什么，一句话）。溯源锚点挂在**条目**上，不挂在分节上。

模板 SHALL 新增一个负责**出口**的技能：关闭与归档问题、按 `blocks` 生成会议清单。
现状是 9 个技能只往清单里追加、没有任何技能负责取出，这是清单失控的根因。

#### Scenario: 技能生成一份分析文档

- **WHEN** 某个分析技能产出了一份文档，并在过程中发现 3 个未决问题
- **THEN** 文档正文里不出现问题清单表格
- **AND** `questions/` 下多出 3 个文件，每个都带 `source` 指回这份文档

### Requirement: 存量迁移不自动推断凭据

迁移脚本 SHALL 把现有 `open-questions.md` 的表格条目逐条转成问题文件，
并 MUST NOT 自动推断 `evidence` 与 `blocks` —— 自动填出来的凭据本身就是虚假确定性。
这两个字段留空，交人工过一遍。

脚本 SHALL 单独列出两类存量脏数据供人裁定：
正文已写「已解决 / 不再阻塞 / 已定案」但编号没划掉的条目（置为 `conflict`），
以及根本不是问题的条目（如会议话术）。

#### Scenario: 迁移一份存量清单

- **WHEN** 对一份含两百余条、四十余个分节的存量清单跑迁移
- **THEN** 每条生成一个问题文件，`evidence` 与 `blocks` 为空
- **AND** 脚本输出一份待人工裁定清单，含状态冲突条目与疑似非问题条目

#### Scenario: 表格里有跨行或分叉编号

- **WHEN** 存量条目使用了 `16b` 这类分叉编号，或单元格里含 `|` 与换行
- **THEN** 迁移脚本 SHALL 保留原始行到问题文件的正文中，并在待裁定清单里点名该条
- **AND** 不静默丢弃任何一条
