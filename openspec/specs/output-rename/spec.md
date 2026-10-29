# output-rename

## Purpose

产出文档视图里，用户可以把 `analysis` / `docs` / `decisions` 三组原稿改名。看板先预览将改名的路径和要更新的链接，确认后只 spawn 工作空间的 `scripts/rename_output.py`：原稿、交付稿镜像目录和对应 Word 成品一起改名，指向旧路径的引用跟着改，有记录的在状态流水留痕。看板自己不写盘。
本能力由 `output-rename` 变更落地。

## Requirements

### Requirement: 三组原稿的行菜单提供「重命名」

产出文档视图中 `analysis` / `docs` / `decisions` 三组的每一行(含组内子目录与已归档项、含非 `.md` 文件)的「更多」菜单 SHALL 提供「重命名」。转换产物标签的行菜单 MUST 把它置灰并说明原因,不得可点;那里可用的是「复制到…」(见 `converted-copy-to-output`)。

#### Scenario: 交付文档行可以重命名

- **WHEN** 用户在「交付文档」标签某一行点「更多」
- **THEN** 菜单里有可点的「重命名」

#### Scenario: 转换产物不可重命名

- **WHEN** 用户在「转换产物」标签某一行点「更多」
- **THEN** 「重命名」置灰,悬停提示说明到「输入资料 → 原始资料」里重命名或移动该原件,关联会跟着更新
- **AND** 「复制到…」仍可用

#### Scenario: 工作空间没有改名脚本

- **WHEN** scan 返回 `canRename: false`
- **THEN** 「重命名」置灰,提示更新模板后可用

#### Scenario: 旧服务进程没给 canRename

- **WHEN** scan 结果里没有 `canRename` 字段
- **THEN** 「重命名」置灰,提示重启看板服务,不弹窗、不白屏

### Requirement: 先预览再执行

重命名 SHALL 分两步:用户填新基名后,看板先展示预览 —— 要改名的路径、要更新链接的文件清单与每个文件的处数;
排除范围内的命中 MUST NOT 出现在预览里;用户点「确定」才执行。预览成功之前「确定」MUST 不可点。
执行时脚本 MUST 重算计划并与预览指纹比对,不一致时 MUST 一个字节都不动并返回 409。

#### Scenario: 预览显示链接数

- **WHEN** 用户把 `output/docs/实施方案.md` 改为 `01实施方案`
- **THEN** 弹窗显示「将更新 N 个文件中的 M 处链接」,可展开看到每个文件及处数
- **AND** 磁盘上没有任何文件变化

#### Scenario: 预览后文件被改动

- **WHEN** 预览之后、确定之前,某份被引用的文件内容变了
- **THEN** 执行返回 409「预览之后有文件变了,请重新预览」,磁盘无变化

### Requirement: 改名连带镜像目录与 Word 成品

执行 SHALL 把原稿改为新基名(扩展名不变)。原稿是 `.md` 且交付稿镜像目录存在时,镜像目录 MUST 同步改名;
镜像目录内的 `<旧基名>.docx` 与原稿旁的 `<旧基名>.docx` MUST 改为 `<新基名>.docx`。
镜像目录里其余文件(`v*.md`、`v*.docx`、`定稿.md`、`定稿.assets/`、带时间戳的历史 Word)MUST 保持原名。

#### Scenario: 改名后交付稿仍在

- **WHEN** 一份有交付稿与定稿的原稿 `output/docs/实施方案.md` 被改名为 `01实施方案`
- **THEN** 镜像目录变为 `output/delivery/docs/01实施方案/`,看板点开新原稿能看到全部交付稿版本与定稿

#### Scenario: 子目录与已归档项

- **WHEN** 改名 `output/docs/一次归档/旧稿.md` 或 `output/docs/子目录/x.md`
- **THEN** 文件在原目录内改名,镜像目录按同一路径规则改名,不移动到别的目录

### Requirement: 更新指向这份文件的引用

执行 SHALL 更新 `output/**` 下 `.md` / `.yaml` / `.yml` 与工作空间根 `project.yaml` 中解析后指向旧路径(或旧镜像目录下)的引用:
记录 `target`、交付稿与定稿 front-matter 的 `source` / `docx`、批注 `- 对象：` 行、问题 `source` / `flows_to`、
工作空间根路径、相对链接与 wikilink。改写 MUST 保留 `#锚点`、`|别名`、是否带 `.md` 与相对 / 绝对形式;
MUST NOT 替换不构成路径引用的同名词语。

