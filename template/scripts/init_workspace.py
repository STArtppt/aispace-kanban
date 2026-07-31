#!/usr/bin/env python3
"""
从本模板初始化一个新的项目接手工作空间。

    python3 scripts/init_workspace.py --name "华电福建AI监管平台" --path ~/projects/huadian

新建时只需要名称和路径，元信息里的其它字段先留 null，
等合同 / 招标技术文件 / 立项文件进来之后，由 pm-project-meta 技能增量补全。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import sys
from pathlib import Path

TEMPLATE = Path(__file__).resolve().parent.parent

# 骨架要带过去的东西：约定、技能、脚本。资料和产出一律不带。
COPY_ENTRIES = ["AGENTS.md", "CLAUDE.md", "README.md", ".gitignore", ".env.example", "scripts", ".claude", "skills"]
EMPTY_DIRS = [
    "input/raw",
    "input/converted",
    "input/assets",
    "output/analysis",
    "output/docs",
    "output/decisions",
    "prototypes",
]


def log(msg: str) -> None:
    print(msg, flush=True)


def copy_entry(name: str, target: Path) -> None:
    src = TEMPLATE / name
    if not src.exists():
        return
    dst = target / name
    if src.is_symlink():
        # skills 是指向 .claude/skills 的软链接，照原样复制链接本身
        link = src.readlink()
        if dst.exists() or dst.is_symlink():
            dst.unlink()
        dst.symlink_to(link)
    elif src.is_dir():
        shutil.copytree(src, dst, dirs_exist_ok=True, symlinks=True)
    else:
        shutil.copy2(src, dst)


def render_project_yaml(name: str) -> str:
    """拿模板自己的 project.yaml 当骨架，只替换 workspace 段。"""
    text = (TEMPLATE / "project.yaml").read_text(encoding="utf-8")
    today = dt.date.today().isoformat()
    lines = []
    for line in text.split("\n"):
        if line.startswith("  name:"):
            lines.append(f"  name: {name}")
        elif line.startswith("  created_at:"):
            lines.append(f"  created_at: {today}")
        else:
            lines.append(line)
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="初始化一个新的项目接手工作空间")
    ap.add_argument("--name", required=True, help="工作空间名称")
    ap.add_argument("--path", required=True, help="工作空间目录（不存在会创建）")
    ap.add_argument("--force", action="store_true", help="目标目录非空时也继续")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出结果，供程序调用")
    args = ap.parse_args()

    target = Path(args.path).expanduser().resolve()
    if target.exists() and any(target.iterdir()) and not args.force:
        msg = f"目录非空：{target}（要在已有目录上初始化请加 --force）"
        print(json.dumps({"ok": False, "error": msg}) if args.json else f"出错了：{msg}", file=sys.stderr)
        return 1

    target.mkdir(parents=True, exist_ok=True)
    for name in COPY_ENTRIES:
        copy_entry(name, target)
    for rel in EMPTY_DIRS:
        d = target / rel
        d.mkdir(parents=True, exist_ok=True)
        (d / ".gitkeep").touch()

    (target / "project.yaml").write_text(render_project_yaml(args.name), encoding="utf-8")

    if args.json:
        print(json.dumps({"ok": True, "root": str(target), "name": args.name}, ensure_ascii=False))
    else:
        log(f"工作空间已创建：{target}")
        log(f"  名称：{args.name}")
        log("\n下一步：把合同 / 招标技术文件 / 立项文件放进 input/raw/，然后跑")
        log("  python3 scripts/ingest.py")
        log("转换完成后让 AI 提取项目元信息，它会把 project.yaml 补起来。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
