#!/usr/bin/env python3
"""把看板缓存里的批注批次搬进 `output/records/notes/`。

缓存的位置是 `~/.pmwork/dashboard/note-history/<工作空间 id>.json`，
键是工作空间相对路径。本脚本按记录的 `target` 反查编号，
写进 `output/records/notes/I<编号>.md`。

不推断
------
搬过来的状态一律是 `pending`。这些批次当年没有回执，
不能因为文档后来被改过就当成已处理。批次标题上标「迁移自看板缓存」。

没命中的不删
------------
某个路径在 `output/records/` 里找不到 `target` 与之相等的记录时，
这一批留在缓存里，本脚本不改那个 JSON。

用法
----
    python3 scripts/migrate_note_history.py              # 预演，不落盘（默认）
    python3 scripts/migrate_note_history.py --write      # 确认后落盘
    python3 scripts/migrate_note_history.py --id <编号>  # 注册表里对不上本目录时指定

再跑一次是安全的：按「源码区间 + 原文 + 意见」去重，已经在文件里的不再追加。
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from questions_fm import as_text, parse_frontmatter  # noqa: E402

HERE = Path(__file__).resolve().parent
WS = HERE.parent
RECORDS_DIR = WS / "output" / "records"
NOTES_DIR = RECORDS_DIR / "notes"

RECORD_FILE_RE = re.compile(r"^I(\d{4})\.md$")
NOTE_ID_RE = re.compile(r"^###[ \t]+N(\d{4})\b", re.M)
BATCH_INDEX_RE = re.compile(r"^##[ \t]+\d{4}-\d{2}-\d{2}[ \t]*·[ \t]*第[ \t]*(\d+)[ \t]*批", re.M)
NOTE_HEADING_RE = re.compile(r"^###[ \t]+(N\d{4})[ \t]*·[ \t]*(\S+)[ \t]*$")
FIELD_RE = re.compile(r"^-[ \t]*(状态|回执|源码区间|来源)[ \t]*[:：][ \t]?(.*)$")
OPINION_RE = re.compile(r"^(?:-[ \t]*)?意见[ \t]*[:：][ \t]?(.*)$")

STRUCTURES = {"段落", "表格行", "列表项", "跨块"}


def today() -> str:
    return dt.date.today().isoformat()


def normalize_rel(value: str) -> str:
    text = value.replace("\\", "/")
    while text.startswith("./"):
        text = text[2:]
    return text.rstrip("/")


def history_name(project_id: str) -> str:
    """与看板 `note-history.mjs` 的文件名规则一致：非法字符换成下划线。"""
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", project_id) or "workspace"
    return f"{safe}.json"


def fingerprint(start: int | None, end: int | None, quote: str, comment: str) -> str:
    """与 `src/server/notes.mjs` 的指纹同一口径：区间 + 原文 + 意见。"""
    s = "" if start is None else str(start)
    e = "" if end is None else str(end)
    return f"{s},{e}\0{quote}\0{comment}"


def load_targets() -> dict[str, str]:
    """`target` → 记录编号。同路径有多条时留编号最小的那条。"""
    found: dict[str, str] = {}
    if not RECORDS_DIR.is_dir():
        return found
    files = sorted(p for p in RECORDS_DIR.iterdir() if p.is_file() and RECORD_FILE_RE.match(p.name))
    for path in files:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        meta, _, _ = parse_frontmatter(text)
        target = normalize_rel(as_text(meta.get("target")))
        if not target or target in found:
            continue
        found[target] = path.stem
    return found


def _fingerprints_from_walk(text: str) -> set[str]:
    """`parse` 的实际实现：边扫边收，避免上面那份半截状态。"""
    found: set[str] = set()
    note: dict | None = None

    def finish() -> None:
        nonlocal note
        if not note:
            return
        quote = "\n".join(note["quote_lines"])
        comment = "\n".join(note["comment_lines"])
        found.add(fingerprint(note["start"], note["end"], quote, comment))
        note = None

    for line in text.splitlines():
        if NOTE_HEADING_RE.match(line):
            finish()
            note = {"start": None, "end": None, "quote_lines": [], "comment_lines": [], "mode": ""}
            continue
        if line.startswith("## "):
            finish()
            continue
        if not note:
            continue
        field = FIELD_RE.match(line)
        if field:
            note["mode"] = ""
            if field.group(1) == "源码区间":
                span = re.match(r"^(\d+)\s*,\s*(\d+)$", field.group(2).strip())
                if span:
                    note["start"] = int(span.group(1))
                    note["end"] = int(span.group(2))
            continue
        if line.startswith(">"):
            note["mode"] = "quote"
            note["quote_lines"].append(re.sub(r"^>[ \t]?", "", line))
            continue
        opinion = OPINION_RE.match(line)
        if opinion:
            note["mode"] = "comment"
            note["comment_lines"].append(opinion.group(1))
            continue
        if note["mode"] == "quote":
            if not line.strip():
                note["mode"] = ""
            continue
        if note["mode"] == "comment":
            if not line.strip():
                note["mode"] = ""
                continue
            note["comment_lines"].append(line)
    finish()
    return found


def max_note_number(text: str) -> int:
    nums = [int(n) for n in NOTE_ID_RE.findall(text)]
    return max(nums) if nums else 0


def max_batch_index(text: str) -> int:
    nums = [int(n) for n in BATCH_INDEX_RE.findall(text)]
    return max(nums) if nums else 0


def batch_date(archived_at: object) -> str:
    if isinstance(archived_at, str) and re.match(r"^\d{4}-\d{2}-\d{2}", archived_at):
        return archived_at[:10]
    return today()


def render_note(note_id: str, note: dict) -> str:
    structure = note.get("structure") if note.get("structure") in STRUCTURES else "段落"
    start = note.get("start")
    end = note.get("end")
    if isinstance(start, (int, float)) and isinstance(end, (int, float)) and end >= start:
        span = f"{int(start)},{int(end)}"
        start_i, end_i = int(start), int(end)
    else:
        span = ""
        start_i = end_i = None
    quote = note.get("quote") if isinstance(note.get("quote"), str) else ""
    comment = note.get("comment") if isinstance(note.get("comment"), str) else ""
    quoted = "\n".join(f"> {line}" for line in quote.split("\n")) if quote else ">"
    return "\n".join(
        [
            f"### {note_id} · {structure}",
            "",
            "- 状态：pending",
            "- 回执：",
            f"- 源码区间：{span}",
            "- 来源：迁移",
            "",
            quoted,
            "",
            f"意见：{comment}",
            "",
        ]
    ), fingerprint(start_i, end_i, quote, comment)


def render_batch(date: str, index: int, blocks: list[str]) -> str:
    return "\n".join([f"## {date} · 第 {index} 批 · 迁移自看板缓存", "", *blocks])


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def find_history(project_id: str | None) -> tuple[Path | None, str]:
    """返回 (缓存文件, 说明)。对不上注册表时说明里写为什么。"""
    if project_id:
        path = Path.home() / ".pmwork" / "dashboard" / "note-history" / history_name(project_id)
        return path, project_id
    registry = Path.home() / ".pmwork" / "dashboard" / "projects.json"
    try:
        data = json.loads(registry.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return None, f"读不到看板注册表（{exc}）。用 --id 指定工作空间编号"
    projects = data.get("projects") if isinstance(data, dict) else None
    if not isinstance(projects, list):
        return None, "看板注册表里没有 projects。用 --id 指定工作空间编号"
    ws = str(WS.resolve())
    hits = []
    for item in projects:
        if not isinstance(item, dict):
            continue
        root = item.get("root")
        if isinstance(root, str) and str(Path(root).resolve()) == ws and isinstance(item.get("id"), str):
            hits.append(item["id"])
    if not hits:
        return None, "看板注册表里没有指向这个目录的工作空间。用 --id 指定编号"
    if len(hits) > 1:
        return None, f"这个目录登记了多次（{'、'.join(hits)}）。用 --id 指定一个"
    project_id = hits[0]
    path = Path.home() / ".pmwork" / "dashboard" / "note-history" / history_name(project_id)
    return path, project_id


def load_store(path: Path) -> dict:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"缓存读不出来：{exc}", file=sys.stderr)
        return {}
    if not isinstance(raw, dict):
        return {}
    return raw


def note_span(note: dict) -> tuple[int | None, int | None]:
    start, end = note.get("start"), note.get("end")
    if isinstance(start, (int, float)) and isinstance(end, (int, float)) and end >= start >= 0:
        return int(start), int(end)
    return None, None


def main() -> int:
    parser = argparse.ArgumentParser(description="把看板缓存里的批注搬进 output/records/notes/（默认预演）")
    parser.add_argument("--write", action="store_true", help="落盘。不加这个参数只打印计划")
    parser.add_argument("--id", help="工作空间在看板注册表里的编号。对不上目录时才需要")
    parser.add_argument("--history", help="直接指定缓存 JSON，跳过注册表查找（给核对用）")
    args = parser.parse_args()

    if args.history:
        history_path = Path(args.history)
        label = args.id or history_path.stem
    else:
        history_path, label = find_history(args.id)
        if history_path is None:
            print(label)
            return 2

    print(f"工作空间：{WS.name}")
    print(f"缓存：note-history/{history_path.name}" if history_path else "缓存：无")
    print("模式：落盘" if args.write else "模式：预演（加 --write 才落盘）")

    if history_path is None or not history_path.is_file():
        print("这个工作空间没有批注缓存，没什么可搬的。")
        return 0

    store = load_store(history_path)
    targets = load_targets()
    if not RECORDS_DIR.is_dir():
        print("这个工作空间没有 output/records/。缓存一条都不会动。")
        for rel, batches in store.items():
            count = sum(len(b.get("notes") or []) for b in batches if isinstance(b, dict))
            print(f"  未命中  {rel}  · {count} 条  · 没有记录目录")
        return 0

    moved = 0
    skipped = 0
    missed = 0
    # 同一轮里还没写盘的指纹也要记住，预演第二遍才不会把自己算成新的
    pending_fp: dict[str, set[str]] = {}
    pending_text: dict[str, str] = {}

    for rel, batches in store.items():
        if not isinstance(rel, str) or not isinstance(batches, list):
            continue
        key = normalize_rel(rel)
        record_id = targets.get(key)
        if not record_id:
            count = 0
            for batch in batches:
                if isinstance(batch, dict) and isinstance(batch.get("notes"), list):
                    count += len(batch["notes"])
            print(f"未命中  {key}  · {count} 条  · 没有 target 等于它的记录，留在缓存里")
            missed += count
            continue

        note_path = NOTES_DIR / f"{record_id}.md"
        existing = ""
        if record_id in pending_text:
            existing = pending_text[record_id]
        elif note_path.is_file():
            try:
                existing = note_path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError) as exc:
                print(f"读不出来，跳过 {record_id}：{exc}")
                continue
        have = set(pending_fp.get(record_id, set()))
        have |= _fingerprints_from_walk(existing) if existing.strip() else set()
        number = max_note_number(existing)
        batch_index = max_batch_index(existing)

        for batch in batches:
            if not isinstance(batch, dict):
                continue
            raw_notes = batch.get("notes")
            if not isinstance(raw_notes, list):
                continue
            fresh_blocks: list[str] = []
            fresh_ids: list[str] = []
            for raw in raw_notes:
                if not isinstance(raw, dict):
                    continue
                quote = raw.get("quote") if isinstance(raw.get("quote"), str) else ""
                comment = raw.get("comment") if isinstance(raw.get("comment"), str) else ""
                if not quote and not comment:
                    continue
                start, end = note_span(raw)
                fp = fingerprint(start, end, quote, comment)
                if fp in have:
                    skipped += 1
                    continue
                if number >= 9999:
                    print(f"{record_id} 的编号已经到 N9999，剩下的没有搬。")
                    break
                number += 1
                note_id = f"N{number:04d}"
                block, written_fp = render_note(
                    note_id,
                    {
                        "structure": raw.get("structure"),
                        "start": start,
                        "end": end,
                        "quote": quote,
                        "comment": comment,
                    },
                )
                have.add(written_fp)
                fresh_blocks.append(block)
                fresh_ids.append(note_id)
                moved += 1
            if not fresh_blocks:
                continue
            batch_index += 1
            section = render_batch(batch_date(batch.get("archivedAt")), batch_index, fresh_blocks)
            existing = existing + ("\n\n" if existing.strip() else "") + section
            if not existing.endswith("\n"):
                existing += "\n"
            span = fresh_ids[0] if len(fresh_ids) == 1 else f"{fresh_ids[0]}–{fresh_ids[-1]}"
            print(f"搬到 {record_id}  {key}  · {batch_date(batch.get('archivedAt'))} · {span}")

        pending_fp[record_id] = have
        pending_text[record_id] = existing

    if args.write:
        for record_id, text in pending_text.items():
            # 文件已经是这个内容（这一轮没追加）时不要碰它的修改时间
            note_path = NOTES_DIR / f"{record_id}.md"
            previous = ""
            if note_path.is_file():
                try:
                    previous = note_path.read_text(encoding="utf-8")
                except (OSError, UnicodeDecodeError):
                    previous = ""
            if previous == text:
                continue
            atomic_write(note_path, text)

    print(
        f"合计：{'写入' if args.write else '将写入'} {moved} 条，"
        f"已在文件里跳过 {skipped} 条，未命中留在缓存 {missed} 条。"
    )
    if not args.write and moved:
        print("这是预演，工作空间和缓存都没有改。确认后加 --write。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
