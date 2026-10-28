#!/usr/bin/env python3
"""产出原稿重命名：改一份 `output/<组>/…` 下的文件名，连带交付稿镜像目录与所有指向它的引用。

为什么要有它
------------
看板按**路径**把原稿和它的交付稿对上：`output/docs/a/实施方案.md` 的交付稿在
`output/delivery/docs/a/实施方案/`。记录的 `target`、交付稿的 `source`、批注的 `- 对象：`、
问题的 `source` / `flows_to`、别的文档里的链接，指的也都是路径。
在文件夹里手改名字，这些全断：九版交付稿一个都没少，看板上却一个都看不到了。

它做的事
--------
1. 改名：原稿（扩展名不变）；`.md` 原稿的镜像目录 `output/delivery/<组>/<子路径>/<旧基名>/`；
   镜像目录里的 `<旧基名>.docx` 和原稿旁边的 `<旧基名>.docx`。镜像目录里其余文件名字不变。
2. 改引用：扫 `output/**` 的 `.md` / `.yaml` / `.yml` 与根上的 `project.yaml`，把**解析后指向旧路径**的写法改成新路径：
   - 工作空间根路径 `output/<组>/…/旧.md`（反引号里、YAML 值、正文里都算），镜像目录前缀 `output/delivery/…/旧/`；
   - 相对链接 `[文本](../docs/旧.md)`，相对所在文件解析；
   - wikilink `[[…]]`，规则与看板渲染器一致：`./` `../` 相对、带 `/` 从根算、裸名只认同一目录，省略 `.md` 也算。
   只改路径里变了的那一段，`#锚点`、`|别名`、带不带 `.md`、相对还是绝对，都照原样。
   **不做纯字符串替换**：正文里不带路径的「实施方案」四个字不动。
3. 别的原稿因为链接改写而内容变了，它交付稿里原本对得上的 `source_sha` 换成新摘要，免得看板误报「原稿已变更」。
4. 原稿有记录（`target` 等于旧路径）时，在记录「## 状态流水」末尾追加一条改名留痕，状态不变。

不碰的地方：`input/`、`output/converted/`、`visualization/`、`.claude/`、根上的 `AGENTS.md`；
交付稿 `v<序号>.md` 只改 front-matter，正文一个字不改（写出后不再改动，改了 `body_sha` 会报「被直接改过」）；
记录的「## 状态流水」是历史，旧条目里的旧路径不改写。**不删除任何文件。**

两步走
------
    python3 scripts/rename_output.py --source output/docs/实施方案.md --to 01实施方案 --dry-run
    python3 scripts/rename_output.py --source output/docs/实施方案.md --to 01实施方案 --apply --expect <指纹>

`--dry-run` 打出完整计划和指纹；`--apply` 重算一遍计划，指纹对不上就一个字节都不动（预览之后有文件变了）。
在终端里用也可以，看板「产出文档 → 更多 → 重命名」调的就是它（看板只 spawn，自己不写盘）。
改名前先停下正在跑的 agent：它若同时在写同一个文件，指纹只能挡住预览到执行之间的变化。

退出码：0 = 成功；1 = 执行失败；2 = 参数不合法、文件不在或名字冲突；3 = 预览之后文件变了。
带 `--json` 时，失败也在标准输出最后一行打 `{"ok": false, "error": …, "kind": …}`。
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote

HERE = Path(__file__).resolve().parent
WS = HERE.parent

GROUPS = ("analysis", "docs", "decisions")
# 与看板仓 src/server/scan.mjs 的 ARCHIVE_DIR / DELIVERY_DIR / DELIVERY_FILE_RE 同一口径
ARCHIVE_DIR = "一次归档"
DELIVERY_DIR = "output/delivery"
DELIVERY_FILE_RE = re.compile(r"^v\d{3}\.md$")
RECORD_FILE_RE = re.compile(r"^I\d{4}\.md$")

SCAN_EXT = {".md", ".yaml", ".yml"}
# 扫描时跳过的 output/ 子树：转换产物重新转换会被覆盖，改了也白改
SKIP_UNDER_OUTPUT = {"converted"}
SKIP_DIRS = {".git", "node_modules", "__pycache__"}
MAX_SCAN_BYTES = 8 * 1024 * 1024
MAX_NAME = 120
BAD_NAME_CHARS = re.compile(r'[/\\\0<>:"|?*#\[\]\x00-\x1f]')

FRONT_RE = re.compile(r"\A---\r?\n[\s\S]*?\r?\n---\r?\n")
WIKI_RE = re.compile(r"(!?)\[\[([^\[\]\n]+?)\]\]")
# `[文本](目标 "标题")` 与图片；目标可以用尖括号包起来（允许空格）
MDLINK_RE = re.compile(r"!?\[[^\]\n]*\]\((<[^>\n]*>|[^)\s]+)((?:\s+\"[^\"\n]*\")?)\)")
SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.-]*:", re.I)
# 根路径前面不能贴着路径字符（`../output/...`、`xoutput/...` 都不是根路径）
LEAD = r"(?<![A-Za-z0-9_./\\-])"
# 根路径后面必须是这些之一，`旧.md.bak`、`旧.mdx` 都不算
TRAIL_CHARS = "#\\s'\"`)\\]|,;>，。、；：）》」"
FLOW_HEAD_RE = re.compile(r"^##[ \t]+状态流水[ \t]*$", re.M)
NEXT_H2_RE = re.compile(r"^##[ \t]+", re.M)


class RenameError(Exception):
    """exit_code：1 执行失败，2 参数 / 文件 / 冲突，3 指纹不符。kind 给看板区分 400 与 409。"""

    def __init__(self, message: str, exit_code: int = 1, kind: str = "failed", hint: str = "") -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.kind = kind
        self.hint = hint


def bad(message: str, kind: str = "invalid") -> RenameError:
    return RenameError(message, 2, kind)


def today() -> str:
    return dt.date.today().isoformat()


def sha16(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def norm(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def rel(p: Path) -> str:
    return p.relative_to(WS).as_posix()


# ---------------------------------------------------------------- 参数校验


def check_source(raw: str) -> str:
    src = raw.strip().replace("\\", "/")
    parts = src.split("/")
    if not src or src.startswith("/") or any(p in ("", ".", "..") for p in parts):
        raise bad(f"来源必须是工作空间相对路径，不能有 `..` 或空段：{raw}")
    if len(parts) < 3 or parts[0] != "output" or parts[1] not in GROUPS:
        raise bad(f"只能重命名 output/{' / '.join(GROUPS)} 三组里的文件：{src}")
    if parts[-1].startswith("."):
        raise bad(f"不重命名隐藏文件：{src}")
    inner = parts[2:]
    if inner[0] == ARCHIVE_DIR and (inner[1:] == ["README.md"] or (len(inner) == 3 and inner[2] == "INDEX.md")):
        raise bad(f"{src} 是归档区的说明文件，归档脚本和二次归档靠这个名字找它，不能改名。")
    abs_path = WS / src
    # 路径上任何一段是符号链接都不行：改名会落到工作空间外面去
    cur = WS
    for p in parts:
        cur = cur / p
        if cur.is_symlink():
            raise bad(f"{rel(cur)} 是符号链接，不重命名。")
    if not abs_path.is_file():
        raise bad(f"找不到这份文件：{src}。可能已经被移走或改名，刷新列表看一眼。", "missing")
    return src


def check_name(raw: str, old_stem: str) -> str:
    name = raw.strip()
    if not name:
        raise bad("新名字是空的。")
    if name.startswith("."):
        raise bad(f"新名字不能以 . 开头：{name}")
    if ".." in name or BAD_NAME_CHARS.search(name):
        raise bad(f'新名字里不能有 / \\ .. 和 < > : " | ? * # [ ]：{name}。只填名字本身，扩展名不用写。')
    if name.endswith("."):
        raise bad(f"新名字不能以 . 结尾（Windows 上会被吞掉）：{name}")
    if name == ARCHIVE_DIR:
        raise bad(f"「{ARCHIVE_DIR}」是归档目录的名字，换一个。")
    if len(name) > MAX_NAME:
        raise bad(f"新名字超过 {MAX_NAME} 个字。")
    if name == old_stem:
        raise bad("新名字和原来的一样。")
    return name


# ---------------------------------------------------------------- 改名对与路径映射


class Plan:
    """一次改名的全部路径规则。所有引用判定都走 map_path：给一个旧的工作空间路径，答它改名后在哪。"""

    def __init__(self, src: str, new_stem: str) -> None:
        self.src = src
        self.dir, self.name = src.rsplit("/", 1)
        self.ext = os.path.splitext(self.name)[1]
        self.old_stem = self.name[: len(self.name) - len(self.ext)] if self.ext else self.name
        self.new_stem = new_stem
        self.dst = f"{self.dir}/{new_stem}{self.ext}"
        self.is_md = self.ext.lower() == ".md"
        self.renames: list[dict] = [{"from": src, "to": self.dst, "kind": "file"}]
        self.old_mirror = self.new_mirror = None
        self.mirror_docx = False
        self.beside_old = self.beside_new = None
        if self.is_md:
            inner = src[len("output/"):]
            self.old_mirror = f"{DELIVERY_DIR}/{inner[: -len(self.ext)]}"
            self.new_mirror = f"{self.old_mirror.rsplit('/', 1)[0]}/{new_stem}"
            beside = f"{self.dir}/{self.old_stem}.docx"
            if (WS / beside).is_file():
                self.beside_old, self.beside_new = beside, f"{self.dir}/{new_stem}.docx"
            if (WS / self.old_mirror).is_dir() and not (WS / self.old_mirror).is_symlink():
                self.renames.insert(0, {"from": self.old_mirror, "to": self.new_mirror, "kind": "dir"})
                if (WS / self.old_mirror / f"{self.old_stem}.docx").is_file():
                    self.mirror_docx = True
                    self.renames.insert(1, {
                        "from": f"{self.old_mirror}/{self.old_stem}.docx",
                        "to": f"{self.new_mirror}/{new_stem}.docx",
                        "kind": "file",
                    })
            if self.beside_old:
                self.renames.append({"from": self.beside_old, "to": self.beside_new, "kind": "file"})

    @property
    def has_mirror(self) -> bool:
        return any(r["kind"] == "dir" for r in self.renames)

    def map_path(self, p: str) -> str | None:
        if p == self.src:
            return self.dst
        if self.beside_old and p == self.beside_old:
            return self.beside_new
        if self.old_mirror and self.has_mirror:
            if p == self.old_mirror:
                return self.new_mirror
            if p.startswith(self.old_mirror + "/"):
                rest = p[len(self.old_mirror) + 1:]
                if self.mirror_docx and rest == f"{self.old_stem}.docx":
                    rest = f"{self.new_stem}.docx"
                return f"{self.new_mirror}/{rest}"
        return None

    def final_location(self, p: str) -> str:
        """一个被改写的文件，改名之后落在哪（镜像目录里的文件跟着目录走）。"""
        return self.map_path(p) or p

    def conflicts(self) -> list[str]:
        out = []
        same_file = False
        if (WS / self.dst).exists():
            try:
                # 大小写不敏感的文件系统上只改大小写：新旧是同一个文件，不算冲突
                same_file = os.path.samefile(WS / self.src, WS / self.dst)
            except OSError:
                same_file = False
            if not same_file:
                out.append(f"{self.dst} 已经存在")
        if self.is_md and not same_file:
            if (WS / self.new_mirror).exists():
                out.append(f"交付稿目录 {self.new_mirror}/ 已经存在")
            if self.mirror_docx and (WS / self.old_mirror / f"{self.new_stem}.docx").exists():
                out.append(f"交付稿目录里已经有 {self.new_stem}.docx")
            if (WS / self.dir / f"{self.new_stem}.docx").exists():
                out.append(f"原稿旁边已经有 {self.new_stem}.docx")
        return out


# ---------------------------------------------------------------- 链接识别与改写


def resolve(base_dir: str, target: str) -> str | None:
    """把 target 相对 base_dir 解析成工作空间路径；退出根返回 None。"""
    stack: list[str] = [p for p in base_dir.split("/") if p] if base_dir else []
    for seg in target.split("/"):
        if not seg or seg == ".":
            continue
        if seg == "..":
            if not stack:
                return None
            stack.pop()
        else:
            stack.append(seg)
    return "/".join(stack) or None


def ensure_ext(p: str) -> str:
    """与 markdownSyntax.ts 的 ensureExt 一致：最后一段没有 `.` 才补 `.md`。"""
    last = p.split("/")[-1]
    if not last or last in (".", "..") or "." in last:
        return p
    return f"{p}.md"


def rewrite_segments(raw_segs: list[str], decoded_segs: list[str], old: str, new: str,
                     strip_ext: str = "", encode=None) -> str | None:
    """old → new 只改了末尾几段。把这几段在原写法里对位换掉，其余（`..`、`./`、大小写之外的写法）照抄。

    strip_ext：wikilink 原写法省略了 `.md`，新段也去掉它。encode：链接目标里需要转义的新段怎么写。
    对不上位（变了的段落在 `..` 区里）返回 None，宁可不改也不改错。
    """
    old_p, new_p = old.split("/"), new.split("/")
    if len(old_p) != len(new_p):
        return None
    segs = list(raw_segs)
    for i in range(1, len(old_p) + 1):
        if old_p[-i] == new_p[-i]:
            continue
        if i > len(segs):
            return None
        want = old_p[-i][: -len(strip_ext)] if (i == 1 and strip_ext) else old_p[-i]
        if decoded_segs[-i] != want:
            return None
        repl = new_p[-i][: -len(strip_ext)] if (i == 1 and strip_ext) else new_p[-i]
        if encode and (segs[-i] != decoded_segs[-i] or encode(repl) != repl):
            repl = encode(repl)
        segs[-i] = repl
    return "/".join(segs)


def encode_link_seg(seg: str) -> str:
    # 只转义会让 Markdown 链接断掉的字符；中文照原样写，读起来是人话
    return seg.replace("%", "%25").replace(" ", "%20").replace("(", "%28").replace(")", "%29")


def root_literal_re(plan: Plan) -> tuple[re.Pattern | None, dict[str, str]]:
    pairs: dict[str, str] = {plan.src: plan.dst}
    if plan.beside_old:
        pairs[plan.beside_old] = plan.beside_new
    if plan.has_mirror:
        if plan.mirror_docx:
            pairs[f"{plan.old_mirror}/{plan.old_stem}.docx"] = f"{plan.new_mirror}/{plan.new_stem}.docx"
        pairs[plan.old_mirror] = plan.new_mirror
    alts = "|".join(re.escape(k) for k in sorted(pairs, key=len, reverse=True))
    trail = f"(?=[{TRAIL_CHARS}]|$)"
    mirror_trail = f"(?=[/{TRAIL_CHARS}]|$)"
    # 镜像目录前缀后面可以接 `/`；文件路径不行（`旧.md/` 不是这份文件）
    pattern = "|".join(
        f"{LEAD}{re.escape(k)}{mirror_trail if k == plan.old_mirror else trail}"
        for k in sorted(pairs, key=len, reverse=True)
    ) if alts else ""
    return (re.compile(pattern, re.M) if pattern else None), pairs


def find_edits(text: str, file_rel: str, plan: Plan, lit_re: re.Pattern | None, pairs: dict[str, str],
               lo: int = 0, hi: int | None = None, skip: list[tuple[int, int]] | None = None) -> list[tuple[int, int, str]]:
    """在 text[lo:hi] 里找全部改写点：(起, 止, 新文本)。wikilink → Markdown 链接 → 根路径，先占先得、不重叠。"""
    hi = len(text) if hi is None else hi
    base = file_rel.rsplit("/", 1)[0] if "/" in file_rel else ""
    taken: list[tuple[int, int]] = list(skip or [])
    edits: list[tuple[int, int, str]] = []

    def free(a: int, b: int) -> bool:
        return all(b <= x or a >= y for x, y in taken)

    for m in WIKI_RE.finditer(text, lo, hi):
        if not free(m.start(), m.end()):
            continue
        inner = m.group(2)
        pipe = inner.find("|")
        main = inner if pipe == -1 else inner[:pipe]
        hash_ = main.find("#")
        target_raw = main if hash_ == -1 else main[:hash_]
        target = target_raw.strip()
        if not target or "\0" in target or SCHEME_RE.match(target):
            continue
        file = ensure_ext(target.replace("\\", "/"))
        if file.startswith("./") or file.startswith("../"):
            resolved = resolve(base, file)
        elif "/" in file:
            resolved = resolve("", file)
        else:
            resolved = resolve(base, file)
        if not resolved:
            continue
        mapped = plan.map_path(resolved)
        if not mapped:
            continue
        segs = target.replace("\\", "/").split("/")
        strip = ".md" if file != target.replace("\\", "/") else ""
        new_target = rewrite_segments(segs, segs, resolved, mapped, strip)
        if new_target is None:
            continue
        # 只换目标那一段，前后空白、`#标题`、`|别名` 原样留着
        t_start = m.start(2) + main.find(target)
        edits.append((t_start, t_start + len(target), new_target))
        taken.append((m.start(), m.end()))

    for m in MDLINK_RE.finditer(text, lo, hi):
        if not free(m.start(), m.end()):
            continue
        dest = m.group(1)
        d_start = m.start(1)
        if dest.startswith("<") and dest.endswith(">"):
            dest, d_start = dest[1:-1], d_start + 1
        path_part = re.split(r"[?#]", dest, maxsplit=1)[0]
        if not path_part or SCHEME_RE.match(path_part) or path_part.startswith("/"):
            continue
        raw_segs = path_part.split("/")
        decoded = [unquote(s) for s in raw_segs]
        resolved = resolve(base, "/".join(decoded))
        mapped = plan.map_path(resolved) if resolved else None
        if not mapped:
            continue  # 留给下面的根路径规则：`[x](output/docs/旧.md)` 这种写法按根路径认
        new_path = rewrite_segments(raw_segs, decoded, resolved, mapped, encode=encode_link_seg)
        if new_path is None:
            continue
        edits.append((d_start, d_start + len(path_part), new_path))
        taken.append((m.start(), m.end()))

    if lit_re is not None:
        for m in lit_re.finditer(text, lo, hi):
            if not free(m.start(), m.end()):
                continue
            edits.append((m.start(), m.end(), pairs[m.group(0)]))
            taken.append((m.start(), m.end()))

    return edits


def apply_edits(text: str, edits: list[tuple[int, int, str]]) -> str:
    out, last = [], 0
    for a, b, s in sorted(edits):
        out.append(text[last:a])
        out.append(s)
        last = b
    out.append(text[last:])
    return "".join(out)


# ---------------------------------------------------------------- 扫描范围


def scan_files() -> list[str]:
    out: list[str] = []
    for name in ("project.yaml", "project.yml"):
        p = WS / name
        if p.is_file() and not p.is_symlink():
            out.append(name)
    output = WS / "output"
    if not output.is_dir():
        return out
    for dirpath, dirnames, filenames in os.walk(output):
        d = Path(dirpath)
        here = rel(d)
        dirnames[:] = sorted(
            n for n in dirnames
            if not n.startswith(".") and n not in SKIP_DIRS and not (d / n).is_symlink()
            and not (here == "output" and n in SKIP_UNDER_OUTPUT)
        )
        for n in sorted(filenames):
            if n.startswith(".") or os.path.splitext(n)[1].lower() not in SCAN_EXT:
                continue
            p = d / n
            if p.is_symlink():
                continue
            try:
                if p.stat().st_size > MAX_SCAN_BYTES:
                    continue
            except OSError:
                continue
            out.append(rel(p))
    return out


def is_delivery_version(p: str) -> bool:
    return p.startswith(f"{DELIVERY_DIR}/") and bool(DELIVERY_FILE_RE.match(p.rsplit("/", 1)[-1]))


def is_record(p: str) -> bool:
    return p.startswith("output/records/") and p.count("/") == 2 and bool(RECORD_FILE_RE.match(p.rsplit("/", 1)[-1]))


def is_original_md(p: str) -> bool:
    parts = p.split("/")
    return len(parts) >= 3 and parts[0] == "output" and parts[1] in GROUPS and p.lower().endswith(".md")


def read_text(p: str) -> str | None:
    try:
        with open(WS / p, encoding="utf-8", newline="") as fh:
            return fh.read()
    except (OSError, UnicodeDecodeError):
        return None


def front_value(text: str, key: str) -> str:
    m = FRONT_RE.match(text)
    if not m:
        return ""
    fm = re.search(rf"^{re.escape(key)}:[ \t]*(.*?)[ \t]*\r?$", m.group(0), re.M)
    return fm.group(1).strip().strip("'\"") if fm else ""


def flow_span(text: str) -> tuple[int, int] | None:
    """记录正文里「## 状态流水」这一节的范围：历史条目不改写。"""
    head = FLOW_HEAD_RE.search(text)
    if not head:
        return None
    nxt = NEXT_H2_RE.search(text, head.end())
    return head.start(), (nxt.start() if nxt else len(text))


