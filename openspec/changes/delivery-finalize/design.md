## Context

- 交付稿镜像目录是 `output/delivery/<组>/<子路径>/`（`scan.mjs` 的 `deliveryDirOf`），里面已有 `v<三位>.md`、
  「转成 Word」写出的同名 `v<三位>.docx`，以及「重新转换」归档出的 `<基名>-<YYYYMMDDHHmm>.docx`。
- 交付稿列表由 `deai.mjs` 的 `listDelivery` 只读下发；版本条 `DeliveryBar.tsx` 在阅读器里常驻于产出三组的 `.md`。
- 「预览 Word」靠把 `.docx` 当成 `FileItem` 交给 `ReaderBody` 渲染（`Reader.tsx` 的交付稿外壳），不在扫描结果里也能看。
- 系统原生目录选择框已有一份（`platform.mjs` 的 `pickDirectory`，四个平台），只选目录、不能指定起始目录。
- docx → Markdown（带抽图）已有一条成熟路线：工作空间 `scripts/anydoc.py` 的 `to_markdown_with_assets` + `anydoc_writer.mjs`，
  资料转换就用它；anydoc 与 node 的位置由看板写在 `~/.pmwork/dashboard/runtime.json`，脚本自己找得到。
- 写入工作空间的规矩：AGENTS.md 不变量 1。已有九条例外，第九条（转 Word）是最近的同构参照：spawn 族、请求不带路径、只用 `docKey`。

## Goals / Non-Goals

**Goals:**
- 一次点击回答「这份文档最后交出去的是哪一份 Word」，并能在看板里读到它的内容、和看板里的稿子对比。
- 每次定稿用到的 `.docx` 都留在镜像目录、不被覆盖；`定稿.md` 只有一份、指向最近一次。
- 保持「请求不带路径」「看板只 spawn」两条既有立场。

**Non-Goals:**
- 不做浏览器上传；不做多份原稿批量定稿；不做「撤销定稿」（要撤销就人手删 `定稿.md`）。
- 不让 `定稿.md` 进入批注 / 去 AI 味 / 转 Word 的回路，也不让它出现在产出列表、搜索结果之外的新入口。
- 不比较 `.docx` 与 `.docx`；对比只在 Markdown 层做（复用 `DeliveryDiff`）。

## Decisions

### D1 选文件用服务端弹的系统原生选文件框，而不是浏览器 `<input type=file>`

需求要「默认打开镜像目录」并区分「从镜像目录选」与「从其他目录选」。浏览器的文件框不能指定起始目录，也只给文件名不给路径，
两件事都做不到；上传字节还意味着看板要自己落盘，变成直写族。
系统选文件框在服务所在的机器上弹（看板本就只对环回开放写入），拿得到真实路径，判断场景靠比较 `realpath` 的父目录。
- 实现：`platform.mjs` 新增 `pickDocxFile({ prompt, defaultDir })`，与 `pickDirectory` 并列、共用 `runCaptured` / `interpretPick`：
  macOS `choose file of type {"org.openxmlformats.wordprocessingml.document"} default location POSIX file "<dir>"`；
  Windows `OpenFileDialog`（`InitialDirectory`、`Filter = Word 文档|*.docx`）；Linux `zenity --file-selection --filename=<dir>/ --file-filter=*.docx`，退 `kdialog --getopenfilename <dir> '*.docx'`。
  选框只是过滤，服务端与脚本再各查一次扩展名。
- 备选：浏览器上传 + 服务端写临时文件交给脚本。否决：起始目录与场景判定都做不到，且多一条看板直写。

### D2 两步接口 + 一次性令牌，请求里永远没有路径

`pick` 只返回令牌和展示用的信息，选中的绝对路径存在服务端内存 `Map<token, { root, sourceRel, abs, inMirror, expires }>`；
`confirm` 只收令牌。令牌 `crypto.randomUUID()`、10 分钟过期、一次即删，还要校验令牌所属工作空间与当前请求的 `:id` 一致。
- 备选：`pick` 直接把路径回给前端，`confirm` 再带回来并校验。否决：这就是第九条明令不要的「带路径但会校验」。
- 备选：弹框和执行合成一个请求。否决：用户要在看板里看清「会复制成什么名字、会覆盖第几次定稿」再确认，系统框做不到这层说明。

