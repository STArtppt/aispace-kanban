## Why

不做的话，「忽略」会一直占着一条写入例外、一个状态、一项筛选和三个转换脚本里的过滤分支，换来的作用却已经没了：
原始资料列表现在与磁盘目录一一对应，忽略不忽略都照样列出来，它只剩「点『开始转换』时别碰这些文件」一个效果。
把全局「开始转换」也一并拿掉之后，看板只按用户点的那份文件或那个目录转换，忽略清单就没有存在的理由了。

## What Changes

- **BREAKING** 看板去掉「忽略此文件 / 忽略此目录」菜单和 `POST /api/projects/:id/ignore` 接口；不再提供「解除忽略」。
- **BREAKING** 扫描的 raw 条目不再有 `ignored` 状态，`stats.ignored` 不再给；「忽略」筛选、标签和目录汇总里的「忽略」一起去掉。
  原来被忽略的资料按有没有产物显示「待转」或「已转」。
- **BREAKING** 原始资料顶部去掉全局「开始转换」按钮；`POST /api/projects/:id/ingest` 拒绝空路径和 `input/raw` 根本身。
  单份「转换」、目录的「转这一整个目录」、已转资料的「重新转换」保留。转换进度与报错的显示保留。
- AGENTS.md 不变量 1 删掉「忽略待转换资料：追加 `input/.ingestignore`」这条写入例外，看板对工作空间少一处写入。
- 模板（templates/pm-aispace）：
  - `scripts/layout.py` 删掉 `.ingestignore` 的读取、`is_ignored` 与 `--ignore` / `--no-ignore` 参数。
  - `ingest.py`、`pointtable.py`、`web_ingest.py`、`migrate_converted.py` 不再按忽略清单过滤；台账不再写「另有 N 份按忽略清单忽略」。
  - `move_raw.py` 不再改写忽略规则，预览结果去掉 `ignore` 字段。
  - **BREAKING** `ingest.py` 不带路径参数时拒绝运行（退出码非 0，不写任何文件），提示指定文件或目录；`--dry-run` 不带路径仍可看全量计划。
    终端里显式写 `input/raw` 仍可全转，那是人有意为之。模板里所有「`python3 scripts/ingest.py`」不带路径的用法示例改成带路径。
  - `template.yaml` 的 `seedOnly` 与 `init_workspace.py` 不再铺 `input/.ingestignore`，模板里删掉这份文件。
  - 模板 `AGENTS.md`、`input/README.md`、`.gitignore` 注释、`templates/help.md`、`pm-template-update` 技能的文案同步。
- 本会话里已经做掉、但与现行 spec 不符的几处原始资料界面调整，一并记进 spec：
  目录行带汇总状态标签、「原件已改」标签改叫「改动」、标签挪到大小 / 文件数之后、「移动到…」的目录选择改成默认收起的树。
- 回归：`scripts/smoke-package.mjs` 去掉忽略接口的断言、加「ingest 拒绝空路径」；`scripts/check-move-raw.mjs` 与 `fixtures/raw-move/` 去掉忽略规则相关用例。

## 关于工作空间写入（请人拍板）

本变更**只收窄**写入：删掉看板对 `input/.ingestignore` 的追加。不新增任何写入。
已有工作空间实例里的 `input/.ingestignore` **不删、不改**：模板更新后脚本不再读它，它就成了一份无效文件，
留给用户自己决定要不要删。`pm-template-update` 技能会提示这一点，但不替用户删。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `raw-source-status`：去掉「忽略」状态、筛选与操作；标签改名「改动」、位置改到行尾、目录行带汇总标签；去掉全局「开始转换」，看板不发起全量转换。
- `raw-source-organize`：预览与跟进里不再有忽略规则；「移动到…」的目录选择改为默认收起的树。
- `workspace-template-update`：`seedOnly` 不再包含 `input/.ingestignore`。
- `converted-in-output`：模板 `.gitignore` 的要求里不再提 `input/.ingestignore`。

## Impact

- **服务端**（`src/server/http.mjs`、`src/server/scan.mjs`）：删 `addIgnore` 与 `/ignore` 路由、删 `.ingestignore` 读取与 `ignored` 判定、`startIngest` 拒绝空路径。无类型检查，改完必须重启 `pnpm serve` / `pnpm dev`。
- **契约**（`src/app/lib/api.ts`）：删 `addIgnore`；`FileItem.ignored`、`state: 'ignored'`、`stats.ignored` 去掉；`RawOrganizePlan.ignore` 改为可选（旧脚本仍会给）。
- **前端**（`InputPanel.tsx`、`RawOrganizeDialog.tsx`、`FileTree.tsx`）：去菜单、筛选、标签、全局按钮。旧服务进程仍可能下发 `ignored`，前端按「待转」兜底，不白屏。
- **CLI**（`bin/cli.mjs`）：不动。
- **templates**：上面列的脚本与文案（含 `README.md`、`pm-doc-ingest` 技能、`init_workspace.py` 结尾提示里的不带路径示例），放进去就是发出去；已有实例要走一次模板更新才生效。
- 依赖：无新增。
