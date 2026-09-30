# docx-preview

## Purpose

阅读器里对 `.docx` 的分页预览：用 `docx-preview` 在隔离 iframe 里渲染页面尺寸与边距、样式、编号、表格、图片、页眉页脚、脚注；
`/file` 对 `.docx` 返回 Word 的 MIME；超大文件、加密损坏、渲染器加载失败时退回「交给系统打开」卡片；
与 Word 的固有差异（域不刷新、浮动对象位置、缺字体）常驻一行说明，不当成错误。本能力由 `md-to-docx` 变更落地。

## Requirements

### Requirement: 阅读器预览 .docx

阅读器打开 `.docx`（产出、输入原件、模板目录里的样张与参照稿，凡是看板能列出来的都算）时，SHALL 在浏览器里用 `docx-preview`
渲染成分页版式：保留页面尺寸与边距、样式、编号、表格、图片、页眉页脚、脚注。扫描契约不变：`.docx` 仍标 `external`，
由阅读器按扩展名识别，与 PDF 预览同一做法。`docx-preview` MUST 动态 import，只在第一次打开 `.docx` 时加载。
预览区顶部 SHALL 保留「用系统应用打开」，用来看域刷新后的目录、页码等浏览器渲染不了的部分。

#### Scenario: 预览转换成品

- **WHEN** 用户在产出列表点 `output/docs/a.docx`
- **THEN** 预览区显示白色纸张的分页版式，标题编号、表格边框、页眉页脚都在；深色模式下纸张仍是白色，四周是看板背景

#### Scenario: 首屏不受影响

- **WHEN** 用户打开看板但没有点任何 `.docx`
- **THEN** 网络面板里没有加载 `docx-preview` 的脚本块

### Requirement: 渲染隔离

渲染 MUST 放在 `sandbox` 不含 `allow-scripts` 的 iframe 里（只带 `allow-same-origin`，供看板把渲染结果写进去），
使文档里的任何脚本、`javascript:` 链接都不会执行，`docx-preview` 注入的样式也不会影响看板本身。
文档里的超链接 SHALL 在新窗口打开并带 `noopener`；指向本地文件的链接不跟随。

#### Scenario: 文档带恶意链接

- **WHEN** 预览一份超链接写成 `javascript:alert(1)` 的 `.docx`
- **THEN** 点击该链接没有任何脚本执行

#### Scenario: 样式不外溢

- **WHEN** 预览一份自带大量样式的 `.docx` 后切回 Markdown 产物
- **THEN** 看板的字体、配色、间距与预览前完全一致

### Requirement: 文件直出

服务端 `/file` 接口 SHALL 为 `.docx` 返回 `application/vnd.openxmlformats-officedocument.wordprocessingml.document`，
仍走 `resolveInside()`。前端以二进制取回后交给渲染器，不经 JSON。

#### Scenario: 旧服务进程

- **WHEN** 服务端还没重启，`/file` 对 `.docx` 返回 `application/octet-stream`
- **THEN** 预览照常工作（渲染器按内容解析，不依赖 MIME）

### Requirement: 预览的失败与降级

文件超过 30MB、解析失败、或渲染器加载失败时，预览区 SHALL 退回现有的「交给系统打开」卡片，并用一句话说明原因
（「文件太大，不在浏览器里渲染」「这份文档浏览器解析不了，可能是加密或损坏」）。
渲染结果与 Word 存在差异（目录与页码域不刷新、部分浮动对象位置不准、缺字体时用浏览器回退字体）时，
预览区底部 SHALL 常驻一行说明，不当作错误。

#### Scenario: 加密文档

- **WHEN** 预览一份受密码保护的 `.docx`
- **THEN** 显示「这份文档浏览器解析不了，可能是加密或损坏」和「用系统应用打开」，看板其它部分不受影响

#### Scenario: 本机缺字体

- **WHEN** 文档用了本机没有的字体
- **THEN** 预览用浏览器回退字体显示，底部说明常驻；不弹错误