### D3 由新脚本 `finalize_delivery.py` 写盘（spawn 族），不是看板直写

复制 + 转换 + 抽图 + 维护记录都是「工作空间里的文件操作」，转换本就依赖工作空间脚本里的 anydoc 路线；放进脚本，
终端里也能跑同一件事（`python3 scripts/finalize_delivery.py output/docs/方案/总体设计.md --docx <路径> --json`），与第九条同构。
看板侧 `src/server/finalize.mjs` 复用 `docxTools.mjs` 的 `runScript` / `exclusive` / `requirePython`（把它们导出，不复制第二份），
退出码约定一致：2→400、3→409、4→400（缺 anydoc / node）。超时 120 秒。
- 备选：看板自己 `copyFile` + 调 anydoc。否决：开一条新的直写族，且转换逻辑会在看板和模板里各有一份。

### D4 场景判定与复制命名

- 场景判定在服务端 `pick` 时做一次（用于确认框文案），脚本执行时**再判一次**（以脚本为准）：
  `realpath(dirname(选中文件)) === realpath(镜像目录)` 即「镜像目录」；子目录、符号链接指进来的都按「其他目录」处理，宁可多复制一份。
- 复制名 `<原基名>-<定稿时间 YYYYMMDDHHmm>.docx`，与「重新转换」的归档名同一格式；重名追加 `-2`、`-3`。
  用 `O_EXCL` 语义新建（Python `open(..., 'xb')`），保证不覆盖。
- 原基名里有分隔符以外的奇怪字符照样保留（它来自用户本机文件名），只拒 `/ \ \0`。

### D5 `定稿.md` 的格式与覆盖方式

```
---
kind: delivery-final
source: output/docs/方案/总体设计.md
finalized_at: 2026-10-22T16:30:00+08:00
docx: output/delivery/docs/方案/总体设计/客户反馈版-202610221630.docx
docx_sha: 3f9a…（16 位）
count: 3
history:
  - 2026-10-20 10:05 | v002.docx | 镜像目录
  - 2026-10-21 18:40 | 客户反馈版-202610211840.docx | 其他目录（原名 客户反馈版.docx）
  - 2026-10-22 16:30 | 客户反馈版-202610221630.docx | 其他目录（原名 客户反馈版.docx）
---
<anydoc 转出的正文，图片链接指向 定稿.assets/>
```

- 只用 `key: value` 与 `key:` + `  - item` 两种形态，`frontmatter.mjs` 现有解析器直接能读，不引 YAML 依赖。
- 「最近一次」按 `docx` 字段认，不按修改时间——场景 1 选的可能是镜像目录里早就存在的旧文件。
- 覆盖：先把正文写到 `定稿.md.tmp`、图片写到 `定稿.assets.tmp/`，成功后 `os.replace` 换 `.md`，再把旧 `定稿.assets/` 改名 `.old` → 新目录就位 → 删 `.old`。
  中途失败删临时件，原有两样不动。（`定稿.assets/` 的删除是这条例外里唯一的删除，范围只有这个目录。）
- 为什么记录放 front-matter 而不是单独 `定稿.json`：一份文件、预览时可见、AI 读 `.md` 就能顺带读到；文件名统一中文是用户指定的。

### D6 列表与版本条

- `listDelivery` 多读镜像目录下的 `定稿.md`，下发 `final`（见 spec）；`docx` 要过 `resolveInside` 且必须落在镜像目录内，否则当 `null`。
- `DELIVERY_FILE_RE` 不变，`定稿.md` 不会被当成某一版，批注路径映射（`deliveryOf`）对它返回 `original: null`，后端天然拒批注。
- 版本条把「定稿」作为一个特殊选中值 `final`（与 `source` 并列）；说明行（标签下方那一行）显示「第 N 次定稿 · MM-DD HH:mm · 来源」。
  对比复用 `DeliveryDiff`：左边是最新一版（没有版本时是原稿），右边是 `定稿.md`。
