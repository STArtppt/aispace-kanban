## Context

- 视图由 `App.tsx` 的 `NAV` 与 `useBoardSession.ts` 的 `View` 联合类型定义，`overview` 是默认值。
- 「输入资料」三个页签：原始资料（只列 `pending`）、转换产物、数据源；资料台账 `INDEX.md` 是页面底部的一个独立卡片。
- 服务端 `scanInput` 已经算出完整的 `raw`（带 `ignored`）、`pending`、`ignored`，前端只用了 `pending`；stale 挂在转换产物的 `sourceState` 上。
- 转换产物落点由模板 `scripts/layout.py`（`CONVERTED = input/converted`）统一定义，图片在 `input/assets/`（`ingest.py` 的 `ASSETS`），
  正文里的图片链接按产物所在目录算相对路径。已有一次性迁移脚本 `migrate_converted.py`（平铺 → 镜像）可作写法先例。
- 产出文档的溯源约定要求写完整路径 `input/converted/…`，`citations.mjs` 按它算「被引用」。
- 上一个 change `docx-output-to-delivery` 已把输入产物的 Word 落点定为 `output/delivery/converted/`，就是为这次搬家准备的。

## Goals / Non-Goals

**Goals:**
- 少一个视图，概览信息在需要时一键可见。
- 原始资料的处理状态一眼可见，不再「消失」。
- 转换产物在目录与界面上都归到产出侧；过渡期新旧布局都能用。

**Non-Goals:**
- 输入侧「取消忽略」（清单外写入）。
- 看板代为执行迁移（不新增写入例外）。
- 改写产出文档里已有的溯源引用文字。
- 把 `converted` 并入产出三组（记录、归档、完整度）。

## Decisions

### D1 概览变成台账预览的上半部分，而不是一个弹窗或独立页签

在阅读器里加一个前端专用的阅读器类型 `ledger`（不经服务端），渲染 `LedgerOverview`（由 `OverviewPanel` 精简而来）+ `INDEX.md` 正文。
- 备选：保留概览视图但移到二级入口。不选：用户明确要去掉视图。
- 备选：台账行点开只显示 `INDEX.md`，概览放列表上方。不选：列表上方再堆统计卡，回到了「先过一屏统计」的老问题。
- `ledger` 只在前端 `FileItem.reader` 的联合类型里加一个值；服务端不会下发它，不影响契约兼容。

### D2 raw 条目加 `state` 字段，而不是前端拿 `raw` 与 `pending` 求差

服务端已经有完整判定，直接写到条目上，前端不重复实现覆盖规则；旧服务没有 `state` 时前端退回只列 `pending`（规格的降级场景）。
stale 判定在服务端由「产物 `sourceState === 'stale'` 反查其 raw」得出，挂到 raw 条目上。

### D3 图片目录留在 `input/assets/`

「图片资料」页签要留在「输入资料」下，目录也留在 `input/`，看板位置与磁盘一致。`input/assets/` 里除了从文档抽出的图，
还有直接放进 `input/raw/` 的单张图片（`assets/未分类/`），它们与转换产物无关，本来就是原始资料。
代价：产物正文的图片链接要跨目录指回 `input/assets/`（如 `../../../../input/assets/<名>/image0.png`），迁移时改写（D4）；
`ingest.py` 本来就按「产物所在目录」算相对链接，新落点下自然得出跨目录路径。
- 备选：`output/converted/_assets/`（上一版方案）。不选：「图片资料」在输入页签却读产出目录，单张原始图片被塞进产出，位置最拧巴。
- 备选：`output/assets/` 与 `converted/` 平级，深度不变、迁移不用改链接。不选：同样是输入页签读 `output/`；
  迁移脚本无论如何要写（`INDEX.md`、摘要互链），省掉的只是映射表的一行。

### D4 迁移脚本按「解析 → 映射 → 重算」改写所有相对链接

不按字符串替换 `../assets/`：镜像目录深度不一，摘要（`_manifest_*.md`）里还有指向 `SplittingObject/` 的链接、frontmatter 的 `payload`。
统一做法：对被移动的每个 `.md`，逐个相对链接按旧位置解析出绝对目标，经映射表（只有一项：`input/converted → output/converted`）换算，
再相对新位置重算；目标不在映射内的（`input/assets/`、`input/raw/`）同样重算以保持可达。产物之间的互链两端一起搬，重算后不变。
frontmatter 的 `source:` 是工作空间相对路径，不动。改写后 sha256 变化，`ingest.py` 判「未变化」依据是原件 sha，不受影响。

### D5 双布局兼容放在服务端一个函数里

`scan.mjs` 新增 `convertedRootOf(root)` 返回 `{ dir, layout: 'output' | 'input' | 'none', leftover }`，扫描、docKey、citations、
`describeConverted` 的「不许 frontmatter 指出去」校验都改用它。scan 下发可选 `input.layout`，前端据此显示迁移提示。
- 备选：看板只认新布局，强制先迁移。不选：看板与实例更新时序不可控，期间整个转换产物栏会空掉。

