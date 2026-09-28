#!/usr/bin/env python3
"""
从一份工作空间模板铺出一个新工作空间。

    python3 templates/init_workspace.py \\
      --from templates/pm-aispace \\
      --name "华电福建AI监管平台" --path ~/projects/huadian

--from 指向某个模板目录（里面要有 template.yaml）。不传时用旁边的 pm-aispace。
新建时只需要名称和路径，元信息里的其它字段先留 null。

新建时会顺带在 .claude/settings.local.json 里写「禁止改看板源码」的权限规则。
给已有工作空间补这条规则（只写这一个文件）：

    python3 templates/init_workspace.py --guard-only --path <工作空间目录>
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


def kanban_root() -> Path | None:
    """
    看板根目录：本脚本所在 templates/ 的上一级（源码仓库或 npm 包目录）。
    用 PMWORK_TEMPLATE_ROOT 把脚本挪到别处时，上一级就不是看板了 —— 按包名认，认不出返回 None。
    """
    root = HERE.parent
    try:
        pkg = json.loads((root / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    name = pkg.get("name", "") if isinstance(pkg, dict) else ""
    return root if name.split("/")[-1] == "aispace-kanban" else None


def permission_path(p: Path, is_dir: bool) -> str:
    """Claude Code 权限规则里的绝对路径写 //<路径>；Windows 盘符写成 /c/... 的形状。"""
    posix = p.as_posix()
    if p.drive:
        posix = "/" + p.drive.rstrip(":").lower() + posix[len(p.drive):]
    return f"Edit(/{posix}/**)" if is_dir else f"Edit(/{posix})"


def guard_rules(src_root: Path) -> list[str]:
    """
    工作空间里的 agent 不许改看板源码（理由见模板 AGENTS.md「看板显示不对时」）。
    Claude Code 里 deny 压过 allow，没法「整个看板 deny、只放行本模板」，
    所以逐个列顶层条目：templates/ 以外全 deny，templates/ 里只留本模板（模板改动回同步源要写它）。
    Edit 规则对 Claude Code 所有内置写文件工具都生效；shell 写法拦不住，主防线仍是 AGENTS.md。
    """
    root = kanban_root()
    if root is None:
        return []
    rules = []
    for item in sorted(root.iterdir()):
        if item.name == "templates":
            for sub in sorted(item.iterdir()):
                if sub.resolve() != src_root:
                    rules.append(permission_path(sub, sub.is_dir()))
        else:
            rules.append(permission_path(item, item.is_dir()))
    return rules


def write_guard(target: Path, src_root: Path) -> int:
    """
    把 guard_rules 合并进 <工作空间>/.claude/settings.local.json 的 permissions.deny，返回新增条数。
    只动这一个文件的这一个字段：已有条目、allow 和其它字段原样保留，重复跑结果一样。
    写 settings.local.json 而不是 settings.json：里面是本机绝对路径，不该入库、不该跟着工作空间搬走。
    """
    rules = guard_rules(src_root)
    if not rules:
        return 0
    path = target / ".claude" / "settings.local.json"
    data: dict = {}
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError(f"{path} 不是 JSON 对象，没有改动它")
    perms = data.setdefault("permissions", {})
    deny = perms.setdefault("deny", [])
    added = [r for r in rules if r not in deny]
    if not added:
        return 0
    deny.extend(added)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return len(added)


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


def guard_only(target: Path, src_root: Path, as_json: bool) -> int:
    """--guard-only：给已有工作空间补规则。用户在命令行手动跑，看板不调用。"""
    if not target.is_dir():
        return fail(f"工作空间目录不存在：{target}", as_json)
    if kanban_root() is None:
        return fail("没找到看板根目录（本脚本要放在看板仓库或 npm 包的 templates/ 下才能用）", as_json)
    try:
        added = write_guard(target, src_root)
    except ValueError as err:
        return fail(str(err), as_json)
    if as_json:
        print(json.dumps({"ok": True, "root": str(target), "guard": added}, ensure_ascii=False))
    else:
        log(f"已补上 {added} 条禁改看板源码的权限规则：{target / '.claude' / 'settings.local.json'}"
            if added else "规则已经齐了，没有改动")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="从一份模板初始化一个新的工作空间")
    ap.add_argument("--from", dest="from_dir", default="", help="模板目录（默认：本目录下的 pm-aispace）")
    ap.add_argument("--name", default="", help="工作空间名称（新建时必填）")
    ap.add_argument("--path", required=True, help="工作空间目录（不存在会创建）")
    ap.add_argument("--force", action="store_true", help="目标目录非空时也继续")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出结果，供程序调用")
    ap.add_argument(
        "--guard-only",
        action="store_true",
        help="只给已有工作空间补上「禁止改看板源码」的权限规则，不复制、不新建其它任何文件",
    )
    args = ap.parse_args()

    src_root = Path(args.from_dir).expanduser().resolve() if args.from_dir else (HERE / "pm-aispace")
    if not src_root.is_dir():
        return fail(f"找不到模板目录：{src_root}", args.json)

    target = Path(args.path).expanduser().resolve()
    if args.guard_only:
        return guard_only(target, src_root, args.json)
    if not args.name:
        return fail("新建工作空间要给 --name", args.json)
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
    try:
        guard = write_guard(target, src_root)
    except (OSError, ValueError) as err:
        # 规则是附加防线，写不成不该让新建失败
        print(f"禁改看板源码的权限规则没写成：{err}", file=sys.stderr)
        guard = 0

    if args.json:
        # 名字里多半有中文；stdout 已在上面强制成 UTF-8，Windows 上不会再炸编码
        print(json.dumps({"ok": True, "root": str(target), "name": args.name, "guard": guard}, ensure_ascii=False))
    else:
        log(f"工作空间已创建：{target}")
        log(f"  名称：{args.name}")
        log(f"  禁改看板源码的权限规则：{guard} 条" if guard else "  没找到看板根目录，未生成禁改看板源码的权限规则")
        ingest = target / "scripts" / "ingest.py"
        if ingest.exists():
            log("\n下一步：把资料放进 input/raw/，然后跑")
            log("  python3 scripts/ingest.py")
        else:
            log("\n下一步：把资料放进 input/raw/，产出写到 output/。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
