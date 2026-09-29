## ADDED Requirements

### Requirement: 一份产出物一个记录文件

产出物记录 SHALL 落在 `output/records/`,与 `analysis/` `docs/` `decisions/` `questions/` **平级**。
一份产出物一个记录,文件名 `I<四位编号>.md`。

记录是**我方视角的私有元数据**,MUST NOT 与产出物本身混为一体:
本能力 MUST NOT 要求、也 MUST NOT 修改 `output/analysis/`、`output/docs/`、`output/decisions/`
下任何文件的内容或 front-matter。

#### Scenario: 为一份交付文档建记录

- **WHEN** 技能为 `output/docs/某份文档.md` 建立记录
- **THEN** 生成 `output/records/I<新编号>.md`,`kind` 为 `docs`,`target` 指向该文档的相对路径
- **AND** `output/docs/某份文档.md` 一个字节都没有变化

#### Scenario: 产出物进入终态

- **WHEN** 一份产出物的记录进入终态(`absorbed` / `final` / `superseded` / `overturned` 等)
- **THEN** 记录文件 MUST 保留,不删除、不改名

### Requirement: 编号唯一且只增不复用

编号在一个工作空间内 MUST 唯一,MUST 只增不复用。
终态、归档之后 MUST NOT 被新的产出物重新使用 ——
编号是外部引用的锚点(会议纪要、别的分析文档会写「见 I0007」)。

新增时取当前最大编号加一。**目录为空不等于从 `I0001` 开始**:
整批随阶段结束归档之后目录就是空的,这时从头编号会让此前所有外部引用指向一条内容无关的新记录 ——
那比悬空引用危险,因为它看起来完全正常。空目录 MUST 先查历史用过的最大编号。

`decisions/` 自己的 `0001-短标题.md` 文件名序号与记录编号是**两套互不相干的编号**,
记录编号 MUST NOT 与它对齐或复用。

#### Scenario: 目录为空时新建

- **WHEN** `output/records/` 下没有任何 `I*.md`,技能要新建一份
- **THEN** 先从版本历史里查曾经用过的最大编号,取其加一
- **AND** 查不到(确实是新工作空间)才从 `I0001` 开始

#### Scenario: 一份交付文档被新版取代

- **WHEN** `I0007` 对应的文档取代了 `I0001` 对应的文档
- **THEN** `I0001` 的记录保留,`status` 为 `superseded`,`resolved_by` 为 `I0007`
- **AND** `I0001` 这个编号不被任何新产出物占用

### Requirement: 扁平 front-matter 字段

front-matter MUST 是扁平的:只用 `key: value` 与 `key:` + `  - item` 两种形态,MUST NOT 用嵌套对象。
这不只是迁就解析器 —— 扁平限制强制 `title` 是一句话、`target` 是一个路径,
**条目长度由结构管住,不靠自觉**。长文 MUST 进正文。

必填字段:

| 字段 | 含义 | 约束 |
| --- | --- | --- |
| `id` | 编号 | MUST 与文件名一致(`I0007.md` → `I0007`) |
| `kind` | 产出物类别 | `analysis` / `docs` / `decisions` 三者之一 |
| `title` | **一句话**说清这份产出物是什么 | 清单只显示它 |
| `target` | 产出物的工作空间相对路径 | MUST 指向 `kind` 对应的那个子目录下的文件 |
| `status` | 当前状态 | MUST 属于该 `kind` 的状态机 |
| `created` | 建立日期 | `YYYY-MM-DD` |

可选字段:`resolved_by`(被哪个编号吸收/取代/推翻)、`status_changed`(状态最后一次变更日期)、
`updated`(内容最后一次更新日期)。

#### Scenario: 解析器能读出字段

- **WHEN** 看板的 front-matter 解析器读一份记录文件
- **THEN** 上表字段全部读出为字符串,没有整体被当成一个字符串的字段

#### Scenario: kind 与 target 不匹配

- **WHEN** `kind` 是 `docs` 而 `target` 指向 `output/analysis/` 下的文件
- **THEN** 校验 MUST 报告这一条

#### Scenario: target 指向的产出物不存在

- **WHEN** `target` 指向的文件已经被删除或改名
- **THEN** 看板 MUST 把这份记录标成「指向丢失」,MUST NOT 隐藏它、MUST NOT 报错崩溃
- **AND** 记录文件本身不被修改

