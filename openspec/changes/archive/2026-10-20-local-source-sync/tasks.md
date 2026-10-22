## 1. 服务端：判定与启动配置

- [x] 1.1 在 `src/server/config.mjs` 判定安装根有没有 `src/app`，导出 `LAUNCH`（`source` / `package`）与 `REPO_ROOT`（npm 包为空串）。npm 包路径下不得判成源码
- [x] 1.2 `writeRuntimeInfo` 的调用处增加 `launch`、`repoRoot`、`instances`。源码时 `instances` 来自当前注册表的 `id` / `name` / `root`；npm 包时 `repoRoot` 为空串、`instances` 为空数组。写失败不阻止启动。保留 `anydocBin` / `node` / `version`
- [x] 1.3 `writeProjects` 成功后，若 `LAUNCH === 'source'`，读回 `runtime.json`、只替换 `instances` 与 `updatedAt` 再写回；读不到就跳过。写失败吞掉
- [x] 1.4 `GET /api/health` 增加可选 `launch`，响应里不带任何绝对路径
- [x] 1.5 核对：服务端没有新增任何对工作空间的写入（`grep` 新增代码里的 `writeFile` / `rename` / `appendFile`，落点只能是 `CONFIG_DIR`）

## 2. 契约与反馈页

- [x] 2.1 `src/app/lib/api.ts` 的 `Health` 增加可选 `launch?: 'source' | 'package'`。缺字段时调用方保持改动前的行为
- [x] 2.2 反馈单详情在 `launch === 'source'` 时说明：单子留在工作空间、源码侧可以直接读、不必发邮件，也不必点「我已发出」，回执回来后由工作空间智能体改状态。「邮件发送」和 `mailto:` 保持可用。`package` 或缺字段时不出现这段说明。颜色只用现有令牌，不用 orange
- [x] 2.3 `templates/help.md` 的反馈单一节补一句：源码启动时页面会说明不必发邮件，npm 安装仍走邮件

## 3. 模板脚本

- [x] 3.1 `templates/pm-aispace/scripts/template_update.py`：`--ref` 缺省改为 `None`，下载处仍按 `main` 兜底
- [x] 3.2 读 `~/.pmwork/dashboard/runtime.json`（与 `anydoc.py` 同一位置），按 design D4 三条判定本机来源；只在既无 `--from` 也无 `--ref` 时生效。`launch` 为 `source` 但后两条不成立时，stderr 说明哪条不满足再走 GitHub。读不到或没有 `launch` 按 npm 包
- [x] 3.3 `local_source()` 改为带提交号：`local:<目录名>@<提交号>`，有未提交改动加 `+dirty`，并在计划 warnings 里加一条说明。找不到 `git` 或不在仓库里退回 `local:<目录名>`。只用标准库 `subprocess`
- [x] 3.4 `compare`：无 `--base-from` / `--base-ref`、lock 来源为 `local:<目录名>@<提交号>`、且本机条件成立时，用 `git -C <repoRoot> show <提交号>:templates/<模板 id>/<相对路径>` 取冲突文件基线到临时目录；取不到回到原有 warning。`+dirty` 基线哈希对不上按 `inexact`
- [x] 3.5 只 import Python 标准库；脚本顶部「用法」说明补上本机来源的缺省行为

## 4. 模板：工作空间侧约定

- [x] 4.1 `pm-template-update`：本机条件成立时不带参数 `plan`，向用户说明来源是本机源码；计划带 `+dirty` warning 时照实转述；不自己搜索看板仓库；确认前不 `apply`
- [x] 4.2 模板 `AGENTS.md`：缺省仍读 GitHub、仍禁止写看板仓库；写明只有本机条件成立时，脚本可以读本机模板目录，核对正在跑的看板可以读那份源码。文档中的源码位置继续用 GitHub 链接。贡献改进一节说明源码启动时不必发邮件
- [x] 4.3 核对：模板 `.gitignore` 与 `template.yaml` 的 `seedOnly` 都不改

## 5. 源码仓库侧技能与协作约定

