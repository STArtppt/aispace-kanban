#!/usr/bin/env python3
"""给 `output/decisions/` 下的存量决策各建一份产出物记录。

字段契约见 [`output/records/README.md`](../output/records/README.md)。

为什么需要这一步
----------------
决策的状态一直写在正文 bullet 里（`- 状态：已确认 | 待确认 | 已推翻（被 0007 取代）`）。
那行是给人读的，**解析器读不到它** —— 看板抽的是 front-matter，
所以失效的决策在列表里和生效的长得一模一样。

这个脚本把状态搬进记录的 front-matter，让它变成可解析、可分组、可就地改的字段。

**决策文件本身一个字节都不动**，正文那行 bullet 照样留着：
它是给人读的，删了反而丢信息。两处并存不是冗余 —— front-matter 给机器，bullet 给人。

不推断
------
正文里读不出状态、或者写法不认识的，一律标成**待人工确认**
（`status: pending`，并在状态流水里写明是脚本没读出来），**不猜一个填进去**。
猜出来的状态看着合理、实际靠不住，比留着「待确认」危险 ——
后者会被人看见，前者不会。

用法
----
    python3 scripts/migrate_decisions.py              # 预演，不落盘（默认）
    python3 scripts/migrate_decisions.py --write      # 确认后落盘

已经有记录指向的决策一律跳过（按 `target` 判断），所以重跑是安全的。
"""

from __future__ import annotations

import argparse
import datetime as dt
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from questions_fm import as_text, parse_frontmatter  # noqa: E402

HERE = Path(__file__).resolve().parent
WS = HERE.parent
DECISIONS_DIR = WS / "output" / "decisions"
RECORDS_DIR = WS / "output" / "records"

# 记录编号形态，与 output/records/README.md 一致
RECORD_FILE_RE = re.compile(r"^I(\d{4})\.md$")

# 正文里那行状态。宽松匹配：全角/半角冒号、`状态` 前可有 `-`/`*`/空格、可加粗
STATUS_LINE_RE = re.compile(r"^[\s>*-]*\**\s*状态\s*\**\s*[:：]\s*(.+?)\s*$", re.M)

# 中文状态 → 记录状态机的值。**只认这三种写法**，别的交人工
STATUS_WORDS = [
    ("已推翻", "overturned"),
    ("已确认", "confirmed"),
    ("待确认", "pending"),
]

# 「被 0007 取代」「被 0007 推翻」里的决策序号 —— 它是决策文件名的序号，不是记录编号，
# 所以要再查一次那条决策对应的记录编号
SUPERSEDER_RE = re.compile(r"被\s*(\d{1,4})\s*(?:号)?\s*(?:取代|替代|推翻|覆盖)")

# 决策文件名：`0001-短标题.md`
DECISION_FILE_RE = re.compile(r"^(\d{1,4})-(.+)\.md$")


def today() -> str:
    return dt.date.today().isoformat()


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        print(f"读不出来，跳过：{path.name}（{exc}）", file=sys.stderr)
        return ""


def parse_status(body: str) -> tuple[str, str, str]:
    """从正文读状态。返回 (status, 取代方决策序号, 读出来的原文)。

    读不出来时 status 为空 —— 调用方据此标成待人工确认，**不猜**。
    """
    for m in STATUS_LINE_RE.finditer(body):
        raw = m.group(1).strip()
        # 模板示例那行把三个值用 `|` 并排列着（`已确认 | 待确认 | 已推翻`），
        # 它是说明不是取值。命中多于一个词就当读不出来，交人工
        hit = [value for word, value in STATUS_WORDS if word in raw]
        if len(hit) != 1:
            continue
        seq = SUPERSEDER_RE.search(raw)
        return hit[0], (seq.group(1).zfill(4) if seq else ""), raw
    return "", "", ""


def first_h1(body: str) -> str:
    m = re.search(r"^#\s+(.+?)\s*$", body, re.M)
    return m.group(1).strip() if m else ""


def existing_records() -> tuple[dict[str, str], int]:
    """已有记录：`target` → 编号，以及当前最大编号。"""
    by_target: dict[str, str] = {}
    largest = 0
    if not RECORDS_DIR.is_dir():
        return by_target, largest
    for path in sorted(RECORDS_DIR.glob("*.md")):
        matched = RECORD_FILE_RE.match(path.name)
        if not matched:
            continue
        largest = max(largest, int(matched.group(1)))
        meta, _, _ = parse_frontmatter(read_text(path))
        target = as_text(meta.get("target"))
        if target:
            by_target[target] = path.stem
    return by_target, largest


