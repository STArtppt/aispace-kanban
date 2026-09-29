## ADDED Requirements

### Requirement: 「添加环境参数」入口在要配的地方就近出现

看板 MUST 在两处提供入口,两处打开的是**各自独立的对话框**,MUST NOT 在同一层里用 tab 切换类型:

- 「输入资料 · 原始资料」tab 的标题栏,视图切换按钮组**之前**,一个 key 图标按钮,
  打开「添加 API Key」对话框;
- 「输入资料 · 数据库源」tab 的标题栏,一个数据库图标按钮,打开「添加数据库源」对话框。

两个图标按钮 MUST 与同一排的排序 / 筛选 / 搜索同一套描边方钮(outline + size-8),
MUST 使用 startist Tooltip,MUST NOT 用浏览器原生 `title`。
同一排其它图标按钮(排序、筛选、搜索、视图切换、刷新 schema)的提示 MUST 同样走 startist Tooltip。

#### Scenario: 从原始资料 tab 配 MinerU key
- **WHEN** 用户停在「原始资料」tab,点标题栏那个 key 图标按钮
- **THEN** 弹出「添加 API Key」对话框,变量名预填 `MINERU_API_KEY` 且可编辑
- **AND** 对话框里没有切到「数据库」的 tab 或开关

#### Scenario: 从数据库源 tab 加一个库
- **WHEN** 用户停在「数据库源」tab,点标题栏那个数据库图标按钮
- **THEN** 弹出「添加数据库源」对话框,只有显示名和一段连接信息粘贴框
- **AND** 对话框里没有切到「API Key」的 tab 或开关,也没有引擎 / 主机 / 端口 / 库名 / 账号 / 口令这些拆开的字段

#### Scenario: 标题栏按钮与 tooltip
- **WHEN** 用户停在「原始资料」或「数据库源」tab,看标题栏右侧那一排图标
- **THEN** 添加按钮与排序 / 筛选 / 搜索同一套描边方钮
- **AND** 悬停任一图标看到的是 startist Tooltip,不是浏览器默认黄框

#### Scenario: 一个源都还没有的工作空间
- **WHEN** 工作空间有 `input/sources/` 目录但里面一份 `*.yaml` 都没有
- **THEN** 「数据库源」tab 仍然出现,空态里能看到并点到这个添加按钮

### Requirement: 主动作是复制 prompt,看板不落任何凭据

对话框的主按钮 MUST 是「复制 prompt 给 AI」,MUST NOT 提供「保存到看板」一类的动作。
看板 MUST NOT 把用户填的任何字段发给任何接口、写进任何文件、写进日志或注册表。
API Key 的 token 字段 MUST 用 password 类型输入框。数据库连接信息是原文粘贴框,MUST NOT 再拆成口令框。
对话框 MUST 在界面上明写:内容只进剪贴板,由用户粘给 AI 完成配置,刷新页面即丢失。
关闭对话框或刷新页面后,已填的凭据 MUST NOT 被保留。

#### Scenario: 复制后粘给 AI
- **WHEN** 用户填完 MinerU 的 key,点「复制 prompt 给 AI」
- **THEN** 用 startist sonner 的成功提示说明「已复制，粘给当前 Agent」,输入框下面不再出现这段字
- **AND** 主按钮先进入不可点的浅灰态,约一秒半后恢复可点
- **AND** 服务端没有收到任何携带该 key 的请求

#### Scenario: 刷新页面
- **WHEN** 用户填了口令但没有提交,刷新页面后重新打开对话框
- **THEN** 所有字段是空的,没有任何被记住的值

#### Scenario: 剪贴板不可用
- **WHEN** 用户从另一台机器用 http 访问看板,浏览器没有 Clipboard API 且兜底写入也失败
- **THEN** 界面明确提示复制失败,并把 prompt 原文显示出来供手工选取
- **AND** MUST NOT 静默当作成功

### Requirement: prompt 照模板已冻结的字段契约拼装

复制出的文本 MUST 以能触发工作空间 `pm-env-config` 技能的固定头开始,
后接平铺的 `key: value` 行,字段名与取值形态 MUST 与
`templates/pm-aispace/.claude/skills/pm-env-config/references/kanban-prompt.md` 一致。
用户没填的字段 MUST NOT 出现在输出里。
「添加数据库源」对话框 MUST 只收显示名和一段连接信息原文。
用户粘了原始 JDBC / Spring / 主机端口账号口令时,看板 MUST 把它原样跟在固定头和 `kind: database`(以及填了的 `name`)后面,
MUST NOT 自己拆字段、MUST NOT 猜引擎或端口 —— 拆解由 AI 按技能做。
复制出的文本末尾 MUST 带一段「输出要求」:配完后用几句简单易懂的话说明结果,不要贴配置原文、不要回显口令或 token。
看板 MUST NOT 在 prompt 里写入任何本机绝对路径或工作空间外的信息。
对话框表单 MUST 完整可见:字段不得被弹窗边缘裁切;内容超出时在弹窗体内滚动,焦点环不得被切掉。

#### Scenario: 数据库只贴了一段连接信息
- **WHEN** 用户填了显示名,在连接信息框里粘了一段 `jdbc.url` / `jdbc.username` / `jdbc.password` 并复制
- **THEN** 剪贴板内容第一行是固定头,随后是 `kind: database`、`name: …`,再是这段原文
- **AND** 看板没有推断出引擎、主机、端口或其它字段值

#### Scenario: 数据库没填显示名
- **WHEN** 用户只粘了连接信息、显示名为空并复制
- **THEN** 剪贴板内容有固定头和 `kind: database`,没有 `name:` 行,原文跟在后面

#### Scenario: 复制出的文本带输出要求
- **WHEN** 用户复制 API Key 或数据库源的 prompt
- **THEN** 剪贴板内容以固定头开始,以「输出要求」那段结尾,要求 Agent 用简单易懂的话说明配置结果

#### Scenario: 必填项没填
- **WHEN** API Key 的变量名或值为空,或数据库的连接信息为空
- **THEN** 复制按钮不可点,并说明还缺什么
