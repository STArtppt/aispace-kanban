#!/usr/bin/env python3
"""把存量手写 Markdown 迁到 AGENTS.md「Markdown 写法」那一节的子集。

契约在 [`AGENTS.md`](../AGENTS.md) 的「Markdown 写法」一节。**契约变了这里要跟着变。**

这个脚本**只做两件机械的事，不推断**
----------------------------------
1. 给 `output/analysis/` 与 `output/decisions/` 补齐缺失的 front-matter 字段
   （`title` / `created` / `updated`）。标题从已有 H1 或文件名抄，日期从文件 mtime 抄。
2. 把裸文件名引用（`` `foo.md` ``、`[文本](foo.md)`）改写成相对路径链接。
   同名匹配到多份时跳过并列进「需人工处理」清单，**不猜目标**。

明确不做
--------
- **不改正文措辞** —— 那是人的事。
- **不调标题层级** —— 多个 H1、跳级这些要人看过再改，脚本猜错比不做更糟。
- **不碰** `input/converted/` 与 `input/raw/`。
- **不改** `output/questions/` 的字段（那是 `migrate_questions.py` / 字段契约的事）；
  那里的裸文件名引用仍会改。
- **不给** `output/docs/` 和各目录 `README.md` 强加 front-matter
  （对外文档的 YAML 头对收件人是噪音）。

用法
----
    python3 scripts/migrate_markdown.py              # 预演，不落盘（默认）
    python3 scripts/migrate_markdown.py --write      # 确认后落盘

落盘走「先写临时文件再原子替换」，中断不留半截文件。
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from layout import md_link, rel_path  # noqa: E402
from questions_fm import is_blank, parse_frontmatter  # noqa: E402

HERE = Path(__file__).resolve().parent
WS = HERE.parent
DEFAULT_DIR = WS / "output"

SKIP_DIRS = {".git", "node_modules", ".claude", ".agents", "__pycache__", "dist"}
SKIP_PARTS = {"input/converted", "input/raw"}

BARE_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^/#)\s]+\.md)\)")
BARE_TICK_RE = re.compile(r"`([^`/#]+\.md)`")
H1_RE = re.compile(r"^#\s+(\S.*)$", re.M)
FENCE_RE = re.compile(r"^(\s*)(`{3,}|~{3,})")


def _resolve_inside(root: Path, target: Path) -> Path | None:
    try:
        resolved = target.resolve()
        resolved.relative_to(root.resolve())
        return resolved
    except ValueError:
        return None


def _under_skipped(path: Path) -> bool:
    posix = path.as_posix()
    return any(f"/{part}/" in f"/{posix}/" or posix.startswith(part + "/") for part in SKIP_PARTS)


def needs_frontmatter(path: Path) -> bool:
    try:
        rel = path.resolve().relative_to(DEFAULT_DIR.resolve())
    except ValueError:
        return False
    if path.name.lower() == "readme.md":
        return False
    if not rel.parts:
        return False
    if rel.parts[0] in {"docs", "questions"}:
        return False
    return rel.parts[0] in {"analysis", "decisions"}


def scan_output(directory: Path) -> list[Path]:
    files = []
    for path in sorted(directory.rglob("*.md")):
        if not path.is_file() or _under_skipped(path):
            continue
        files.append(path)
    return files


def build_name_index() -> dict[str, list[Path]]:
    """工作空间内所有 .md 的文件名 → 路径列表。用来解析裸文件名。"""
    index: dict[str, list[Path]] = {}
    for path in WS.rglob("*.md"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        index.setdefault(path.name, []).append(path)
    return index


def first_h1(body: str) -> str:
    in_fence = False
    fence_mark = ""
    for line in body.split("\n"):
        fence = FENCE_RE.match(line)
        if fence:
            mark = fence.group(2)[0]
            token = mark * len(fence.group(2))
            if not in_fence:
                in_fence = True
                fence_mark = token
                continue
            if line.strip().startswith(fence_mark):
                in_fence = False
                fence_mark = ""
            continue
        if in_fence:
            continue
        m = H1_RE.match(line)
        if m:
            return m.group(1).strip()
    return ""


def file_date(path: Path) -> str:
    try:
        return dt.date.fromtimestamp(path.stat().st_mtime).isoformat()
    except OSError:
        return dt.date.today().isoformat()


def dump_frontmatter(meta: dict[str, object]) -> str:
    lines = ["---"]
    for key, value in meta.items():
        if isinstance(value, list):
            lines.append(f"{key}:")
            lines.extend(f"  - {item}" for item in value)
        elif value is None or value == "":
            lines.append(f"{key}:")
        else:
            lines.append(f"{key}: {value}")
    lines += ["---", ""]
    return "\n".join(lines)


def fill_frontmatter(path: Path, text: str) -> tuple[str, list[str]]:
    """补齐缺失字段。不需要 front-matter 的文件原样返回。"""
    notes: list[str] = []
    if not needs_frontmatter(path):
        return text, notes
    meta, body, raw = parse_frontmatter(text)
    # 保留原有字段顺序，只补缺的。
    ordered: dict[str, object] = {}
    if raw:
        # 按原 raw 的键顺序走一遍
        for line in raw.split("\n"):
            m = re.match(r"^([\w.-]+):", line)
            if m and m.group(1) not in ordered:
                ordered[m.group(1)] = meta.get(m.group(1), "")
        for key, value in meta.items():
            ordered.setdefault(key, value)
    title = first_h1(body) or path.stem
    today = file_date(path)
    if "title" not in ordered or is_blank(ordered.get("title")):
        ordered["title"] = title
        notes.append(f"补 `title: {title}`")
    if "created" not in ordered or is_blank(ordered.get("created")):
        ordered["created"] = today
        notes.append(f"补 `created: {today}`")
    if "updated" not in ordered or is_blank(ordered.get("updated")):
        ordered["updated"] = today
        notes.append(f"补 `updated: {today}`")
    # 把三个最小字段放到最前，其余保持原顺序。
    preferred = ["title", "created", "updated"]
    final: dict[str, object] = {}
    for key in preferred:
        if key in ordered:
            final[key] = ordered[key]
    for key, value in ordered.items():
        final.setdefault(key, value)
    new_text = dump_frontmatter(final) + body
    if not notes:
        return text, notes
    return new_text, notes


def rewrite_bare_refs(
    path: Path,
    text: str,
    index: dict[str, list[Path]],
    manual: list[str],
) -> tuple[str, list[str]]:
    notes: list[str] = []

    def pick(name: str) -> Path | None:
        hits = [p for p in index.get(name, []) if p.resolve() != path.resolve()]
        # 自己链到自己没有意义；同名只剩一份才自动改。
        unique = []
        seen = set()
        for p in hits:
            key = str(p.resolve())
            if key in seen:
                continue
            seen.add(key)
            unique.append(p)
        if len(unique) == 1:
            return unique[0]
        if len(unique) > 1:
            shown = ", ".join(p.relative_to(WS).as_posix() for p in unique[:5])
            extra = f" …另 {len(unique) - 5} 份" if len(unique) > 5 else ""
            manual.append(f"{path.relative_to(WS).as_posix()} 里的 `{name}` 匹配到多份：{shown}{extra}")
        return None

    def to_link(name: str, label: str) -> str | None:
        target = pick(name)
        if target is None:
            return None
        rel = rel_path(target, path.parent)
        return f"[{label}]({md_link(rel)})"

    def sub_link(m: re.Match[str]) -> str:
        label, href = m.group(1), m.group(2)
        if "/" in href or href.startswith("#"):
            return m.group(0)
        name = Path(href).name
        replacement = to_link(name, label)
        if replacement is None:
            return m.group(0)
        notes.append(f"`[{label}]({href})` → `{replacement}`")
        return replacement

    def sub_tick(m: re.Match[str]) -> str:
        name = m.group(1)
        replacement = to_link(name, name)
        if replacement is None:
            return m.group(0)
        notes.append(f"`{name}` → `{replacement}`")
        return replacement

    # 围栏代码块里的裸文件名不改 —— 那是示例，不是引用。
    out: list[str] = []
    in_fence = False
    fence_mark = ""
    for line in text.split("\n"):
        fence = FENCE_RE.match(line)
        if fence:
            mark = fence.group(2)[0]
            token = mark * len(fence.group(2))
            if not in_fence:
                in_fence = True
                fence_mark = token
                out.append(line)
                continue
            if line.strip().startswith(fence_mark):
                in_fence = False
                fence_mark = ""
            out.append(line)
            continue
        if in_fence:
            out.append(line)
            continue
        line = BARE_LINK_RE.sub(sub_link, line)
        line = BARE_TICK_RE.sub(sub_tick, line)
        out.append(line)
    return "\n".join(out), notes


def atomic_write(path: Path, text: str) -> None:
    """先写同目录临时文件再 os.replace，中断不留半截目标文件。"""
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def migrate_one(
    path: Path,
    index: dict[str, list[Path]],
    manual: list[str],
) -> tuple[str | None, list[str]]:
    try:
        original = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return None, [f"读不出来：{exc}"]
    text, notes_fm = fill_frontmatter(path, original)
    text, notes_ref = rewrite_bare_refs(path, text, index, manual)
    notes = notes_fm + notes_ref
    if text == original:
        return None, notes
    return text, notes


def main() -> int:
    ap = argparse.ArgumentParser(description="把存量手写 Markdown 迁到 AGENTS.md「Markdown 写法」子集")
    ap.add_argument("directory", nargs="?", default="", help=f"要迁的目录（默认 {DEFAULT_DIR}）")
    ap.add_argument("--write", action="store_true", help="落盘。不加这个就是预演")
    args = ap.parse_args()

    explicit = bool(args.directory)
    directory = Path(args.directory).expanduser() if explicit else DEFAULT_DIR
    directory = directory if directory.is_absolute() else (Path.cwd() / directory)
    inside = _resolve_inside(WS, directory)
    if inside is None:
        print(f"路径不在工作空间内：{directory}", file=sys.stderr)
        return 2
    directory = inside

    if not directory.is_dir():
        print(f"工作空间里还没有 {directory.name}/ 目录，没有文件可迁移。不创建目录。", file=sys.stderr)
        return 2

    files = scan_output(directory)
    index = build_name_index()
    manual: list[str] = []
    planned: list[tuple[Path, str, list[str]]] = []
    for path in files:
        new_text, notes = migrate_one(path, index, manual)
        if new_text is None:
            continue
        planned.append((path, new_text, notes))

    print(f"扫描 {directory}：{len(files)} 份，待改 {len(planned)} 份")
    for path, _text, notes in planned:
        rel = path.relative_to(WS).as_posix()
        print(f"\n{rel}")
        for note in notes:
            print(f"  · {note}")

    if manual:
        print(f"\n需人工处理 {len(manual)} 条（同名多份，不猜目标）：")
        for item in manual:
            print(f"  · {item}")

    if not args.write:
        print("\n这是预演，什么都没写。确认无误后加 --write。")
        return 0

    written = 0
    for path, text, _notes in planned:
        atomic_write(path, text)
        written += 1
    print(f"\n已写入 {written} 份")
    if manual:
        print(f"另有 {len(manual)} 条裸文件名要人看一眼，没改。")
    print("下一步：python3 scripts/check_markdown.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
