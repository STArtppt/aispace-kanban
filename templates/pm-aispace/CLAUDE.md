# 产品经理AI空间

本工作空间的完整约定写在 [`AGENTS.md`](AGENTS.md)，对所有 Agent 通用。
**开始工作前先读它**（下面这行会自动引入）：

@AGENTS.md

Claude Code 专有的两点：

- `.claude/skills/` 下的技能会被自动发现并按需触发，不用手动读 SKILL.md。
  根目录 `skills/` 是指向同一位置的软链接，供不支持自动发现的 Agent 使用。
- `.claude/settings.json` 已预授权 `scripts/ingest.py`、`pandoc`、`markitdown` 等命令，
  减少权限确认弹窗。
