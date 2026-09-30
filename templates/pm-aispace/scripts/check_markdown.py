#!/usr/bin/env python3
"""校验 `output/**` 下手写 Markdown 是否符合写法子集。

契约在 [`AGENTS.md`](../AGENTS.md) 的「Markdown 写法」一节，
本脚本是那份契约的可执行版本。**契约变了这里要跟着变**，否则脚本会一直给过期的绿灯。

为什么值得有这个脚本
--------------------
写法规范是约定，不是强制 —— agent 直接改文件，谁也拦不住它写 `tags: [a, b]`
或连着放两个 H1。这个脚本的作用不是阻止违约，是**让违约可见**，不要静默生效。

它**不管** `input/converted/`（转换脚本的产物，重跑即覆盖）和 `input/raw/`（原件，不碰）。
`output/questions/` 的字段契约仍由 `check_questions.py` 负责；对那个目录本脚本只查写法子集
（扁平 front-matter、标题层级），不重复检查问题字段。
wikilink、callout、行首标签、`%%注释%%`、段尾 `^id`、数学公式看板已经能渲染，这里不再报。

`output/records/` 是例外：产出物记录的字段契约由本脚本查，没有单独的脚本。
理由是记录文件本来就在 `output/**` 的扫描范围里，而要查的东西
（`kind` 决定 `status` 的合法取值、终态必须有 `resolved_by`、`status` 与正文流水末条一致）
只有几十行，再开一个脚本会让「两份契约实现」的老问题多一处。
`output/records/notes/` 的批注文件也在这里查（四个状态、`rejected` 必须有回执、`N` 编号唯一；
批次下的 `- 对象：` 行与回执末尾的「沉淀为 R<编号>（规则库 v<版本>）」标记认得，但沉淀标记不算拒绝原因）。
契约的事实源是 [`output/records/README.md`](../output/records/README.md)。

`output/delivery/**/v<三位序号>.md`（去 AI 味的交付稿）的 front-matter 必填，字段见
[`output/delivery/README.md`](../output/delivery/README.md)。

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
from questions_fm import as_text, is_blank, parse_frontmatter  # noqa: E402

HERE = Path(__file__).resolve().parent
WS = HERE.parent
DEFAULT_DIR = WS / "output"

# 同类问题在文本输出里最多点名几份文件。
SHOW_FILES = 6

# 这些路径即使被扫到也跳过：转换产物与原件不在本规范范围内。
SKIP_PARTS = {"input/converted", "input/raw"}

# ── 产出物记录（output/records/）─────────────────────────────────────────────
# 契约事实源：output/records/README.md。**那份变了这里要跟着变。**
# 看板服务端的同一份映射表在 src/shared/recordStatus.mjs，三处不能分叉。
RECORD_DIR = "records"
RECORD_FILE_RE = re.compile(r"^I\d{4}\.md$")
RECORD_REQUIRED = ("id", "kind", "title", "target", "status", "created")

# kind → 合法状态值。三类不共用一套：分析中间产物不存在「发给对方」，
# 决策不存在「待修订」—— 硬套一套会让每类都带着两三个永远用不上的状态。
RECORD_STATUS = {
    "analysis": ("drafting", "absorbed", "stale"),
    "docs": ("draft", "delivered", "revising", "final", "superseded"),
    "decisions": ("pending", "confirmed", "overturned"),
}
# 产出物落在哪个子目录，由 kind 决定
RECORD_TARGET_DIR = {"analysis": "output/analysis/", "docs": "output/docs/", "decisions": "output/decisions/"}
# 这三个终态必须说清被谁消解，否则外部引用无处可去
RECORD_NEEDS_RESOLVED_BY = {"absorbed", "superseded", "overturned"}
# front-matter 单个值的长度上限。超了说明该写进正文的状态流水 —— 扁平限制管的就是这个
RECORD_FIELD_LIMIT = 120
# `title` 超过这个长度只警告：它仍然是一句话，但清单行会被挤爆
RECORD_TITLE_WARN = 60
# 状态流水的小节标题与条目：`## 状态流水` 下的 `### 2026-09-02 · revising`
RECORD_FLOW_HEADING_RE = re.compile(r"^##[ \t]+状态流水[ \t]*$", re.M)
RECORD_FLOW_ENTRY_RE = re.compile(r"^###[ \t]+(\S+)[ \t]*·[ \t]*(\S+)[ \t]*$", re.M)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# ── 批注文件（output/records/notes/）─────────────────────────────────────────
# 契约事实源仍是 output/records/README.md 的「批注」一节。
NOTE_STATUS = {"pending", "adopted", "rejected", "unclear"}
NOTE_HEADING_RE = re.compile(r"^###[ \t]+(N\d{4})[ \t]*·[ \t]*(\S+)[ \t]*$")
NOTE_BATCH_RE = re.compile(r"^##[ \t]+\d{4}-\d{2}-\d{2}[ \t]*·[ \t]*第[ \t]*\d+[ \t]*批")
NOTE_FIELD_RE = re.compile(r"^-[ \t]*(状态|回执|源码区间)[ \t]*[:：]")
# 批次标题下紧跟的「- 对象：<被批注文件>」：看板追加批次时写，旧批次没有它（视为针对记录的 target）
NOTE_TARGET_RE = re.compile(r"^-[ \t]*对象[ \t]*[:：][ \t]*(\S.*)$")
# 回执末尾的沉淀标记（交付稿批注沉淀进去 AI 味规则库）
NOTE_DEPOSIT_RE = re.compile(r"沉淀为[ \t]*R\d{3}[ \t]*[（(]规则库[ \t]*v\d+[)）][。；;，,\s]*")

# ── 交付稿（output/delivery/）───────────────────────────────────────────────
DELIVERY_DIR = "delivery"
DELIVERY_FILE_RE = re.compile(r"^v\d{3}\.md$")
DELIVERY_KEYS = ("source", "source_sha", "version", "based_on", "notes", "rules_version", "created", "body_sha", "hits", "note")

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


def is_note(path: Path, output_root: Path) -> bool:
    """这份文件是不是 `output/records/notes/` 下的一份批注（与记录文件同编号）。"""
    try:
        rel = path.resolve().relative_to(output_root.resolve())
    except ValueError:
        return False
    parts = rel.parts
    return len(parts) == 3 and parts[0] == RECORD_DIR and parts[1] == "notes" and bool(RECORD_FILE_RE.match(parts[2]))


def check_note(body: str, where: str, report: Report) -> None:
    """批注文件的格式。事实源是 output/records/README.md 的「批注」一节。

    只报告不修。状态写错、拒绝不给原因，都要在这里看得见 ——
    看板读的时候会把整份读不出来的文件标出来，但写错一个词它仍会显示，
    校验是让这种写法过不了闸的那一层。
    """
    if not body.strip():
        report.warn("批注文件是空的", where, "这份批注文件一个条目都没有。看板第一次复制提示词时会写进第一批")
        return

    seen: dict[str, int] = {}
    sections: list[tuple[int, str, list[str]]] = []
    current: tuple[int, str, list[str]] | None = None
    in_batch = False
    batch_line = 0
    for i, line in enumerate(body.splitlines(), start=1):
        if NOTE_BATCH_RE.match(line):
            in_batch = True
            batch_line = i
            continue
        target = NOTE_TARGET_RE.match(line)
        if target and not current and in_batch:
            if not target.group(1).startswith("output/"):
                report.error(
                    "批次对象不是工作空间相对路径",
                    f"{where}:{i}",
                    "`- 对象：` 写的是被批注文件的工作空间相对路径（`output/…`）。这一行由看板写，不要手改",
                )
            if i != batch_line + 1:
                report.warn("批次对象不在批次标题下一行", f"{where}:{i}", "`- 对象：` 应紧跟在 `## 日期 · 第 N 批` 下一行")
            continue
        matched = NOTE_HEADING_RE.match(line)
        if matched:
            if current:
                sections.append(current)
            current = (i, matched.group(1), [])
            if not in_batch:
                report.error(
                    "批注条目不在批次里",
                    f"{where}:{i}",
                    f"`{matched.group(1)}` 上面没有 `## 日期 · 第 N 批`。一批一个二级标题，一条一个三级标题",
                )
            continue
        if line.startswith("## "):
            in_batch = False
        if current:
            current[2].append(line)
    if current:
        sections.append(current)

    if not sections:
        report.error(
            "批注文件读不出条目",
            where,
            "文件不是空的，但没有 `### N<四位编号> · 结构` 这样的条目。格式见 output/records/README.md 的「批注」",
        )
        return

    for line_no, note_id, lines in sections:
        if note_id in seen:
            report.error(
                "批注编号重复",
                f"{where}:{line_no}",
                f"`{note_id}` 在第 {seen[note_id]} 行已经用过。编号只增不复用，不要把删掉的号补回来",
            )
        else:
            seen[note_id] = line_no

        fields = {m.group(1) for line in lines if (m := NOTE_FIELD_RE.match(line))}
        for key in ("状态", "回执", "源码区间"):
            if key not in fields:
                report.error(
                    f"批注缺 `- {key}：`",
                    f"{where}:{line_no}",
                    f"`{note_id}` 缺 `- {key}：` 这一行。一条批注要有状态、回执、源码区间、原文引用和意见",
                )
        if not any(line.startswith(">") for line in lines):
            report.error(
                "批注缺原文引用",
                f"{where}:{line_no}",
                f"`{note_id}` 没有 `>` 引用块。选中的原文要留在条目里，区间失效时靠它定位",
            )
        if not any(re.match(r"^(?:-[ \t]*)?意见[ \t]*[:：]", line) for line in lines):
            report.error(
                "批注缺意见",
                f"{where}:{line_no}",
                f"`{note_id}` 没有 `意见：` 这一行",
            )

        status = ""
        receipt = ""
        for line in lines:
            status_m = re.match(r"^-[ \t]*状态[ \t]*[:：][ \t]*(.*)$", line)
            if status_m:
                status = status_m.group(1).strip()
            receipt_m = re.match(r"^-[ \t]*回执[ \t]*[:：][ \t]*(.*)$", line)
            if receipt_m:
                receipt = receipt_m.group(1).strip()
        if status and status not in NOTE_STATUS:
            report.error(
                "批注状态不在四值内",
                f"{where}:{line_no}",
                f"`{note_id}` 的状态是 `{status}`。只能是 pending / adopted / rejected / unclear",
            )
        if status == "rejected" and not NOTE_DEPOSIT_RE.sub("", receipt).strip():
            report.error(
                "拒绝没写原因",
                f"{where}:{line_no}",
                f"`{note_id}` 是 `rejected`，回执里没有原因（只有沉淀标记不算原因）。没有原因的拒绝等于没有回答",
            )


def is_delivery(path: Path, output_root: Path) -> bool:
    """这份文件是不是 `output/delivery/**/v<三位序号>.md`。"""
    try:
        parts = path.resolve().relative_to(output_root.resolve()).parts
    except ValueError:
        return False
    return len(parts) >= 3 and parts[0] == DELIVERY_DIR and bool(DELIVERY_FILE_RE.match(parts[-1]))


def check_delivery(meta: dict, raw: str, where: str, report: Report) -> None:
    """交付稿的 front-matter：字段必填（notes 首版可以空着，但键要在）。事实源是 output/delivery/README.md。"""
    if not raw:
        report.error("交付稿没有 front-matter", where,
                     "交付稿必须有扁平 front-matter（source / source_sha / version / based_on / …），见 output/delivery/README.md")
        return
    present = set(re.findall(r"^([\w.-]+):", raw, re.M))
    for key in DELIVERY_KEYS:
        if key not in present:
            report.error(f"交付稿缺字段 `{key}`", where, f"缺 `{key}`。字段见 output/delivery/README.md")
    for key in ("source_sha", "body_sha"):
        v = as_text(meta.get(key)) if key in meta else ""
        if v and not re.fullmatch(r"[0-9a-f]{16}", v):
            report.error(f"`{key}` 不是 16 位摘要", where, f"`{key}` 是 SHA-256 的十六进制前 16 位，算法见技能 pm-deai-writing")
    rv = as_text(meta.get("rules_version")) if "rules_version" in meta else ""
    if rv and not rv.isdigit():
        report.error("`rules_version` 不是正整数", where, "`rules_version` 写规则库的版本号，如 `4`")


def is_record(path: Path, output_root: Path) -> bool:
    """这份文件是不是 `output/records/` 下的一条记录（README 与别的过程件不算）。"""
    try:
        rel = path.resolve().relative_to(output_root.resolve())
    except ValueError:
        return False
    parts = rel.parts
    return len(parts) == 2 and parts[0] == RECORD_DIR and bool(RECORD_FILE_RE.match(parts[1]))


def _last_flow_entry(body: str) -> tuple[str, str] | None:
    """取「## 状态流水」下最后一条 `### 日期 · 状态` 的（日期, 状态）。没有就 None。"""
    heading = RECORD_FLOW_HEADING_RE.search(body)
    if not heading:
        return None
    start = heading.end()
    after = re.compile(r"^##[ \t]+", re.M).search(body, start)
    section = body[start : after.start() if after else len(body)]
    entries = RECORD_FLOW_ENTRY_RE.findall(section)
    if not entries:
        return None
    date, status = entries[-1]
    return date, status