def append_flow(text: str, entry: str) -> str:
    """与看板 records.mjs 的 appendFlow 同一写法：追加在流水末尾；没有这一节就补在文末。"""
    nl = "\r\n" if "\r\n" in text else "\n"
    entry = entry.replace("\n", nl)
    head = FLOW_HEAD_RE.search(text)
    if not head:
        return f"{text.rstrip()}{nl}{nl}## 状态流水{nl}{nl}{entry}{nl}"
    start = head.end()
    nxt = NEXT_H2_RE.search(text, start)
    cut = nxt.start() if nxt else len(text)
    section = text[start:cut].rstrip()
    tail = text[cut:]
    return f"{text[:start]}{section}{nl}{nl}{entry}{nl}" + (f"{nl}{tail}" if tail else "")


# ---------------------------------------------------------------- 计划


def build_plan(src: str, new_stem: str) -> tuple[Plan, dict[str, tuple[str, str]], dict]:
    plan = Plan(src, new_stem)
    clash = plan.conflicts()
    if clash:
        raise RenameError("不能改成这个名字：" + "；".join(clash) + "。磁盘上没有任何变化，换一个名字。", 2, "conflict")

    lit_re, pairs = root_literal_re(plan)
    before: dict[str, str] = {}
    after: dict[str, str] = {}
    links: dict[str, int] = {}

    # 第一轮：链接改写
    for p in scan_files():
        text = read_text(p)
        if text is None:
            continue
        before[p] = text
        if is_delivery_version(p):
            # 交付稿只改 front-matter：正文写出后不再改动，命中也不列
            fm = FRONT_RE.match(text)
            edits = find_edits(text, p, plan, lit_re, pairs, 0, fm.end()) if fm else []
        elif is_record(p):
            span = flow_span(text)
            edits = find_edits(text, p, plan, lit_re, pairs, skip=[span] if span else None)
        else:
            edits = find_edits(text, p, plan, lit_re, pairs)
        if edits:
            after[p] = apply_edits(text, edits)
            links[p] = len(edits)

    # 第二轮：内容变了的原稿，交付稿里对得上的 source_sha 跟着换
    sha_follow: set[str] = set()
    for p in list(after):
        if not is_original_md(p):
            continue
        old_sha, new_sha = sha16(norm(before[p])), sha16(norm(after[p]))
        if old_sha == new_sha:
            continue
        mirror = f"{DELIVERY_DIR}/{p[len('output/'):-3]}"
        mdir = WS / mirror
        if not mdir.is_dir():
            continue
        for v in sorted(mdir.iterdir()):
            vp = f"{mirror}/{v.name}"
            if not DELIVERY_FILE_RE.match(v.name) or vp not in before:
                continue
            cur = after.get(vp, before[vp])
            fm = FRONT_RE.match(cur)
            if not fm:
                continue
            block = fm.group(0)
            new_block, n = re.subn(rf"^(source_sha:[ \t]*['\"]?){old_sha}(['\"]?[ \t]*\r?)$",
                                   rf"\g<1>{new_sha}\g<2>", block, flags=re.M)
            if n:
                after[vp] = new_block + cur[fm.end():]
                sha_follow.add(vp)

    # 第三轮：记录留痕
    flowed: list[str] = []
    for p in sorted(before):
        if not is_record(p) or front_value(before[p], "target") != src:
            continue
        status = front_value(before[p], "status") or "未填"
        entry = (f"### {today()} · {status}\n\n"
                 f"改名：`{src}` → `{plan.dst}`（看板「重命名」，状态未变）。")
        after[p] = append_flow(after.get(p, before[p]), entry)
        flowed.append(p)

    changed = {p: (before[p], after[p]) for p in sorted(after) if after[p] != before[p]}
    files = [{
        "path": p,
        "newPath": plan.final_location(p),
        "links": links.get(p, 0),
        **({"sourceSha": True} if p in sha_follow else {}),
        **({"flow": True} if p in flowed else {}),
    } for p in changed]
    # 指纹 = 改名对 + 每个文件改写前后的摘要。预览到执行之间任何一份变了，指纹就变
    finger = json.dumps({
        "renames": plan.renames,
        "files": [[p, sha16(b), sha16(a)] for p, (b, a) in changed.items()],
    }, ensure_ascii=False, sort_keys=True)
    summary = {
        "ok": True,
        "source": src,
        "to": plan.dst,
        "renames": plan.renames,
        "files": files,
        "linkFiles": sum(1 for f in files if f["links"]),
        "links": sum(f["links"] for f in files),
        "records": [p.rsplit("/", 1)[-1][:-3] for p in flowed],
        "plan": hashlib.sha256(finger.encode("utf-8")).hexdigest()[:16],
    }
    return plan, changed, summary


