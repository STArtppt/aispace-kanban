## ADDED Requirements

### Requirement: 转换产物的新目录约定

工作空间模板 SHALL 把转换产物落在 `output/converted/`，目录结构仍镜像 `input/raw/`；图片 SHALL 仍落在 `input/assets/`（目录不变），
产物正文的图片链接按产物所在目录跨目录指向 `input/assets/`；数据库源产物落在 `output/converted/_sources/`。
`_sources`、`_manifest*` 为保留名，镜像目录名与之冲突时由 `layout.py` 安全化。
「图片资料」页签 SHALL 仍在「输入资料」下，读 `input/assets/`，行为不变。
`ingest.py`、`db_ingest.py`、`web_ingest.py`、`pointtable.py`、`realdata.py` 等写产物的脚本 SHALL 只写新位置。
`output/converted/` SHALL NOT 属于产出三组：不建产出物记录、不可归档、不计入完整度与产出总数。

#### Scenario: 新转换一份 docx

- **WHEN** 新布局工作空间里把 `input/raw/需求调研/方案.docx` 转换
- **THEN** 产物是 `output/converted/需求调研/方案.md`，图片在 `input/assets/方案/`，正文图片链接可在预览里显示；「输入资料 → 图片资料」里出现这份文档的图

### Requirement: 一次性迁移脚本

模板 SHALL 提供 `scripts/migrate_converted_to_output.py`：`--dry-run` 只打印计划；执行时把 `input/converted/` 整体移到 `output/converted/`
（`input/assets/` 不动），并改写被移动 `.md` 正文与 frontmatter `payload` 里的相对链接（指向 `input/assets/`、`input/raw/` 的链接因所在目录变化而重算），
改写按「旧位置解析 → 映射到新位置 → 重新算相对路径」进行；同时重写 `input/INDEX.md` 中的产物链接。
脚本 MUST NOT 改 `output/analysis|docs|decisions` 等其他文件，MUST NOT 移动 `input/assets/`；目标已存在且非空时 MUST 拒绝并退出非零，不合并。
看板 SHALL NOT 提供触发迁移的按钮。

#### Scenario: 先看计划

- **WHEN** 在旧布局工作空间执行 `python3 scripts/migrate_converted_to_output.py --dry-run`
- **THEN** 输出将移动的目录与将改写的链接条数，工作空间没有任何文件变化

#### Scenario: 迁移后图片不断

- **WHEN** 迁移完成，打开 `output/converted/需求调研/方案.md`
- **THEN** 预览里图片正常显示

### Requirement: 模板 .gitignore 精简

模板 `.gitignore` SHALL 整目录忽略 `input/raw/*`、`input/assets/*`、`input/sources/*`，并只放行 `.gitkeep`、`input/sources/README.md`、
`input/sources/example.yaml.txt`；SHALL 删除原来按扩展名列举的 `input/**/*.<扩展名>` 规则；
SHALL 对 `output/converted/**` 忽略同一组大体积二进制 / 表格扩展名（csv、sqlite、db、sql、Office 文件、pdf、zip），
`_manifest*.md` 与普通 `.md` 产物仍入库。`input/INDEX.md`、`input/README.md`、`input/.ingestignore` 仍入库。
`output/` 其余目录与 `visualization/` 的规则不变。

#### Scenario: 新工作空间提交

- **WHEN** 新建工作空间后放入原件、转换，执行 `git add -A`
- **THEN** 暂存区没有 `input/raw/`、`input/assets/`、`input/sources/*.yaml` 下的文件，也没有 `output/converted/` 下的 csv / sqlite；
  `output/converted/` 的 `.md` 与 `input/INDEX.md` 在暂存区里

#### Scenario: 数据源配置

- **WHEN** 用户在 `input/sources/` 新建 `仓库库.yaml`
- **THEN** 它被忽略；`input/sources/README.md` 仍被跟踪

### Requirement: 产出文档页签文案

「产出文档」视图的页签 SHALL 叫「分析产物」（`output/analysis/`，原「分析中间产物」）与「交付文档」（`output/docs/`，原「对外交付文档」），
「决策」及其他页签文案不变。目录名、记住的页签 key（`analysis` / `docs`）不变，改名不影响已记住的选择。
模板 `AGENTS.md`、`output/README.md`、`output/records/README.md` 等描述这两个目录的叫法 SHALL 同步改成新名。

#### Scenario: 页签改名

- **WHEN** 用户进「产出文档」
- **THEN** 页签显示「分析产物」「交付文档」，上次停留的页签照旧选中

### Requirement: 产出视图的「转换产物」栏

「产出文档」视图 SHALL 新增一栏「转换产物」，排在产出三组之后，内容、搜索、排序、列表 / 树形、筛选（存疑、原件已改、被引用）
与原「输入资料 → 转换产物」一致，并保留其「重新转换」等行内操作。「输入资料」下 SHALL NOT 再有「转换产物」栏，
原记住的输入页签是 `converted` 时退回「原始资料」。上一个 change 的交付稿栏（转 Word）随条目一起出现在新位置。

#### Scenario: 找到转换产物

- **WHEN** 用户进「产出文档」点「转换产物」
- **THEN** 看到原来在输入资料下的同一份列表，点开 markdown 预览顶栏下有交付稿栏

### Requirement: 双布局兼容

看板 SHALL 按以下顺序认转换产物根目录：`output/converted/` 存在 → 新布局；否则 `input/converted/` 存在 → 旧布局；都没有 → 新布局空态。
旧布局时「转换产物」栏顶部 SHALL 提示「这个工作空间还是旧目录布局，更新模板后执行迁移脚本」，功能照常可用。
两处都存在时用新布局，并提示 `input/converted/` 残留待人工确认。
`converted-md` 的 docKey、交付稿落点（`output/delivery/converted/<子路径>/`）在两种布局下 SHALL 得到同一个镜像目录。
SSE 已递归监听 `input/` 与 `output/`，两种布局都自动刷新。

#### Scenario: 实例还没迁移

- **WHEN** 看板已更新、工作空间只有 `input/converted/`
- **THEN** 「产出文档 → 转换产物」照常列出产物并显示迁移提示，原始资料的「已转」标签正确

#### Scenario: 工作空间目录丢失

- **WHEN** 当前工作空间 `available === false`
- **THEN** 转换产物栏按现有方式降级，不报错

### Requirement: 溯源引用的旧前缀别名

产出文档里写着 `input/converted/…` 的溯源引用 SHALL 在新布局下仍被反链识别：看板把 `input/converted/` 前缀当作 `output/converted/` 的别名匹配，
「被引用」计数与改动前一致。迁移 SHALL NOT 改写产出文档里的引用文字；模板技能 SHALL 改为要求新写的引用使用 `output/converted/`。

#### Scenario: 迁移前写的分析文档

- **WHEN** `output/analysis/现状.md` 里有 `（来源：input/converted/需求调研/方案.md，"3.2"）`，工作空间已迁移
- **THEN** `output/converted/需求调研/方案.md` 的「被引用」里列出 `现状.md`
