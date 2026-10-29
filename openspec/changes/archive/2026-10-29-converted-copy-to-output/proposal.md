## Why

不做的话，用户想把一份转换产物(比如转好的需求说明)当成自己的分析底稿或交付文档继续写，只能去文件夹里手动复制：
要自己在 `output/analysis/` 下按原来的子目录重建一层层文件夹;正文里指向 `input/assets/<名>/` 的相对图片链接，
拷过去后会全部断掉。
而转换产物行菜单里现在只有一项置灰的「重命名」,告诉用户"不能改",却没给出能做的事。

用户原本要的是"移动"。但 `ingest.py` 判断一份资料"已转换"靠的是 `output/converted/` 里有它的产物：产物移走后，
资料台账会清掉那一行，下次点「开始转换」又会生成一份，结果和复制一样，还白白丢了台账。用户因此选了**复制**。

## What Changes

- 「产出文档 → 转换产物」每一行的「更多」菜单**去掉置灰的「重命名」**。**只有单文件 `.md` 产物**(和能「转成 Word」的是同一批)
  新增「复制到…」;其他格式(`.csv`、图片、HTML 原型等)和目录型产物(摘要 + `SplittingObject/` 拆分正文、旧布局目录)不出现这一项。
- 点开后在弹窗里三选一：分析产物(`analysis`)、决策记录(`decisions`)、交付文档(`docs`)。弹窗**预览**落点路径和
  要改写的链接数;落点已经存在的直接显示冲突，不能确定。
- **目录结构跟着走**:`output/converted/<子路径>/<名>.md` 复制到 `output/<组>/<子路径>/<名>.md`,中间目录按需新建。每次只复制这一个文件。
- 复制件里的相对链接(典型是图片 `input/assets/<名>/…`)按新位置重算，继续指向原文件;**图片不随文件复制**。
  复制件的 front-matter 加一行 `copied_from:`,
  写明从哪份转换产物复制过来，原有的 `source` / `source_sha256` 保留，溯源不断。
- `output/converted/` 一个字节都不动，资料台账、"原件动过"提示和「重新转换」都不受影响。
- 新增工作空间脚本 `templates/pm-aispace/scripts/copy_converted.py`(模板随附),看板只 spawn 它。
- 服务端新增预览和执行两个接口;scan 新增可选字段 `canCopyConverted`。条目沿用已有的 `docKey`(种类 `converted-md`),
  不新增键种类。

### 不变量 1 新增第十二条写入例外(需要人拍板)

这一条放宽了只读红线，属于 **spawn 族**:看板只 spawn,自己一个字节都不写。写入面是**只新建**:

- 每次只在 `output/analysis/` `output/decisions/` `output/docs/` 之一下新建**一个** `.md`(加上按需新建的中间目录),
  不覆盖、不删除、不改名;落点已存在拒绝(409)。
- 被复制的转换产物只读;`input/`、`output/converted/`、`output/delivery/`、`output/records/`、`visualization/`、
  `project.yaml` 都只读。复制件不建记录、不建交付稿镜像。
- 来源只能是转换产物根下的单文件 `.md`(docKey 种类 `converted-md`);请求只带 `docKey` + 组名，不带任何路径。

用户已选定"复制而不是移动"。**第十二条本身和上面的边界，需要确认后才写进 AGENTS.md**。

## Capabilities

### New Capabilities

- `converted-copy-to-output`:把一份单文件 `.md` 转换产物带着子目录结构复制进产出三组之一。覆盖：入口与可用范围、
  预览与冲突、链接重算、`copied_from` 留痕、只新建的写入边界、看板只 spawn。

### Modified Capabilities

- `output-rename`:「转换产物不可重命名」这个场景改成"转换产物行菜单里不出现「重命名」"。原来的置灰项
  只是一条说明，现在由「复制到…」取代。

## Impact

- **templates**:新增 `templates/pm-aispace/scripts/copy_converted.py`,随模板发给新工作空间，已有实例通过
  `template_update.py` 拿到。模板 AGENTS.md 加一句"想基于转换产物继续写，用看板的『复制到…』,不要直接改 converted"。
- **服务端**(`src/server/`):`scan.mjs` 返回 `canCopyConverted`(docKey 沿用 `converted-md`,不改);`http.mjs` 新增 `POST projects/:id/converted-copy/preview` 与 `POST projects/:id/converted-copy`,
  守 `allowMutations` + `rejectIfForeignOrigin`,docKey 反查后再过 `resolveInside()`。
- **契约**(`src/app/lib/api.ts`):新增 `canCopyConverted?`、`ConvertedCopyPlan` 类型、
  `api.convertedCopyPreview` / `api.convertedCopy`。新字段全部可选：旧服务进程不给时，菜单项置灰，提示重启。
- **前端**(`src/app/`):`ConvertedList.tsx` 换掉菜单项;新建 `ConvertedCopyDialog.tsx`;复制成功后切到目标组并打开复制件。
- **CLI**:不涉及。
- **文档**:AGENTS.md 不变量 1 加第十二条、spawn 族列表补上它，第十一条末尾"转换产物不提供改名(菜单置灰说明)"同步改掉;
  `openspec/specs/converted-copy-to-output/`。
- **依赖**:无新增(脚本只用 Python 标准库)。
