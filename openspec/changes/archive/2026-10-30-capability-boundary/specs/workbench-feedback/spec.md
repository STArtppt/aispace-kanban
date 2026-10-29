## MODIFIED Requirements

### Requirement: 用户确认后写回发送记录

唤起邮件客户端之后，界面 SHALL 出现「我已发出」。用户点击后，前端调用 `POST /api/projects/:id/feedback/:fid/sent`，
服务端 SHALL 把 `sent_at` 写成当前时间，并在「## 发送记录」下追加一条 `### <日期时间> 已发送至 aispace_kanban@163.com`。
这个接口（能力标识 `feedback-sent`）MUST 满足以下全部边界：只改已存在的反馈单（不存在就 404），不新建、不删除、不改名；
只写人写区，即 front-matter 的 `sent_at` 与「## 发送记录」（只追加 `###` 子节），载荷带 AI 写区字段
（`status` / `receipt` / `title` / `kind` / `id` / `created` 等）一律 400；请求只带编号（`F0003`），落盘路径由服务端过 `resolveInside()` 自己拼；
由用户点「我已发出」发起，唤起 mailto 本身不写盘；环回且非跨站（否则 403）；先写临时文件再原子替换。
反馈单结构认不出（没有 front-matter 或没有「## 发送记录」）时 409。其余文件（含 `.kanban-feedback/`、`output/docx-template/`）只读。

#### Scenario: 标记已发送

- **WHEN** 用户点「我已发出」
- **THEN** `F0003.md` 的 `sent_at` 有值，发送记录多了一条，`status` 和其它各节一个字节都没变；列表里这一份移到「已发送」组

#### Scenario: 重复发送

- **WHEN** 用户对「已发送」组里的一份再发一次，并点「我已发出」
- **THEN** 发送记录再追加一条，`sent_at` 更新为最近一次的时间，旧的记录保留

#### Scenario: 非环回监听

- **WHEN** 看板以 `--host 0.0.0.0` 启动，有人从另一台机器点「我已发出」
- **THEN** 接口返回 403，文件不变；界面上的「邮件发送」和「我已发出」置灰，并说明原因

#### Scenario: 没点确认

- **WHEN** 用户唤起了邮件客户端，但在客户端里取消了，也没回看板点「我已发出」
- **THEN** 这份反馈单仍在「待发送」组

#### Scenario: 结构认不出

- **WHEN** 反馈单没有「## 发送记录」这一节，用户点「我已发出」
- **THEN** 接口返回 409，文件不变