def check_record(path: Path, meta: dict, body: str, where: str, report: Report) -> None:
    """产出物记录的字段契约。事实源是 output/records/README.md。

    这里**只报告，不修**：记录是人和 agent 共写的文件，替它猜一个状态填进去
    正是这套结构要防的事（自动推导出来的状态是虚假确定性）。
    """
    for key in RECORD_REQUIRED:
        if key not in meta or is_blank(meta[key]):
            report.error(
                f"记录缺 `{key}`",
                where,
                f"缺必填字段 `{key}`。六个必填字段见 output/records/README.md 的「front-matter 字段」",
            )

    # `id` 与文件名一致 —— 编号是外部引用的锚点，对不上就等于引用指错
    wanted = path.name[:-3]
    if not is_blank(meta.get("id")) and as_text(meta["id"]) != wanted:
        report.error(
            "记录编号与文件名不符",
            where,
            f"`id: {as_text(meta['id'])}` 与文件名 `{path.name}` 不一致。改 `id`，不要改文件名",
        )

    kind = as_text(meta.get("kind"))
    status = as_text(meta.get("status"))
    if kind and kind not in RECORD_STATUS:
        report.error(
            "记录 `kind` 不在三值内",
            where,
            f"`kind: {kind}` 不认识。只能是 {' / '.join(RECORD_STATUS)}，它决定 `status` 的合法取值",
        )
    elif kind and status and status not in RECORD_STATUS[kind]:
        report.error(
            "记录 `status` 不属于该 `kind`",
            where,
            f"`kind: {kind}` 的 `status` 只能是 {' / '.join(RECORD_STATUS[kind])}，"
            f"现在写的是 `{status}`。三类不共用一套状态机",
        )

    # 终态必须说清被谁消解，否则外部引用无处可去
    if status in RECORD_NEEDS_RESOLVED_BY and is_blank(meta.get("resolved_by")):
        report.error(
            "终态没写 `resolved_by`",
            where,
            f"`status: {status}` 是终态，必须填 `resolved_by`（被哪个编号吸收 / 取代 / 推翻）",
        )

    # `target` 要落在 `kind` 对应的子目录下；指向的文件不在了只警告 ——
    # 看板会把它标成「指向丢失」照常列出，删改产出物是用户的正常动作，不是记录写错了
    target = as_text(meta.get("target"))
    if kind in RECORD_TARGET_DIR and target and not target.startswith(RECORD_TARGET_DIR[kind]):
        report.error(
            "`target` 与 `kind` 不匹配",
            where,
            f"`kind: {kind}` 的 `target` 应当落在 `{RECORD_TARGET_DIR[kind]}` 下，现在指向 `{target}`",
        )
    if target and not (WS / target).exists():
        report.warn(
            "`target` 指向的产出物不在了",
            where,
            f"`{target}` 不存在。产出物改名或移走时要跟进 `target`（走 pm-output-record）；"
            "看板会把这条标成「指向丢失」照常列出",
        )

    # `status` 必须等于流水最后一条 —— 不一致只会来自手工编辑
    last = _last_flow_entry(body)
    if last and status and last[1] != status:
        report.error(
            "`status` 与流水末条不一致",
            where,
            f"front-matter 是 `{status}`，「## 状态流水」最后一条是 `{last[1]}`（{last[0]}）。"
            "看板按 `status` 分组，两者必须一致",
        )
    elif not last and status:
        report.warn(
            "没有状态流水",
            where,
            "正文缺「## 状态流水」小节或里面没有 `### 日期 · 状态` 条目。"
            "每次状态变更都该留一条，说清为什么变成这个状态",
        )

    for key in ("created", "status_changed", "updated"):
        value = as_text(meta.get(key))
        if value and not DATE_RE.match(value):
            report.error(f"记录 `{key}` 不是日期", where, f"`{key}: {value}` 要写成 YYYY-MM-DD")

    # 长文进正文：扁平限制管的就是条目长度，front-matter 里塞几百字等于绕过它
    for key, value in meta.items():
        text = as_text(value)
        if len(text) > RECORD_FIELD_LIMIT:
            report.error(
                "front-matter 里有长文",
                where,
                f"`{key}` 有 {len(text)} 字，超过 {RECORD_FIELD_LIMIT}。"
                "长文写进正文（状态变更的说明写进「## 状态流水」），front-matter 只放短字段",
            )
    title = as_text(meta.get("title"))
    if len(title) > RECORD_TITLE_WARN:
        report.warn(
            "记录 `title` 偏长",
            where,
            f"`title` 有 {len(title)} 字，超过 {RECORD_TITLE_WARN}。清单行只显示它，一句话说清就够",
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
    # records/ 有自己的六个必填字段（见 check_record），不走 title/created/updated 这套
    if parts[0] in {"docs", "questions", RECORD_DIR}:
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

    check_headings(body, body_start, where, report)

    if is_note(path, output_root):
        check_note(body, where, report)

    if is_delivery(path, output_root):
        check_delivery(meta, raw, where, report)

    if is_record(path, output_root):
        if not raw:
            report.error(
                "记录没有 front-matter",
                where,
                "产出物记录必须有扁平 front-matter（id / kind / title / target / status / created）。"
                "看板读不出 front-matter 的记录只能标成「读不出」",
            )
        else:
            check_record(path, meta, body, where, report)


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
