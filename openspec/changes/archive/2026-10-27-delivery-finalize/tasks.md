## 1. 模板脚本（templates/pm-aispace）

- [x] 1.1 新增 `scripts/finalize_delivery.py`：参数 `<原稿相对路径> --docx <路径> [--json]`；校验原稿在产出三组、`.docx` 存在且扩展名对；按需建镜像目录
- [x] 1.2 场景判定（realpath 父目录 == 镜像目录）与复制：`<原基名>-<YYYYMMDDHHmm>.docx`，重名 `-2`/`-3`，`open(..., 'xb')` 只新建
- [x] 1.3 转换：`anydoc.to_markdown_with_assets` 写临时 `.md` 与 `定稿.assets.tmp/`，链接前缀过 `layout.md_link`；成功后原子替换，失败清临时件、保留旧定稿
- [x] 1.4 front-matter：读上一份 `history`，追加本次；写 `kind/source/finalized_at/docx/docx_sha/count/note?/history`；`--note` 清洗后追加为 history 第四段（D8）；不写任何外部绝对路径
- [x] 1.5 结果 JSON 与退出码（0 / 2 / 3 / 4）对齐 `md2docx.py`；终端直接跑一遍两种场景各一次（用合成 docx，验证后删掉产物）
- [x] 1.6 文档：`output/delivery/README.md`、模板 `AGENTS.md`（定稿.md 由看板生成、AI 不要手改）、`templates/help.md` 补「定稿」一段；工具链小版本号 +1

## 2. 服务端（src/server，改完重启 pnpm dev / serve）

- [x] 2.1 `platform.mjs` 新增 `pickDocxFile({ prompt, defaultDir })`：macOS / Windows / zenity / kdialog 四条，复用 `runCaptured` / `interpretPick`
- [x] 2.2 `docxTools.mjs` 导出 `runScript` / `exclusive` / `requirePython`（行为不变）
- [x] 2.3 新模块 `finalize.mjs`：`pickFinal(project, docKey)`（反查原稿、定位默认目录、弹框、场景判定、算 `copyAs` 与 `nextCount`、发令牌）与 `confirmFinal(project, token, note)`（清洗 / 限长备注、校验令牌 / 过期 / 所属工作空间 / 文件还在、检查脚本存在、spawn、清令牌）；同原稿互斥 409、同时只一个选文件框 409
- [x] 2.4 `deai.mjs` 的 `listDelivery` 读 `定稿.md` 下发可选 `final`；`docx` 过 `resolveInside` 且限镜像目录内
- [x] 2.5 `http.mjs` 加 `POST delivery/final/pick` 与 `POST delivery/final`，挂 `rejectIfRemoteWrite` + `rejectIfForeignOrigin`
- [x] 2.6 重启服务后用 curl 验：非环回 403、跨站 403、坏 docKey 400、过期 / 重复令牌 400、响应不含路径

## 3. 契约（src/app/lib/api.ts）

- [x] 3.1 新增 `DeliveryFinal` 类型、`DeliveryList.final?`、`finalizePick(projectId, docKey)`、`finalizeConfirm(projectId, token, note?)`、`DeliveryFinal.note?`，字段全可选

## 4. 前端（src/app）

- [x] 4.1 `Reader.tsx` 顶栏「在访达中显示」后加「定稿」按钮（lucide `Stamp`），只对产出三组 `.md` 原稿出现；无 `docKey` / 404 置灰提示重启
- [x] 4.2 新组件 `FinalizeDialog.tsx`：等待态「请在桌面上选择文件…」→ 确认框（文件名、是否复制及新名、第 N 次 / 将生成定稿.md、非必填单行「备注」≤60 字、「以 Word 为准，请先在 Word 里保存」）→ 成功 toast
- [x] 4.3 `DeliveryBar.tsx` 追加「定稿」标签（选中值 `final`）；说明行显示「第 N 次定稿 · MM-DD HH:mm · 来源」；右侧「预览 Word」「与最新一版 / 原稿对比」；不出现批注、去 AI 味、转 Word
- [x] 4.4 `Reader.tsx` 交付稿外壳：选中 `final` 时正文读 `定稿.md`（去 front-matter）、Word 预览用 `final.docx`、批注铅笔置灰并说明；定稿成功后刷新列表并切到「定稿」
- [x] 4.5 颜色只用现有令牌，不用 orange

## 5. 协作文档

- [x] 5.1 AGENTS.md 不变量 1 加第十条（按 design.md D7），「spawn 族」列举里补上第十条；README 交付稿一节补「定稿」

## 6. 验收闸

- [x] 6.1 `pnpm typecheck` 与 `pnpm build` 全绿
- [x] 6.2 重启 `pnpm dev`，在测试工作空间点一遍：从镜像目录定稿、从其他目录定稿、再次定稿（同名）、无交付稿时定稿、取消、令牌过期
- [x] 6.3 版本条：「定稿」标签、说明行、预览 Word 指向最新一份、对比、批注置灰；删掉记录的 docx 后无「预览 Word」
- [x] 6.4 降级：旧模板实例无脚本 400、旧服务进程按钮置灰、无 project.yaml / 目录丢失时不报错、深色模式检查
- [x] 6.5 清理验证过程产生的临时工作空间文件（合成语料不入库，除非按约定接进 scripts）