因链接改写而内容变化的其他原稿,其交付稿中 `source_sha` 等于改写前摘要的 MUST 换成改写后的摘要。

#### Scenario: 记录与批注跟到新路径

- **WHEN** 改名完成
- **THEN** 原稿对应记录的 `target` 是新路径,该记录的批注仍挂在新原稿与各版交付稿上

#### Scenario: wikilink 保留形式

- **WHEN** 另一份分析文档里写着 `[[../docs/实施方案#范围|方案]]`
- **THEN** 改写为 `[[../docs/01实施方案#范围|方案]]`

#### Scenario: 同名词语不误改

- **WHEN** 某文档正文出现不带路径的「实施方案」四个字
- **THEN** 原样保留

#### Scenario: 其他原稿不误报已变更

- **WHEN** 原稿 B 因为链接改写而内容变化,且 B 的最新交付稿改名前未提示「原稿已变更」
- **THEN** 改名后 B 的最新交付稿仍不提示「原稿已变更」

### Requirement: 写入边界

看板 MUST 只 spawn 工作空间的 `scripts/rename_output.py`,自己不写、不改名、不删除任何工作空间文件;
请求 MUST 只带 `docKey` 与新基名,不接受路径;接口 MUST 环回且非跨站,否则 403。
脚本 MUST NOT 改动 `input/`、`output/converted/`、`visualization/`、`.claude/`、根 `AGENTS.md`,
MUST NOT 改动交付稿 `v*.md` 的正文。
MUST NOT 删除任何文件。

#### Scenario: 新基名带路径

- **WHEN** 请求的新基名包含 `/`、`\`、`..` 或以 `.` 开头
- **THEN** 返回 400,不 spawn 脚本

#### Scenario: 非环回监听

- **WHEN** 看板以非环回地址监听时调用改名接口
- **THEN** 返回 403

#### Scenario: 规则库历史不动

- **WHEN** `.claude/` 下的规则库历史条目提到旧路径
- **THEN** 改名后该文件一个字节不变

### Requirement: 改名在记录状态流水里留痕

原稿有对应记录(`target` 等于旧路径)时,执行 SHALL 在该记录「## 状态流水」末尾追加一条
`### <日期> · <当前状态>`,正文写明旧路径 → 新路径与「看板重命名、状态未变」。
记录缺这一节时 MUST 先在文末补上该小节。MUST NOT 改变记录的 `status`,原稿没有记录时 MUST NOT 新建记录。

#### Scenario: 有记录的原稿改名

- **WHEN** `output/docs/实施方案.md` 有记录 `I0004`,改名为 `01实施方案`
- **THEN** `I0004` 的 `target` 是新路径,状态流水多出一条改名留痕,`status` 不变,记录详情里能看到这一条

#### Scenario: 没有记录的原稿改名

- **WHEN** 改名一份没有记录的原稿
- **THEN** `output/records/` 下没有新增文件

### Requirement: 冲突拒绝且失败不留半截

新路径、新镜像目录、或新 `<新基名>.docx` 已存在时 MUST 拒绝(409),磁盘无变化。
执行中改名步骤失败 MUST 回退已做的改名并清掉临时文件;链接改写 MUST 先写临时文件、改名全部成功后再原子替换。

#### Scenario: 新名已被占用

- **WHEN** 把 `实施方案.md` 改为一个同目录已存在的名字
- **THEN** 预览即显示冲突、「确定」不可点;直接调执行接口返回 409,磁盘无变化

### Requirement: 改名后界面跟到新路径

执行成功后,看板 SHALL 把收藏置顶里的旧路径换成新路径;阅读器正打开这份原稿时 SHALL 切到新路径。
列表由文件监听自动刷新。

#### Scenario: 收藏的文件改名

- **WHEN** 一份已收藏置顶的原稿被改名
- **THEN** 改名后它仍在置顶位置

### Requirement: 新基名的校验

新基名 MUST 是不带扩展名的一层名字：不以 `.` 开头或结尾，不含 `/ \ .. < > : " | ? * # [ ]`，不超过 120 个字，
不等于 `一次归档`。服务端与脚本 MUST 各校验一次，不合格 400，不 spawn 脚本。

#### Scenario: 新基名是归档目录名

- **WHEN** 用户把一份原稿改名为 `一次归档`
- **THEN** 返回 400，原稿不变

#### Scenario: 新基名过长

- **WHEN** 新基名有 121 个字
- **THEN** 返回 400，不 spawn 脚本
