## 1. 工作空间模板（templates/pm-aispace）

- [x] 1.1 `scripts/md2docx.py`：加 `PLACEMENT = "delivery-mirror"` 与 `mirror_target(md)`（四类来源规则），按需建目录；输入来源落点不在 `output/delivery/converted/` 下时退出 2；更新文件头帮助与 argparse 描述
- [x] 1.2 合成回归语料：补落点断言（原稿 → 镜像、交付稿 → 同目录、输入 → `output/delivery/converted/`、其他 → 旁边），接进现有 scripts 校验
- [x] 1.3 `output/delivery/README.md`、模板 `AGENTS.md`：目录说明加 `<基名>.docx` 与 `input/` 镜像子目录

## 2. 服务端（src/server，改完重启 pnpm dev）

- [x] 2.1 `scan.mjs`：`docxTargetOf(rel)` 落点规则（与 1.1 同一规则）；`DOC_KEY_KINDS` 加 `converted-md`；`describeConverted` 给单文件 `.md` 挂 `docKey`
- [x] 2.2 `docxTools.mjs`：`resolveDoc` 依次反查三类；预检改用 `docxTargetOf`；旧脚本检测加 `delivery-mirror`，所有来源 400 `old-script`
- [x] 2.3 `deai.mjs` `listDelivery`：产出原稿 `sourceDocx` 镜像优先、旧位置兜底；认 `converted-md` 键返回 `sourceKind: 'input'` 的 Word-only 列表
- [x] 2.4 AGENTS.md 不变量 1 第九条 ④⑤ 改写

## 3. 契约（src/app/lib/api.ts）

- [x] 3.1 输入条目可选 `docKey` 注释更新；交付稿列表加可选 `sourceKind?: 'output' | 'input'`；`docxConvert` 注释改为镜像落点

## 4. 前端

- [x] 4.1 落点工具函数（与 `deliveryDirOf` 并列）供弹窗显示目标
- [x] 4.2 `Reader.tsx`：输入转换产物带 `docKey` 时请求交付稿列表，`sourceKind === 'input'` 渲染 Word-only 栏；接口 400 时不显示
- [x] 4.3 `DeliveryBar.tsx`：Word-only 形态（无版本、去 AI 味、对比、定稿；说明行写成品目录）；保留工作区里未提交的「复制路径」改动
- [x] 4.4 `DocxExportDialog.tsx` 与产出列表「更多 → 转成 Word」：目标文件、toast 预览按结果 `target`；复制提示词补落点说明

## 5. 同步与验收

- [x] 5.1 `pnpm typecheck`、`pnpm build` 全绿
- [x] 5.2 重启 `pnpm dev`；curl 交付稿列表（产出键 / 输入键）与转换接口，确认返回与落点
- [x] 5.3 浏览器：找一份单文件输入转换产物在预览里转 Word，`input/` 无新文件；产出原稿转 Word 落镜像；只有旧成品时预览旧的；深色模式；工作空间丢失与无 project.yaml 的工作空间各点一遍
- [x] 5.4 `local-source-sync` 推模板到已登记实例（有实例专有约定的对照其 `AGENTS.local.md`）
