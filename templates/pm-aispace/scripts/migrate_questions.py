#!/usr/bin/env python3
"""把旧的 `output/analysis/open-questions.md` 表格拆成一问一文件。

字段契约见 [`output/questions/README.md`](../output/questions/README.md)。

这个脚本**只搬运和标记，不推断**
--------------------------------
`blocks` 与 `evidence` 一律留空交人工过一遍：

- **`evidence` 自动推断是自相矛盾的** —— 自动填出来的凭据本身就是虚假确定性，
  而这个字段存在的全部意义就是防止它。
- `blocks` 按分节名机械匹配能出结果，但那些结果**看着合理、实际靠不住**，
  比留空更危险：留空会被人看见，错的分组不会。

`source` 是例外：它不是推断，是**照抄**。分节前面的引言里常写着
「由 `xxx.md` 产生」「来源：`xxx`」，脚本把那个路径原样搬到条目上 ——
溯源锚点从分节挪到条目，本来就是这次改造要做的事。抄不到就退回指向原表格的分节锚点。

一条都不能丢
------------
表格单元格里的 `|`、`<br>`、分叉编号（`16b`）、加粗过的序号（`**187**`）都真实存在。
遇到拆不干净的行，脚本**保留整行原文**到正文并在待裁定清单里点名，
绝不静默丢弃 —— 静默丢条是这类迁移最常见也最难发现的事故。

用法
----
    python3 scripts/migrate_questions.py              # 预演，不落盘（默认）
    python3 scripts/migrate_questions.py --write      # 确认后落盘

落盘时做三件事：写 `output/questions/Q*.md`、写一份
`output/questions/MIGRATION-REVIEW.md` 待人工裁定清单、
把原表**整份搬进** `output/questions/_原表快照.md` 并在开头加一句指向说明
（**正文一个字不删**，留着回滚）。

快照跟着搬，是因为它是**被引用的溯源终点**：没有更深来源的那些条目，`source`
直接指向它，每条正文里还有一句「来自原表第 N 行」。留在 `analysis/` 会一直占着
分析产物清单的位置，删掉则一次弄断上百处引用 —— 搬进 `questions/` 两头都解决。

已存在的问题文件一律跳过不覆盖，所以重跑是安全的。
"""

from __future__ import annotations

import argparse
import datetime as dt
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
WS = HERE.parent
DEFAULT_SOURCE = WS / "output" / "analysis" / "open-questions.md"
DEFAULT_TARGET = WS / "output" / "questions"

# 这些词出现在**行内任何一格**（问题列、为什么需要列、甚至优先级列都真实出现过）
# = 这条其实已经有结论了。序号没划掉的，置 conflict 等人裁。
# 只看「为什么需要」那一格会漏掉一多半 —— 真实数据里三个列都藏过结论。
# 「已确认」不收：问句本身常写「XX 是否已确认？」，收了会大面积误判。
CLOSED_WORDS = ["已解决", "已关闭", "已定案", "不再阻塞", "✅"]
ARCHIVE_NAME = "_原表快照.md"
POINTER = "> **问题清单已迁移到本目录下的 `Q<编号>.md` —— 一问一文件。**"


class Row:
    """旧表格里的一行。"""

    def __init__(self, section: str, section_note: str, line: str, lineno: int) -> None:
        self.section = section
        self.section_note = section_note
        self.line = line.rstrip()
        self.lineno = lineno
        cells = [c.strip() for c in self.line.strip().strip("|").split("|")]
        self.cells = cells
        self.ragged = len(cells) != 5
        self.num_raw = cells[0] if cells else ""
        self.struck = self.num_raw.startswith("~~") and self.num_raw.endswith("~~")
        self.question = _clean(cells[1]) if len(cells) > 1 else ""
        self.why = _clean(cells[2]) if len(cells) > 2 else ""
        self.asked_of = _clean(cells[3]) if len(cells) > 3 else ""
        self.priority = _clean(cells[4]) if len(cells) > 4 else ""
        self.qid = ""
        self.status = ""
        self.title = ""
        self.flags: list[str] = []


