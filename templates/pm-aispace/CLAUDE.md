# 产品经理AI空间

本工作空间的完整约定写在 [`AGENTS.md`](AGENTS.md)，对所有 Agent 通用。
**开始工作前先读它**（下面这行会自动引入）：

@AGENTS.md

本项目专有的约定（不随模板分发，没有这个文件时这一行什么也不做）：

@AGENTS.local.md

Claude Code 专有的几点：

- `.claude/skills/` 下的技能会被自动发现并按需触发，不用手动读 SKILL.md。
  根目录 `skills/` 是指向同一位置的软链接，供不支持自动发现的 Agent 使用。
- `.claude/settings.json` 已预授权 `scripts/ingest.py`、`markitdown` 等命令，
  减少权限确认弹窗。
- `.claude/settings.local.json`（不入库）由新建工作空间的脚本生成，里面的 `deny` 禁止改看板仓库的任何文件，
  `templates/` 也在内。别删这些条目；看板有缺陷写缺陷单，有可推广的改进写贡献单，
  见 AGENTS.md「看板显示不对时」「贡献改进」（文件在 `output/feedback/F<编号>.md`，不再用根目录的 `.kanban-feedback/`）。
