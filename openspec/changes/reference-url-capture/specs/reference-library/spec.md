## MODIFIED Requirements

### Requirement: 扫描结果经 Scan.references 下发，字段可选

`Scan` MUST 增加可选字段 `references`，形状与原型清单同类：`items`、`note`、`updatedAt`。
每条 item MUST 带 `itemKey`、`title`、可预览的 `url`；可选带 `sourceUrl`、
`source`（`manual` / `url-capture` / `plugin`）、`mtime`、封面图地址。
**由看板采集得到的参考，`source` MUST 是 `url-capture`，且其 `meta.json` MUST 记着
源 URL、采集时间与 `scrubbed: false`；`scrubbed` 只是告知读者这页没经过任何脱敏，
MUST NOT 被当作安全保证。**
工作空间没有 `visualization/references/` 时，新服务进程 MUST 仍然返回这个字段（空结构）。
旧服务进程不给这个字段时，前端 MUST 不白屏、不抛错。

#### Scenario: 采集来的参考带来源信息
- **WHEN** 用户采集了一个公开页面，随后打开参考 tab
- **THEN** 该卡片显示源 URL，其 `source` 为 `url-capture`

#### Scenario: 手工放进去的参考
- **WHEN** 用户自己把自包含 HTML 摆成 `visualization/references/foo/index.html`，没有 `meta.json`
- **THEN** 清单里仍出现「foo」，`source` 为 `manual`，来源显示相对路径

#### Scenario: 旧服务进程缺 references 字段
- **WHEN** 前端已是带参考 tab 的新构建，常驻服务还是改动前的进程，
  `/api/projects/:id/scan` 没有 `references`
- **THEN** 参考 tab 显示「当前看板服务还没有参考能力，重启看板服务后即可」，
  原型 tab 仍按现有数据工作
- **AND** 页面不白屏、控制台不因为 `scan.references` 为 `undefined` 报错
