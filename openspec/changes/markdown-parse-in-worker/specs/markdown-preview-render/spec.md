## ADDED Requirements

### Requirement: 同一篇正文只解析一次

预览窗渲染 markdown 正文时，看板 MUST 只在**正文源码或锚点参数变化时**跑一次 markdown 解析管线。
父组件因为别的状态重渲染（回传目录后 setState、批注层量完几何后 setState、扫描 SSE 刷新、
预览内检索输入等）MUST NOT 触发同一篇正文的再次解析。

#### Scenario: 目录回传不引起重解析
- **WHEN** 打开一篇 markdown 产物，渲染完成后组件把标题列表回传给上层并触发一次重渲染
- **THEN** 该篇正文不再被解析第二次
- **AND** 浏览器 longtask 只记到一段解析开销，不是两段或三段

#### Scenario: 换文档才重新解析
- **WHEN** 预览窗从一篇产物切到另一篇
- **THEN** 新正文被解析一次，目录、锚点、检索都对上新文档

### Requirement: 解析在 Web Worker 里完成，主线程不被阻塞

markdown 正文的解析管线（remark 解析 → rehype 转换 → 盖锚点属性）MUST 在 Web Worker 中执行。
主线程 MUST 只做「hast → React 元素 → 提交 DOM」。
点开一篇 800 行以上表格的产物时，主线程 MUST NOT 因解析出现单段超过 120ms 的长任务。

#### Scenario: 大表文档点开时界面仍可响应
- **WHEN** 点开 800 行以上表格的产物（如数据库结构快照）
- **THEN** 解析进行期间侧栏、关闭按钮、滚动仍然可响应
- **AND** 主线程不出现由解析造成的单段 120ms 以上长任务

#### Scenario: 解析期间有过渡态
- **WHEN** 正文已读到但尚未排版完成
- **THEN** 预览窗显示"正在排版"一类的过渡态
- **AND** 不出现空白正文区，也不出现上一篇文档的残留正文

### Requirement: 渲染结果与改动前等价

worker 路径产出的正文 MUST 与改动前 `react-markdown` 的渲染结果等价：

- 同一套组件映射（标题 / 表格 / 代码块 / 图片 / 链接等排版）MUST 不变；
- `rehype-raw` MUST 保留（MinerU 与旧 pandoc 产物的裸 HTML 图表还要靠它）；
- 表格结构标签里的空白文本节点 MUST 仍被清掉（React 19 会把它当 hydration 错误）；
- `remark-gfm` MUST 仍以 `singleTilde: false` 运行（中文区间写法不得被当成删除线）；
- 契约 A2 的 `data-source-file` / `data-source-range` MUST 仍盖在元素与文本 span 上，字节区间与改动前一致；
- `script` / `iframe` / `object` / `embed` MUST 仍被丢弃；
- 图片与链接 URL MUST 仍经调用方给的 `urlTransform`；调用方没给时 MUST 退回
  `react-markdown` 的默认实现（它会挡 `javascript:` 之类的协议）。

#### Scenario: 批注锚点不受影响
- **WHEN** 在 worker 渲染出的正文里划选一段文字并新建批注
- **THEN** 切出来的源码字节区间与改动前一致
- **AND** `pnpm test:anchor` 全部通过

#### Scenario: 裸 HTML 表仍能渲染
- **WHEN** 打开一份正文里带裸 HTML 表格（带换行缩进）的转换产物
- **THEN** 表格正常显示，预览不空白

### Requirement: worker 不可用时降级为同步渲染

worker 创建失败、解析抛错或消息超时时，看板 MUST 退回改动前的同步 `react-markdown` 渲染路径，
MUST NOT 白屏、MUST NOT 让预览窗停在过渡态。降级 MUST 只影响流畅度，不影响能不能读。

#### Scenario: 环境不支持 Worker
- **WHEN** 浏览器环境拿不到可用的 Worker
- **THEN** 正文仍然被渲染出来，目录、检索、批注照常
- **AND** 表现回到改动前的同步渲染（点开会卡一下，但内容完整）

#### Scenario: 解析在 worker 里抛错
- **WHEN** worker 解析某篇正文时抛错
- **THEN** 主线程用同步路径重渲染这篇正文
- **AND** 预览窗不停留在"正在排版"
