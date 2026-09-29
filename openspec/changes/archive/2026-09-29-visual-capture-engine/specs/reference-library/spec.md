## MODIFIED Requirements

### Requirement: 参考落在 visualization/references/,一份参考一个目录

工作空间若要收参考页,MUST 使用 `visualization/references/`。
`visualization/` 是可选的视觉平面,与 `input/` `output/` 的文档平面并列;识别工作空间的判据
(有 `input/` 和 `output/`)MUST NOT 因为缺 `visualization/` 而失败。

每一份参考 MUST 是 `visualization/references/<slug>/` 子目录。
**判定「是不是一份参考」的唯一条件 MUST 是该目录根上有 `index.html`**。
散装的 `某页.html` 扔在 `visualization/references/` 根上,看板 MUST 扫不到。

目录内其余文件都是可选的,形状固定如下:

```
visualization/references/<slug>/
  index.html                  # 必须。带交互的原始页面
  meta.json                   # 可选
  screenshots/hero.png        # 可选。桌面标准屏首屏
  screenshots/full.png        # 可选。完整页面
  screenshots/mobile.png      # 可选。移动端响应式
```

`meta.json` 的字段 MUST 是:`title`、`sourceUrl`、`capturedAt`、
`source`(`manual` / `url-capture` / `plugin`)、`scrubbed`、`screenshots`,
**外加可选的 `degraded`(本次产出少了哪些档位及原因)**。
`scrubbed` 只告知这页有没有经过脱敏,MUST NOT 被当作安全保证。
缺 `meta.json` 时 `source` MUST 退回 `manual`,标题 MUST 从 `index.html` 的 `<title>` 取。
`meta.json` 读不出或不是合法 JSON 时 MUST 退回同一套缺省值,MUST NOT 让该条目消失、
MUST NOT 让整次扫描失败。

**由看板采集得到的参考,`source` MUST 是 `url-capture`,且其 `meta.json` MUST 记着
源 URL、采集时间与 `scrubbed: false`。** 本能力自身(扫描与展示)仍然 MUST NOT
往工作空间写入任何文件 —— 写入是 `visual-capture` 的事。

#### Scenario: 采集来的参考带来源信息
- **WHEN** 用户采集了一个公开页面,随后打开参考 tab
- **THEN** 该卡片显示源 URL,其 `source` 为 `url-capture`,封面是 `screenshots/hero.png`

#### Scenario: 降级采集的参考照常显示
- **WHEN** 一次采集因为缺 Playwright 只产出了 `index.html` 与 `meta.json`
- **THEN** 卡片正常出现,预览区用窗框占位,不出现破图
- **AND** `meta.json` 里的 `degraded` 说明少了截图

#### Scenario: 手工放进去的参考
- **WHEN** 用户自己把自包含 HTML 摆成 `visualization/references/foo/index.html`,没有 `meta.json`
- **THEN** 清单里仍出现「foo」,`source` 为 `manual`,来源显示相对路径

#### Scenario: meta.json 坏了不拖垮条目
- **WHEN** `visualization/references/foo/meta.json` 内容不是合法 JSON
- **THEN** 「foo」仍然出现在清单里并可打开,元信息退回缺省值