# ---------------------------------------------------------------- 落盘


def stage(changed: dict[str, tuple[str, str]]) -> dict[str, Path]:
    """在每个文件当前所在目录写一份临时文件。镜像目录改名时，它们跟着目录一起走。"""
    staged: dict[str, Path] = {}
    try:
        for p, (_, text) in changed.items():
            fd, tmp = tempfile.mkstemp(prefix=".rename-", suffix=".tmp", dir=(WS / p).parent)
            with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
                fh.write(text)
            staged[p] = Path(tmp)
    except OSError as exc:
        drop(staged.values())
        raise RenameError(f"写临时文件失败：{exc}。没有改动任何文件。") from exc
    return staged


def drop(paths) -> None:
    for t in paths:
        try:
            os.unlink(t)
        except OSError:
            pass


def do_renames(plan: Plan, staged: dict[str, Path]) -> dict[str, Path]:
    """按「镜像目录 → 目录里的 Word → 原稿 → 原稿旁的 Word」改名。任何一步失败全部改回去。"""
    done: list[tuple[Path, Path]] = []
    moved = dict(staged)
    try:
        for r in plan.renames:
            a, b = WS / r["from"], WS / r["to"]
            if r["from"].startswith(f"{plan.old_mirror}/") and plan.has_mirror:
                a = WS / plan.new_mirror / r["from"][len(plan.old_mirror) + 1:]
            # os.rename 在 POSIX 上会静默覆盖同名文件：动手前再看一眼（只改大小写时是同一个文件，放行）
            if b.exists() and not (a.exists() and os.path.samefile(a, b)):
                raise OSError(f"{r['to']} 刚刚被占用")
            os.rename(a, b)
            done.append((a, b))
            if r["kind"] == "dir":
                prefix = f"{plan.old_mirror}/"
                for p, t in moved.items():
                    if p.startswith(prefix):
                        moved[p] = WS / plan.new_mirror / t.relative_to(WS / plan.old_mirror)
    except OSError as exc:
        undo_failed = []
        for a, b in reversed(done):
            try:
                os.rename(b, a)
            except OSError:
                undo_failed.append(f"{rel(b)} → {rel(a)}")
        drop(staged.values())
        msg = f"改名失败：{exc}。"
        if undo_failed:
            msg += "以下几步没能改回去，请手动处理：" + "；".join(undo_failed)
        else:
            msg += "已经全部改回原样，没有文件被改动。"
        raise RenameError(msg) from exc
    return moved


