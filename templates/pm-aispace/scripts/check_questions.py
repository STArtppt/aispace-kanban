#!/usr/bin/env python3
"""校验 `output/analysis/questions/` 下的问题文件。

字段契约在 [`output/analysis/questions/README.md`](../output/analysis/questions/README.md)，
本脚本是那份契约的可执行版本。**契约变了这里要跟着变**，否则脚本会一直给过期的绿灯。

为什么值得有这个脚本
--------------------
问题文件由三方写：技能、迁移脚本、看板。字段分区是**约定**，代码强制不了 ——
agent 直接改文件，谁也拦不住它把 `我方推断` 和 `answered` 写在同一份文件里。
这个脚本的作用不是阻止违约，是**让违约可见**，不要静默生效。

用法
----
    python3 scripts/check_questions.py               # 默认查 output/analysis/questions/
    python3 scripts/check_questions.py <目录>         # 查指定目录（回归语料用）
    python3 scripts/check_questions.py --json        # 给程序用

退出码：0 = 没有错误（可能有警告）；1 = 有错误；2 = 用法/目录问题。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from questions_fm import as_text, is_blank, parse_frontmatter  # noqa: E402

HERE = Path(__file__).resolve().parent
DEFAULT_DIR = HERE.parent / "output" / "analysis" / "questions"

REQUIRED = ["id", "title", "status", "blocks", "asked_of", "source"]
STATUSES = ["open", "pending_ai", "answered", "dropped", "conflict"]
EVIDENCES = ["客户确认", "资料实证", "我方决策", "我方推断"]
ANSWERS = ["verify", "decide", "drop", "ask"]
# 只有前三种凭据能关闭问题。「我方推断」不能 —— 见 README「凭据」一节。
CLOSING_EVIDENCES = ["客户确认", "资料实证", "我方决策"]

# 四位编号；末尾允许一个小写字母，那是迁移给分叉编号（旧表格里的 `16b`）留的口子，
# 新问题不用它 —— 理由见 questions/README.md「编号」一节。
NAME_RE = re.compile(r"^Q\d{4}[a-z]?$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TITLE_MAX = 60
# 同类问题在文本输出里最多点名几份文件。刚迁移完会有两百多条同类，逐条打没人看。
SHOW_FILES = 6
# 这两份是问题目录里名正言顺的非问题文件，不要当成拼错的编号来警告。
SKIP_FILES = {"README.md", "MIGRATION-REVIEW.md", "TRIAGE.md"}


class Report:
    """每条记录带一个 `kind`（同类问题的共同标签）。

    刚迁移完的工作空间会一口气报出两百多条同类警告（`blocks` 全空、标题全太长）。
    逐条打出来没人会看完，反而把真正孤立的那几条埋掉了 ——
    所以文本输出按 `kind` 归并，JSON 输出保持逐条不变，给程序用。
    """

    def __init__(self) -> None:
        self.errors: list[tuple[str, str, str]] = []
        self.warnings: list[tuple[str, str, str]] = []

    def error(self, kind: str, where: str, msg: str) -> None:
        self.errors.append((kind, where, msg))

    def warn(self, kind: str, where: str, msg: str) -> None:
        self.warnings.append((kind, where, msg))


def check_file(path: Path, report: Report) -> None:
    where = path.name
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        report.error("读不出来", where, f"读不出来：{exc}")
        return

    meta, _body, raw = parse_frontmatter(text)
    if not raw:
        report.error("没有 front-matter", where, "没有 front-matter —— 看板只读 front-matter 拼索引，这条会整个看不见")
        return

    for key in REQUIRED:
        if key not in meta:
            report.error(f"缺必填字段 `{key}`", where, f"缺必填字段 `{key}`")

    stem = path.stem
    fm_id = as_text(meta.get("id"))
    if fm_id and NAME_RE.match(stem) and fm_id != stem:
        report.error("id 与文件名对不上", where, f"`id: {fm_id}` 与文件名 `{stem}` 对不上 —— 外部引用会指错条目")

    title = as_text(meta.get("title"))
    if title and len(title) > TITLE_MAX:
        report.warn("title 太长", where, f"`title` {len(title)} 字，超过 {TITLE_MAX} —— 该拆条，或把上下文挪进正文")

    status = as_text(meta.get("status"))
    if status and status not in STATUSES:
        report.error("status 不在枚举内", where, f"`status: {status}` 不在枚举内（{' / '.join(STATUSES)}）")

    evidence = as_text(meta.get("evidence"))
    if evidence and evidence not in EVIDENCES:
        report.error("evidence 不在四值内", where, f"`evidence: {evidence}` 不在四值内（{' / '.join(EVIDENCES)}）")

    answer = as_text(meta.get("human_answer"))
    if answer and answer not in ANSWERS:
        report.error("human_answer 不在四值内", where, f"`human_answer: {answer}` 不在四值内（{' / '.join(ANSWERS)}）")

    # 核心非法组合：拿推断当结论把问题关掉。这是整份契约存在的理由。
    if status == "answered" and evidence and evidence not in CLOSING_EVIDENCES:
        report.error("推断关闭了问题", where, f"`{evidence}` 不能关闭问题 —— 置回 `open` 当待验证假设，或补一个实证凭据")
    if status == "answered" and not evidence:
        report.error("已关闭但缺凭据", where, "`answered` 却没写 `evidence` —— 凭什么关的必须写出来")

    if answer == "ask" and is_blank(meta.get("due")):
        report.error("ask 缺 due", where, "`human_answer: ask` 必须填 `due` —— 没有最迟答复日期就没有机制逼它到期")
    due = as_text(meta.get("due"))
    if due and not DATE_RE.match(due):
        report.error("due 格式不对", where, f"`due: {due}` 不是 YYYY-MM-DD")

    for key in ("created", "updated"):
        value = as_text(meta.get(key))
        if value and not DATE_RE.match(value):
            report.warn(f"{key} 格式不对", where, f"`{key}: {value}` 不是 YYYY-MM-DD")

    if "blocks" in meta and is_blank(meta.get("blocks")):
        report.warn("blocks 待归类", where, "`blocks` 空着 —— 待归类。填在途交付物名，或写 `backlog` 表示不阻塞任何交付物")
    if status == "conflict":
        report.warn("状态冲突待裁定", where, "状态是 `conflict` —— 等人裁定，裁完改成 open / answered / dropped")


def scan(directory: Path, report: Report) -> list[Path]:
    files = []
    for path in sorted(directory.glob("*.md")):
        if path.name in SKIP_FILES:
            continue
        if not NAME_RE.match(path.stem):
            report.warn("文件名不是问题编号", path.name, "文件名不是 `Q<四位编号>.md` —— 看板不会把它当问题文件")
            continue
        files.append(path)
    return files


def _print_grouped(label: str, mark: str, items: list[tuple[str, str, str]]) -> None:
    """按 kind 归并着打。同类超过 SHOW_FILES 份就只点名前几份，剩下的报个数。"""
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


def main() -> int:
    ap = argparse.ArgumentParser(description="校验问题文件是否符合 questions/README.md 的字段契约")
    ap.add_argument("directory", nargs="?", default="", help=f"问题目录（默认 {DEFAULT_DIR}）")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出，供程序调用")
    args = ap.parse_args()

    explicit = bool(args.directory)
    directory = Path(args.directory).expanduser().resolve() if explicit else DEFAULT_DIR

    if not directory.is_dir():
        if explicit:
            print(f"找不到目录：{directory}", file=sys.stderr)
            return 2
        # 旧工作空间还没迁移过来，这不是错误。
        msg = f"还没有 {directory.name}/ 目录，没有问题文件可校验。迁移见 scripts/migrate_questions.py"
        print(json.dumps({"ok": True, "checked": 0, "note": msg}, ensure_ascii=False) if args.json else msg)
        return 0

    report = Report()
    files = scan(directory, report)
    for path in files:
        check_file(path, report)

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

    print(f"校验 {directory}：{len(files)} 份问题文件")
    _print_grouped("错误", "✗", report.errors)
    _print_grouped("警告", "·", report.warnings)
    if not report.errors and not report.warnings:
        print("全部通过。")
    elif not report.errors:
        print("\n没有错误。")
    return 1 if report.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
