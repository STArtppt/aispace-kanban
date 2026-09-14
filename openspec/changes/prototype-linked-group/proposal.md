## Why

不做的话，原型工作区的同步脚本每跑一次，看板「原型」tab 上就会多出几张互不相干的卡片。
一份原型被拆成离线包 zip、在线链接、手工录入的重复链接三张卡，同步过来的规格、标注和批注也看不到入口，
「在线版落后本地改动」这类需要人处理的状态只写在一份 md 里。

原型工作区（Axhub Make 工程）新增了一条单向反写流程：原型改完后，把离线 HTML 包、在线发布链接、
规格 / 文档 / 标注 / 批注和一份 `SYNC.md` 写进工作空间的 `visualization/prototypes/`。
布局是这样的：

```
visualization/prototypes/
├─ <product>-html.zip        离线包（不和镜像目录同名，否则被看板跳过）
└─ <product>/                镜像目录（根上不放 index.html，否则 meta.json 被忽略）
   ├─ meta.json              kind: "url"，另带 publishedAt / syncedAt / source: "axhub-make-sync"
   ├─ cover.png              可选，脚本不碰
   ├─ SYNC.md                源提交、本地最近改动、同步时间、离线包与在线链接状态
   └─ spec/  docs/  annotations/  comments/
```

看板现在按「文件形态」一张一张摆卡片。这个布局本来就是被看板扫描规则逼出来的，
看板却不认得它们属于同一份原型。

## What Changes

- **按原型聚合。** 带 `SYNC.md` 的镜像目录认作一份「已接入」原型：同级的 `<product>-html.zip`
  是它的离线包，`meta.json` 是它的在线版，`spec/ docs/ annotations/ comments/` 下的 `.md` 是它的资料。
- **状态显式化。** 从 `SYNC.md` 表格和 `meta.json` 读出同步时间、源提交、本地最近改动、发布时间，
  以及「离线包本次没更新」这一条。「在线版落后」（本地最近改动晚于发布时间）
  和「离线包没更新」按「需要注意」处理，用 orange 标出。**解析不出就不标**，不猜。
- **重复卡片合并。** 其他**不带** `SYNC.md` 的 url 形态目录，链接只取 origin + pathname（丢掉 hash 与查询串）后
  与某份已接入原型的在线版相同，就并进那份原型，并在界面上说明「看板不代删」。
- **原型 tab 分两段。** 上段「已接入原型工作区」一行一份原型：封面、打开离线包 / 打开在线版、
  三格状态、按组列出的资料。点资料走看板自带阅读器（现有 `/file` 接口，已过 `resolveInside`）。
  下段「其他原型」保持现在的卡片网格一点不改。
- **tab 计数按原型算**，被并掉的 zip 和重复卡片不重复计数。

**不需要拍板：本 change 全程只读。** 只扫 `visualization/prototypes/`、只读文件，
不删重复目录、不代用户发布、不改 `capture.mjs` 的写入收口。SSE 已经递归监听 `visualization/`，
同步脚本写完看板会自动刷新。

v0 明确不做：在看板里触发同步或发布、渲染 `annotation-source.json` / 批注 JSON 原件、
在资料之间做全文检索、给未接入的原型补登记入口。

## Capabilities

### New Capabilities
- `prototype-linked-group`：认出原型工作区同步过来的镜像目录，把离线包、在线版、资料、同步状态、
  重复卡片聚合成一个条目并展示。

### Modified Capabilities
（无已归档的 `prototype-preview` 主规格可改。该能力仍在 `visual-showcase-view` 的 change 里，
本 change 不改动它的任何判定规则：未接入的原型照旧按 bundle / url 两种形态扫描与展示。）

## Impact

跨服务端、契约、前端三个平面；不动 CLI、不动 `templates/`。

| 平面 | 影响 |
| --- | --- |
| 服务端 `src/server/**` | `prototypes.mjs`：扫描后加一步聚合，读 `SYNC.md` / `meta.json`、列资料 md、标 `groupedInto`；`scanPrototypes` 下发新字段；新增 `resolvePrototypeCover`。`http.mjs`：`/proto/<slug>/cover.png` 对 url 形态放行封面（改动前 url 形态的封面一律 404，聚合行的封面同样显示不出来） |
| 契约 `src/app/lib/api.ts` | **要改**：`PrototypeItem` 增加**可选**的 `linked`（聚合信息）和 `groupedInto`（被并入的原型 key）；新增 `PrototypeLinked` / `PrototypeDoc` 类型 |
| 前端 `src/app/**` | `PrototypePanel` 分段渲染，新增 `LinkedPrototypeRow`；`VisualPanel` 与 `App.tsx` 把 `onOpen` 传进来打开阅读器；tab 计数排除 `groupedInto` |
| CLI `bin/cli.mjs` | 不动 |
| `templates/` | 不动 |

**依赖：** 不引新包。

**兼容性：**
- 新服务 + 旧前端：条目列表形状不变，被并掉的 zip / 重复卡片**照旧下发**（只多一个 `groupedInto`），
  旧前端看到的和现在完全一样。
- 旧服务 + 新前端：没有 `linked` / `groupedInto`，新前端退回现在的卡片网格。
- 工作空间里没有任何 `SYNC.md`：和现在完全一样。