#### Scenario: 长文写进 front-matter

- **WHEN** 有人把一段几百字的说明写进 front-matter 的某个字段
- **THEN** 校验 MUST 报告这一条(该内容属于正文的状态流水)

### Requirement: 三类产出物各有自己的状态机

`status` 的合法取值 MUST 由 `kind` 决定,三类 MUST NOT 共用一套。

`kind: analysis`:

| 值 | 含义 |
| --- | --- |
| `drafting` | 在写 |
| `absorbed` | 已被后续产出物吸收,`resolved_by` MUST 有值 |
| `stale` | 过时,没被用上 |

`kind: docs`:

| 值 | 含义 |
| --- | --- |
| `draft` | 草稿,还没发出(含内部评审) |
| `delivered` | 已发出,等对方反馈 |
| `revising` | 收到反馈,待修订 |
| `final` | 已定稿 |
| `superseded` | 被新版取代,`resolved_by` MUST 有值 |

`kind: decisions`(照搬模板 README 里已有的三态约定,不另立一套):

| 值 | 含义 |
| --- | --- |
| `pending` | 待确认 |
| `confirmed` | 已确认 |
| `overturned` | 已推翻,`resolved_by` MUST 有值 |

三套 MUST NOT 包含「已归档」—— 归档改变的是文件位置,不是产出物的状态。

#### Scenario: 用了不属于本类的状态

- **WHEN** 一份 `kind: analysis` 的记录把 `status` 写成 `delivered`
- **THEN** 校验 MUST 报告这一条,写入接口 MUST 返回 400

#### Scenario: 进入终态但没说被谁消解

- **WHEN** `status` 改成 `absorbed` / `superseded` / `overturned` 而 `resolved_by` 为空
- **THEN** 校验 MUST 报告这一条,写入接口 MUST 返回 400
  (终态必须说清被谁消解,否则外部引用无处可去)

#### Scenario: 发出去之后长期没有回音

- **WHEN** 一份 `docs` 记录 `delivered` 之后很久没有反馈
- **THEN** 它 MUST 仍然是 `delivered`,由日期与当天的差值表达停滞
- **AND** MUST NOT 为此引入额外状态(状态不表达时间的流逝)

### Requirement: 状态变更落成正文的状态流水

每次状态变更 MUST 在正文「## 状态流水」小节下追加一条 `###` 子节,
带**日期、变更后的状态值、以及一句补充说明**。
追加 MUST NOT 改写已有的流水条目。

`status` 字段 MUST 等于流水最后一条的状态值。两者不一致时以 `status` 为准
(解析器读它做分组),校验 MUST 报告不一致 —— 这种不一致只会来自手工编辑。

补充说明是**一句话级的注解**,长篇内容(如对方完整的评审意见)MUST 写在正文别处,
由 agent 维护。

#### Scenario: 记一次状态变更

- **WHEN** 用户把一份 `docs` 记录从 `delivered` 改成 `revising`,并填了一句说明
- **THEN** 「## 状态流水」末尾多出一条带日期、`revising`、该说明的子节
- **AND** front-matter 的 `status` 变成 `revising`,已有流水条目一个字都没改

#### Scenario: 流水小节还不存在

- **WHEN** 记录里还没有「## 状态流水」小节,发生第一次状态变更
- **THEN** 该小节被创建在正文末尾,这条变更作为它的第一个子节

#### Scenario: status 与流水末条不一致

- **WHEN** 手工编辑导致 `status` 是 `final` 而流水最后一条是 `revising`
- **THEN** 看板按 `status` 分组,校验脚本 MUST 报告这处不一致

### Requirement: 人写区与 AI 写区分区

字段 MUST 按写入方物理隔开 —— 这本身就是并发方案,不引入锁。

| 区 | 内容 | 谁写 |
| --- | --- | --- |
| 建立时写定 | `id` `kind` `title` `created` | 技能建记录时写,之后不改 |
| 人写区 | `status` `resolved_by` `status_changed`、正文「## 状态流水」小节 | 看板可写 |
| AI 写区 | `target` `updated`、正文除「## 状态流水」以外的一切 | 工作空间的 agent 写,看板 MUST NOT 写 |

`target` 归 AI 写区:产出物文件改名时要跟进,而只有能看到文件系统的 agent 有依据判断。

