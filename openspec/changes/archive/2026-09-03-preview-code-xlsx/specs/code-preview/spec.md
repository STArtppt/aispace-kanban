## ADDED Requirements

### Requirement: 代码类文本按语言高亮预览

当预览窗打开扩展名为 `.yaml`、`.yml`、`.json` 或 `.xml` 的文件，且正文已通过现有文本接口读到时，看板 MUST 按该扩展名对应的语言做语法高亮显示，MUST 显示行号，MUST NOT 再使用无高亮的裸等宽纯文本作为默认视图。

语言映射 MUST 为：`.yaml` / `.yml` → yaml，`.json` → json，`.xml` → xml。`.txt` MUST 保持现有纯文本预览，MUST NOT 被当成代码高亮。

高亮配色 MUST 使用已有的 Shiki 主题（浅色 `github-light`、深色 `github-dark`），MUST NOT 另引入一套彩色语法主题，MUST NOT 在组件里硬编码色值。

高亮失败（未知语言、Shiki 抛错）时 MUST 退回改动前的纯文本 `<pre>` 视图，MUST NOT 白屏，MUST NOT 把文件改标成「原始格式、网页里不渲染」。

正文仍 MUST 走现有 `GET /api/projects/:id/file`，MUST NOT 为代码预览新增接口。`reader` 字段 MUST 继续是 `text`（旧服务进程同样能高亮）。

#### Scenario: yaml 按代码高亮
- **WHEN** 预览窗打开一份 `.yaml` 或 `.yml` 产出且正文已读到
- **THEN** 正文按 yaml 语法高亮，并显示行号
- **AND** 不是改动前那种无高亮纯文本

#### Scenario: json 与 xml 同样处理
- **WHEN** 预览窗打开一份 `.json` 或 `.xml`
- **THEN** 分别按 json、xml 高亮，并显示行号

#### Scenario: txt 仍是纯文本
- **WHEN** 预览窗打开一份 `.txt`
- **THEN** 仍是现有的纯文本预览，没有按某种编程语言高亮

#### Scenario: 高亮失败仍能读
- **WHEN** 高亮过程抛错
- **THEN** 预览退回纯文本 `<pre>`，文件仍可读
- **AND** 不出现「网页里不渲染」的原始格式空态

#### Scenario: 旧服务进程也能高亮
- **WHEN** 常驻服务还是旧版本，scan 给的 `reader` 仍是 `text`
- **AND** 前端打开一份 `.yaml`
- **THEN** 仍按 yaml 高亮（只看扩展名，不依赖新字段）

### Requirement: 代码预览按行可检索、可复制

代码高亮视图 MUST 保持预览窗内检索可用：搜索按钮出现条件与纯文本预览相同；每一行 MUST 仍是检索可定位的一块，选中结果后 MUST 滚动到该行并临时高亮约两秒。

高亮产生的 token 着色 MUST NOT 破坏按行分块：检索索引 MUST 按行而不是按 token。看板 MUST NOT 为了高亮而让 `collectBlocks()` 对这份正文返回空数组。

视图 MUST 提供复制全文的入口。复制结果 MUST 是文件原文，MUST NOT 夹带行号。

代码预览 MUST NOT 启用批注：没有 markdown 源码锚点，选取文字 MUST NOT 冒出批注按钮。

#### Scenario: yaml 里能搜到键名
- **WHEN** 一份 yaml 里某行含 `timeout`
- **AND** 在预览窗检索「timeout」
- **THEN** 该行出现在结果里
- **AND** 选中后预览滚动到这一行并临时高亮

#### Scenario: 复制不含行号
- **WHEN** 用户复制这份代码预览的全文
- **THEN** 剪贴板里是文件原文，没有行号前缀
