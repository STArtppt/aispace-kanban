## 0. 人工拍板(动手前)

- [x] 0.1 用户确认不变量 1 新增第十二条(spawn 族，每次只新建一个 `.md`,写入面见 proposal「需要人拍板」一段和 design 决策 4–8)
- [x] 0.2 确认通过后改 AGENTS.md:第十二条正文、spawn 族列表补「十二」、第十一条末尾的「转换产物不提供改名(菜单置灰说明)」改成「转换产物不提供改名;想基于它继续写用第十二条复制」

## 1. 工作空间脚本(templates)

- [x] 1.1 新建 `templates/pm-aispace/scripts/copy_converted.py`:参数 `--source <相对路径> --to <analysis|decisions|docs> (--dry-run | --apply) --json`;
      转换产物根复用 `layout.py`;校验 source 在根内、是 `.md`、不是符号链接、不是摘要、不在 `SplittingObject/` `MergedObject/` `_sources/` 下(决策 3)
- [x] 1.2 算落点(决策 4);冲突时退出码 2,并给出路径
- [x] 1.3 链接重算(决策 5),front-matter 追加 `copied_from` / `copied_at`(决策 6)
- [x] 1.4 落盘：同目录临时文件 + `os.link`,不覆盖;失败时只回收本次的临时文件和新建的空目录(决策 8)
- [x] 1.5 合成回归语料 `fixtures/converted-copy/` + `scripts/check-converted-copy.mjs`(`pnpm test:converted-copy`):
      覆盖子目录、assets 图片链接重算、外链 / 锚点不改、无 front-matter 新建、冲突退出码 2、摘要与 SplittingObject 来源被拒、converted 字节不变
- [x] 1.6 模板 AGENTS.md 加一句"基于转换产物继续写用看板『复制到…』,不要直接改 converted"

## 2. 服务端(`src/server/**`,改完重启 `pnpm dev`)

- [x] 2.1 `scan.mjs`:scan 返回 `canCopyConverted`(看工作空间里有没有 `scripts/copy_converted.py`);docKey 沿用 `converted-md`;
      确认 `.` 开头的临时文件不会出现在产出列表里
- [x] 2.2 `http.mjs`:`POST projects/:id/converted-copy/preview` 与 `POST projects/:id/converted-copy`,
      `allowMutations` + `rejectIfForeignOrigin`,只收 `{ docKey, group }`,多余字段 400,用 `converted-md` 反查 + `resolveInside` 后 spawn;
      退出码 1→400、2→409,超时 504,脚本的中文说明原样带回
- [x] 2.3 重启 `pnpm dev`,用 `curl` 验证：预览返回形状、非法组名 400、拿产出 docKey 请求 400、冲突 409

## 3. 契约(`src/app/lib/api.ts`)

- [x] 3.1 `canCopyConverted?`、`ConvertedCopyPlan` / `ConvertedCopyResult`、`api.convertedCopyPreview` / `api.convertedCopy`

## 4. 前端(`src/app/**`)

- [x] 4.1 `ConvertedList.tsx`:删除置灰的「重命名」;只有带 `docKey` 的条目加「复制到…」,没脚本 / 旧服务两种情况置灰并各给一句提示
- [x] 4.2 新建 `components/ConvertedCopyDialog.tsx`:三选一，选中后调预览，显示落点、要重算的链接数、冲突;确定后执行
- [x] 4.3 成功后提示落点，切到目标组，阅读器打开入口文件

## 5. 文档

- [x] 5.1 `systematic-debugging` 分诊清单补一条"复制到…置灰：看 canCopyConverted / 重启服务 / 更新模板"

## 6. 验收闸

- [x] 6.1 `pnpm typecheck` + `pnpm build` 都通过;`pnpm test:converted-copy` 通过
- [x] 6.2 重启 `pnpm dev`,在浏览器里把带图片的 `.md` 产物分别复制到三组，打开复制件，确认图片正常、converted 列表不变;
      确认 `.csv` / 目录型产物的菜单里没有「复制到…」,也没有「重命名」
- [x] 6.3 降级：模板没有脚本的工作空间(置灰)、旧服务进程(置灰并提示重启)、无 `project.yaml`、深色模式下弹窗
