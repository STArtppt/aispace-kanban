## Context

转换产物放在 `output/converted/` 下(旧布局在 `input/converted/`,统一由 `scan.mjs` 的 `convertedRootOf` 决定),
目录结构和 `input/raw/` 一一对应。看板列表里的"一份产物"可能是单个文件(`.md` / `.csv` / 图片 / HTML 原型等)，
也可能是目录型：新布局是摘要 `_manifest_<名>.md` 加正文容器 `SplittingObject/<名>/`,旧布局是一个带 `_manifest.md` 的目录。

**这次只做单文件 `.md`**(用户的范围决定)。这批文件刚好就是现在已经下发 docKey(种类 `converted-md`,`listConvertedMd`)、
能「转成 Word」的那批：不含摘要、目录型产物的内部文件、`SplittingObject/` `MergedObject/`、`_sources/`。

由 anydoc / MinerU 转出的 `.md` 会把图片放进 `input/assets/<名>/`(`ingest.py` 的 `ASSETS`),正文用跨目录的相对链接引用，比如
`../../input/assets/<名>/p1.png`。工作空间模板的 `.gitignore` 忽略所有图片，这些图片只在本机，不入库。

`ingest.py` 判断幂等只看 `output/converted/` 里的产物;产物不在了，台账 `INDEX.md` 会清掉那一行。
所以用户选了复制，没选移动。

可以照搬的先例是第十一条重命名(`runRename` → `scripts/rename_output.py`):服务端按 docKey 反查路径，
同步 spawn 脚本，先预览再执行，脚本的中文报错原样带回前端。

## Goals / Non-Goals

**Goals:**

- 一次点击把一份 `.md` 转换产物放进三个产出组之一，子目录结构不变;复制件在看板里打开，和原产物显示一致(图片不断)。
- 执行前就能看到落点;落点已存在就拒绝。
- 复制件能追溯到原件(`source`),也能看出它是从哪份产物复制来的(`copied_from`)。

**Non-Goals:**

- 不做移动，也不提供"复制后删掉 converted 里那份"。
- 不支持非 `.md` 文件和目录型产物，菜单里不出现这一项。
- 不支持改落点名字，也不能另选子目录;要改名，复制完用第十一条重命名。
- 不建记录、不建交付稿镜像、不碰台账;原件重转后，复制件不会跟着更新。
- 不改写 wikilink(ingest 生成的产物里没有)。

## Decisions

### 1. 复制，不移动

见 proposal。备选方案是"移动，同时把原件写进 `input/.ingestignore`"。**不选**:一是用户已经选了复制;
二是原件被忽略后，再改动也不会提示，为了"移动"这个字面意思，会把"原件动过"的提醒丢掉。

### 2. spawn 工作空间脚本 `copy_converted.py`,看板不自己写

形状和第十一条一样。**备选**:服务端直接复制(直写族)。**不选**:复制件还要重算链接、补 front-matter,
写成脚本后，工作空间里的 agent 在终端也能用同一套规则(`python3 scripts/copy_converted.py --source … --to analysis`)。
代价是老实例要先更新模板;没有脚本时置灰，不退化成看板代劳。

### 3. 沿用 `docKey` / `converted-md`,不新增键种类

能复制的范围和能转 Word 的范围完全相同，直接复用这个键，服务端用 `findDocByKey(root, 'converted-md', key)` 反查。
**备选**:新开一个键种类。**不选**:范围一样，再开一个只会多一份需要对齐的枚举。
前端用"有没有 `docKey`"决定显不显示「复制到…」,和「转成 Word」的判断一致。
脚本**自己**再校验一遍：来源在转换产物根内、是 `.md`、不是符号链接、不是摘要、不在 `SplittingObject/` `MergedObject/` `_sources/` 下。

### 4. 落点

