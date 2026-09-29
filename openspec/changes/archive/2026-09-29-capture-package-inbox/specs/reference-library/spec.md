## MODIFIED Requirements

### Requirement: 扫描结果经 Scan.references 下发,字段可选

`Scan` MUST 增加可选字段 `references`,形状与原型清单同类:`items`、`note`、`updatedAt`。
每条 item MUST 带 `itemKey`、`title`、可打开的 `url`(指向查看器壳页);
可选带 `sourceUrl`、`source`、`scrubbed`、`mtime`、`cover`、`screenshots`。

**`source` 为 `plugin` 的条目由 annotation-collect 的扩展投递而来,此时 `meta.json`
MUST 记着来源页面地址、投递时间、`scrubbed` 的真实值与包自带的免责声明原文。
卡片 MUST 能看出它来自采集插件,MUST NOT 把它和贴 URL 采来的参考混为一谈显示来源。**

工作空间没有 `visualization/` 时,新服务进程 MUST 仍然返回这个字段(空结构)。
旧服务进程不给这个字段时,前端 MUST 不白屏、不抛错。

#### Scenario: 插件投来的参考
- **WHEN** 用户用采集插件投了一个需要登录才能看的页面,随后打开参考 tab
- **THEN** 卡片显示来源页面地址,`source` 为 `plugin`
- **AND** 它和贴 URL 采来的参考并排显示,用同一个查看器打开

#### Scenario: 三种来源并存
- **WHEN** 同一个工作空间里同时有手工摆的、贴 URL 采的、插件投的三份参考
- **THEN** 三张卡片都正常显示,来源各自标明,行为一致
