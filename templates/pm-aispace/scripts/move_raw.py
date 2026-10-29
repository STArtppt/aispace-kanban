#!/usr/bin/env python3
"""原始资料整理：给 `input/raw/` 里的一个文件或目录改名，或移到 `input/raw/` 下的另一个目录，关联一次跟到位。

为什么要有它
------------
看板和转换脚本按**路径**把原件和它的一切对上：`input/INDEX.md` 的台账行、`output/converted/` 里与
`input/raw/` 同构的产物、产物 front-matter 的 `source`、`input/.ingestignore` 里的字面路径、
别处文档里指向原件或产物的链接。在文件夹里手挪，这些全断：列表里多出一份「待转」，旧产物成了孤儿，
被忽略的资料重新冒出来。

它做的事
--------
1. 改名或移动原件（文件或整个目录），**原件字节不动**（目录改名，不复制），所以「已转」不会变成「原件已改」。
2. 对应的转换产物搬到新的镜像位置（落点调 `layout.py`，不手写规则），改写产物的 `source` / `sources`、
   `payload` / `preview`，以及因为换了目录而失效的相对链接（含指向 `input/assets/` 的图片，图片本身不动）。
3. 改写台账表格里对得上的行；「## 人工批注」只改解析后指向旧路径的链接，普通句子不动。
4. `.ingestignore`：整行等于被移动的路径（或在它下面）的规则改前缀；规则是被移动项的上级目录、
   移动后又不在它下面了，就追加一行新路径，忽略状态不变；只靠通配符命中的规则不改，在预览里单列。
5. `output/**` 的 `.md` / `.yaml` / `.yml`、`output/docx-template/**` 的 `.json` 与根 `project.yaml` 里
   解析后指向旧路径的链接和字段改成新路径（链接规则与 `rename_output.py` 同一份）；
   交付稿 `v*.md` 只改 front-matter；记录「## 状态流水」不改；内容因此变了的原稿，交付稿 `source_sha` 换新。
6. `input/assets/未分类/_manifest.md` 里列的原件路径改成新路径。

不碰：原件内容、`input/assets/` 的文件、`input/sources/`、`output/delivery/` 的 `.docx`、`visualization/`、`.claude/`。
**不删除任何文件**，整理后留下的空目录也不删。不为这次整理重跑 `ingest.py`。

点表集（`input/raw/` 的直接子目录，整目录汇总成一份产物）只能原地改名；点表文件不能单独改名或移动；
含点表文件的子树不能换到另一个顶层目录下。

两步走
------
    python3 scripts/move_raw.py --source input/raw/批次甲/说明.docx --to 说明-修订 --dry-run
    python3 scripts/move_raw.py --source input/raw/批次甲 --into input/raw/归档 --dry-run
    python3 scripts/move_raw.py --source … --into … --apply --expect <指纹>

`--to` 是新名字（文件不写扩展名，扩展名不变；目录写完整名字），`--into` 是目标目录（`input/raw` 本身也行），
二者只取一个。`--dry-run` 打出计划和指纹；`--apply` 重算一遍，指纹对不上就一个字节都不动。
看板「输入资料 → 原始资料 → 重命名 / 移动到…」调的就是它（看板只 spawn，自己不写盘）。

退出码：0 = 成功；1 = 执行失败；2 = 落点已存在；3 = 预览之后文件变了；4 = 参数不合法或不允许这样整理。
带 `--json` 时，失败也在标准输出最后一行打 `{"ok": false, "error": …, "kind": …}`。
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path, PurePosixPath
from urllib.parse import quote, unquote

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ingest  # noqa: E402  点表 / 现场数据的判定与台账行格式，与转换脚本同一份
import layout  # noqa: E402  产物落点与忽略清单的共用约定
import rename_output as ro  # noqa: E402  链接解析与 source_sha 跟进，与产出改名同一份
from copy_converted import FENCE_RE, IMG_RE  # noqa: E402  代码块与 <img> 的识别，与复制同一份

WS = layout.REPO
RAW = "input/raw"
INDEX = "input/INDEX.md"
IGNORE = "input/.ingestignore"
ASSET_MANIFEST = "input/assets/未分类/_manifest.md"
TEMPLATE_DIR = "output/docx-template"
MAX_NAME = 200
HEAD_BYTES = 8192


class MoveError(Exception):
    """exit_code：1 执行失败，2 落点已存在，3 指纹不符，4 参数或不允许。kind 给看板区分。"""

    def __init__(self, message: str, exit_code: int = 1, kind: str = "failed") -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.kind = kind


def bad(message: str, kind: str = "invalid") -> MoveError:
    return MoveError(message, 4, kind)


def rel(p: Path) -> str:
    return p.relative_to(WS).as_posix()


def dirname(p: str) -> str:
    return p.rsplit("/", 1)[0] if "/" in p else ""


def relpath(target: str, base: str) -> str:
    return os.path.relpath(target, base or ".").replace(os.sep, "/")


# ---------------------------------------------------------------- 参数校验


def check_layout() -> None:
    # 与 layout.ensure_layout / 看板 scan.mjs 的 convertedRootOf 同一判据
    if layout.has_entries(layout.LEGACY_CONVERTED) and not layout.has_entries(layout.CONVERTED):
        raise bad("转换产物还在旧位置 input/converted/，先迁移到 output/converted/ 再整理原始资料："
                  "python3 scripts/migrate_converted_to_output.py --dry-run。磁盘上没有任何变化。",
                  "legacy-converted")


def check_raw_path(raw: str, what: str) -> str:
    p = raw.strip().replace("\\", "/").rstrip("/")
    parts = p.split("/")
    if not p or p.startswith("/") or any(x in ("", ".", "..") for x in parts):
        raise bad(f"{what}必须是工作空间相对路径，不能有 `..` 或空段：{raw}")
    if parts[:2] != ["input", "raw"]:
        raise bad(f"{what}必须在 input/raw/ 里：{p}。原始资料不能移出 input/raw/。")
    if any(x.startswith(".") for x in parts[2:]):
        raise bad(f"不整理隐藏文件或隐藏目录：{p}")
    # 路径上任何一段是符号链接都不行：改名会落到工作空间外面去
    cur = WS
    for x in parts:
        cur = cur / x
        if cur.is_symlink():
            raise bad(f"{rel(cur)} 是符号链接，不整理。")
    return p


def check_source(raw: str) -> str:
    src = check_raw_path(raw, "来源")
    if src == RAW:
        raise bad("input/raw 本身不能改名或移动。")
    if not (WS / src).exists():
        raise bad(f"找不到 {src}。可能已经被移走或改名，刷新列表看一眼。", "missing")
    return src


def check_name(raw: str, is_dir: bool, cur_name: str) -> str:
    name = raw
    if not name or not name.strip():
        raise bad("新名字是空的。")
    if name != name.strip():
        raise bad(f"新名字首尾不能是空白：「{name}」")
    if name in (".", ".."):
        raise bad("新名字不能是 . 或 ..")
    if "/" in name or "\\" in name or "\0" in name:
        raise bad(f"新名字只能是一层名字，不能含 / \\ 或空字符：{name}")
    if name.startswith("."):
        raise bad(f"新名字不能以 . 开头（以点开头的资料转换时会被跳过，改完就从列表里消失）：{name}")
    if name.endswith("."):
        raise bad(f"新名字不能以 . 结尾（Windows 上会被吞掉）：{name}")
    if len(name) > MAX_NAME:
        raise bad(f"新名字超过 {MAX_NAME} 个字。")
    ext = "" if is_dir else os.path.splitext(cur_name)[1]
    full = name + ext
    if full == cur_name:
        raise bad("新名字和原来的一样。")
    return full


def check_dest(raw: str, src: str) -> str:
    dest = check_raw_path(raw, "目标目录")
    if not (WS / dest).is_dir():
        raise bad(f"目标目录不存在：{dest}。刷新列表看一眼。", "missing")
    if dest == dirname(src):
        raise bad(f"{src} 已经在 {dest}/ 里了。")
    if dest == src or dest.startswith(src + "/"):
        raise bad("不能把目录移进它自己或它的子目录。")
    return dest


# ---------------------------------------------------------------- 路径映射


class Move:
    """一次整理的全部路径规则。所有引用判定都走 map_path：给一个旧的工作空间路径，答它整理后在哪。"""

    def __init__(self, src: str, dst: str, is_dir: bool) -> None:
        self.src, self.dst, self.is_dir = src, dst, is_dir
        self.exact: dict[str, str] = {}
        self.prefix: dict[str, str] = {}
        # 执行顺序；from / to 是执行那一刻的路径（目录先改名，里面的文件跟着走）
        self.ops: list[dict] = []
        # 给人看的改名清单：都是整理前 → 整理后
        self.shown: list[dict] = []
        self.products: list[dict] = []

    def add(self, old: str, new: str, kind: str, op_from: str | None = None, show: bool = True) -> None:
        if old == new:
            return
        (self.prefix if kind == "dir" else self.exact)[old] = new
        self.ops.append({"from": op_from or old, "to": new, "kind": kind})
        if show:
            self.shown.append({"from": old, "to": new, "kind": kind})

    def map_path(self, p: str | None) -> str | None:
        if not p:
            return None
        trail = p.endswith("/")
        q = p.rstrip("/")
        out = self.exact.get(q)
        if out is None:
            for old in sorted(self.prefix, key=len, reverse=True):
                if q == old or q.startswith(old + "/"):
                    out = self.prefix[old] + q[len(old):]
                    break
        if out is None:
            return None
        return out + ("/" if trail else "")

    def roots(self) -> list[tuple[str, bool]]:
        """字面路径的匹配根：(旧路径, 是不是目录)。长的在前，目录里单独改名的文件先于目录前缀命中。"""
        items = [(k, False) for k in self.exact] + [(k, True) for k in self.prefix]
        return sorted(items, key=lambda x: len(x[0]), reverse=True)


def head_text(p: Path) -> str:
    try:
        with open(p, "rb") as fh:
            return fh.read(HEAD_BYTES).decode("utf-8", "replace")
    except OSError:
        return ""


def front_field(p: Path, key: str) -> str:
    return ro.front_value(head_text(p), key)


def inside_converted(p: Path) -> bool:
    try:
        p.relative_to(layout.CONVERTED)
        return True
    except ValueError:
        return False


def index_row_target(src: str) -> str | None:
    """台账里这份原件那一行的产物（工作空间相对路径）。"""
    try:
        text = (WS / INDEX).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    for line in text.split("## 人工批注", 1)[0].splitlines():
        m = ingest.ROW_RE.match(line)
        if not m or m.group(1).rstrip("/") != src:
            continue
        link = re.match(r"\[`([^`]+)`\]", m.group(3))
        return ro.resolve("input", link.group(1)) if link else None
    return None


def products_of_file(src: str) -> list[tuple[str, str | None]]:
    """一份原件现有的产物：[(产物文件, 正文目录或 None)]。按「现有 source」认，不按名字猜。"""
    abs_src = WS / src
    mdir = layout.mirror_dir(abs_src)
    found: dict[str, None] = {}
    if mdir.is_dir() and not mdir.is_symlink():
        for f in sorted(mdir.iterdir()):
            if (f.is_file() and not f.is_symlink() and not f.name.startswith(".")
                    and f.suffix.lower() == ".md" and front_field(f, "source") == src):
                found[rel(f)] = None
    row = index_row_target(src)
    if row and (WS / row).is_file() and inside_converted(WS / row) and not (WS / row).is_symlink():
        if not row.lower().endswith(".md") or front_field(WS / row, "source") == src:
            found[row] = None
    # 直接拷过去的 .csv / .json 这类没有 front-matter，只能认「与原件同扩展名的镜像落点」
    ext = abs_src.suffix.lower()
    if ext in ingest.PASSTHROUGH and ext not in {".md", ".markdown", ".txt"}:
        t = layout.single_target(abs_src, ext)
        if t.is_file() and not t.is_symlink():
            found[rel(t)] = None
    out = []
    for p in found:
        payload = None
        val = front_field(WS / p, "payload") if p.lower().endswith(".md") else ""
        if val:
            cand = ro.resolve(dirname(p), val)
            if cand and (WS / cand).is_dir() and not (WS / cand).is_symlink() and inside_converted(WS / cand):
                payload = cand
        out.append((p, payload))
    return out


def plan_file(mv: Move) -> None:
    s, d = WS / mv.src, WS / mv.dst
    mv.add(mv.src, mv.dst, "file")
    for prod, payload in products_of_file(mv.src):
        p = WS / prod
        suf = p.suffix
        if p == layout.single_target(s, suf):
            new = layout.single_target(d, suf)
        elif p == layout.split_paths(s)[0]:
            new = layout.split_paths(d)[0]
        else:
            new = layout.mirror_dir(d) / p.name
        new_rel = rel(new)
        mv.add(prod, new_rel, "file")
        mv.products.append({"from": prod, "to": new_rel})
        if payload:
            if WS / payload == layout.split_paths(s)[1]:
                new_payload = rel(layout.split_paths(d)[1])
            else:
                new_payload = ro.resolve(dirname(new_rel), relpath(payload, dirname(prod))) or payload
            mv.add(payload, new_payload, "dir")


def plan_dir(mv: Move) -> None:
    s, d = WS / mv.src, WS / mv.dst
    mv.add(mv.src, mv.dst, "dir")
    mo, mn = layout.mirror_of(s), layout.mirror_of(d)
    if not mo.is_dir() or mo.is_symlink():
        return
    # 两个原件目录的名字安全化后撞到同一个镜像目录：整个搬走会把别人的产物也带走
    for sib in s.parent.iterdir():
        if sib != s and sib.is_dir() and not sib.name.startswith(".") and layout.mirror_of(sib) == mo:
            raise bad(f"{rel(sib)} 和 {mv.src} 的产物共用镜像目录 {rel(mo)}/，没法只搬一个。先在文件夹外核对这两份资料。")
    old_m, new_m = rel(mo), rel(mn)
    mv.add(old_m, new_m, "dir")
    mv.products.append({"from": old_m, "to": new_m})
    # 点表集原地改名：合并摘要的名字跟着目录名走（merge_paths），正文目录 MergedObject/ 名字不变
    m_old, m_new = layout.merge_paths(s)[0], layout.merge_paths(d)[0]
    if m_old.is_file() and m_old.name != m_new.name:
        mv.add(rel(m_old), rel(m_new), "file", op_from=f"{new_m}/{m_old.name}")


def list_files(p: str) -> list[str]:
    abs_p = WS / p
    if abs_p.is_file():
        return [p]
    out = []
    for dirpath, dirnames, filenames in os.walk(abs_p):
        dirnames.sort()
        for n in sorted(filenames):
            out.append(rel(Path(dirpath) / n))
    return out


def guard_special(mv: Move, files: list[str], moving: bool) -> None:
    """点表与现场数据的成集规则（design 决策 5）。判定调 ingest.py，不另写一套。"""
    if not mv.is_dir:
        if ingest.is_pointtable(WS / mv.src):
            raise bad(f"{mv.src} 是点表文件。点表按整个目录（input/raw/<点表集>/）汇总成一份产物，"
                      "不能单独改名或移动；要整理就给整个点表集改名。", "pointtable")
        if moving and dirname(mv.dst) == RAW and ingest.is_realdata(WS / mv.src):
            raise bad(f"{mv.src} 是现场实测数据。放在 input/raw/ 根上不会被当成数据集，换一个子目录。", "realdata")
        return
    old_top, new_top = mv.src.split("/")[2], mv.dst.split("/")[2]
    if not moving or old_top == new_top:
        return
    for f in files:
        if PurePosixPath(f).name.startswith("."):
            continue
        if ingest.is_pointtable(WS / f):
            if dirname(mv.src) == RAW:
                raise bad(f"{mv.src} 是点表集。点表集只能是 input/raw/ 的直接子目录，只能在根上原地改名，"
                          "不能移进别的目录。", "pointtable")
            raise bad(f"{mv.src} 里有点表文件（{f}）。移过去会让它换到另一个点表集下，下次转换会合并错。"
                      "要整理就给整个点表集改名。", "pointtable")


def conflicts(mv: Move) -> list[str]:
    out = []
    for op in mv.ops:
        a, b = WS / op["from"], WS / op["to"]
        if op["from"] != mv.src and not a.exists():
            continue  # 目录里跟着走的文件，执行时才在新位置
        if b.exists() or b.is_symlink():
            try:
                # 大小写不敏感的文件系统上只改大小写：新旧是同一个文件，不算冲突
                if a.exists() and os.path.samefile(a, b):
                    continue
            except OSError:
                pass
            out.append(f"{op['to']} 已经存在")
    return out


# ---------------------------------------------------------------- 链接识别与改写


def literal_re(mv: Move) -> re.Pattern | None:
    trail = f"(?=[{ro.TRAIL_CHARS}]|$)"
    dir_trail = f"(?=[/{ro.TRAIL_CHARS}]|$)"
    alts = [f"{re.escape(k)}{dir_trail if is_dir else trail}" for k, is_dir in mv.roots()]
    return re.compile(ro.LEAD + "(?:" + "|".join(alts) + ")", re.M) if alts else None


def needles(mv: Move) -> set[str]:
    """一个没挪位置的文件要改，正文里必然出现某个被改名路径的最后一段。先粗筛，省掉大多数文件的正则。"""
    out: set[str] = set()
    for k, _ in mv.roots():
        last = k.rsplit("/", 1)[-1]
        stem = last[:-3] if last.lower().endswith(".md") else last
        for s in (last, stem):
            out.update({s, layout.md_link(s), quote(s)})
    return {n for n in out if n}


def rebuild_rel(target: str, base: str, encode: bool) -> str:
    r = relpath(target, base)
    return layout.md_link(r) if encode else r


def find_edits(text: str, old: str, new: str, mv: Move, lit: re.Pattern | None,
               lo: int = 0, hi: int | None = None, skip: list[tuple[int, int]] | None = None) -> list[tuple[int, int, str]]:
    """text[lo:hi] 里的改写点。old / new 是这个文件整理前后的位置（产物会跟着搬）。

    链接按「旧位置解析 → 映射 → 从新位置重算」；文件没挪、目标也没挪的不动。
    没挪位置的文件尽量只换变了的那几段（rename_output.rewrite_segments），保住原来的写法。
    """
    hi = len(text) if hi is None else hi
    base_old, base_new = dirname(old), dirname(new)
    moved = old != new
    taken: list[tuple[int, int]] = list(skip or [])
    fences = [m.span() for m in FENCE_RE.finditer(text)] if old.lower().endswith(".md") else []
    edits: list[tuple[int, int, str]] = []

    def free(a: int, b: int) -> bool:
        return all(b <= x or a >= y for x, y in taken)

    def fenced(a: int) -> bool:
        return any(x <= a < y for x, y in fences)

    def relink(decoded: str, raw_segs: list[str] | None, encode: bool) -> str | None:
        resolved = ro.resolve(base_old, decoded)
        if not resolved:
            return None
        mapped = mv.map_path(resolved)
        target = mapped or resolved
        if not mapped and not moved:
            return None
        if ro.resolve(base_new, decoded) == target:
            return None  # 原写法在新位置照样指到同一处
        if not mapped and not (WS / resolved).exists():
            return None  # 本来就是断链，不猜
        if not moved and raw_segs is not None:
            kept = ro.rewrite_segments(raw_segs, decoded.split("/"), resolved, target,
                                       encode=ro.encode_link_seg if encode else None)
            if kept is not None:
                return kept
        return rebuild_rel(target, base_new, encode)

    if old.lower().endswith(".md"):
        for m in ro.WIKI_RE.finditer(text, lo, hi):
            if not free(m.start(), m.end()) or fenced(m.start()):
                continue
            inner = m.group(2)
            pipe = inner.find("|")
            main = inner if pipe == -1 else inner[:pipe]
            hash_ = main.find("#")
            target = (main if hash_ == -1 else main[:hash_]).strip()
            if not target or "\0" in target or ro.SCHEME_RE.match(target):
                continue
            t = target.replace("\\", "/")
            file = ro.ensure_ext(t)
            strip = file != t
            relative = file.startswith("./") or file.startswith("../") or "/" not in file
            resolved = ro.resolve(base_old if relative else "", file)
            if not resolved:
                continue
            mapped = mv.map_path(resolved)
            dest = mapped or resolved
            if relative:
                if ro.resolve(base_new, file) == dest or (not mapped and not moved):
                    continue
                if not mapped and not (WS / resolved).exists():
                    continue
                kept = None if moved else ro.rewrite_segments(t.split("/"), t.split("/"), resolved, dest,
                                                              ".md" if strip else "")
                if kept is None:
                    r = relpath(dest, base_new)
                    if not r.startswith("../") and ("/" in r or "/" in file):
                        r = "./" + r  # 带 / 的 wikilink 从根算，相对写法必须带 ./
                    kept = r[:-3] if strip and r.endswith(".md") else r
            else:
                if not mapped:
                    continue
                kept = ro.rewrite_segments(t.split("/"), t.split("/"), resolved, mapped, ".md" if strip else "")
                if kept is None:
                    kept = mapped[:-3] if strip and mapped.endswith(".md") else mapped
            t_start = m.start(2) + main.find(target)
            edits.append((t_start, t_start + len(target), kept))
            taken.append((m.start(), m.end()))

        for m in IMG_RE.finditer(text, lo, hi):
            if not free(m.start(), m.end()) or fenced(m.start()):
                continue
            raw = m.group(2)[1:-1]
            cut = min((i for i in (raw.find("#"), raw.find("?")) if i >= 0), default=len(raw))
            path_part = raw[:cut]
            if not path_part or path_part.startswith("/") or ro.SCHEME_RE.match(path_part):
                continue
            new_path = relink(unquote(path_part), None, False)
            if new_path is None:
                continue
            a = m.start(2) + 1
            edits.append((a, a + len(path_part), new_path))
            taken.append((m.start(), m.end()))

    for m in ro.MDLINK_RE.finditer(text, lo, hi):
        if not free(m.start(), m.end()) or fenced(m.start()):
            continue
        dest = m.group(1)
        d_start = m.start(1)
        angle = dest.startswith("<") and dest.endswith(">")
        if angle:
            dest, d_start = dest[1:-1], d_start + 1
        path_part = re.split(r"[?#]", dest, maxsplit=1)[0]
        if not path_part or ro.SCHEME_RE.match(path_part) or path_part.startswith("/"):
            continue
        raw_segs = path_part.split("/")
        new_path = relink("/".join(unquote(s) for s in raw_segs), raw_segs, not angle)
        if new_path is None:
            continue  # 留给下面的根路径规则：`[x](input/raw/旧.docx)` 这种写法按根路径认
        edits.append((d_start, d_start + len(path_part), new_path))
        taken.append((m.start(), m.end()))

    if lit is not None:
        for m in lit.finditer(text, lo, hi):
            if not free(m.start(), m.end()):
                continue
            mapped = mv.map_path(m.group(0))
            if mapped:
                edits.append((m.start(), m.end(), mapped))
                taken.append((m.start(), m.end()))
    return edits


def front_path_edits(text: str, old: str, new: str, mv: Move) -> list[tuple[int, int, str]]:
    """搬走的摘要里 `payload:` / `preview:` 相对摘要自己写，换了目录或正文目录改了名要重算。"""
    fm = ro.FRONT_RE.match(text)
    if not fm or old == new:
        return []
    edits = []
    for key in ("payload", "preview"):
        m = re.search(rf"^{key}:[ \t]*(['\"]?)(.+?)\1[ \t]*\r?$", fm.group(0), re.M)
        if not m:
            continue
        val = m.group(2)
        resolved = ro.resolve(dirname(old), val)
        if not resolved:
            continue
        target = mv.map_path(resolved) or resolved
        if ro.resolve(dirname(new), val) == target:
            continue
        edits.append((m.start(2), m.end(2), relpath(target, dirname(new))))
    return edits


def json_edits(text: str, mv: Move) -> list[tuple[int, int, str]]:
    """JSON 只改「整个字符串值等于旧路径」的，不碰字符串内部。"""
    edits = []
    for m in re.finditer(r'"((?:[^"\\\n]|\\.)*)"', text):
        try:
            val = json.loads(m.group(0))
        except ValueError:
            continue
        mapped = mv.map_path(val) if isinstance(val, str) else None
        if mapped:
            edits.append((m.start(), m.end(), json.dumps(mapped, ensure_ascii=False)))
    return edits


def index_edits(text: str, mv: Move, lit: re.Pattern | None) -> tuple[list[tuple[int, int, str]], int]:
    """台账：表格行按 ingest.py 的写法重排这一行；表格外的说明和「人工批注」只改链接。"""
    cut = text.find("## 人工批注")
    head_end = cut if cut >= 0 else len(text)
    edits: list[tuple[int, int, str]] = []
    rows = 0
    pos = 0
    for line in text[:head_end].splitlines(keepends=True):
        body = line.rstrip("\r\n")
        m = ingest.ROW_RE.match(body)
        if m and m.group(1) != "原始文件":
            source, kind, cell, status = m.groups()
            new_source = mv.map_path(source)
            new_cell = cell
            link = re.match(r"\[`([^`]+)`\]", cell)
            if link:
                resolved = ro.resolve("input", link.group(1))
                mapped = mv.map_path(resolved) if resolved else None
                if mapped:
                    t = relpath(mapped, "input")
                    new_cell = f"[`{t}`]({ingest.index_link(t)})"
            if new_source or new_cell != cell:
                edits.append((pos, pos + len(body), f"| `{new_source or source}` | {kind} | {new_cell} | {status} |"))
                rows += 1
        else:
            edits.extend(find_edits(text, INDEX, INDEX, mv, lit, pos, pos + len(body)))
        pos += len(line)
    if cut >= 0:
        edits.extend(find_edits(text, INDEX, INDEX, mv, lit, cut, len(text)))
    return edits, rows


def glob_hit(pat: str, p: str) -> bool:
    return PurePosixPath(p).match(pat) or PurePosixPath(p.rsplit("/", 1)[-1]).match(pat)


def ignore_plan(text: str, mv: Move, moved_files: list[str]) -> tuple[str, dict]:
    """改写 .ingestignore。规则相对 input/ 写。分类跟着 layout.is_ignored 的顺序：先字面、再通配符。"""
    old, new = mv.src[len("input/"):], mv.dst[len("input/"):]
    pairs = [(f[len("input/"):], (mv.map_path(f) or f)[len("input/"):]) for f in moved_files]
    if mv.is_dir:
        pairs.append((old, new))
    olds = [a for a, _ in pairs]
    rewritten, added, wildcard = [], [], []
    lines = text.splitlines(keepends=True)
    out = []
    for line in lines:
        s = line.strip()
        pat = s.rstrip("/")
        if not s or s.startswith("#"):
            out.append(line)
            continue
        # 字面命中 = 某个被移动的路径等于这条规则、或在它下面（layout.is_ignored 的第一支）。
        # 光是以被移动目录开头不算：`raw/批次甲/*.pdf` 只靠通配符命中，改前缀会改掉它的含义
        if ((pat == old or pat.startswith(old + "/"))
                and any(a == pat or a.startswith(pat + "/") for a in olds)):
            repl = new + pat[len(old):] + ("/" if s.endswith("/") else "")
            out.append(line.replace(s, repl, 1))
            rewritten.append({"from": s, "to": repl})
            continue
        out.append(line)
        if old.startswith(pat + "/"):
            # 规则是被移动项的上级目录：移出去之后就不再被它忽略，追加一行新路径保住忽略状态
            if not new.startswith(pat + "/") and new not in added:
                added.append(new)
            continue
        if any(glob_hit(pat, a) != glob_hit(pat, b) for a, b in pairs):
            wildcard.append(s)
    result = "".join(out)
    if added:
        if result and not result.endswith("\n"):
            result += "\n"
        result += "".join(f"{a}\n" for a in added)
    return result, {"rewritten": rewritten, "added": added, "wildcard": wildcard}


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
        dirnames[:] = sorted(n for n in dirnames
                             if not n.startswith(".") and n not in ro.SKIP_DIRS and not (d / n).is_symlink())
        in_template = here == TEMPLATE_DIR or here.startswith(TEMPLATE_DIR + "/")
        for n in sorted(filenames):
            ext = os.path.splitext(n)[1].lower()
            if n.startswith(".") or not (ext in ro.SCAN_EXT or (in_template and ext == ".json")):
                continue
            p = d / n
            try:
                if p.is_symlink() or p.stat().st_size > ro.MAX_SCAN_BYTES:
                    continue
            except OSError:
                continue
            out.append(rel(p))
    return out


def stat_sig(p: str) -> list:
    try:
        st = os.lstat(WS / p)
        return [st.st_size, st.st_mtime_ns]
    except OSError:
        return [None, None]


# ---------------------------------------------------------------- 计划


def build_plan(src: str, to: str | None, into: str | None) -> tuple[Move, dict[str, tuple[str, str]], dict]:
    check_layout()
    is_dir = (WS / src).is_dir()
    if to is not None:
        dst = f"{dirname(src)}/{check_name(to, is_dir, src.rsplit('/', 1)[-1])}"
    else:
        dst = f"{check_dest(into or '', src)}/{src.rsplit('/', 1)[-1]}"
    mv = Move(src, dst, is_dir)
    files = list_files(src)
    guard_special(mv, files, into is not None)
    (plan_dir if is_dir else plan_file)(mv)
    clash = conflicts(mv)
    if clash:
        raise MoveError("不能这样整理：" + "；".join(clash) + "。不覆盖、不合并，磁盘上没有任何变化。", 2, "conflict")

    lit = literal_re(mv)
    marks = needles(mv)
    before: dict[str, str] = {}
    after: dict[str, str] = {}
    links: dict[str, int] = {}
    index_rows = 0

    for p in scan_files():
        text = ro.read_text(p)
        if text is None:
            continue
        before[p] = text
        new = mv.map_path(p) or p
        if new == p and not any(n in text for n in marks):
            continue
        if p.endswith(".json"):
            edits = json_edits(text, mv)
        elif ro.is_delivery_version(p):
            # 交付稿只改 front-matter：正文写出后不再改动
            fm = ro.FRONT_RE.match(text)
            edits = find_edits(text, p, new, mv, lit, 0, fm.end()) if fm else []
        elif ro.is_record(p):
            span = ro.flow_span(text)
            edits = find_edits(text, p, new, mv, lit, skip=[span] if span else None)
        else:
            fp = front_path_edits(text, p, new, mv)
            edits = fp + find_edits(text, p, new, mv, lit, skip=[(a, b) for a, b, _ in fp])
        if edits:
            after[p] = ro.apply_edits(text, edits)
            links[p] = len(edits)

    for p in (INDEX, ASSET_MANIFEST):
        text = ro.read_text(p) if (WS / p).is_file() and not (WS / p).is_symlink() else None
        if text is None:
            continue
        before[p] = text
        if p == INDEX:
            edits, index_rows = index_edits(text, mv, lit)
        else:
            edits = find_edits(text, p, p, mv, lit)
        if edits:
            after[p] = ro.apply_edits(text, edits)
            links[p] = len(edits)

    ignore = {"rewritten": [], "added": [], "wildcard": []}
    if (WS / IGNORE).is_file() and not (WS / IGNORE).is_symlink():
        text = ro.read_text(IGNORE)
        if text is not None:
            before[IGNORE] = text
            new_text, ignore = ignore_plan(text, mv, files)
            if new_text != text:
                after[IGNORE] = new_text
                links[IGNORE] = len(ignore["rewritten"]) + len(ignore["added"])

    sha_follow = ro.follow_source_sha(before, after)

    changed = {p: (before[p], after[p]) for p in sorted(after) if after[p] != before[p]}
    file_rows = [{
        "path": p,
        "newPath": mv.map_path(p) or p,
        "links": links.get(p, 0),
        **({"sourceSha": True} if p in sha_follow else {}),
    } for p in changed]
    # 指纹 = 改名对 + 被移动原件的路径、大小、修改时间 + 每个要改写的文件前后的摘要与大小、修改时间。
    # 预览之后原件被改过、目录里多了或少了文件，都会对不上
    finger = json.dumps({
        "ops": mv.ops,
        "moved": [[f, *stat_sig(f)] for f in files],
        "files": [[p, ro.sha16(b), ro.sha16(a), *stat_sig(p)] for p, (b, a) in changed.items()],
    }, ensure_ascii=False, sort_keys=True)
    # 给前端改收藏和当前打开的条目：dir 为真的按前缀换，否则整条相等才换
    path_map = [{"from": k, "to": v, "dir": False} for k, v in mv.exact.items()] + [
        {"from": k, "to": v, "dir": True} for k, v in mv.prefix.items()]
    summary = {
        "ok": True,
        "mode": "rename" if to is not None else "move",
        "source": src,
        "to": mv.dst,
        "isDir": is_dir,
        "renames": mv.shown,
        "rawFiles": len(files),
        "products": mv.products,
        "files": file_rows,
        "indexRows": index_rows,
        "ignore": ignore,
        "linkFiles": sum(1 for f in file_rows if f["links"]),
        "links": sum(f["links"] for f in file_rows),
        "pathMap": path_map,
        "plan": hashlib.sha256(finger.encode("utf-8")).hexdigest()[:16],
    }
    return mv, changed, summary


# ---------------------------------------------------------------- 落盘


def drop(paths) -> None:
    for t in paths:
        try:
            os.unlink(t)
        except OSError:
            pass


def stage(changed: dict[str, tuple[str, str]]) -> dict[str, Path]:
    """在每个文件当前所在目录写一份临时文件。镜像目录改名时，它们跟着目录一起走。"""
    staged: dict[str, Path] = {}
    try:
        for p, (_, text) in changed.items():
            fd, tmp = tempfile.mkstemp(prefix=".move-raw-", suffix=".tmp", dir=(WS / p).parent)
            with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
                fh.write(text)
            staged[p] = Path(tmp)
    except OSError as exc:
        drop(staged.values())
        raise MoveError(f"写临时文件失败：{exc}。没有改动任何文件。") from exc
    return staged


def make_parents(target: Path, created: list[Path]) -> None:
    missing = []
    cur = target.parent
    while not cur.exists():
        missing.append(cur)
        cur = cur.parent
    for d in reversed(missing):
        try:
            d.mkdir()
        except FileExistsError:
            continue  # 别人刚建出来的目录不归本次回收
        created.append(d)


def do_renames(mv: Move, staged: dict[str, Path]) -> dict[str, Path]:
    """按计划顺序改名，按需建镜像父目录。任何一步失败：倒序改回、删掉本次新建的空目录、删临时文件。

    临时文件的去向按改名列表逐个换算：哪个目录被改了名，落在它下面的临时文件就跟着换前缀。
    """
    done: list[tuple[Path, Path]] = []
    created: list[Path] = []
    moved = dict(staged)
    try:
        for op in mv.ops:
            a, b = WS / op["from"], WS / op["to"]
            # os.rename 在 POSIX 上会静默覆盖同名文件：动手前再看一眼（只改大小写时是同一个文件，放行）
            if (b.exists() or b.is_symlink()) and not (a.exists() and os.path.samefile(a, b)):
                raise OSError(f"{op['to']} 刚刚被占用")
            make_parents(b, created)
            os.rename(a, b)
            done.append((a, b))
            if op["kind"] == "dir":
                for p, t in moved.items():
                    try:
                        moved[p] = b / t.relative_to(a)
                    except ValueError:
                        pass
    except OSError as exc:
        undo_failed = []
        for a, b in reversed(done):
            try:
                os.rename(b, a)
            except OSError:
                undo_failed.append(f"{rel(b)} → {rel(a)}")
        for d in reversed(created):
            try:
                d.rmdir()  # 只删空目录：别人刚往里放了东西就留着
            except OSError:
                pass
        drop(staged.values())
        drop(moved.values())
        cross = isinstance(exc, OSError) and exc.errno == errno.EXDEV
        msg = ("改名失败：资料和产物不在同一块磁盘上，不能用改名搬过去（看板不会改成复制）。" if cross
               else f"改名失败：{exc}。")
        if undo_failed:
            msg += "以下几步没能改回去，请手动处理：" + "；".join(undo_failed)
        else:
            msg += "已经全部改回原样，没有文件被改动。"
        raise MoveError(msg, 4 if cross else 1, "cross-device" if cross else "failed") from exc
    return moved


def apply(src: str, to: str | None, into: str | None, expect: str) -> dict:
    mv, changed, summary = build_plan(src, to, into)
    if summary["plan"] != expect:
        raise MoveError("预览之后有文件变了，请重新预览（重新打开弹窗会按当前内容重算）。磁盘上没有任何变化。", 3, "stale")
    staged = stage(changed)
    moved = do_renames(mv, staged)
    failed = []
    for p, tmp in moved.items():
        target = mv.map_path(p) or p
        try:
            os.replace(tmp, WS / target)
        except OSError as exc:
            failed.append(f"{target}（{exc}）")
            drop([tmp])
    summary["failed"] = failed
    if failed:
        # 改名已经做完，再改一次名去补救只会更乱：如实说哪些文件没更新
        raise MoveError(f"已经整理到 {mv.dst}，但这些文件没能更新：" + "；".join(failed)
                        + "。请手动把里面的旧路径改成新路径。")
    return summary


class Parser(argparse.ArgumentParser):
    def error(self, message: str):  # type: ignore[override]
        # argparse 默认退出 2，和「落点已存在」撞了：参数错一律 4
        raise MoveError(f"参数不对：{message}", 4, "invalid")


def emit_error(exc: MoveError, as_json: bool) -> int:
    print(str(exc), file=sys.stderr)
    if as_json:
        print(json.dumps({"ok": False, "error": str(exc), "kind": exc.kind}, ensure_ascii=False))
    return exc.exit_code


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        except (AttributeError, ValueError):
            pass
    as_json = "--json" in sys.argv[1:]
    ap = Parser(description="给 input/raw/ 里的文件或目录改名、移动，连带产物、台账、忽略规则与引用")
    ap.add_argument("--source", default="", help="工作空间相对路径，如 input/raw/批次甲/说明.docx")
    ap.add_argument("--to", default=None, help="新名字（文件不写扩展名）")
    ap.add_argument("--into", default=None, help="目标目录，如 input/raw/归档；input/raw 本身也行")
    ap.add_argument("--dry-run", action="store_true", help="只打计划和指纹，不动磁盘")
    ap.add_argument("--apply", action="store_true", help="按计划执行，必须带 --expect")
    ap.add_argument("--expect", default="", help="--dry-run 给出的指纹")
    ap.add_argument("--json", action="store_true", help="结果打成一行 JSON")
    try:
        args = ap.parse_args()
        if (args.to is None) == (args.into is None):
            raise bad("--to（改名）和 --into（移动）要且只能给一个：一次只改名或只换目录。")
        if args.dry_run == args.apply:
            raise bad("--dry-run 和 --apply 要且只能给一个。")
        src = check_source(args.source)
        if args.apply:
            if not re.fullmatch(r"[0-9a-f]{16}", args.expect or ""):
                raise bad("执行要带 --expect <指纹>，先用 --dry-run 拿到它。")
            result = apply(src, args.to, args.into, args.expect)
        else:
            result = build_plan(src, args.to, args.into)[2]
    except MoveError as exc:
        return emit_error(exc, as_json)

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
        return 0
    verb = "已" if args.apply else "将"
    for r in result["renames"]:
        print(f"{verb}{'改名' if result['mode'] == 'rename' else '移动'}：{r['from']} → {r['to']}")
    print(f"{verb}更新 {result['linkFiles']} 个文件中的 {result['links']} 处路径（台账 {result['indexRows']} 行）")
    for f in result["files"]:
        extra = "、source_sha" if f.get("sourceSha") else ""
        print(f"  {f['path']}" + (f" · {f['links']} 处" if f["links"] else "") + extra)
    for w in result["ignore"]["wildcard"]:
        print(f"  ⚠ 忽略规则 {w} 含通配符，整理后可能不再套用，脚本不会改")
    if not args.apply:
        print(f"指纹：{result['plan']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
