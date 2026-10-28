## Why

不做的话，用户想给产出文档改个名(比如加 `01` 前缀排评审顺序),只能去文件夹里手改，一改就"丢"东西。
看板按路径把原稿和交付稿镜像目录 `output/delivery/<组>/<子路径>/` 对上,`output/records/` 的 `target`、
交付稿 front-matter 的 `source`、批注的 `- 对象：` 行、问题的 `source` / `flows_to`、别的文档里的链接，
指的也都是旧路径。改名之后，九版交付稿、定稿和 Word 在磁盘上一个都没少，但在看板上全看不到了，
用户只能把名字改回去。

用户期望的体验和 Obsidian 改名一样：在看板上点「重命名」,填新名字，先看到"将更新 N 个文件中的 M 处链接",
确认之后，文件、交付稿和所有引用一次改到位。

## What Changes

- 产出文档视图中，三组原稿(`analysis` / `docs` / `decisions`,包括组内子目录和已归档项)每一行的「更多」菜单
  新增「重命名」。转换产物标签不提供这一项，菜单里置灰并写明原因。
- 重命名弹窗分两步：先填新名字(只填基名，扩展名不变),然后**预览**这次会改名的文件和目录，以及要更新链接的文件清单、
  每个文件改几处，最后点「确定」执行。预览之后磁盘有变化的，执行时拒绝，提示重新预览。
- 新增工作空间脚本 `templates/pm-aispace/scripts/rename_output.py`(模板随附),由它完成全部改动：
  - 改原稿的名字;`.md` 原稿的交付稿镜像目录一起改名，目录里的 `<旧基名>.docx` 改成 `<新基名>.docx`,
    其余文件(`v*.md`、`v*.docx`、`定稿.md`、`定稿.assets/`、带时间戳的历史 Word)名字不变;
  - 更新结构性引用：记录的 `target`,交付稿和定稿 front-matter 的 `source` / `docx`,批注的 `- 对象：` 行，
    问题的 `source` / `flows_to`;
  - 更新正文里的链接：完整路径、相对路径链接、wikilink,解析规则和看板渲染器保持一致;
  - 原稿有记录的，在记录「## 状态流水」追加一条改名留痕(状态不变);
  - 链接改动让其他原稿内容变了的，把它们交付稿里原本匹配的 `source_sha` 一并换新，免得交付稿条误报"原稿已变更"。
- 服务端新增预览和执行两个接口，都只 spawn 这个脚本;scan 新增可选字段 `canRename`,
  三组所有文件都下发 `docKey`(原来只给 `.md`)。
- 改名成功后，前端把收藏置顶、当前打开的条目都跟到新路径。

### 不变量 1 新增第十一条写入例外(已获用户批准)

这次放宽了只读红线，是 **spawn 族**的新例外，形状和第七条"一次归档"相同：看板只 spawn,自己一个字节都不写。
但写入面比归档宽得多。归档只移一个文件、追加一行 README;重命名要**改写 `output/` 下任意文本文件中的链接**,
包括 AI 写区的字段(记录 `target`、问题 `source` / `flows_to`)。
具体边界在 design 里列出：只扫 `output/` 和 `project.yaml`,不碰 `input/`、`output/converted/`、`visualization/`、`.claude/`,
交付稿 `v*.md` 的正文不改，命中也不在预览里列出。用户已同意新增这一条，以及 design 决策 4、5 的边界。

另外，第六条 ① 写了记录"不改名"。重命名不改记录文件名，只由脚本改 `target` 字段，两条不冲突。

## Capabilities

### New Capabilities

- `output-rename`:产出原稿重命名。覆盖范围、预览和确认的两步交互、脚本的改写范围与排除项、
  失败时不留半截状态、看板只 spawn 的写入边界。

### Modified Capabilities

(无。scan 新增的 `canRename`、`docKey` 扩展到非 `.md` 文件，都是本能力内部用到的可选字段，现有能力的需求不变。)

## Impact

- **templates**:新增 `templates/pm-aispace/scripts/rename_output.py`,会随模板发给每个新工作空间;
  已有实例通过 `template_update.py` 拿到。模板 AGENTS.md 的目录说明加一句"改名走看板，不要手改"。
- **服务端**(`src/server/`):`http.mjs` 新增 `rename` 预览 / 执行路由与 spawn 入口(环回、非跨站、请求只带 `docKey` + 新基名);
  `scan.mjs` 新增 `canRename`,三组所有文件下发 `docKey`,新增 docKey 种类 `output-file`。
  不新增文件，打包清单不用动。
- **契约**(`src/app/lib/api.ts`):新增 `renamePreview` / `rename` 两个方法和响应类型;`canRename?` 是可选字段，
  旧服务进程不给时菜单置灰并提示重启。
- **前端**(`src/app/`):`OutputPanel.tsx` 行菜单加一项，新增弹窗组件 `RenameDialog.tsx`,收藏置顶的路径迁移。
- **CLI**:不涉及。
- **文档**:AGENTS.md 不变量 1 加第十一条(批准后),`openspec/specs/output-rename/`。
- **依赖**:无新增。
