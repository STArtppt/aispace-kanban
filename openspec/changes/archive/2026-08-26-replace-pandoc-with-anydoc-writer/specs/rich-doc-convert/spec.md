## ADDED Requirements

### Requirement: 四种富文档零系统依赖转 Markdown

`.docx` `.odt` `.rtf` `.epub` 的转换 MUST 只依赖看板自带的 `@firecrawl/anydoc`，
不得再要求用户安装 pandoc 或任何其它系统级二进制。引擎二进制的定位 MUST 复用
`anydoc.py` 现有的四级查找链（`ANYDOC_BIN` → 工作空间 `.env` → `runtime.json` → PATH），
使「终端里直接跑 `ingest.py`」与「看板上点转换」两条触发路径拿到同一个二进制。

#### Scenario: 未装 pandoc 的机器把 docx 丢进 input/raw/
- **WHEN** 用户机器上没有 pandoc，把一份 `.docx` 放进 `input/raw/` 后运行 `python3 scripts/ingest.py`
- **THEN** 转换正常完成，`output/converted/` 下出现同名 `.md`，进程退出码为 0
- **AND** 全程没有任何提示要求安装 pandoc

#### Scenario: 看板上点转换
- **WHEN** 用户在看板的待转换列表上点转换，且工作空间 `.env` 未配置任何引擎路径
- **THEN** 转换使用看板通过 `ANYDOC_BIN` 注入的那份二进制完成
- **AND** 产物与在终端直接跑 `ingest.py` 得到的一致

#### Scenario: 四种格式都覆盖
- **WHEN** `input/raw/` 里同时存在 `.docx` `.odt` `.rtf` `.epub` 各一份
- **THEN** 四份都转出 `.md`，没有任何一种因为"引擎不支持"被跳过或报错

### Requirement: 图片必须落盘并在正文里成为可点链接

转换 MUST 把源文档里的嵌入图片按字节写进工作空间的 `input/assets/<源文件名>/`，
并在正文里写成 `![](相对路径)`。图片链接 MUST 相对**产物所在目录**计算（镜像目录深度不一，
不能写死 `../assets/`），且 MUST 经过 `layout.md_link()` 转义空格与括号。
正文里 MUST NOT 出现只有 alt 文本、没有实际链接的图片占位。
产物 frontmatter MUST 用 `extracted_images` 记录抽出的图片数。

#### Scenario: 带图 PRD 的图片数不退步
- **WHEN** 转换一份含 14 张嵌入图的 `.docx`
- **THEN** `input/assets/<名字>/` 下出现 14 个图片文件
- **AND** 正文里有 14 个 `![](...)`，每个链接都指向一个真实存在的文件
- **AND** frontmatter 里 `extracted_images: 14`

#### Scenario: 源文件名带空格或括号
- **WHEN** 源文件名里含空格或圆括号，其图片目录随之取名
- **THEN** 正文里的图片链接把空格与括号转成百分号转义，链接不被 `)` 提前截断

#### Scenario: 文档不含图片
- **WHEN** 转换一份没有任何嵌入图的文档
- **THEN** 不创建空的 assets 目录，frontmatter 里不出现 `extracted_images` 字段

### Requirement: 产物是干净的 GFM，不含裸 HTML

正文 MUST 是标准 GFM。MUST NOT 输出 `<img>` `<figure>` `<div>` 等裸 HTML 标签，
也 MUST NOT 输出 `<span id="anchor">` 一类的锚点噪音。
表格 MUST 是标准紧凑 GFM 表格。

#### Scenario: 裸 HTML 计数为零
- **WHEN** 对回归语料里任意一份产物统计 `<img` 与 `<div` 的出现次数
- **THEN** 两者都为 0

#### Scenario: 中文不被破坏
- **WHEN** 转换正文为中文的 `.rtf` / `.docx`
- **THEN** 产物中不出现问号残缺一类的乱码，中文可正常阅读

### Requirement: 表格跨行列与复合编号的降级行为是确定的

转换 MUST 用确定的、可预期的方式处理两处 GFM 表达不了的结构 —— 表格的 rowspan / colspan，
以及 `1-a)`、`（3）` 这类复合编号。降级规则如下：

- 跨行列：被覆盖的格子**默认留空**，MUST NOT 复制 origin 的内容进去
  （复制会让下游分析把同一条统计两遍）。
- 复合编号：某个列表只要出现 `markerLabel`，整个列表降级成带缩进的段落序列，
  label 原样写在行首并转义，MUST NOT 被 Markdown 重新解析成列表。
  没有 label 的列表正常走 `-` / `1.`。

#### Scenario: 含合并单元格的表格
- **WHEN** 转换一份表格里有合并单元格的文档
- **THEN** 合并区域的首格写内容，被覆盖的格子为空
- **AND** 表格的列数与行数与源文档一致，没有整表退化成 HTML

#### Scenario: 复合编号列表
- **WHEN** 源文档里有 `1-a)` `（3）` 这类编号的列表
- **THEN** 产物里编号原样保留在行首，缩进层级保留
- **AND** 重新渲染这份 Markdown 时这些行不会被当成有序列表而重新编号

### Requirement: 转换失败与未知模型分支不得断流

Writer 遇到 `Document` 模型里未知的 block / inline 种类 MUST 降级输出纯文本，
MUST NOT 抛错中断整批转换。转换真正失败时 MUST 通过退出码与 stderr 把 anydoc 的错误
如实传回，由 `ingest.py` 记进失败清单，其余文件继续转。
产物 frontmatter 的 `tool` 字段 MUST 如实写明引擎与版本，使用户一眼能分辨产物出自哪个引擎。

#### Scenario: anydoc 升级后出现未知节点类型
- **WHEN** 源文档里含 Writer 未实现的节点种类（如公式、代码块、复选框）
- **THEN** 该节点降级成纯文本写入正文，转换继续完成并退出码 0

#### Scenario: 单份文件转换失败
- **WHEN** 一批 10 份文件里有 1 份损坏、anydoc 解析失败
- **THEN** 该文件被记进失败清单并打出 anydoc 的原始错误
- **AND** 其余 9 份正常转完

#### Scenario: 引擎完全找不到
- **WHEN** 既没有 `ANYDOC_BIN`、`.env`、`runtime.json`，PATH 上也没有 anydoc
- **THEN** 报出人话错误，说明看板会注入该变量、以及自行安装的方式
- **AND** 提示中 MUST NOT 建议用 `npx`（首次会联网下载，违反"本地、不外发"）

### Requirement: 引擎可替换，上层无感

Python 侧 MUST 提供一个引擎无关的调用契约
`anydoc.to_markdown_with_assets(src, assets_dir, link_prefix) -> str`。
`ingest.py` 及以上 MUST 只依赖这个签名，不得直接感知底层是自研 Writer、pandoc 还是别的引擎。

#### Scenario: 把实现换成另一个引擎
- **WHEN** 把 `to_markdown_with_assets()` 的函数体整体换成调用另一个转换引擎，签名不变
- **THEN** `ingest.py`、`src/server/**`、前端都不需要任何改动，转换链路照常工作

### Requirement: 服务端不再提示安装 pandoc

`src/server/http.mjs` 的转换错误映射 MUST NOT 再包含"缺少 pandoc / 请先 brew install pandoc"
一类的分支 —— 这条提示已无触发路径，留着只会误导用户去装一个用不上的东西。

#### Scenario: 看板上转换失败
- **WHEN** 看板上转换一份富文档失败
- **THEN** 错误提示里不出现 pandoc 字样，只出现与 anydoc 相关的、可操作的说明