- [x] 5.1 新增 `.claude/skills/local-source-sync/SKILL.md`，并在根目录 `AGENTS.md` 第 7 节技能表登记。内容覆盖：非 `source` 时本技能不适用；从 `runtime.json` 的 `instances` 找实例，不在磁盘另找；用实例自己的 `template_update.py` 加显式 `--from` 出计划，确认后 `apply`；不跑 `--resolved`，冲突与 seedOnly 新版交回工作空间智能体；不跑源码仓库里那份脚本；直接读实例 `output/feedback/`，回执交给用户，不写反馈单
- [x] 5.2 根目录 `AGENTS.md` 第 6.2 节：补上 `launch` 为 `source` 时直接读已登记实例里的反馈单；把「这边不写任何工作空间文件」改成写明唯一例外——用户确认后运行实例自己的 `template_update.py apply`（不带 `--resolved`）。不变量 1 不新增条目。不把这些复制进 `CLAUDE.md`

## 6. 文档

- [x] 6.1 `README.md`「用法」：源码启动与 npx 并列，源码标为长期使用的推荐方式，各写一句适用场景与差别（本机更新模板、反馈不必发邮件、能直接提改进）
- [x] 6.2 `README.md`「从源码跑」：补前置（Node ≥ 20、git、`corepack enable`）、`git clone` 到起服务的完整步骤、拉新版（`git pull` → `pnpm install` → `pnpm build` → 重启）、源码启动后实例怎么更新模板（第一跳 `--from`，之后实例侧说「更新模板」即可）
- [x] 6.3 `README.md`「改代码前」：改为指向 `CONTRIBUTING.md`，保留 `AGENTS.md` 与路线图链接
- [x] 6.4 新增 `CONTRIBUTING.md`，按 design D10 的七项写；规则只链接 `AGENTS.md` 对应小节，不复制条文；不出现本机路径和真实客户名
- [x] 6.5 根目录 `AGENTS.md` 开头补一句人类贡献者的入口在 `CONTRIBUTING.md`
- [x] 6.6 `scripts/build-npm-package.mjs` 生成的 npm 包 README 加一句指向仓库源码启动说明，主线仍是 npx
- [x] 6.7 核对 README 与 `CONTRIBUTING.md` 里的相对链接都能点开（`AGENTS.md` 小节锚点、技能目录、`templates/pm-aispace/AGENTS.md`）

## 7. 回归

- [x] 7.1 `scripts/check-template-update.mjs` 增加（用临时 HOME 放假的 `runtime.json`，不碰真实配置目录）：
  - 本机条件成立时 `plan` 不联网，来源为 `local:<目录名>@<提交号>`（临时 git 仓库）
  - 模板目录有未提交改动时来源带 `+dirty`，计划有对应 warning
  - `launch` 为 `package`、或本工作空间不在 `instances` 里时，不读本机目录
  - 显式 `--from` / `--ref` 优先
  - lock 来源带提交号时 `compare` 能取回基线（`base` 为 `exact`）
  - 已有断言 `local:tpl-v1` / `local:tpl-v2` 按新来源串更新（非 git 目录仍是旧形态）
  
  跑 `pnpm test:template-update`
- [x] 7.2 `scripts/smoke-package.mjs` 确认打包后的服务 `/api/health` 的 `launch` 为 `package`，包内 README 含指向源码启动的那一句

## 8. 验收闸

- [x] 8.1 `pnpm typecheck`
- [x] 8.2 `pnpm build`
- [x] 8.3 重启 `pnpm dev`。`curl -s localhost:7788/api/health` 看到 `launch` 为 `source`，正文没有绝对路径。`runtime.json` 有 `launch` / `repoRoot` / `instances`。在看板上登记、移出一个工作空间后，`instances` 随之变化。已登记工作空间的 `git status` 无变化
- [x] 8.4 浏览器打开反馈单：源码模式下能看到不必发邮件的说明，邮件预览仍能打开。再看无 `project.yaml` 的工作空间、目录丢失的工作空间，以及深色模式下这段说明仍可读、页面不白屏