- 「预览 Word」沿用现在把 `.docx` 包成 `FileItem` 交给 `ReaderBody` 的做法，只是 `.docx` 来自 `final.docx`。

### D7 AGENTS.md 第十条草案（实现时写进不变量 1 清单）

> **第十条 · 交付稿定稿**（spawn `scripts/finalize_delivery.py`，`finalize.mjs`，同步等退出、带超时）：
> ① 看板只 spawn，自己不写盘；② 用户点「定稿」、在系统选文件框里选中一个 `.docx`、再点「确认定稿」三步发起；③ 环回且非跨站；
> ④ 请求不带任何路径：原稿只用 `docKey`，选中文件的路径只存在服务端内存，前端只拿一次性令牌（10 分钟、用一次即废）；
>    确认时可附 ≤60 字的单行备注，只作为文本写进记录；
> ⑤ 脚本只写原稿的交付稿镜像目录 `output/delivery/<组>/<子路径>/`：新建复制进来的 `<原基名>-<YYYYMMDDHHmm>.docx`（只新建不覆盖）、
>    覆盖 `定稿.md`、整目录替换 `定稿.assets/`；镜像目录里其余文件只读；按需建镜像目录；
> ⑥ 这是唯一会**读工作空间外文件**的例外：只读用户在系统选文件框里亲手选中的那一个 `.docx`，看板不提供按路径读外部文件的接口；
>    记录里只写原文件名，不写外部路径。缺脚本 / Python / anydoc 时 400 说清出路，不退化成看板代劳。

### D8 确认框的可选「备注」

确认框带一个非必填的单行「备注」（例如「发给甲方 · 第二轮评审」），随 `confirm` 的载荷 `{ token, note? }` 发出，
经脚本参数 `--note` 写进记录：本次 `history` 行追加第四段 `| 备注 <内容>`，front-matter 另写 `note:`（只记最近一次，空则不写）。
- 只是文本，不是路径，不改变「请求不带路径」的立场。
- 限制：服务端去首尾空白、把换行与 `|` 换成空格（`|` 是 `history` 行的分隔符），超过 60 字 400；脚本再做一次同样的清洗。
- 列表 `final.note?` 下发最近一次的备注，说明行在来源后追加「· 备注」。

## Risks / Trade-offs

- [系统选文件框弹到浏览器后面，用户以为没反应] → 与 `pickDirectory` 一样先 `activate` System Events；前端在等待期间按钮显示「请在桌面上选择文件…」。
- [无桌面环境（远程 SSH 起的看板）弹不出框] → 400 说明原因；此时本来也是非环回只读的高发场景，不提供上传替代。
- [anydoc 转 Word 的保真度有限（复杂表格、批注、修订痕迹）] → `定稿.md` 定位是「可读、可对比的文字快照」，权威仍是那份 `.docx`；确认框与说明行都写「以 Word 为准」。
- [用户在 Word 里打开着那份文件时复制，读到的是保存前的内容] → 不处理；确认框提示「请先在 Word 里保存」。
- [同一分钟内重复定稿同名文件] → `-2` 后缀，`O_EXCL` 保证不覆盖。
- [令牌在服务重启后丢失] → 确认时 400「请重新选一次」，无副作用。
- [`docxTools.mjs` 导出内部函数，模块边界变宽] → 只导出 `runScript` / `exclusive` / `requirePython` 三个通用件，不改其行为。

## Migration Plan

1. 模板加脚本、文档；工具链版本号随之升一个小版本（与 `docxkit/__init__.py` 同一处版本，便于模板更新识别）。
2. 服务端加接口与字段（全可选）；重启后生效。旧前端不受影响。
3. 前端接入；遇旧服务 404 时按钮置灰提示重启。
4. 已有工作空间实例经 `template_update.py` / `pm-template-update` 拿到新脚本；没拿到前按钮点了是 400 的清楚提示。
回滚：删前端入口即可；已生成的 `定稿.md` 与复制进来的 `.docx` 是普通文件，留着无害。

## Open Questions

- （已定）确认框的可选「备注」见 D8。
