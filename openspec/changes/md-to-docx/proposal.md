## Why

不做的话，工作空间里写好的 Markdown 交付给客户时，仍要手工在 Word 里一段一段调格式；
工作台的「模版洗炼」停留在演示，`output/docx-template/` 永远是空的；
看板里点开 `.docx` 只能交给系统打开，连转出来的成品都没法在看板里核对。
提炼脚本已经在 `spike-docx-template/` 里用一份真实客户文档跑通
（采集 → 清洗 → 按规范重建样式 → 补齐通用角色 → 输出 reference.docx → pandoc 转样张 → 反查格式），
上一个 change（`workbench-module-hub`）也把入口搭好了，现在该把这条链路接成真功能。

## What Changes

- **docx 工具链进工作空间模板**：把 spike 里的脚本整理进 `templates/pm-aispace/scripts/`：
  `docx_template.py`（提炼模板：`collect` 采集、`build` 生成模板包）、`md2docx.py`（按模板把 `.md` 转成 `.docx`，含后处理），
  公共代码放 `scripts/docxkit/`，通用内容规范 `base-spec.json` 随模板分发。脚本只用 Python 标准库，转换需要本机装有 pandoc。
  `spike-docx-template/` 在迁移完成后删除，合成回归语料转到 `fixtures/docx-template/` 并接进 `pnpm test:docx`。
- **模版洗炼从演示变成真功能**（修改 `docx-template-refine`）：
  - ① 选来源：从 `input/raw/` 的 `.docx` 清单里选。「上传」本期不做，改成提示「把文件放进 `input/raw/`」并提供「在访达中显示」。
  - ② 样式分析、③ 大纲层级：点「开始分析」后，看板启动 `docx_template.py collect`，采集报告写进 `output/docx-template/<模板名>/collect/`，
    界面展示真实的格式簇和大纲，用户在界面上做映射、合并、取舍（就是提炼时「计划 → 确认」那一步）。
  - ④ 模板补全输出：点「生成模板」后，看板把用户的决定交给 `docx_template.py build`，
    由它写出 `profile.json`、`reference.docx`、`spec.md`（写给写 md 的人看的文字规定）和 `sample.docx`（样张）；
    右侧直接预览样张。
  - 删除页顶的「演示」提示和两条内置示例模板；浏览页的「演示」标记去掉。
- **产出文档 `.md` 条目的「更多」菜单新增「转成 Word」**：弹窗里选模板（工作空间里的真实模板，或「通用规范」），然后二选一：
  - **直接转换**：看板启动 `md2docx.py`，成品写在 `.md` 的同目录、同名 `.docx`；完成后可以直接在看板里预览。
  - **复制提示词**：只写剪贴板，把命令与检查要点交给工作空间 AI 去执行（适合要让 AI 顺手修 md 写法的情况）。
- **看板直接预览 `.docx`**：阅读器认出 `.docx` 后，在浏览器里用 `docx-preview` 渲染成分页版式；
  渲染放在不带脚本权限的隔离 iframe 里，不污染看板样式，也不执行文档里的任何东西。扫描契约不变（仍是 `external`），与 PDF 预览同一个做法。
- **AGENTS.md 不变量 1 新增第九条窄例外**（spawn 一族，见下文「写入工作空间」）。
- **`platform.mjs` 增加 pandoc 查找**，`/api/health` 报告 docx 工具链是否可用（Python、pandoc），界面据此置灰并说明出路。

## Capabilities

### New Capabilities

- `docx-toolchain`：工作空间里的 docx 工具链：脚本位置与入口、通用内容规范、模板包文件、pandoc 依赖与探测、合成回归语料。
- `md-docx-export`：产出文档 `.md` 的「转成 Word」：菜单入口、选模板弹窗、直接转换与复制提示词两条路径、落点与同名处理、失败与降级。
- `docx-preview`：阅读器里预览 `.docx`：渲染方式、隔离、字体、体积与失败降级。

### Modified Capabilities

- `docx-template-refine`（由 `workbench-module-hub` 引入，**需先归档那个 change**）：
  「演示不上传、不落盘」改为真实提炼；四步流程接真实数据；列表去掉示例模板；目录约定补上 `sample.docx`，更正 `reference.docx` 的含义。
- `workbench-module-hub`（同上，需先归档 `workbench-module-hub`）：模版洗炼卡片不再标「演示」，改为显示模板个数。

## Impact

- **服务端**：`http.mjs` 新增三个写接口（采集、生成模板、转换，均为 spawn 后同步等待，带超时）和一个只读接口（工具链可用性）；
  新增 `src/server/docxTools.mjs` 收口参数校验与 spawn；`platform.mjs` 加 pandoc 查找；`MIME` 补 `.docx`；
  `scan.mjs` 给产出组里的 `.md` 和 `input/raw/` 里的 `.docx` 条目加可选字段 `docKey`（扫描口径的其它部分不变）。
  服务端没有类型检查，改完必须重启 `pnpm dev` / `pnpm serve`。`output/` 已在递归监听内，不用改 `watchWorkspace`。