def _clean(cell: str) -> str:
    """去掉划除线与加粗，`<br>` 还原成换行。单元格里的内容本身一个字不改。"""
    text = cell.strip()
    text = re.sub(r"^~~(.*)~~$", r"\1", text.strip()).strip()
    text = re.sub(r"^\*\*(.*)\*\*$", r"\1", text).strip()
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    return text.strip()


def _one_line(text: str, limit: int = 0) -> str:
    """压成一行 —— front-matter 是扁平的，换行会把后面的字段吃掉。"""
    line = " ".join(text.split())
    if limit and len(line) > limit:
        line = line[: limit - 1] + "…"
    return line


TITLE_MAX = 60


def make_title(question: str) -> tuple[str, bool]:
    """把一格几百字的「问题」压成一句话，返回 (标题, 是否截断)。

    存量条目平均 200 字、最长 900+ 字全挤在一个单元格里 —— 直接搬进 `title`，
    清单会退化成又一份读不下去的大文件，这次改造就白做了。

    截断是**安全的**：原单元格一个字不改地留在正文的「原始条目」里。
    但截出来的句子多半不通顺，所以每一条都会进待裁定清单等人改写。
    先切到第一个问号（这些本来就是问句，问号是天然的句末），还太长再硬截。
    """
    line = " ".join(question.split())
    if len(line) <= TITLE_MAX:
        return line, False
    m = re.search(r"[？?]", line)
    if m and m.end() <= TITLE_MAX:
        return line[: m.end()], True
    return line[: TITLE_MAX - 1] + "…", True


def _base_number(num_raw: str) -> tuple[int, str]:
    """从 `~~16~~` / `**187**` / `16b` / `61（续）` 里取出编号与后缀标记。"""
    text = _clean(num_raw)
    m = re.match(r"^(\d+)(.*)$", text)
    if not m:
        return 0, text
    return int(m.group(1)), m.group(2).strip()


def parse_table(source: Path) -> tuple[list[Row], list[str]]:
    """扫全文，任何以 `|` 开头、不是表头也不是分隔行的行都算一条问题。"""
    rows: list[Row] = []
    notes: list[str] = []
    section = "（无分节）"
    section_note: list[str] = []
    for lineno, line in enumerate(source.read_text(encoding="utf-8").split("\n"), 1):
        if line.startswith("## "):
            section = line[3:].strip()
            section_note = []
            continue
        if line.startswith("#"):
            continue
        if line.startswith(">"):
            section_note.append(line[1:].strip())
            continue
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if not cells or not cells[0]:
            continue
        if cells[0] in ("序号", "#"):
            continue
        if set(cells[0]) <= set("-: "):
            continue
        rows.append(Row(section, "\n".join(section_note).strip(), line, lineno))
    if not rows:
        notes.append(f"{source} 里没找到任何表格行")
    return rows, notes


def assign_ids(rows: list[Row]) -> None:
    """编号照抄原表格补零到四位；分叉编号用小写字母后缀，不重新编号。

    重新编号会让别的文档里写着「见 Q16b」「转 Q55」的引用全部指错 ——
    旧表格的编号已经是这个工作空间的外部锚点了，动不得。
    """
    taken: set[str] = set()
    for row in rows:
        base, suffix = _base_number(row.num_raw)
        if base == 0:
            row.flags.append(f"序号 `{row.num_raw}` 解析不出数字，已按出现顺序另编")
            base = 9000 + len(taken)
            suffix = ""
        qid = f"Q{base:04d}"
        if suffix or qid in taken:
            if suffix and re.fullmatch(r"[A-Za-z]", suffix):
                candidate = f"{qid}{suffix.lower()}"
            else:
                candidate = ""
            if not candidate or candidate in taken:
                for letter in "bcdefghijklmnopqrstuvwxyz":
                    if f"{qid}{letter}" not in taken:
                        candidate = f"{qid}{letter}"
                        break
            row.flags.append(f"分叉编号：原序号 `{_clean(row.num_raw)}` → `{candidate}`，别处的引用要跟着改")
            qid = candidate
        taken.add(qid)
        row.qid = qid


