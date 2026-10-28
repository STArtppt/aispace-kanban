## 0. 人工拍板(动手前)

- [x] 0.1 用户确认不变量 1 新增第十一条(spawn 族,写入面见 design 决策 4、5),改名留痕(决策 11),预览不列排除项命中

## 1. 工作空间脚本(templates)

- [x] 1.1 新建 `templates/pm-aispace/scripts/rename_output.py`:参数 `--source <相对路径> --to <新基名> (--dry-run | --apply --expect <指纹>) --json`;
      校验 source 在 `output/<三组>/` 下、非 delivery/converted、非符号链接;新基名规则同 design 决策 2
- [x] 1.2 计算改名对:原稿、`.md` 的镜像目录、镜像内与原稿旁的 `<基名>.docx`;冲突退出码 2
- [x] 1.3 扫描与改写:范围与排除按决策 5;根路径 / 镜像前缀 / 相对链接 / wikilink 四类按决策 4;
      交付稿 `v*.md` 只改 front-matter `source`,正文跳过
- [x] 1.4 `source_sha` 跟进(决策 6);记录状态流水追加改名留痕(决策 11)
- [x] 1.5 计划指纹;`--apply` 重算比对,不一致退出码 3
- [x] 1.6 落盘顺序:暂存临时文件 → 改名(失败回退)→ `os.replace`(决策 7)
- [x] 1.7 合成回归语料 + `scripts/check-rename.mjs`(`pnpm test:rename`):建临时工作空间,
      覆盖镜像目录、定稿 `docx:`、记录、批注对象行、问题 `flows_to#锚点`、相对链接、三种 wikilink、
      同名词语不误改、`.claude/` 不动、`v*.md` 正文不动、冲突 409、指纹不符、source_sha 跟进、状态流水留痕(含缺小节补齐)
- [x] 1.8 模板 AGENTS.md 目录说明加「产出改名走看板『重命名』,不要在文件夹里手改」;
      模板 `output/records/README.md` 的 `target` 行补「看板重命名时由脚本跟进并在状态流水留痕」

## 2. 服务端(`src/server/**`,改完重启 `pnpm dev`)

- [x] 2.1 `scan.mjs`:三组所有文件下发 `docKey`;新增 docKey 种类 `output-file`;scan 返回 `canRename`
- [x] 2.2 `http.mjs`:`POST projects/:id/rename/preview` 与 `POST projects/:id/rename`,
      `allowMutations` + `rejectIfForeignOrigin`,`docKey` 反查 + `resolveInside`,新基名先校验再 spawn;
      退出码 2→409/400(按脚本说明区分)、3→409、超时 504,脚本中文说明原样带回
- [x] 2.3 `curl` 验证预览返回形状、非法基名 400、冲突 409

## 3. 契约(`src/app/lib/api.ts`)

- [x] 3.1 `canRename?: boolean`;`RenamePlan` / `RenameResult` 类型;`api.renamePreview` / `api.rename`

## 4. 前端(`src/app/**`)

- [x] 4.1 新建 `components/RenameDialog.tsx`:预填 stem、扩展名后缀、debounce 预览、文件清单可展开(含留痕的记录)、冲突与错误提示
- [x] 4.2 `OutputPanel.tsx` 行菜单「重命名」(归档之上),按 `canRename` 置灰;转换产物列表菜单加置灰项
- [x] 4.3 成功后迁移收藏置顶路径、阅读器跳到新路径

## 5. 文档

- [x] 5.1 AGENTS.md 不变量 1 加第十一条(0.1 批准的版本),第 3 节服务端说明补 rename 入口
- [x] 5.2 `dashboard-feature-flow` / `systematic-debugging` 如有踩坑补一行

## 6. 验收闸

- [x] 6.1 `pnpm typecheck` 绿、`pnpm build` 绿、`pnpm test:rename` 绿
- [x] 6.2 重启 `pnpm dev`,`curl -s localhost:7788/api/health`
- [x] 6.3 浏览器:在模板示例工作空间(或合成工作空间)对带交付稿的原稿改名,确认交付稿、定稿、批注、记录都跟过去;
      再改回原名;子目录项、已归档项、非 `.md` 项各改一次;转换产物菜单置灰
- [x] 6.4 降级:无 `project.yaml` 的工作空间、目录丢失的工作空间、删掉脚本后的置灰提示、深色模式