### D6 scan 数据形状不搬家

转换产物仍在 `scan.input.converted` 里下发，只是前端换到 `OutputPanel` 渲染。
- 备选：挪到 `scan.output.converted`。不选：契约大改且收益只是命名；产出统计（`output.stats.total`）也不该把它算进去。注释写清现状。

### D7 溯源旧前缀做别名，不改写引用

`citations.mjs` 在匹配前把 `input/converted/` 规范化为当前布局根。
- 备选：迁移脚本顺手改产出文档。不选：那是人写/AI 写的交付内容，迁移脚本不该碰，且引用文字可能已经发出去了。

### D8 `.gitignore` 按目录忽略，二进制规则跟着产物搬

`input/` 下三个目录整体不入库，比逐个列扩展名短且不漏（原件里的 `.md`、`.txt`、图片原来会漏进去）。
转换产物搬到 `output/converted/` 后，原来挂在 `input/**` 下的二进制规则必须改挂过去，否则搬家的副作用是大文件开始进库。
`.gitignore` 是模板的 seedOnly 文件，`template_update.py` 不覆盖实例里的版本：实例同步时逐个对照合并，保留实例自己加的行。
已经被实例 git 跟踪的 `input/raw|assets|sources` 文件不会因 `.gitignore` 自动脱离跟踪，需 `git rm --cached`（只动索引、不删本地文件），
逐个实例经用户确认后执行，不批量做。

### D9 实例同步分两次：A 一次、B 一次

- `docx-output-to-delivery` 完成后**单独同步一次**，只涉及 `md2docx.py` 与两份说明文档，全是模板管理文件，`template_update.py` 自动处理。
  理由：A 的服务端对旧版 `md2docx.py` 一律 400（防止写进 `input/`）。如果把 A 的同步推迟到 B 收尾，
  A 上线到 B 完成之间所有实例都无法转 Word —— A 最想解决的事反而被卡住。
- 本 change 收尾时**再同步一次**，是全部剩余内容的唯一同步点：新脚本与迁移脚本、文档改名、`.gitignore` 人工合并、
  `git rm --cached`、逐实例 `--dry-run` → 确认 → 迁移。
- 若确定 A、B 连续做完、中间不用看板转 Word，也可以把 A 的同步并进这里；两次同步互不冲突，第二次会带上第一次的内容。

## Risks / Trade-offs

- [模板约 28 个文件引用旧路径，漏改会让 AI 往旧目录写] → 改完 `grep -rn "input/converted" templates/pm-aispace` 必须只剩迁移脚本与兼容说明；`check_markdown.py` 加一条新路径校验。
- [产物链接跨 `input/` 与 `output/`，单独拷走 `output/converted/` 时图片会断] → 接受：工作空间是整体使用的；在 `output/README.md` 写明图片在 `input/assets/`。
- [页签改名后，模板文档、技能里的旧叫法残留] → `grep -rn "分析中间产物\|对外交付文档"` 复查，只剩历史记录类文字。
- [迁移改写链接出错导致图片断] → `--dry-run` 列出每条改写；执行后脚本自检所有被改写链接的目标存在，不存在的列出并以非零退出。
- [工作空间 AI 读到旧 `AGENTS.md` 缓存继续写旧路径] → 双布局兼容期内看板仍能显示；两处都存在时提示残留。
- [`output/` 下多了大量文件，产出侧的扫描、搜索变慢] → `converted` 不进 `OUTPUT_GROUPS`，产出扫描按组走，不递归整个 `output/`。

## Migration Plan

1. 看板先上双布局兼容（旧实例照常可用）。
2. 模板脚本与文档改到新路径，提供迁移脚本。
3. `local-source-sync` 推模板到实例；每个实例先 `--dry-run`，用户确认后执行；执行后在看板确认图片与「被引用」正常。
4. 回滚：迁移脚本支持 `--reverse` 把目录与链接还原（同一映射反向）；看板代码回滚不影响已迁移实例以外的数据。

## 与 `docx-output-to-delivery` 的关系与执行顺序

1. **先做 `docx-output-to-delivery`**：小、独立，立刻解决「同事的稿子套模板」；Word 落点已是 `output/delivery/converted/`，搬家后不用挪。
2. 再做本 change，内部顺序：视图（台账、标签）→ 服务端双布局 → 前端「转换产物」栏挪位 → 模板与迁移脚本 → 同步实例并迁移。
   其中「`converted-md` 的来源同时认 `output/converted/`」「`md2docx.py` 来源规则加 `output/converted/`」两处是对上一个 change 的增补。

## Open Questions

（无。合并为一个 change、Word 落点已与用户确认；图片目录按用户「图片资料留在输入资料下」的要求重新评估为留在 `input/assets/`，见 D3。）
