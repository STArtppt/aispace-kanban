## ADDED Requirements

### Requirement: 源码模式下说明不必发邮件

当 `/api/health` 的 `launch` 为 `"source"` 时，反馈单详情 SHALL 说明：这份单子留在工作空间里，源码侧可以直接读，不必发邮件，也不必点「我已发出」；回执回来后由工作空间智能体改状态。
「邮件发送」按钮、预览和 `mailto:` MUST 仍然可用，行为与「邮件发送反馈单」一致。
`launch` 不是 `"source"` 或字段缺失时，MUST NOT 显示这段说明。
这段说明 MUST NOT 使用表示「需要注意」的强调色。

#### Scenario: 源码模式打开反馈单

- **WHEN** `launch` 为 `"source"`，用户打开一份待发送的反馈单
- **THEN** 详情里能看到不必发邮件的说明，「邮件发送」仍可点开预览

#### Scenario: npm 包模式不出现这段说明

- **WHEN** `launch` 为 `"package"`，用户打开同一份反馈单
- **THEN** 详情与改动前一样，没有这段说明
