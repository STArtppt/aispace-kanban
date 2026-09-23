#!/usr/bin/env python3
"""一次归档：把一份产出物从 `output/<组>/` 移进 `output/<组>/一次归档/`。

为什么要有它
------------
`output/` 下三组只会单调变长，陈旧的分析、被取代的文档和在用的东西平铺在一个时间序里。
人能靠搜索凑合，**AI 是全量读** —— 这正是早先那张问题大表被放弃的机制。
归档把不作数的移出主列表，**但不降低可达性**：归档目录在各组**内部**，
看板照样扫得到、搜得到、点得开，AI 需要时照样读得到。

它做的事只有三件
----------------
1. 没有 `output/<组>/一次归档/` 就建一个；
2. 把那一份 `rename` 进去（**只移动，内容一个字节不变**）；
3. 维护同目录的 `README.md` 交接单：
   - 文件不存在时整份生成（已归档清单 + 二次归档提示词）；
   - 已存在时**只在清单那对标记之间追加一行**，提示词那一段一个字不碰 ——
     用户按自己语境改过的提示词，不该被下一次归档改回去。

它**不删除任何文件**；落点已有同名文件时加日期后缀另存，不覆盖。
它只写 `output/<三个组名>/一次归档/` 之下，别处一概只读。

看板「产出文档」列表行的「更多 → 归档」调的就是它（看板只 spawn，自己不写盘）。
二次归档（分堆 + 每堆一份短索引）不归它管，走 `pm-output-archive` 技能。

参数只收组名与文件基名，**不收路径**：出现路径分隔符、`..`、目录成分一律拒绝。
所以本轮只能归档组根目录下的文件，组内子目录里的不行 —— 这是「不收路径」换来的代价。

用法
----
    python3 scripts/archive_output.py --group docs --name 旧版需求说明.md
    python3 scripts/archive_output.py --group analysis --name x.md --reason "被新的现状基线取代"
    python3 scripts/archive_output.py --group docs --name x.md --json   # 给程序用

退出码：0 = 已归档；1 = 执行失败（读写出错、README 标记被删等）；2 = 参数不合法或文件不在。
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
WS = HERE.parent

GROUPS = ("analysis", "docs", "decisions")
# 目录名改了要同步看板仓 src/server/scan.mjs 的 ARCHIVE_DIR
ARCHIVE_DIR = "一次归档"
README_NAME = "README.md"
RECORDS_DIR = WS / "output" / "records"
RECORD_FILE_RE = re.compile(r"^I\d{4}\.md$")
TARGET_LINE_RE = re.compile(r"^target:[ \t]*(.*?)[ \t]*$", re.M)

# 清单的一对标记。脚本只在两者之间追加，不重写整份 —— 这份文件人和 agent 也会改
LIST_START = "<!-- archive-list:start -->"
LIST_END = "<!-- archive-list:end -->"

GROUP_LABEL = {"analysis": "分析中间产物", "docs": "交付文档", "decisions": "决策记录"}

README_TEMPLATE = """# 一次归档 · {label}

这个目录里是从 `output/{group}/` 移出来的产出物 —— 它们不再占主列表的位置，
但**没有被删除**：看板照样能搜到、点开预览，AI 需要时照样可以读。
归档改变的是文件位置，不是产出物的状态（记录里的 `status` 不因归档而变）。

移进来的每一份都在下面的清单里有一行：日期、原路径、新路径、一句话来由。
清单由 `scripts/archive_output.py` 追加，**请不要删掉那两行标记注释** ——
脚本靠它们找插入点，找不到就拒绝归档。清单以外的地方可以随便改。

## 已归档清单

{start}
{entry}
{end}

## 二次归档

一次归档只是「先挪开」。攒到十几份之后，平铺在这里仍然要一份份翻。
二次归档把它们**按主题或阶段分堆，每堆写一份短索引**，让人和 AI 读一份几百字的索引，
就知道这一堆要不要打开 —— 目的是**降低读取成本，不是禁止读**。