- **`src/app/lib/api.ts` 契约**：**要改**。新增采集报告、生成结果、转换结果、工具链可用性的类型与 `api.*` 方法；`/api/health` 加可选字段。新字段全部可选、前端兜底。
- **前端**：`OutputPanel.tsx`（更多菜单）、新增「转成 Word」弹窗；`Reader.tsx` 加 docx 分支与新组件 `DocxView.tsx`；
  `TemplateRefinePane.tsx` 与 `templateRefine/` 由演示数据换成真实接口；`WorkbenchHub.tsx` 去掉「演示」。
- **CLI**：不改。
- **templates（放进去就是发出去）**：`templates/pm-aispace/scripts/` 新增 `docx_template.py`、`md2docx.py`、`docxkit/`、`base-spec.json`；
  `output/docx-template/README.md` 改写；工作空间 `AGENTS.md` 补「转 Word」与「模板提炼」的说明（工作空间 AI 走复制提示词那条路时照着做）。
  已有工作空间拿不到新脚本，看板检测到脚本缺失时说清出路。
- **依赖**：前端新增 `docx-preview`（进 `dependencies`，与本仓其它前端库一致；动态 import，不进首屏包）。
  服务端不新增 npm 包。系统依赖：直接转换需要 pandoc（≥ 3）；提炼不需要。LibreOffice 不是必需项。
- **仓库**：`spike-docx-template/` 删除；`fixtures/docx-template/` 放合成语料（含一份由脚本生成的「格式很乱的旧文档」）；`package.json` 加 `test:docx`。

## 写入工作空间（需要拍板）

新开**第九条窄例外**，属于「看板只 `spawn`，工作空间脚本写盘」一族（与资料转换、第三、五、七条同构），
**不是**第四、六、八条那种服务端直写。理由：提炼和转换都是重活（解析 OOXML、跑 pandoc），本来就该由工作空间脚本做；
而且终端里、工作空间 AI 手里都要能跑同一份脚本，看板只是其中一个触发方。边界草案：

1. 看板只 `spawn`，自己不写、不 `rename`、不 `unlink` 工作空间里任何一个字节；同步等待脚本退出，带超时。
2. 必须由用户在看板上点「开始分析」「生成模板」「转换」明确发起；没有后台任务、没有定时，不因文件变化自动重跑。
3. 必须环回（`allowMutations`）且非跨站（`rejectIfForeignOrigin`），否则 403。
4. **请求不带任何路径**：
   - 来源文档和待转换的 `.md` 只用**服务端下发的不透明键 `docKey`** 指定（扫描时对可转换条目的相对路径取摘要得到）。
     服务端收到键后重新扫描、反查出路径，查不到就 400，然后才把路径交给脚本。
     **不接受「带路径但我们会校验」** —— 第七条第 ④ 款的理由原样适用；
     与第七条不同的是，这里不能退回「组名 + 基名」，因为产出文档常在组内子目录里；
   - 模板名只接受一层基名（不以 `.` 开头，不含分隔符、不含 `..`）；
   - 用户在第 ②③ 步做的决定以 JSON 经 stdin 传给脚本，服务端限制大小、脚本校验结构，JSON 里不允许出现路径。
5. 脚本只允许写两处：
   - `docx_template.py`：只写 `output/docx-template/<模板名>/` 这一个目录（`collect/`、`profile.json`、`reference.docx`、`spec.md`、`sample.docx`）；
   - `md2docx.py`：只写与来源 `.md` 同目录、同基名的 `.docx`，不写别的文件（中间文件放系统临时目录，结束即删）。
   `input/`、`project.yaml`、`visualization/`、`.md` 原文以及 `output/` 下的其它一切仍然只读。
6. **不覆盖别人的文件**：同名 `.docx` 已存在时，只有它带着本工具链写入的生成标记，并且用户在弹窗里确认「覆盖」，才允许覆盖；
   没有标记（比如是人手写或客户给的 Word）一律拒绝，改名另存由用户自己决定。模板名已存在时，「生成模板」只在用户确认「重新生成」后才覆盖该模板目录下的上述文件。
   脚本不存在、Python 或 pandoc 缺失时接口 400 并说清出路，不退化成「看板替你写」。

另外两处也请一并确认：

- **上传本期不做**：想用本地文件提炼，先把它放进 `input/raw/`。这样第九条就不用再开一个「看板往 `input/` 写」的口子。
- **pandoc 是系统依赖**：资料转换（`rich-doc-convert`）当初专门去掉了 pandoc 依赖；这次「md → docx」反过来需要它，
  因为模板样式的继承、题注、脚注、代码高亮都靠 pandoc 的 docx writer。没装 pandoc 时，「直接转换」置灰，「复制提示词」照样可用。