转换产物根记为 `C`,落点是 `output/<组>/<来源相对 C 的路径>`,中间目录按需新建。
组名只收 `analysis` / `decisions` / `docs` 三个字面值，服务端和脚本各校验一次。落点已存在就退出码 2,服务端回 409。

### 5. 相对链接按新位置重算

只处理复制件里的 Markdown 链接 / 图片 `[..](相对路径)` 和 `<img src="相对路径">`(规则同 `markdownSyntax.ts`;
带协议的、以 `#` 开头的、绝对路径一律跳过)。链接按**原位置**解析，落在工作空间内且文件存在的，按新位置重新算出相对路径;
其余的保持原样。重算后依旧指向原文件，典型就是 `input/assets/<名>/` 下的图片。

**备选**:把 `input/assets/<名>/` 一起复制到复制件旁边。**不选**(用户也确认不复制图片):同一批图要存两份，还得另定一套落点规则;
而且图片本来就不入库，复制过去也只是多一份本机文件。
指回原图，看板预览和 `md2docx.py` 都能正常解析。

### 6. `copied_from` 留痕

在复制件的 front-matter 追加 `copied_from: <来源工作空间相对路径>` 和 `copied_at: <ISO 时间>`。
原有的 `source` / `source_sha256` / `converted_by` 保留;没有 front-matter 就新建一段。

### 7. 先预览再执行，不用指纹

`--dry-run --json` 返回 `{ target, rewrittenLinks, conflict }`,不写盘。执行时重新计算，冲突退出码 2。
**不像第十一条那样带指纹**:复制只新建一个文件，冲突检查本身就兜住了;预览之后源文件改了，复制的就是执行那一刻的内容，没有坏处。

### 8. 落盘：同目录临时文件 + `os.link`,不覆盖

先在落点目录写 `.<名>.copy-<随机>.tmp`,再 `os.link(tmp, target)`:目标已存在时它会原子地失败，不会覆盖;
最后删掉这个临时文件。失败时只删本次的临时文件，以及本次新建出来的空中间目录。
**备选**:`os.replace`。**不选**:它会静默覆盖已有文件。文件系统不支持硬链接时，退回到 `open(target, 'x')` 独占创建后写入。

### 9. 前端

- `ConvertedRow` 菜单：删除置灰的「重命名」;**有 `docKey` 的条目**加「复制到…」,没有 `docKey` 的条目不出现。
  有 `docKey` 但 `canCopyConverted === false` 时置灰，提示"更新模板后可用";字段缺失(旧服务进程)时置灰，提示重启。
- 新建 `ConvertedCopyDialog.tsx`,结构参照 `RenameDialog.tsx`:三个单选项(分析产物 / 决策记录 / 交付文档)。
  选中一项后调用预览，显示落点路径和"会重算 N 处链接";有冲突就显示已存在的路径，确定按钮禁用。
- 成功后提示"已复制到 <路径>",切到目标组，在阅读器里打开复制件。

## Risks / Trade-offs

- [复制件的图片指向 `input/assets/`;有人清掉它，或者在另一台机器上 clone 工作空间(图片不入库)时，图会断] →
  可以接受。图片由转换脚本从原件抽出，重跑 ingest 就能重建;做交付件时走「转成 Word」或定稿，图片会打进 docx。
- [复制件 front-matter 的 `source:` 指向 `input/raw/`,溯源反链会把它算成"这篇产出引用了原件"] → 这本身就是事实;
  落地时核对 `referencedBy`,确认不会重复计数。
- [老实例没有脚本] → `canCopyConverted: false` 时置灰，提示更新模板。
- [进程被杀后残留临时文件] → 文件名以 `.` 开头，scan 不显示;脚本不做自动清理(那就成了删除)。

## Migration Plan

模板新增脚本，实例通过 `template_update.py` 拿到。服务端新增的字段都是可选的。
回滚：去掉菜单项和路由即可，已经复制出来的就是普通产出文件。

## Open Questions

- 第十二条及其边界(proposal 中"需要人拍板"一段)是否同意。
