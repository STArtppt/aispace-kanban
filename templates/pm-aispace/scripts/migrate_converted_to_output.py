#!/usr/bin/env python3
"""把转换产物从 `input/converted/` 整体搬到 `output/converted/`。**一次性脚本**。

背景
----
转换产物是脚本从原件转出来、给 AI 读的东西，用起来更像一份产出（同事写好、转成 markdown
后还要套模板交付）。所以目录约定改成 `output/converted/`，看板上它也挪到了「产出文档」下。
图片目录 `input/assets/` **不动**：直接放进 `input/raw/` 的单张图片本来就是原始资料。

做什么
------
1. 把 `input/converted/` 整个目录移到 `output/converted/`（含数据库源产物 `_sources/`）。
2. 改写被移动的 `.md` 里的相对链接（正文的 markdown 链接 / 图片、`<img src>` / `href`，
   frontmatter 的 `payload:` `preview:`）：按**旧位置解析 → 映射到新位置 → 相对新位置重算**。
   指向 `input/assets/`、`input/raw/` 的链接因所在目录变了而重算；产物之间的互链两端一起搬，算完不变。
   frontmatter 的 `source:` 是工作空间相对路径，不动。
3. 改写 `input/INDEX.md` 表格里的产物链接（`converted/…` → `../output/converted/…`）。
4. 执行后自检：每条改写过的链接，迁移前指得到东西的，迁移后也必须指得到；不然列出来并以 1 退出。

**不做的事**：不碰 `output/analysis|docs|decisions` 等任何其他文件 —— 产出文档里写着
`input/converted/…` 的溯源引用不改写（看板把旧前缀当新路径的别名）；不移动 `input/assets/`；
目标目录已存在且非空时拒绝，不合并。看板不提供触发它的按钮。

用法
----
    python3 scripts/migrate_converted_to_output.py --dry-run    # 先看计划（不动任何文件）
    python3 scripts/migrate_converted_to_output.py              # 执行
    python3 scripts/migrate_converted_to_output.py --reverse    # 回滚：搬回 input/converted/，链接同样重算

退出码：0 = 完成或无事可做；1 = 拒绝执行或自检发现断链；2 = 用法问题。
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
from pathlib import Path
from urllib.parse import unquote

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from layout import CONVERTED, LEGACY_CONVERTED, REPO, has_entries, md_link  # noqa: E402

INDEX = REPO / "input" / "INDEX.md"
# 链接目标以这些开头的不是相对路径，不碰
SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.-]*:", re.I)
# markdown 链接 / 图片：`](目标)` 或 `](目标 "标题")`。md_link 已把空格和括号转义，目标里不会有裸的 `)`
MD_LINK_RE = re.compile(r"(\]\()([^)\s]+)((?:\s+\"[^\"]*\")?\))")
HTML_ATTR_RE = re.compile(r"((?:src|href)=\")([^\"]+)(\")", re.I)
FRONT_KEYS_RE = re.compile(r"^(payload|preview)(:\s*)(\S.*?)\s*$")
FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})")


def log(msg: str) -> None:
    print(msg, flush=True)


def ws_rel(path: Path) -> str:
    return Path(os.path.relpath(path, REPO)).as_posix()


class Rewriter:
    """一份文件里的相对链接：旧位置解析 → 映射 → 相对新位置重算。"""

    def __init__(self, src_root: Path, dst_root: Path):
        self.src_root = src_root
        self.dst_root = dst_root
        # (改写后所在文件的新位置, 新链接解析出的目标, 迁移前目标是否存在)
        self.checks: list[tuple[Path, Path, bool]] = []

    def map_path(self, abs_path: Path) -> Path:
        try:
            return self.dst_root / abs_path.relative_to(self.src_root)
        except ValueError:
            return abs_path

    def rewrite_target(self, raw: str, old_dir: Path, new_dir: Path, file_new: Path, escape: bool) -> str:
        if not raw or raw.startswith(("#", "/", "<")) or SCHEME_RE.match(raw):
            return raw
        path_part, sep, frag = raw.partition("#")
        path_part, qsep, query = path_part.partition("?")
        if not path_part:
            return raw
        decoded = unquote(path_part)
        old_target = Path(os.path.normpath(old_dir / decoded))
        new_target = self.map_path(old_target)
        rel = Path(os.path.relpath(new_target, new_dir)).as_posix()
        if path_part.startswith("./") and not rel.startswith("../"):
            rel = "./" + rel
        if path_part.endswith("/") and not rel.endswith("/"):
            rel += "/"
        out = (md_link(rel) if escape else rel) + (qsep + query if qsep else "") + (sep + frag if sep else "")
        if out != raw:
            self.checks.append((file_new, new_target, old_target.exists()))
        return out

    def rewrite_text(self, text: str, old_dir: Path, new_dir: Path, file_new: Path) -> tuple[str, int]:
        before = len(self.checks)
        lines = text.split("\n")
        in_front = bool(lines) and lines[0].strip() == "---"
        fence = ""
        for i, line in enumerate(lines):
            if in_front and i > 0 and line.strip() == "---":
                in_front = False
                continue
            if in_front:
                m = FRONT_KEYS_RE.match(line)
                if m:
                    value = m.group(3).strip("'\"")
                    lines[i] = m.group(1) + m.group(2) + self.rewrite_target(value, old_dir, new_dir, file_new, False)
                continue
            fm = FENCE_RE.match(line)
            if fm:
                mark = fm.group(1)[0]
                fence = "" if fence == mark else (fence or mark)
                continue
            if fence:
                continue
            line = MD_LINK_RE.sub(
                lambda m: m.group(1) + self.rewrite_target(m.group(2), old_dir, new_dir, file_new, True) + m.group(3),
                line,
            )
            # HTML 属性里空格括号不会打断语法，原来转义过才转义，保持原样的写法
            line = HTML_ATTR_RE.sub(
                lambda m: m.group(1)
                + self.rewrite_target(m.group(2), old_dir, new_dir, file_new, unquote(m.group(2)) != m.group(2))
                + m.group(3),
                line,
            )
            lines[i] = line
        return "\n".join(lines), len(self.checks) - before


INDEX_ROW_TARGET_RE = re.compile(r"\[`([^`]+)`\]\(([^)\s]+)\)")


def rewrite_index(text: str, rw: Rewriter) -> tuple[str, int]:
    """台账表格里的产物格子 `[`显示路径`](链接)`：显示路径与链接一起重算（ingest.py 读回时取的是显示路径）。"""
    count = 0

    def repl(m: re.Match) -> str:
        nonlocal count
        shown, link = m.group(1), m.group(2)
        new_shown = rw.rewrite_target(shown, INDEX.parent, INDEX.parent, INDEX, False)
        if new_shown.startswith("./"):
            new_shown = new_shown[2:]
        new_link = rw.rewrite_target(link, INDEX.parent, INDEX.parent, INDEX, True)
        # 与 ingest.py 的 index_link 同一写法：不以 ../ 开头的补 ./
        if not new_link.startswith(("../", "./")):
            new_link = "./" + new_link
        if (new_shown, new_link) == (shown, link):
            return m.group(0)
        count += 1
        return f"[`{new_shown}`]({new_link})"

    head, marker, tail = text.partition("## 人工批注")
    # 人工批注区是人写的，不碰；只改脚本生成的表格部分
    return INDEX_ROW_TARGET_RE.sub(repl, head) + marker + tail, count


def main() -> int:
    ap = argparse.ArgumentParser(description="把转换产物从 input/converted/ 搬到 output/converted/（一次性）")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划，不动任何文件")
    ap.add_argument("--reverse", action="store_true", help="回滚：从 output/converted/ 搬回 input/converted/")
    args = ap.parse_args()

    src, dst = (CONVERTED, LEGACY_CONVERTED) if args.reverse else (LEGACY_CONVERTED, CONVERTED)
    if not has_entries(src):
        log(f"{ws_rel(src)}/ 不存在或是空的，没什么可搬的。")
        return 0
    if has_entries(dst):
        log(f"{ws_rel(dst)}/ 已经存在且不是空的，拒绝执行（不合并两处的产物）。")
        log(f"请先人工确认：两边各是什么、要留哪一份。确认后把不要的那份移走，再重跑本脚本。")
        return 1

    files = sorted(p for p in src.rglob("*") if p.is_file())
    mds = [p for p in files if p.suffix.lower() == ".md"]
    rw = Rewriter(src, dst)
    planned: list[tuple[Path, Path, str, int]] = []   # (旧位置, 新位置, 新内容, 改写条数)
    for md in mds:
        try:
            text = md.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        new_path = rw.map_path(md)
        new_text, n = rw.rewrite_text(text, md.parent, new_path.parent, new_path)
        if n:
            planned.append((md, new_path, new_text, n))

    index_text, index_count = "", 0
    if INDEX.is_file():
        index_text, index_count = rewrite_index(INDEX.read_text(encoding="utf-8"), rw)

    link_total = sum(n for *_, n in planned)
    log(f"将移动：{ws_rel(src)}/ → {ws_rel(dst)}/（{len(files)} 个文件，input/assets/ 不动）")
    log(f"将改写：{len(planned)} 份 .md 里的 {link_total} 处相对链接；input/INDEX.md 里 {index_count} 处产物链接")
    for old, _, _, n in planned[:20]:
        log(f"  · {ws_rel(old)}  {n} 处")
    if len(planned) > 20:
        log(f"  …… 另有 {len(planned) - 20} 份")
    if args.dry_run:
        samples = [c for c in rw.checks if c[2]][:5]
        if samples:
            log("改写后的链接目标示例：")
            for file_new, target, _ in samples:
                log(f"  {ws_rel(file_new)} → {ws_rel(target)}")
        log("\n（预演，没有改动任何文件。确认无误后去掉 --dry-run 执行。）")
        return 0

    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        # 目标只有隐藏占位文件（如 .gitkeep）：逐项搬进去。撞名的只可能是两边都有的占位文件，源里那份不要了
        for child in list(src.iterdir()):
            target = dst / child.name
            if target.exists():
                child.unlink() if child.is_file() else shutil.rmtree(child)
                continue
            shutil.move(str(child), str(target))
        src.rmdir()
    else:
        shutil.move(str(src), str(dst))
    for _, new_path, new_text, _ in planned:
        new_path.write_text(new_text, encoding="utf-8")
    if index_count:
        INDEX.write_text(index_text, encoding="utf-8")

    broken = [(f, t) for f, t, existed in rw.checks if existed and not t.exists()]
    log(f"\n已搬到 {ws_rel(dst)}/，改写 {link_total} 处链接、台账 {index_count} 处。")
    if broken:
        log(f"自检：{len(broken)} 条链接迁移前指得到、迁移后指不到：")
        for f, t in broken[:50]:
            log(f"  {ws_rel(f)} → {ws_rel(t)}")
        return 1
    log("自检通过：迁移前指得到的链接，迁移后都还指得到。")
    log("产出文档里的 input/converted/… 溯源引用没有改写，看板照常识别；新写的引用请用 output/converted/。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