def apply(src: str, new_stem: str, expect: str) -> dict:
    plan, changed, summary = build_plan(src, new_stem)
    if summary["plan"] != expect:
        raise RenameError("预览之后有文件变了，请重新预览（重新打开重命名弹窗会按当前内容重算）。磁盘上没有任何变化。", 3, "stale")
    staged = stage(changed)
    moved = do_renames(plan, staged)
    failed = []
    for p, tmp in moved.items():
        target = WS / plan.final_location(p)
        try:
            os.replace(tmp, target)
        except OSError as exc:
            failed.append(f"{plan.final_location(p)}（{exc}）")
            drop([tmp])
    summary["failed"] = failed
    if failed:
        # 改名已经做完，再改一次名去补救只会更乱：如实说哪些引用没更新
        raise RenameError(
            f"文件已经改名为 {plan.dst}，但这些文件里的链接没能更新：" + "；".join(failed)
            + "。请手动把里面的旧路径改成新路径。")
    return summary


def emit_error(exc: RenameError, as_json: bool) -> int:
    print(str(exc), file=sys.stderr)
    if as_json:
        print(json.dumps({"ok": False, "error": str(exc), "kind": exc.kind,
                          **({"hint": exc.hint} if exc.hint else {})}, ensure_ascii=False))
    return exc.exit_code


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="重命名 output/<组>/ 下的一份产出物，连带交付稿与所有引用")
    ap.add_argument("--source", required=True, help="工作空间相对路径，如 output/docs/实施方案.md")
    ap.add_argument("--to", required=True, help="新名字，不带扩展名")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="只打计划和指纹，不动磁盘")
    mode.add_argument("--apply", action="store_true", help="按计划执行，必须带 --expect")
    ap.add_argument("--expect", default="", help="--dry-run 给出的指纹")
    ap.add_argument("--json", action="store_true", help="结果打成一行 JSON")
    args = ap.parse_args()

    try:
        src = check_source(args.source)
        name = os.path.basename(src)
        ext = os.path.splitext(name)[1]
        new_stem = check_name(args.to, name[: len(name) - len(ext)] if ext else name)
        if args.apply:
            if not re.fullmatch(r"[0-9a-f]{16}", args.expect or ""):
                raise bad("执行要带 --expect <指纹>，先用 --dry-run 拿到它。")
            result = apply(src, new_stem, args.expect)
        else:
            result = build_plan(src, new_stem)[2]
    except RenameError as exc:
        return emit_error(exc, args.json)

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
        return 0
    verb = "已改名" if args.apply else "将改名"
    for r in result["renames"]:
        print(f"{verb}：{r['from']} → {r['to']}")
    print(f"{'已更新' if args.apply else '将更新'} {result['linkFiles']} 个文件中的 {result['links']} 处链接")
    for f in result["files"]:
        extra = [x for x, on in (("source_sha", f.get("sourceSha")), ("状态流水留痕", f.get("flow"))) if on]
        print(f"  {f['path']}" + (f" · {f['links']} 处" if f["links"] else "") + (f" · {'、'.join(extra)}" if extra else ""))
    if not args.apply:
        print(f"指纹：{result['plan']}")
        print(f"确认无误后执行：python3 scripts/rename_output.py --source {src} --to {new_stem} --apply --expect {result['plan']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
