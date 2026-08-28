#!/usr/bin/env python3
"""
从一份工作空间模板铺出一个新工作空间。

    python3 templates/init_workspace.py \\
      --from templates/pm-aispace \\
      --name "华电福建AI监管平台" --path ~/projects/huadian

--from 指向某个模板目录（里面要有 template.yaml）。不传时用旁边的 pm-aispace。
新建时只需要名称和路径，元信息里的其它字段先留 null。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import sys
from pathlib import Path

# Windows 上 stdout / stderr 默认跟着系统 locale 走（如 cp1252），输出中文会直接
# UnicodeEncodeError。看板和冒烟脚本都按 UTF-8 读子进程输出，这里统一改成 UTF-8。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent

# 骨架要带过去的东西：约定、技能、脚本。资料和产出一律不带。
# skills 不在这里 —— 它是 .claude/skills 的别名，由 link_skills() 单独建，理由见那里。
# template.yaml 是给看板发现模板用的，不铺进工作空间。
COPY_ENTRIES = ["AGENTS.md", "CLAUDE.md", "README.md", ".gitignore", ".env.example", "scripts", ".claude"]

# 基本目录（及 input 下的约定子目录）缺了就建。output 的子目录跟模板走，
# 不在这里写死 analysis/docs/decisions —— 那是 PM 模板自己的阶段。
# visualization/ 是视觉平面：references/ 放收下来的别人的页面，prototypes/ 放工具产出的原型。
# 它和 input/ output/ 的差别在于这边是给人看、能点开的页面，不是要转换的文档。
BASE_DIRS = [
    "input/raw",
    "input/converted",
    "input/assets",
    "output",
    "visualization/references",
    "visualization/prototypes",
    "scripts",
]


def log(msg: str) -> None:
    print(msg, flush=True)


def fail(msg: str, as_json: bool) -> int:
    print(json.dumps({"ok": False, "error": msg}) if as_json else f"出错了：{msg}", file=sys.stderr)
    return 1


def copy_entry(src_root: Path, name: str, target: Path) -> None:
    src = src_root / name
    if name == ".gitignore" and not src.exists():
        # 模板被打进 npm 包时 .gitignore 会被 npm 无条件剔除（不管 files 怎么写），
        # 所以包里另存了一份 gitignore（无点）。两边都找一下，找不到就算了。
        src = src_root / "gitignore"
    if not src.exists():
        return
    dst = target / name
    if src.is_dir():
        shutil.copytree(src, dst, dirs_exist_ok=True, symlinks=True)
    else:
        shutil.copy2(src, dst)


def copy_output(src_root: Path, target: Path) -> None:
    """拷模板的 output/ 结构（README、空子目录），不把示例文档带过去。"""
    src = src_root / "output"
    if not src.is_dir():
        return
    dst = target / "output"
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        if item.name in {".DS_Store", "__pycache__"}:
            continue
        dest = dst / item.name
        if item.is_dir():
            shutil.copytree(item, dest, dirs_exist_ok=True, symlinks=True)
        else:
            shutil.copy2(item, dest)


def copy_input_readme(src_root: Path, target: Path) -> None:
    src = src_root / "input" / "README.md"
    if src.exists():
        (target / "input").mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target / "input" / "README.md")


def link_skills(target: Path) -> None:
    """
    建 skills/ —— .claude/skills 的别名。AGENTS.md 里的技能链接都写的 skills/<名字>/，
    少了它非 Claude 的 agent 就找不到技能。

    不从模板里复制那条软链接，而是在目标目录现建一条**相对**链接：
      - 模板里那条是绝对路径，复制过去会指回模板所在的机器；
      - npm 打包会把软链接整个丢掉，包里根本没有它。
    Windows 上没开开发者模式建不了软链接，退化成复制一份实体目录（内容一样，只是不会跟着变）。
    """
    real = target / ".claude" / "skills"
    if not real.is_dir():
        return
    dst = target / "skills"
    if dst.is_symlink() or dst.exists():
        return
    try:
        dst.symlink_to(Path(".claude") / "skills", target_is_directory=True)
    except OSError:
        shutil.copytree(real, dst, dirs_exist_ok=True)


def ensure_skill_creator(target: Path) -> None:
    """用户自建模板漏掉 skill-creator 时，从内置 PM 模板补一份。"""
    dest = target / ".claude" / "skills" / "skill-creator"
    if dest.exists():
        return
    src = HERE / "pm-aispace" / ".claude" / "skills" / "skill-creator"
    if not src.is_dir():
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dest)


def render_project_yaml(src_root: Path, name: str) -> str:
    """拿模板自己的 project.yaml 当骨架，只替换 workspace 段。没有这份文件就写最小骨架。"""
    today = dt.date.today().isoformat()
    src = src_root / "project.yaml"
    if not src.exists():
        return f"workspace:\n  name: {name}\n  created_at: {today}\n"
    text = src.read_text(encoding="utf-8")
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
    ap = argparse.ArgumentParser(description="从一份模板初始化一个新的工作空间")
    ap.add_argument("--from", dest="from_dir", default="", help="模板目录（默认：本目录下的 pm-aispace）")
    ap.add_argument("--name", required=True, help="工作空间名称")
    ap.add_argument("--path", required=True, help="工作空间目录（不存在会创建）")
    ap.add_argument("--force", action="store_true", help="目标目录非空时也继续")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出结果，供程序调用")
    args = ap.parse_args()

    src_root = Path(args.from_dir).expanduser().resolve() if args.from_dir else (HERE / "pm-aispace")
    if not src_root.is_dir():
        return fail(f"找不到模板目录：{src_root}", args.json)

    target = Path(args.path).expanduser().resolve()
    if target.exists() and any(target.iterdir()) and not args.force:
        return fail(f"目录非空：{target}（要在已有目录上初始化请加 --force）", args.json)

    target.mkdir(parents=True, exist_ok=True)
    for name in COPY_ENTRIES:
        copy_entry(src_root, name, target)
    copy_output(src_root, target)
    copy_input_readme(src_root, target)
    ensure_skill_creator(target)
    link_skills(target)
    for rel in BASE_DIRS:
        d = target / rel
        d.mkdir(parents=True, exist_ok=True)
        keep = d / ".gitkeep"
        if not any(d.iterdir()):
            keep.touch()
    # .ingestignore 是约定文件不是示例资料，要铺过去；input/ 其它内容一律不带
    ignore_src = src_root / "input" / ".ingestignore"
    if ignore_src.exists():
        shutil.copy2(ignore_src, target / "input" / ".ingestignore")

    (target / "project.yaml").write_text(render_project_yaml(src_root, args.name), encoding="utf-8")

    if args.json:
        # 名字里多半有中文；stdout 已在上面强制成 UTF-8，Windows 上不会再炸编码
        print(json.dumps({"ok": True, "root": str(target), "name": args.name}, ensure_ascii=False))
    else:
        log(f"工作空间已创建：{target}")
        log(f"  名称：{args.name}")
        ingest = target / "scripts" / "ingest.py"
        if ingest.exists():
            log("\n下一步：把资料放进 input/raw/，然后跑")
            log("  python3 scripts/ingest.py")
        else:
            log("\n下一步：把资料放进 input/raw/，产出写到 output/。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
