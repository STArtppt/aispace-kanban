# CLAUDE.md

本项目的协作事实源是 **[AGENTS.md](./AGENTS.md)** —— 请先完整读它,
其中有项目定位、**只读不变量**、技术栈、三个平面的目录结构、命令与验证闸、编码规范总则。
**这些内容不在本文件重复**,以免两份文档漂移。

## Claude Code 专属补充

- **非平凡改动先立 change**:跨平面、动 `api.ts` 契约、引新依赖、要做取舍的,
  先 `/opsx:propose`,产物落 `openspec/changes/`。琐碎改动直接做。
  **本仓已开源,规划产物随代码公开** —— 脱敏红线见 AGENTS.md 第 6.1 节。
- **工程平面技能在 `.claude/skills/`**(只此一份,无 `.agents/` 镜像)。
  接到任务先读对应技能;**加/改功能一律先读 `dashboard-feature-flow`**;缺失处顺手补全。
- **改完必须**:`pnpm typecheck` + `pnpm build` 都绿。
  另外 `src/server/**` 与 `bin/cli.mjs` **没有任何静态检查**,改了必须重启 `pnpm serve` / `pnpm dev`
  并在浏览器点一遍受影响视图 —— 光看类型检查过了不算做完。
- **红线**:看板对工作空间**只读**;工作空间内路径必须过 `resolveInside()`。
- **配色**:黑白灰为主,orange(`--destructive`)只用于"需要注意";令牌只写在
  `src/app/styles/globals.css`,组件里不硬编码色值。

> 修改协作约定 / 项目说明时,改 **AGENTS.md**,不要改本文件。