把下面这段提示词粘给工作空间里的 agent（它会走 `pm-output-archive` 技能）：

```text
请对 output/{group}/一次归档/ 做二次归档。

1. 读这份 README 的已归档清单和目录里的文件，按主题或阶段分成若干堆，
   每堆一个子目录 output/{group}/一次归档/<主题短名>/，把文件移进去。
   只移动，不删除任何文件，也不改文件内容。已经在堆里的文件不动。
2. 每堆写一份 INDEX.md，几百字，回答三件事：
   这堆是什么；当初为什么产生；什么情况下需要回来翻。
3. 移动之后，output/records/ 里 target 指向被移动文件的记录，把 target 跟进到新路径。
4. 本 README 的已归档清单是历史，已有的行不要改写。

禁止：
- 不得产出任何形式的「始终无需再读」「可以跳过」清单；
- 不得往 AGENTS.md、技能或任何会影响后续会话的地方写跳过规则。
归档降低的是读取频率与成本，不是可达性。每一份归档文件都必须仍然可以被搜到、被读到。
```
"""


class ArchiveError(Exception):
    """执行期错误。exit_code 2 = 参数/文件问题，1 = 读写失败。"""

    def __init__(self, message: str, exit_code: int = 1) -> None:
        super().__init__(message)
        self.exit_code = exit_code


def today() -> str:
    return dt.date.today().isoformat()


def check_name(name: str) -> str:
    """文件名只能是基名。任何目录成分都拒绝，**在碰文件系统之前**。"""
    name = name.strip()
    if not name or name in {".", ".."}:
        raise ArchiveError("文件名是空的，或者是 . / ..。只接受组根目录下的文件基名。", 2)
    if "/" in name or "\\" in name or "\0" in name or ".." in name:
        raise ArchiveError(
            f"文件名里不能有路径分隔符或 `..`：{name}。"
            "只接受组根目录下的文件基名，组内子目录里的文件本轮不支持归档。",
            2,
        )
    if name.startswith("."):
        raise ArchiveError(f"不归档隐藏文件：{name}", 2)
    return name


def pick_destination(archive_dir: Path, name: str) -> Path:
    """落点。同名已存在时加日期后缀；同一天再撞就再加序号。**绝不覆盖。**"""
    dest = archive_dir / name
    if not dest.exists():
        return dest
    stem, suffix = os.path.splitext(name)
    base = f"{stem}-{today()}"
    dest = archive_dir / f"{base}{suffix}"
    n = 2
    while dest.exists():
        dest = archive_dir / f"{base}-{n}{suffix}"
        n += 1
    return dest


def records_pointing_at(target: str) -> list[str]:
    """哪些产出物记录的 `target` 指着这份。只读，给 README 清单行一个跟进线索。"""
    hits: list[str] = []
    if not RECORDS_DIR.is_dir():
        return hits
    for path in sorted(RECORDS_DIR.iterdir()):
        if not RECORD_FILE_RE.match(path.name):
            continue
        try:
            head = path.read_text(encoding="utf-8")[:4096]
        except (OSError, UnicodeDecodeError):
            continue
        m = TARGET_LINE_RE.search(head)
        if m and m.group(1).strip().strip("'\"") == target:
            hits.append(path.stem)
    return hits


def entry_line(src_rel: str, dest_rel: str, reason: str, records: list[str]) -> str:
    line = f"- {today()} · `{src_rel}` → `{dest_rel}` · {reason}"
    if records:
        line += f" · 记录 {'、'.join(records)} 的 `target` 待跟进"
    return line


def next_readme(readme: Path, group: str, line: str) -> str:
    """算出 README 的新内容。不存在就整份生成；存在就只在标记之间追加一行。"""
    if not readme.exists():
        return README_TEMPLATE.format(
            label=GROUP_LABEL[group], group=group, start=LIST_START, end=LIST_END, entry=line
        )
    try:
        text = readme.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise ArchiveError(f"读不出 {readme.name}：{exc}。没有移动任何文件。") from exc
    start = text.find(LIST_START)
    end = text.find(LIST_END)
    if start == -1 or end == -1 or end < start:
        raise ArchiveError(
            f"{readme.relative_to(WS).as_posix()} 里找不到清单标记（{LIST_START} 与 {LIST_END}），"
            "脚本不知道往哪追加，为了不改写你的内容，这次没有移动任何文件。"
            "把这两行标记补回清单的位置再试一次。"
        )
    # 追加在结束标记之前。结束标记前面不是换行就先补一个，免得新行粘在上一行尾巴上
    before = text[:end]
    if not before.endswith("\n"):
        before += "\n"
    return f"{before}{line}\n{text[end:]}"


def write_atomic(path: Path, content: str) -> None:
    """先写临时文件再替换，失败不留半截 README。"""
    fd, tmp = tempfile.mkstemp(prefix=".readme-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(content)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def archive(group: str, name: str, reason: str) -> dict:
    if group not in GROUPS:
        raise ArchiveError(f"组名只能是 {' / '.join(GROUPS)} 之一，收到的是：{group}", 2)
    name = check_name(name)

    group_dir = WS / "output" / group
    src = group_dir / name
    if not src.is_file() or src.is_symlink():
        raise ArchiveError(f"output/{group}/ 下没有这份文件：{name}", 2)

    archive_dir = group_dir / ARCHIVE_DIR
    if archive_dir.exists() and not archive_dir.is_dir():
        raise ArchiveError(f"output/{group}/{ARCHIVE_DIR} 已经存在但不是目录，没有移动任何文件。")
    dest = pick_destination(archive_dir, name)
    readme = archive_dir / README_NAME

    src_rel = src.relative_to(WS).as_posix()
    dest_rel = dest.relative_to(WS).as_posix()
    records = records_pointing_at(src_rel)
    line = entry_line(src_rel, dest_rel, reason, records)
    # README 先算好再动文件：标记被删了就一个字节都不动，而不是移完了才发现清单写不进去
    content = next_readme(readme, group, line)

    try:
        archive_dir.mkdir(parents=False, exist_ok=True)
        # 刚才挑落点到这里之间被人放了同名文件：宁可失败，也不覆盖
        if dest.exists():
            raise ArchiveError(f"落点刚刚被占用：{dest_rel}。没有移动任何文件，再试一次。")
        os.rename(src, dest)
    except OSError as exc:
        raise ArchiveError(f"移动失败：{exc}。原文件还在 {src_rel}。") from exc

    try:
        write_atomic(readme, content)
    except OSError as exc:
        # 文件已经移过去了，只是清单没写上。不回滚（回滚又是一次 rename），如实说
        raise ArchiveError(
            f"文件已移到 {dest_rel}，但 README 清单没写进去：{exc}。"
            f"请手动在 {readme.relative_to(WS).as_posix()} 的清单标记之间补一行：{line}"
        ) from exc

    return {"ok": True, "group": group, "from": src_rel, "to": dest_rel, "records": records}


def main() -> int:
    ap = argparse.ArgumentParser(description="一次归档：把 output/<组>/ 下的一份产出物移进同组的 一次归档/")
    ap.add_argument("--group", required=True, help="analysis / docs / decisions")
    ap.add_argument("--name", required=True, help="组根目录下的文件基名，不带路径")
    ap.add_argument("--reason", default="", help="一句话来由，写进 README 清单；不给就记「手动归档」")
    ap.add_argument("--json", action="store_true", help="成功时在标准输出打一行 JSON")
    args = ap.parse_args()

    reason = " ".join(args.reason.split()) or "手动归档"
    try:
        result = archive(args.group, args.name, reason)
    except ArchiveError as exc:
        print(str(exc), file=sys.stderr)
        return exc.exit_code

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(f"已归档：{result['from']} → {result['to']}")
        if result["records"]:
            print(f"记录 {'、'.join(result['records'])} 的 target 还指着旧路径，记得跟进（pm-output-record）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