def classify(row: Row) -> None:
    """定标题与状态，并把所有要人看一眼的地方记成 flag。

    全部在这一步做完，预演时打出来的统计才和落盘后的待裁定清单对得上。
    """
    row.title, truncated = make_title(row.question)
    if truncated:
        row.flags.append(
            f"标题从 {len(' '.join(row.question.split()))} 字截到一句话"
            " —— 原文在正文「原始条目」里，请改写成一句通顺的问句"
        )
    body_says_closed = any(word in row.line for word in CLOSED_WORDS)
    if row.struck:
        row.status = "answered"
        row.flags.append("已关闭但没有凭据 —— 补 `evidence`（客户确认 / 资料实证 / 我方决策）")
    elif body_says_closed:
        row.status = "conflict"
        row.flags.append("正文写着已解决 / 不再阻塞 / 已定案，但序号没划掉 —— 到底关没关")
    else:
        row.status = "open"
    if row.ragged:
        row.flags.append(f"这一行拆出 {len(row.cells)} 格而不是 5 格，字段可能串位，原文已整行保留到正文")
    if "？" not in row.question and "?" not in row.question:
        row.flags.append("不像一个问题（没有问号）—— 可能是会议话术或备忘，考虑 `dropped`")


def extract_source(row: Row) -> str:
    """从分节引言里照抄出触发文档路径，抄不到就指回原表格的分节锚点。"""
    note = row.section_note
    m = re.search(r"`([^`]+\.(?:md|csv|xlsx|docx|yaml))`", note)
    if m:
        path = m.group(1)
        if not path.startswith(("input/", "output/", "visualization/")):
            path = f"output/analysis/{path}"
        return path
    m = re.search(r"((?:input|output|visualization)/[^\s`）)，,、]+)", note)
    if m:
        return m.group(1)
    return f"output/questions/_原表快照.md#{row.section}"


def render(row: Row, today: str) -> str:
    title = row.title or f"（原表格第 {row.lineno} 行没有问题描述）"
    asked_of = "" if row.asked_of in ("—", "-", "－", "--") else _one_line(row.asked_of)
    def kv(key: str, value: str) -> str:
        # 空值写成 `key:` 而不是 `key: ` —— 行尾空格是看不见的脏东西，
        # 而且解析器把两者都读成空列表，留着只会让 diff 更吵。
        return f"{key}: {value}" if value else f"{key}:"

    lines = [
        "---",
        f"id: {row.qid}",
        f"title: {title}",
        f"status: {row.status}",
        "blocks:",
        kv("asked_of", asked_of),
        f"source: {extract_source(row)}",
        f"context: 迁移自 open-questions.md 的「{_one_line(row.section)}」一节",
        "created:",
        f"updated: {today}",
        "human_answer:",
        "human_note:",
        "due:",
        "evidence:",
        "ai_conclusion:",
        "ai_source:",
        "flows_to:",
        "---",
        "",
        "## 为什么需要",
        "",
        row.why or "（原表格该列为空）",
        "",
        "## 原始条目（迁移保留，一个字没改）",
        "",
        f"> 来自 `output/questions/_原表快照.md` 第 {row.lineno} 行，"
        f"「{_one_line(row.section)}」一节，原序号 `{_clean(row.num_raw)}`"
        + (f"，原优先级「{row.priority}」" if row.priority and row.priority not in ("—", "-") else "")
        + "。原优先级已废弃，排序轴换成 `blocks`。",
        "",
        "```text",
        row.line,
        "```",
    ]
    if row.section_note:
        lines += [
            "",
            "分节引言（溯源锚点从分节挪到了条目，这段留着备查）：",
            "",
            "```text",
            row.section_note,
            "```",
        ]
    lines += ["", "## 结论", "", "## 人工反馈", ""]
    return "\n".join(lines)


