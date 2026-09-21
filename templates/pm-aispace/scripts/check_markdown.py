#!/usr/bin/env python3
"""校验 `output/**` 下手写 Markdown 是否符合写法子集。

契约在 [`AGENTS.md`](../AGENTS.md) 的「Markdown 写法」一节，
本脚本是那份契约的可执行版本。**契约变了这里要跟着变**，否则脚本会一直给过期的绿灯。

为什么值得有这个脚本
--------------------
写法规范是约定，不是强制 —— agent 直接改文件，谁也拦不住它写 `[[wikilink]]`
或 `tags: [a, b]`。这个脚本的作用不是阻止违约，是**让违约可见**，不要静默生效。

它**不管** `input/converted/`（转换脚本的产物，重跑即覆盖）和 `input/raw/`（原件，不碰）。
`output/questions/` 的字段契约仍由 `check_questions.py` 负责；本脚本只查写法子集
（扁平 front-matter、禁用语法、标题层级），不重复检查问题字段。

用法
----
    python3 scripts/check_markdown.py               # 默认查本工作空间的 output/
    python3 scripts/check_markdown.py <目录>         # 查指定目录（仍跳过 converted / raw）
    python3 scripts/check_markdown.py --json        # 给程序用

退出码：0 = 没有错误（可能有警告）；1 = 有错误；2 = 用法/目录问题。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from questions_fm import parse_frontmatter  # noqa: E402

HERE = Path(__file__).resolve().parent
WS = HERE.parent
DEFAULT_DIR = WS / "output"

# 同类问题在文本输出里最多点名几份文件。
SHOW_FILES = 6

# 这些路径即使被扫到也跳过：转换产物与原件不在本规范范围内。
SKIP_PARTS = {"input/converted", "input/raw"}

# 行首 `#标签`：`#` 后紧跟非空格、非 `#`。`# 标题`（有空格）是合法 H1，不算。
TAG_RE = re.compile(r"^#[^#\s]")
CALLOUT_RE = re.compile(r"^>\s*\[![\w-]+\]", re.I)
WIKILINK_RE = re.compile(r"!?\[\[[^\]]+\]\]")
COMMENT_RE = re.compile(r"%%.*?%%")
BLOCK_ID_RE = re.compile(r"(?:^|\s)\^[A-Za-z0-9_-]+\s*$")
MATH_RE = re.compile(r"(?<!\$)\$(?!\$)[^$\n]+\$|\$\$[^$\n]+\$\$")
INLINE_ARRAY_RE = re.compile(r"^([\w.-]+):\s*\[")
NESTED_KEY_RE = re.compile(r"^\s+[\w.-]+:\s*")
LIST_ITEM_RE = re.compile(r"^\s+-\s+")
HEADING_RE = re.compile(r"^(#{1,6})\s+\S")
FENCE_RE = re.compile(r"^(\s*)(`{3,}|~{3,})")


class Report:
    def __init__(self) -> None:
        self.errors: list[tuple[str, str, str]] = []
        self.warnings: list[tuple[str, str, str]] = []

    def error(self, kind: str, where: str, msg: str) -> None:
        self.errors.append((kind, where, msg))

    def warn(self, kind: str, where: str, msg: str) -> None:
        self.warnings.append((kind, where, msg))


def _rel(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def _under_skipped(path: Path) -> bool:
    posix = path.as_posix()
    return any(f"/{part}/" in f"/{posix}/" or posix.startswith(part + "/") for part in SKIP_PARTS)


def iter_body_lines(body: str):
    """产出 (lineno_in_body_1based, line, in_fence)。"""
    in_fence = False
    fence_mark = ""
    for i, line in enumerate(body.split("\n"), 1):
        fence = FENCE_RE.match(line)
        if fence:
            mark = fence.group(2)[0]
            n = len(fence.group(2))
            token = mark * n
            if not in_fence:
                in_fence = True
                fence_mark = token
                yield i, line, True
                continue
            if line.strip().startswith(fence_mark):
                in_fence = False
                fence_mark = ""
                yield i, line, True
                continue
        yield i, line, in_fence


def _strip_inline_code(line: str) -> str:
    return re.sub(r"`[^`]*`", "", line)


def check_frontmatter(raw: str, where: str, report: Report) -> None:
    if not raw:
        return
    for i, line in enumerate(raw.split("\n"), 1):
        stripped = line.rstrip("\r")
        if not stripped.strip():
            continue
        loc = f"{where}:{i + 1}"  # +1：文件第 1 行是 ---
        if INLINE_ARRAY_RE.match(stripped):
            key = INLINE_ARRAY_RE.match(stripped).group(1)
            report.error(
                "内联数组",
                loc,
                f"`{key}: [...]` 是内联数组，看板会整段当成字符串。"
                f"改成块状 list：\n      {key}:\n        - 第一项\n        - 第二项",
            )
            continue
        if LIST_ITEM_RE.match(stripped):
            continue
        if stripped[:1] in " \t" and NESTED_KEY_RE.match(stripped):
            report.error(
                "嵌套对象",
                loc,
                "front-matter 出现了缩进的二级键值对 —— 看板解析器读不出嵌套结构。"
                "只保留 `key: value` 与 `key:` + `  - item`",
            )


def check_disabled(body: str, body_start: int, where: str, report: Report) -> None:
    for i, line, in_fence in iter_body_lines(body):
        if in_fence:
            continue
        loc = f"{where}:{body_start + i - 1}"
        visible = _strip_inline_code(line)
        if TAG_RE.match(visible):
            report.error(
                "行首标签",
                loc,
                f"行首 `{visible.split()[0]}` 会被渲染器当成 H1 混进文档目录。"
                "标签写进 front-matter 的块状 list，标题写成 `# 标题`（`#` 后有空格）",
            )
        if CALLOUT_RE.match(visible):
            report.error(
                "callout",
                loc,
                "`> [!type]` callout 看板暂不渲染，标记会原样露出来。改成普通引用块，需要强调就加粗",
            )
        for m in WIKILINK_RE.finditer(visible):
            raw = m.group(0)
            inner = raw.strip("![]")
            name = inner.split("|", 1)[0].strip()
            report.error(
                "wikilink" if not raw.startswith("!") else "embed",
                loc,
                f"`{raw}` 看板点不开。改成相对路径链接，例如 `[文本](../analysis/{name}.md)`",
            )
        if COMMENT_RE.search(visible):
            report.error(
                "百分号注释",
                loc,
                "`%%注释%%` 看板会原样露在正文里。改成 HTML 注释 `<!-- -->`，或不写",
            )
        if BLOCK_ID_RE.search(visible):
            report.error(
                "块引用锚点",
                loc,
                "段尾 `^id` 是 Obsidian 块锚点，看板暂不渲染。去掉它；要定位就靠标题",
            )
        if MATH_RE.search(visible):
            report.error(
                "数学公式",
                loc,
                "`$...$` / `$$...$$` 看板暂不渲染。能用文字或代码块说清就说清",
            )


def check_headings(body: str, body_start: int, where: str, report: Report) -> None:
    headings: list[tuple[int, int]] = []
    for i, line, in_fence in iter_body_lines(body):
        if in_fence:
            continue
        m = HEADING_RE.match(_strip_inline_code(line))
        if m:
            headings.append((len(m.group(1)), body_start + i - 1))
    h1s = [ln for level, ln in headings if level == 1]
    if len(h1s) > 1:
        shown = ", ".join(f"第 {ln} 行" for ln in h1s[:6])
        more = f" …另 {len(h1s) - 6} 处" if len(h1s) > 6 else ""
        report.error(
            "多个 H1",
            where,
            f"正文有 {len(h1s)} 个 H1（{shown}{more}）。全文只留一个，其余改成 H2",
        )
    # 正文从 H2 起：跳过可选的那个唯一 H1 后，第一个标题应当是 H2。
    rest = headings[1:] if headings and headings[0][0] == 1 else headings
    if rest and rest[0][0] != 2:
        level, ln = rest[0]
        report.warn(
            "正文不是从 H2 起",
            f"{where}:{ln}",
            f"跳过可选的 H1 之后，第一个标题是 H{level}。正文从 H2 起，不要跳级",
        )


def requires_frontmatter(path: Path, output_root: Path) -> bool:
    """analysis/ 与 decisions/ 下的非 README 才强制最小 front-matter。"""
    try:
        rel = path.resolve().relative_to(output_root.resolve())
    except ValueError:
        return False
    if path.name.lower() == "readme.md":
        return False
    parts = rel.parts
    if not parts:
        return False
    if parts[0] in {"docs", "questions"}:
        return False
    return parts[0] in {"analysis", "decisions"}


def check_file(path: Path, output_root: Path, report: Report) -> None:
    where = _rel(path, output_root.parent if output_root.name == "output" else output_root)
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        report.error("读不出来", where, f"读不出来：{exc}")
        return

    meta, body, raw = parse_frontmatter(text)
    if raw:
        # 文件以 --- 起，结束 --- 之后是 body；body 起始行 = raw 行数 + 2 个 --- + 可能的空行
        body_start = text[: text.find(body)].count("\n") + 1 if body else text.count("\n") + 1
        check_frontmatter(raw, where, report)
    else:
        body_start = 1
        if requires_frontmatter(path, output_root):
            report.error(
                "没有 front-matter",
                where,
                "缺 front-matter。最小形态是 title / created / updated 三个扁平字段，见 AGENTS.md「Markdown 写法」",
            )

    if requires_frontmatter(path, output_root) and raw:
        for key in ("title", "created", "updated"):
            if key not in meta:
                report.error(
                    f"缺字段 `{key}`",
                    where,
                    f"缺 `{key}`。`output/analysis/` 与 `output/decisions/` 的最小字段见 AGENTS.md「Markdown 写法」",
                )

    check_disabled(body, body_start, where, report)
    check_headings(body, body_start, where, report)


def scan(directory: Path) -> list[Path]:
    files = []
    for path in sorted(directory.rglob("*.md")):
        if not path.is_file():
            continue
        if _under_skipped(path):
            continue
        files.append(path)
    return files


def _print_grouped(label: str, mark: str, items: list[tuple[str, str, str]]) -> None:
    if not items:
        return
    groups: dict[str, list[tuple[str, str]]] = {}
    for kind, where, msg in items:
        groups.setdefault(kind, []).append((where, msg))
    print(f"\n{label} {len(items)} 条，{len(groups)} 类：")
    for kind, entries in groups.items():
        if len(entries) == 1:
            where, msg = entries[0]
            print(f"  {mark} {where}  {msg}")
            continue
        print(f"  {mark} {kind}（{len(entries)} 份）  {entries[0][1]}")
        shown = [w for w, _ in entries[:SHOW_FILES]]
        more = len(entries) - len(shown)
        print(f"      {' '.join(shown)}" + (f" …另 {more} 份" if more else ""))


def _resolve_inside(root: Path, target: Path) -> Path | None:
    """路径必须落在工作空间根之内。"""
    try:
        resolved = target.resolve()
        resolved.relative_to(root.resolve())
        return resolved
    except ValueError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description="校验 output/ 下手写 Markdown 是否符合 AGENTS.md「Markdown 写法」")
    ap.add_argument("directory", nargs="?", default="", help=f"要查的目录（默认 {DEFAULT_DIR}）")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出，供程序调用")
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
        msg = (
            f"找不到目录：{directory}"
            if explicit
            else f"工作空间里还没有 output/ 目录，没有手写 Markdown 可校验。不要手工建空目录来骗过脚本。"
        )
        print(msg, file=sys.stderr)
        return 2

    files = scan(directory)
    report = Report()
    # 以 output/ 为相对路径的锚，便于报错里写出 output/analysis/xxx.md
    output_root = directory if directory.name == "output" else directory
    for path in files:
        check_file(path, output_root, report)

    if args.json:
        print(
            json.dumps(
                {
                    "ok": not report.errors,
                    "checked": len(files),
                    "errors": [{"kind": k, "file": w, "message": m} for k, w, m in report.errors],
                    "warnings": [{"kind": k, "file": w, "message": m} for k, w, m in report.warnings],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 1 if report.errors else 0

    print(f"校验 {directory}：{len(files)} 份 Markdown")
    _print_grouped("错误", "✗", report.errors)
    _print_grouped("警告", "·", report.warnings)
    if not report.errors and not report.warnings:
        print("全部通过。")
    elif not report.errors:
        print("\n没有错误。")
    return 1 if report.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
