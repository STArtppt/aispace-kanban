## Context

- 交付稿镜像规则现在写在三处：服务端 `scan.mjs` 的 `deliveryOf` / `deliveryDirOf`、前端 `lib/deaiPrompt.ts` 的同名函数、
  工作空间 `scripts/finalize_delivery.py` 的 `mirror_of`。三处都只认产出三组。
- `md2docx.py` 用 `md.with_suffix(".docx")` 定落点；pandoc 以 `md.parent` 为 cwd 与 `--resource-path`，所以换落点不影响取图。
- 服务端 `runDocxConvert` 自己算 `targetRel = src.rel.replace(.md → .docx)` 做存在 / 生成标记预检，并借「脚本文本里有没有 `--archive`」
  判断旧脚本 —— 这是本仓已有的旧脚本检测先例。
- 阅读器版本条的「已转过」靠交付稿列表接口（`deai.mjs` 的 `listDelivery`）给的 `sourceDocx` / 每版 `docx`。
- 输入转换产物在扫描里有三种形态（`scan.mjs` 的 `describeConverted`），用户的典型文档是单文件形态，图片相对引用 `input/assets/`。
- 输入侧没有产出物记录，批注、定稿都挂在记录上 —— 用户已确认这次只做 Word。

## Goals / Non-Goals

**Goals:**
- 所有转 Word 的成品都在 `output/delivery/` 下，按来源镜像分目录。
- 在输入转换产物的预览里一步转成 Word，不再手动挪 `.md`。
- 旧成品、旧服务、旧脚本三种不一致状态都不白屏、不写错位置。

**Non-Goals:**
- 输入侧的去 AI 味、批注、版本、定稿（等整合视图与 tab 时再做）。
- 搬迁原稿旁的旧 `.docx`（看板不做清单外写入；要搬由用户或工作空间 AI 手动）。
- `_manifest_*.md` / 目录型产物的转换。

## Decisions

### D1 落点规则由脚本拥有，默认生效

`md2docx.py` 不加 `--out` 参数，而是自己按来源位置算落点（`mirror_target(md)`），命令行与看板同一行为。
服务端用同一规则的 JS 实现（放 `scan.mjs`，紧挨 `deliveryDirOf`）只做预检（同名成品是否存在、有没有生成标记），**不把落点传给脚本**。

- 备选 A：服务端传 `--out-dir <路径>`。不选：工作空间 AI 按提示词在终端跑时会落回旧位置，两种入口结果不一致；
  而且多了一个能指到任意目录的参数，脚本还得再校验一遍范围。
- 备选 B：前端算好路径传上来。不选：违反第九条 ④「请求不带任何路径」。

### D2 旧脚本检测：脚本里的落点标记

新脚本定义常量 `PLACEMENT = "delivery-mirror"`；服务端 spawn 前读脚本文本，没有这个字符串就 400 `old-script`，**所有来源一律拦**。

- 备选：只拦输入来源，产出来源放行让旧脚本照旧写原稿旁。不选：同一个看板在不同实例上落点不同，用户找不到文件；
  反正用户要求改完同步实例，拦下来提示更新代价小。
- 选字符串标记而不是 `--version` 子进程：沿用 `--archive` 检测的先例，不多一次 spawn。

### D3 输入来源的 docKey 是第四类 `converted-md`

`DOC_KEY_KINDS` 加 `converted-md`：`input/converted/` 下递归的 `.md`，排除 `_manifest*.md`、目录型产物所在目录
（含 `_manifest.md` 的目录及新布局的 `SplittingObject/` `MergedObject/` 容器）。扫描时只给 `describeConverted` 产出的
「单文件、非目录、`.md`」条目挂 `docKey`，与反查范围一致。
`resolveDoc(root, 'output-md', key)` 扩成按序在 `output-md` → `delivery-md` → `converted-md` 里反查。

- 备选：输入复用 `output-md` 类。不选：键的类别隔离是第九条 ④ 的一部分（产出的键换不来原件），不该放宽。

### D4 交付稿列表接口复用，加 `sourceKind`

`GET delivery?docKey=` 认输入的键时返回 `{ source, dir, sourceKind: 'input', versions: [], sourceDocx }`，
不读批注、不读定稿。前端据 `sourceKind === 'input'` 渲染 Word-only 形态的 `DeliveryBar`。

- 备选：新开 `GET converted-docx?docKey=`。不选：多一个接口、多一套 hook；且后续整合视图要给输入加去 AI 味时，
  走同一个接口自然扩展。

### D5 `sourceDocx` 镜像优先、旧位置兜底

`listDelivery` 对产出原稿给 `sourceDocx = docxAt(mirrorDocx) ?? docxBeside(source)`；输入只看镜像。
`runDocxConvert` 的预检只看镜像落点（旧位置文件与新转换无关，不归档、不阻拦）。
前端「重新转换」的弹窗目标统一显示服务端规则算出的镜像路径，由前端同一规则函数计算（与 `deaiPrompt.ts` 的 `deliveryDirOf` 并列）。

### D6 镜像目录内的命名

原稿成品叫 `<基名>.docx`，与 `v<序号>.docx`、`定稿.md` 同目录不冲突。已知重叠：重新转换的归档名
`<基名>-<YYYYMMDDHHmm>.docx` 与定稿复制进来的 `<原基名>-<YYYYMMDDHHmm>.docx` 同一种形状。两者都只新建不覆盖（重名追加 `-2`），
不会丢文件；哪份是定稿用的以 `定稿.md` 的记录为准。接受这个重叠，不再引入新的命名约定。

### D7 输入产物的镜像子目录叫 `converted`，不叫 `input`

后续 change `input-output-view-regroup` 会把 `input/converted/` 搬到 `output/converted/`。镜像子目录现在就叫 `converted`，
搬完后来源 `output/converted/<子路径>.md` 套产出三组同一条规则（`output/<X>/<子路径>.md` → `output/delivery/<X>/<子路径>/`）
得到的仍是同一个目录，已转出的 Word 不用挪。`converted` 不进 `OUTPUT_GROUPS`，`deliveryOf` 对它返回 `{ original: null }`，
批注、去 AI 味不会误认。

- 备选：叫 `input`。不选：搬家后名不副实，且要么挪文件、要么规则里留一个特例。

## Risks / Trade-offs

- [三处镜像规则继续各写一份（JS 服务端 / TS 前端 / Python 两个脚本）] → 在每份实现旁注明「与 X 同一规则」，并在合成回归语料里加落点断言。
- [用户在 Finder 里找不到新成品，以为转换失败] → toast 带「预览」和完整相对路径；交付稿栏说明行写明目录。
- [旧位置与新位置都有 `a.docx`，用户改了旧的那份] → 规格写明两处都有时只认镜像；旧文件不动，不会丢修改。
- [输入转换产物重新转换（anydoc 再跑一遍）后 `docKey` 不变但内容变了] → 与产出原稿相同，Word 是转换时刻的快照，用户「重新转换」即可。

## Migration Plan

1. 先改模板脚本与模板文档，再改服务端、契约、前端（服务端对旧脚本 400，所以顺序上脚本先就位也无害）。
2. 用 `local-source-sync` 把模板推到已登记实例（有实例专有约定的对照其 `AGENTS.local.md`）。
3. 回滚：还原看板代码即可；实例里新脚本对旧看板兼容（旧看板预检看原稿旁，新脚本写镜像目录 —— 首次转换正常，
   重新转换时旧看板会误判「不存在」而不传 `--archive`，脚本会以「已存在」退出 3，不会覆盖），可接受。

## Open Questions

（无。功能范围、旧成品处理、实例同步均已与用户确认。）