def render_review(rows: list[Row], today: str, source: Path) -> str:
    flagged = [r for r in rows if r.flags]
    conflicts = [r for r in rows if r.status == "conflict"]
    no_evidence = [r for r in rows if r.status == "answered"]
    not_questions = [r for r in rows if any("不像一个问题" in f for f in r.flags)]
    forked = [r for r in rows if any("分叉编号" in f for f in r.flags)]
    ragged = [r for r in rows if r.ragged]
    truncated = [r for r in rows if any("标题从" in f for f in r.flags)]

    out = [
        "# 迁移待人工裁定清单",
        "",
        f"> {today} 由 `scripts/migrate_questions.py` 从 `{source.name}` 生成。",
        "> 裁定完这份清单就可以删掉 —— 它不是问题文件，看板不会扫它。",
        "",
        "迁移**只搬运不推断**，所以下面这些都留给人。`blocks` 与 `evidence` 全部空着，",
        "先补在途交付物相关的那几组，其余留空沉 backlog 就行，不必一次补完。",
        "",
        "| 条目 | 数量 |",
        "| --- | --- |",
        f"| 迁移总数 | {len(rows)} |",
        f"| 状态冲突（正文说已解决、序号没划掉） | {len(conflicts)} |",
        f"| 已关闭但缺凭据 | {len(no_evidence)} |",
        f"| 疑似不是问题 | {len(not_questions)} |",
        f"| 分叉编号 | {len(forked)} |",
        f"| 拆格数不对 | {len(ragged)} |",
        f"| 标题被截断，待改写 | {len(truncated)} |",
        "",
        "校验脚本会把「已关闭但缺凭据」全部报成错误 —— **那是预期的**，",
        "它就是这份工作清单的可执行版本：",
        "",
        "```bash",
        "python3 scripts/check_questions.py",
        "```",
        "",
    ]

    def block(title: str, items: list[Row], hint: str) -> None:
        if not items:
            return
        out.extend([f"## {title}（{len(items)}）", "", hint, ""])
        for r in items:
            out.append(f"- [ ] `{r.qid}` — {_one_line(r.question, 70)}")
        out.append("")

    block(
        "状态冲突，等人裁定",
        conflicts,
        "正文写着「已解决 / 不再阻塞 / 已定案」但序号没划掉。这几条语义各不相同"
        "（已解决 / 部分解决 / 改写升级为另一条…），机械判定必错，逐条看完再改成 "
        "`answered`（并补 `evidence`）或 `open`。",
    )
    block(
        "疑似不是问题",
        not_questions,
        "没有问号，可能是会议话术、备忘或结论。真不是问题的置 `dropped`，`human_answer: drop`。",
    )
    block(
        "已关闭但缺凭据",
        no_evidence,
        "原表格里序号被划掉的条目。补 `evidence`：`客户确认` / `资料实证` / `我方决策`。"
        "**当初就是凭推断关的，改回 `open`** —— 推断不能关闭问题。",
    )
    block(
        "分叉编号",
        forked,
        "原表格里用了 `16b`、`61（续）` 这类编号。文件名保留了字母后缀，"
        "但别的文档里写「见 Q16b」的地方要核一遍。",
    )
    block(
        "标题被截断，待改写",
        truncated,
        "原单元格几百字，截到第一个问号或 60 字。**原文一个字没丢**，在问题文件的「原始条目」里。"
        "改写成一句通顺的问句 —— 清单上只显示 `title`，它不通顺整份清单就难读。",
    )
    block(
        "拆格数不对",
        ragged,
        "单元格里可能有没转义的 `|`。整行原文已保留在问题文件的「原始条目」里，对着看一眼字段有没有串位。",
    )

    out.extend(["## 全部标记明细", "", "| 编号 | 标记 |", "| --- | --- |"])
    for r in flagged:
        out.append(f"| `{r.qid}` | {'；'.join(r.flags)} |")
    out.append("")
    return "\n".join(out)