#### Scenario: 人与 agent 同时改同一份记录

- **WHEN** 用户在看板上改 `status`,同时 agent 在更新 `updated` 与正文其他小节
- **THEN** 两边写的是不相交的字段与小节,不需要加锁,最后两边的改动都在

#### Scenario: 看板试图写 AI 写区字段

- **WHEN** 写入请求的载荷里出现 `target` 或 `updated`
- **THEN** 接口 MUST 返回 400,且 MUST NOT 落盘任何改动

### Requirement: 记录由技能建立,看板不新建

记录文件的**建立** MUST 由工作空间的技能负责。
看板 MUST 只改已存在的文件:文件不存在一律 404,MUST NOT 新建、MUST NOT 删除、MUST NOT 改名。

#### Scenario: 看板收到写入请求但记录不存在

- **WHEN** 写入请求指向一个不存在的编号
- **THEN** 接口返回 404,工作空间内没有任何文件被创建

#### Scenario: 技能建产出物时一并建记录

- **WHEN** 技能新产出一份分析文档
- **THEN** 它 MUST 同时建立对应的记录,`status` 为 `drafting`

### Requirement: 状态不自动推导

状态 MUST 由人在看板上、或 agent 在工作空间里明确置位,系统 MUST NOT 自动置位任何状态。
`analysis` 的 `absorbed` 理论上能从溯源反链推出来(这份分析被某份 `docs` 引用了),
但推错一条就是在骗人,而「这份到底算不算被吸收」需要判断,不是字符串匹配能定的。

#### Scenario: 一份分析被某份交付文档引用了

- **WHEN** 某份 `analysis` 产出物的路径出现在某份 `docs` 产出物的正文里
- **THEN** 它的记录 `status` MUST 保持原样,MUST NOT 被自动改成 `absorbed`

### Requirement: 不进产出列表,也不喂溯源反链

`output/records/` 下的一切 MUST NOT 出现在产出视图的三组列表
(`analysis` / `docs` / `decisions`)里 —— 三类合计的记录数会把「分析中间产物」那份清单整个淹掉。

记录的正文 MUST NOT 喂给溯源反链统计。
状态流水会抄产出物原文与资料引用,喂进去会把「被 N 篇产出引用」顶虚高,
让「转换好了却没人用」这个缺口提示失真。这与 `questions/` 的处理**不同**
(问题正文是喂反链的),差异 MUST 在扫描代码里注明理由。

#### Scenario: 产出视图的三组计数

- **WHEN** `output/records/` 下有大量记录,用户打开产出视图
- **THEN** 三组列表与计数与没有这个目录时完全一致

#### Scenario: 一份资料只被记录的状态流水提到过

- **WHEN** 某份 `input/converted/` 的资料只在某条状态流水的说明里被提到
- **THEN** 它 MUST 仍然显示为「还没有产出引用它」

### Requirement: decisions 的状态从正文迁进 front-matter

存量决策的状态 MUST 迁进记录的 front-matter,且迁移 MUST NOT 改动决策文件本身。
存量 `output/decisions/` 的状态写在正文 bullet(「- 状态:已确认 | 待确认 | 已推翻」),
解析器读不到。迁移 MUST 为每条决策建立记录并把状态填进记录的 front-matter。

迁移 MUST NOT 删除正文里那行 bullet —— 它是给人读的,删了反而丢信息。
迁移脚本 MUST 默认预演、不落盘,落盘 MUST 要求显式参数。

#### Scenario: 迁移一条已推翻的决策

- **WHEN** 某条决策正文写着「状态:已推翻(被 0007 取代)」
- **THEN** 为它建立记录,`kind` 为 `decisions`,`status` 为 `overturned`
- **AND** `resolved_by` 指向 0007 那条决策的记录编号
- **AND** 决策文件正文里那行 bullet 逐字节保留

#### Scenario: 正文里读不出状态

- **WHEN** 某条决策正文没有状态那行,或写法不认识
- **THEN** 迁移 MUST 把它标成待人工确认,MUST NOT 猜一个状态填进去

#### Scenario: 预演

- **WHEN** 迁移脚本不带落盘参数运行
- **THEN** 它只报告将建哪些记录、哪些读不出状态,工作空间内没有任何文件被创建或修改
