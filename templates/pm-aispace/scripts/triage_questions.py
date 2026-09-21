#!/usr/bin/env python3
"""迁移之后的补齐：填一张表，批量落 `blocks` 与 `evidence`。

为什么要有这一步
----------------
`migrate_questions.py` 只搬运不推断，所以刚迁完 `blocks` 与 `evidence` 全是空的。
两百多条逐个开文件改，没人改得完 —— 改不完就等于迁移白做，清单还是那份没人看的清单。

但**它们不是两百多个决定**：

- `blocks` 是**按分节**定的。旧表格的分节本来就是按交付物攒的，
  一节填一个交付物名，39 个分节就是 39 个决定，其中大半看名字就知道。
- `evidence` 只有已关闭的那些缺，而当初为什么关的就写在正文里，一条扫两秒。

所以这个脚本把「决定」和「落盘」拆开：你在一张表上做决定，脚本负责改那两百多个文件。

用法
----
    python3 scripts/triage_questions.py --plan      # 生成/刷新 questions/TRIAGE.md
    # —— 人打开 TRIAGE.md 填空 ——
    python3 scripts/triage_questions.py --apply     # 预演，只说要改什么
    python3 scripts/triage_questions.py --apply --write

只写 `blocks` 与 `evidence` 两个字段，**逐行替换**，正文与其它字段一个字节不动。
已经填过值的条目默认跳过（`--force` 才覆盖）—— 重跑安全。

不推断这条底线没有松
--------------------
表里会给凭据**建议值**，但只在闭包说明里的信号唯一时给，且旁边一定贴着原句。
信号含糊或没有的一律留空，**逼你自己看一眼**。
脚本从头到尾不会替你把一个空的凭据变成有值的。

`evidence` 填 `我方推断` 的，落盘时 `status` 会被退回 `open` —— 推断不能关闭问题。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from questions_fm import as_text, is_blank, parse_frontmatter  # noqa: E402

HERE = Path(__file__).resolve().parent
DEFAULT_DIR = HERE.parent / "output" / "analysis" / "questions"
SHEET = "TRIAGE.md"

EVIDENCES = ["客户确认", "资料实证", "我方决策", "我方推断"]

# 闭包说明里的凭据信号。**只在恰好命中一类时**才敢给建议值，命中多类或一类都不中的留空。
SIGNALS = {
    "我方决策": r"决策\s*\d{3,4}|output/decisions/|评审定案|内部评审|本期不做",
    "客户确认": r"客户(意见|确认|答复|明确|回复)|甲方(确认|明确|答复)|对方(确认|明确|答复)|会上明确|响应说明",
    "资料实证": r"input/converted/|资料入库|已转换入库|导出数据|实测|对拍",
}

SECTION_RE = re.compile(r"^###\s+(.+?)\s*·")
IDS_RE = re.compile(r"^<!--\s*ids:\s*(.*?)\s*-->$")
BLOCKS_RE = re.compile(r"^blocks:\s*(.*)$")
EVIDENCE_LINE_RE = re.compile(r"^-\s+\[(Q\d{4}[a-z]?)\]\s*(.*?)\s*(?:←.*)?$")


class Q:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.text = path.read_text(encoding="utf-8")
        self.meta, self.body, self.raw = parse_frontmatter(self.text)
        self.id = as_text(self.meta.get("id")) or path.stem
        self.status = as_text(self.meta.get("status"))
        self.blocks = as_text(self.meta.get("blocks"))
        self.evidence = as_text(self.meta.get("evidence"))
        self.title = as_text(self.meta.get("title"))
        m = re.search(r"「(.+?)」", as_text(self.meta.get("context")))
        self.section = m.group(1) if m else "（无分节）"

    def closing_note(self) -> str:
        """闭包说明 —— 正文「为什么需要」那段，迁移时把 ✅ 原话搬在这里。"""
        head = self.body.split("## 原始条目")[0]
        head = head.replace("## 为什么需要", "")
        return " ".join(head.split())

    def suggest_evidence(self) -> str:
        note = self.closing_note()
        hits = [k for k, p in SIGNALS.items() if re.search(p, note)]
        return hits[0] if len(hits) == 1 else ""

    def set_field(self, key: str, value: str) -> bool:
        """逐行替换 front-matter 里的一个键，其余字节不动。键不存在就不写。"""
        lines = self.text.split("\n")
        end = next((i for i, ln in enumerate(lines[1:], 1) if ln.strip() == "---"), -1)
        if end == -1:
            return False
        pat = re.compile(rf"^{re.escape(key)}:")
        for i in range(1, end):
            if pat.match(lines[i]):
                lines[i] = f"{key}: {value}" if value else f"{key}:"
                self.text = "\n".join(lines)
                return True
        return False

    def save(self) -> None:
        tmp = self.path.with_suffix(".md.tmp")
        tmp.write_text(self.text, encoding="utf-8")
        tmp.replace(self.path)


def load(directory: Path) -> list[Q]:
    out = []
    for p in sorted(directory.glob("Q*.md")):
        q = Q(p)
        if q.raw:
            out.append(q)
    return out


def has_answers(path: Path) -> bool:
    """表里填过东西没有 —— 填了一半被 --plan 冲掉，谁都受不了。"""
    if not path.is_file():
        return False
    blocks, evidence = read_plan(path)
    return bool(blocks or evidence)


def write_plan(directory: Path, qs: list[Q]) -> Path:
    sections: dict[str, list[Q]] = {}
    for q in qs:
        sections.setdefault(q.section, []).append(q)
    ordered = sorted(sections.items(), key=lambda kv: -sum(1 for q in kv[1] if q.status in ("open", "conflict")))
    need_evidence = [q for q in qs if q.status == "answered" and not q.evidence]

    out = [
        "# 迁移补齐工作表",
        "",
        "> 由 `scripts/triage_questions.py --plan` 生成。填完跑",
        "> `python3 scripts/triage_questions.py --apply` 看预演，再加 `--write` 落盘。",
        "> 重新 `--plan` 会按当前数据刷新本表，**你填过的内容会丢**，所以填完就 apply。",
        "",
        "两件事，分开做，都不用逐条看两百多遍。",
        "",
        "---",
        "",
        "## A · 按分节定 `blocks`",
        "",
        "`blocks` 回答的是「这条卡住了哪个**在途**交付物」，它取代了原来的高/中/低优先级 ——",
        "优先级是自评，必然通胀（存量里未关闭的一半标着「高」）。",
        "",
        "**怎么填**：每节的 `blocks:` 后面写一个在途交付物名（自己起，前后保持一致）。",
        "不阻塞任何在途交付物的写 `backlog` —— 它们不会在看板主视图里占位置，但搜得到、能拉回来。",
        "**留空 = 本次不动这一节**，下次再说。",
        "",
        "不必一次填完。先把手头真在做的那几节填了，其余整片写 `backlog`，就已经够用了。",
        "",
    ]
    for name, items in ordered:
        live = sum(1 for q in items if q.status in ("open", "conflict"))
        done = sum(1 for q in items if q.status == "answered")
        todo = [q for q in items if is_blank(q.meta.get("blocks"))]
        out += [
            f"### {name} · 未关闭 {live} · 已关闭 {done} · 待填 {len(todo)}",
            "",
            "blocks: ",
            f"<!-- ids: {' '.join(q.id for q in items)} -->",
            "",
        ]

    out += [
        "---",
        "",
        f"## B · 已关闭条目的凭据（{len(need_evidence)} 条）",
        "",
        "这些条目在旧表格里序号被划掉了 = 当初关掉了，但**凭什么关的没记下来**。",
        "校验脚本会把它们全报成错误，那不是 bug，就是这份清单。",
        "",
        f"四选一：{' / '.join(f'`{e}`' for e in EVIDENCES)}。判断依据是下面引的闭包原句：",
        "",
        "| 填什么 | 什么时候 |",
        "| --- | --- |",
        "| `客户确认` | 对方书面或会上明确答复过 |",
        "| `资料实证` | 资料里查得到，说得出是哪一份 |",
        "| `我方决策` | 我方拍的板，有决策记录 |",
        "| `我方推断` | 当初其实是猜的 —— **落盘时这条会被退回 `open`**，推断不能关闭问题 |",
        "",
        "带 `←建议` 的是脚本按原句里的信号猜的，**只在信号唯一时才给**，照样要你看一眼再留下。",
        "没有建议值的是信号含糊或压根没有的，只能你判。留空 = 这条本次不动。",
        "",
    ]
    for q in need_evidence:
        guess = q.suggest_evidence()
        mark = f"{guess}   ←建议，请核" if guess else ""
        note = q.closing_note()
        out += [
            f"- [{q.id}] {mark}",
            f"  > {note[:150]}{'…' if len(note) > 150 else ''}",
            "",
        ]
    path = directory / SHEET
    path.write_text("\n".join(out), encoding="utf-8")
    return path


def read_plan(path: Path) -> tuple[dict[str, str], dict[str, str]]:
    """把填好的表读回来：{分节 -> blocks}、{编号 -> evidence}。"""
    blocks: dict[str, str] = {}
    evidence: dict[str, str] = {}
    section = ""
    ids: list[str] = []
    pending = ""
    for line in path.read_text(encoding="utf-8").split("\n"):
        m = SECTION_RE.match(line)
        if m:
            section, ids, pending = m.group(1), [], ""
            continue
        m = BLOCKS_RE.match(line)
        if m and section:
            pending = m.group(1).strip()
            continue
        m = IDS_RE.match(line)
        if m and section:
            ids = m.group(1).split()
            if pending:
                for qid in ids:
                    blocks[qid] = pending
            continue
        m = EVIDENCE_LINE_RE.match(line)
        if m and m.group(2).strip():
            evidence[m.group(1)] = m.group(2).strip()
    return blocks, evidence


def apply(directory: Path, qs: list[Q], write: bool, force: bool) -> int:
    sheet = directory / SHEET
    if not sheet.is_file():
        print(f"还没有 {sheet.name} —— 先跑 --plan 生成工作表", file=sys.stderr)
        return 2
    blocks, evidence = read_plan(sheet)
    if not blocks and not evidence:
        print(f"{sheet.name} 里一个空都没填，没什么可落的。")
        return 0

    bad = {qid: v for qid, v in evidence.items() if v not in EVIDENCES}
    if bad:
        print("凭据取值不对，这几条必须改（四选一）：", file=sys.stderr)
        for qid, v in bad.items():
            print(f"  {qid}: {v}", file=sys.stderr)
        return 1

    by_id = {q.id: q for q in qs}
    changed_b, changed_e, reopened, skipped = [], [], [], []
    for qid, value in blocks.items():
        q = by_id.get(qid)
        if not q:
            continue
        if q.blocks and not force:
            skipped.append(f"{qid} 的 blocks 已是「{q.blocks}」")
            continue
        if q.set_field("blocks", value):
            changed_b.append((qid, value))
    for qid, value in evidence.items():
        q = by_id.get(qid)
        if not q:
            continue
        if q.evidence and not force:
            skipped.append(f"{qid} 的 evidence 已是「{q.evidence}」")
            continue
        if q.set_field("evidence", value):
            changed_e.append((qid, value))
            # 推断不能关闭问题 —— 这不是可配置的，是契约本身。
            if value == "我方推断" and q.status == "answered":
                q.set_field("status", "open")
                reopened.append(qid)

    print(f"blocks 待写 {len(changed_b)} 条，evidence 待写 {len(changed_e)} 条")
    if reopened:
        print(f"其中 {len(reopened)} 条凭据是「我方推断」，status 一并退回 open：{' '.join(reopened)}")
    if skipped:
        print(f"跳过 {len(skipped)} 条（已有值，要覆盖加 --force）")
        for s in skipped[:5]:
            print(f"  · {s}")
        if len(skipped) > 5:
            print(f"  · …另 {len(skipped) - 5} 条")
    if not write:
        print("\n这是预演，什么都没写。确认后加 --write。")
        for qid, v in (changed_b[:3] + changed_e[:3]):
            print(f"  {qid} → {v}")
        return 0

    touched = {qid for qid, _ in changed_b} | {qid for qid, _ in changed_e}
    for qid in touched:
        by_id[qid].save()
    print(f"\n已改 {len(touched)} 个文件。下一步：python3 scripts/check_questions.py")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="迁移后按分节批量补 blocks、按条补 evidence")
    ap.add_argument("directory", nargs="?", default="", help=f"问题目录（默认 {DEFAULT_DIR}）")
    ap.add_argument("--plan", action="store_true", help=f"生成/刷新 {SHEET} 工作表")
    ap.add_argument("--apply", action="store_true", help=f"把填好的 {SHEET} 落盘")
    ap.add_argument("--write", action="store_true", help="配合 --apply：真的写文件")
    ap.add_argument("--force", action="store_true", help="--apply 时覆盖已有值的字段；--plan 时允许冲掉填过的表")
    args = ap.parse_args()

    directory = Path(args.directory).expanduser().resolve() if args.directory else DEFAULT_DIR
    if not directory.is_dir():
        print(f"找不到问题目录：{directory}", file=sys.stderr)
        return 2
    if args.plan == args.apply:
        print("要么 --plan（出表），要么 --apply（落盘），二选一", file=sys.stderr)
        return 2

    qs = load(directory)
    if not qs:
        print(f"{directory} 下没有问题文件")
        return 0

    if args.plan:
        sheet = directory / SHEET
        if has_answers(sheet) and not args.force:
            print(f"{sheet.name} 里已经填过内容了，刷新会冲掉。", file=sys.stderr)
            print("先跑 --apply --write 把它落盘，或者确认要丢就加 --force。", file=sys.stderr)
            return 2
        path = write_plan(directory, qs)
        live = sum(1 for q in qs if q.status in ("open", "conflict"))
        need = sum(1 for q in qs if q.status == "answered" and not q.evidence)
        print(f"工作表：{path}")
        print(f"A 段 {len({q.section for q in qs})} 个分节要定 blocks（覆盖 {live} 条未关闭）")
        print(f"B 段 {need} 条已关闭要补 evidence")
        print("\n填完跑：python3 scripts/triage_questions.py --apply")
        return 0
    return apply(directory, qs, args.write, args.force)


if __name__ == "__main__":
    raise SystemExit(main())