def archive_source(source: Path, target_dir: Path, write: bool) -> str:
    """把原表格搬进问题目录存成 `_原表快照.md`，开头加一句指向说明。

    **正文一个字不删**，留着回滚。搬家而不是留在原地，是因为它既是溯源终点
    （没有更深来源的条目 `source` 直接指向它），又不该一直占着分析产物清单的位置。
    """
    archived = target_dir / ARCHIVE_NAME
    if archived.exists():
        return f"{ARCHIVE_NAME} 已存在，跳过"
    text = source.read_text(encoding="utf-8")
    if POINTER in text:
        return "原表格开头已有指向说明，跳过"
    lines = text.split("\n")
    insert_at = 1 if lines and lines[0].startswith("# ") else 0
    block = [
        "",
        POINTER,
        ">",
        "> 下面的表格是**迁移前的原样快照**，一个字没删，留着回滚用；**不要再往里追加新问题**。",
        "> 字段契约见 [`README.md`](README.md)。",
        "",
    ]
    lines[insert_at:insert_at] = block
    if write:
        archived.write_text("\n".join(lines), encoding="utf-8")
        source.unlink()
    return f"原表已搬进 {archived.parent.name}/{ARCHIVE_NAME} 并加指向说明（正文未改动）"


def main() -> int:
    ap = argparse.ArgumentParser(description="把旧的 open-questions.md 表格迁移成一问一文件")
    ap.add_argument("--source", default="", help=f"旧清单（默认 {DEFAULT_SOURCE}）")
    ap.add_argument("--target", default="", help=f"问题目录（默认 {DEFAULT_TARGET}）")
    ap.add_argument("--write", action="store_true", help="落盘。不加这个就是预演")
    args = ap.parse_args()

    source = Path(args.source).expanduser().resolve() if args.source else DEFAULT_SOURCE
    target = Path(args.target).expanduser().resolve() if args.target else DEFAULT_TARGET
    if not source.is_file():
        print(f"找不到旧清单：{source}", file=sys.stderr)
        return 2

    rows, notes = parse_table(source)
    for note in notes:
        print(f"注意：{note}")
    if not rows:
        return 1

    assign_ids(rows)
    for row in rows:
        classify(row)

    today = dt.date.today().isoformat()
    existing = {p.stem for p in target.glob("Q*.md")} if target.is_dir() else set()
    skipped = [r for r in rows if r.qid in existing]
    todo = [r for r in rows if r.qid not in existing]

    counts = {s: sum(1 for r in rows if r.status == s) for s in ("open", "conflict", "answered")}
    print(f"源：{source}")
    print(f"目标：{target}")
    print(f"解析到 {len(rows)} 条（open {counts['open']} / conflict {counts['conflict']} / answered {counts['answered']}）")
    if skipped:
        print(f"已存在跳过 {len(skipped)} 条：{', '.join(r.qid for r in skipped[:8])}{' …' if len(skipped) > 8 else ''}")
    print(f"待写入 {len(todo)} 条，带标记 {sum(1 for r in rows if r.flags)} 条")

    if not args.write:
        print("\n这是预演，什么都没写。确认无误后加 --write。")
        print("抽样（前 3 条）：")
        for row in todo[:3]:
            print(f"\n----- {row.qid}.md -----")
            print("\n".join(render(row, today).split("\n")[:14]))
        return 0

    target.mkdir(parents=True, exist_ok=True)
    for row in todo:
        (target / f"{row.qid}.md").write_text(render(row, today), encoding="utf-8")
    review = target / "MIGRATION-REVIEW.md"
    review.write_text(render_review(rows, today, source), encoding="utf-8")
    print(f"\n已写入 {len(todo)} 份问题文件")
    print(f"待裁定清单：{review}")
    print(archive_source(source, target, True))
    print("\n下一步：python3 scripts/check_questions.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