def history_max() -> int:
    """空目录不等于从 I0001 开始：先查版本历史里用过的最大编号。

    编号是外部引用的锚点，复用一个旧编号会让此前所有引用指向一条内容无关的新记录 ——
    那比悬空引用危险，因为它看起来完全正常。查不到才从 1 开始。
    """
    import subprocess

    try:
        out = subprocess.run(
            ["git", "log", "--all", "--name-only", "--pretty=format:", "--", "output/records"],
            cwd=WS,
            capture_output=True,
            text=True,
            timeout=20,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return 0
    used = [int(n) for n in re.findall(r"I(\d{4})", out)]
    return max(used) if used else 0


def render(record_id: str, title: str, target: str, status: str, note: str) -> str:
    """记录文件的内容。`resolved_by` 由调用方在第二遍补上（要先知道全部编号）。"""
    return (
        "---\n"
        f"id: {record_id}\n"
        "kind: decisions\n"
        f"title: {title}\n"
        f"target: {target}\n"
        f"status: {status}\n"
        f"created: {today()}\n"
        f"status_changed: {today()}\n"
        f"updated: {today()}\n"
        "resolved_by:\n"
        "---\n"
        "\n"
        "## 这份产出物是什么\n"
        "\n"
        f"决策记录 [{Path(target).name}](../decisions/{Path(target).name})。\n"
        "这份记录由 `scripts/migrate_decisions.py` 建立，只搬状态，正文没有搬过来。\n"
        "\n"
        "## 状态流水\n"
        "\n"
        f"### {today()} · {status}\n"
        "\n"
        f"{note}\n"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="给存量决策各建一份产出物记录（状态从正文 bullet 搬进 front-matter）")
    ap.add_argument("--write", action="store_true", help="落盘。不加这个就是预演")
    args = ap.parse_args()

    if not DECISIONS_DIR.is_dir():
        print(f"没有 {DECISIONS_DIR.relative_to(WS)} 目录，没有决策要迁移。", file=sys.stderr)
        return 2
    decisions = [p for p in sorted(DECISIONS_DIR.glob("*.md")) if p.name.lower() != "readme.md"]
    if not decisions:
        print("决策目录里还没有决策文件，没有要迁移的。")
        return 0

    by_target, largest = existing_records()
    next_no = max(largest, history_max()) + 1

    plan: list[dict] = []
    # 决策序号 → 记录编号，第二遍用来把「被 0007 取代」翻成 resolved_by
    seq_to_record: dict[str, str] = {}

    for path in decisions:
        target = f"output/decisions/{path.name}"
        if target in by_target:
            print(f"已有记录 {by_target[target]} 指向 {path.name}，跳过")
            seq = DECISION_FILE_RE.match(path.name)
            if seq:
                seq_to_record[seq.group(1).zfill(4)] = by_target[target]
            continue
        text = read_text(path)
        if not text:
            continue
        _, body, _ = parse_frontmatter(text)
        status, superseder, raw = parse_status(body)
        title = first_h1(body) or path.stem
        record_id = f"I{next_no:04d}"
        next_no += 1
        seq = DECISION_FILE_RE.match(path.name)
        if seq:
            seq_to_record[seq.group(1).zfill(4)] = record_id
        plan.append(
            {
                "record_id": record_id,
                "path": path,
                "target": target,
                "title": title,
                "status": status or "pending",
                "unreadable": not status,
                "raw": raw,
                "superseder_seq": superseder,
            }
        )

    if not plan:
        print("\n每条决策都已经有记录了，没有要新建的。")
        return 0

    print(f"\n将新建 {len(plan)} 份记录：")
    for item in plan:
        mark = "（正文读不出状态，标成待人工确认）" if item["unreadable"] else f"（正文：{item['raw']}）"
        print(f"  {item['record_id']}  {item['status']:<11} ← {item['path'].name} {mark}")

    pending_review = [i for i in plan if i["unreadable"]]
    if pending_review:
        print(f"\n其中 {len(pending_review)} 条要人过一遍（脚本不猜状态）：")
        for item in pending_review:
            print(f"  {item['record_id']}  {item['path'].name}")

    # 「被 0007 取代」→ resolved_by。指不到（那条决策不在目录里）就留空并点名
    dangling = []
    for item in plan:
        seq = item["superseder_seq"]
        if not seq:
            continue
        found = seq_to_record.get(seq)
        if found:
            item["resolved_by"] = found
        else:
            dangling.append((item["record_id"], seq))
    if dangling:
        print("\n这些条目正文写着被某条决策取代，但那条决策在目录里找不到，`resolved_by` 留空待人工补：")
        for record_id, seq in dangling:
            print(f"  {record_id}  被 {seq} 取代")

    if not args.write:
        print("\n这是预演，什么都没写。确认无误后加 --write。")
        return 0

    RECORDS_DIR.mkdir(parents=True, exist_ok=True)
    for item in plan:
        note = (
            "脚本迁移：正文里读不出状态（没有那行 `- 状态：…`，或者写法不认识），"
            "先按待确认放着，**请人看一眼决策正文再改**。"
            if item["unreadable"]
            else f"脚本迁移：状态从决策正文那行「{item['raw']}」搬进 front-matter，正文那行保留不动。"
        )
        text = render(item["record_id"], item["title"], item["target"], item["status"], note)
        if item.get("resolved_by"):
            text = text.replace("resolved_by:\n", f"resolved_by: {item['resolved_by']}\n", 1)
        out = RECORDS_DIR / f"{item['record_id']}.md"
        if out.exists():
            print(f"已存在，不覆盖：{out.name}")
            continue
        out.write_text(text, encoding="utf-8")
        print(f"写入 {out.relative_to(WS)}")

    print(f"\n完成。决策文件一个字节都没改 —— 正文那行 `- 状态：…` 照样留着，它是给人读的。")
    print("接着跑 python3 scripts/check_markdown.py 看一眼新建的记录是否合法。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
