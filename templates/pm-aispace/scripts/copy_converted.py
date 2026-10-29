#!/usr/bin/env python3
"""把一份转换产物 `.md` 复制进产出三组之一，子目录结构不变，图片链接不断。

为什么要有它
------------
想把转好的需求说明当分析底稿或交付文档继续写，手动复制要自己一层层重建目录；
正文里指向 `input/assets/<名>/` 的相对图片链接，拷过去就全断了。
**不做移动**：`ingest.py` 靠 `output/converted/` 里有产物判断「已转换」，移走了下次转换会再生成一份，
台账那一行也会被清掉。

它做的事
--------
1. 落点：`<转换产物根>/<子路径>/<名>.md` → `output/<组>/<子路径>/<名>.md`，中间目录按需新建。
   组只能是 analysis / decisions / docs。落点已存在就拒绝，不覆盖。
2. 链接重算：Markdown 链接 / 图片 `[..](相对路径)` 和 `<img src="相对路径">`，按**原位置**解析后
   落在工作空间内、文件存在的，按新位置重算相对路径，继续指向原文件（典型是 `input/assets/` 下的图）。
   带协议的、`#` 开头的、绝对路径、找不到文件的、出了工作空间的，原样保留。代码块里的不动。
   **图片不复制。**
3. 留痕：front-matter 追加 `copied_from:`（来源的工作空间相对路径）和 `copied_at:`（ISO 时间），
   原有字段（`source` / `source_sha256` …）保留；没有 front-matter 就新建一段。

只新建这**一个** `.md`（和中间目录），不覆盖、不删除、不改名任何已有文件。
转换产物根、`input/`、`output/delivery/`、`output/records/` 一个字节都不动；复制件不建记录。

来源只收转换产物根下的单文件 `.md`：不收摘要 `_manifest*.md`、`SplittingObject/` `MergedObject/` 里的正文、
根上的 `_sources/`、旧布局里带 `_manifest.md` 的目录型产物，也不收符号链接。

用法
----
    python3 scripts/copy_converted.py --source output/converted/资料A/说明.md --to docs --dry-run
    python3 scripts/copy_converted.py --source output/converted/资料A/说明.md --to docs --apply

看板「产出文档 → 转换产物 → 更多 → 复制到…」调的就是它（看板只 spawn，自己不写盘）。

退出码：0 = 成功（预览时有冲突也是 0，看 `conflict`）；1 = 参数 / 来源不合法，或执行失败；2 = 落点已存在。
带 `--json` 时，结果或失败都在标准输出最后一行打一行 JSON，失败是 `{"ok": false, "error": …, "kind": …}`。
"""

from __future__ import annotations

import argparse
import datetime as dt
import errno
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote

sys.path.insert(0, str(Path(__file__).resolve().parent))
import layout  # noqa: E402  转换产物根与保留名的共用约定

WS = layout.REPO

GROUPS = ("analysis", "decisions", "docs")
GROUP_LABEL = {"analysis": "分析产物", "decisions": "决策记录", "docs": "交付文档"}

FRONT_RE = re.compile(r"\A(---\r?\n)([\s\S]*?\r?\n)?(---[ \t]*(?:\r?\n|\Z))")
# `[文本](目标 "标题")` 与图片；目标可以用尖括号包起来（允许空格）。与 rename_output.py 同一写法
MDLINK_RE = re.compile(r"(!?\[[^\]\n]*\]\()(<[^>\n]*>|[^)\s]+)((?:\s+\"[^\"\n]*\")?\))")
IMG_RE = re.compile(r"(<img\b[^>]*?\bsrc=)(\"[^\"\n]*\"|'[^'\n]*')", re.I)
FENCE_RE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1[ \t]*$|\Z)", re.M)
SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.-]*:", re.I)
TRACE_KEYS = ("copied_from", "copied_at")


class CopyError(Exception):
    """exit_code：1 参数 / 来源不合法或执行失败，2 落点已存在。kind 给看板区分 400 / 409 / 500。"""

    def __init__(self, message: str, exit_code: int = 1, kind: str = "invalid") -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.kind = kind


def rel(p: Path) -> str:
    return p.relative_to(WS).as_posix()


def converted_root() -> Path:
    """与 layout.ensure_layout / 看板 scan.mjs 的 convertedRootOf 同一判据：新位置有内容或旧位置没内容就用新的。"""
    if layout.has_entries(layout.CONVERTED) or not layout.has_entries(layout.LEGACY_CONVERTED):
        return layout.CONVERTED
    return layout.LEGACY_CONVERTED


# ---------------------------------------------------------------- 参数校验


def check_group(raw: str) -> str:
    group = raw.strip()
    if group not in GROUPS:
        raise CopyError(f"只能复制到 {' / '.join(GROUPS)} 三组之一，收到的是：{raw or '(空)'}")
    return group


def check_source(raw: str) -> tuple[str, list[str]]:
    """→ (来源工作空间相对路径, 相对转换产物根的各段)。"""
    src = raw.strip().replace("\\", "/")
    parts = src.split("/")
    if not src or src.startswith("/") or any(p in ("", ".", "..") for p in parts):
        raise CopyError(f"来源必须是工作空间相对路径，不能有 `..` 或空段：{raw}")
    root = converted_root()
    root_parts = rel(root).split("/")
    if parts[: len(root_parts)] != root_parts or len(parts) <= len(root_parts):
        raise CopyError(f"只能复制转换产物根 {rel(root)}/ 下的文件：{src}")
    inner = parts[len(root_parts):]
    name = inner[-1]
    if any(p.startswith(".") for p in inner):
        raise CopyError(f"不复制隐藏文件：{src}")
    if not name.lower().endswith(".md"):
        raise CopyError(f"只能复制单文件 .md 产物：{src}")
    if name == "_manifest.md" or name.startswith(f"{layout.MANIFEST_PREFIX}_"):
        raise CopyError(f"{src} 是产物摘要，不是正文，不能复制。")
    if any(p in (layout.SPLIT_DIR, layout.MERGE_DIR) for p in inner[:-1]):
        raise CopyError(f"{src} 是目录型产物里的一部分，不能单独复制。")
    if inner[0] == layout.RESERVED_TOP:
        raise CopyError(f"{src} 是数据库源的产物，不能复制。")
    # 路径上任何一段是符号链接都不行：读到的可能是工作空间外面的东西
    cur = WS
    for p in parts:
        cur = cur / p
        if cur.is_symlink():
            raise CopyError(f"{rel(cur)} 是符号链接，不复制。")
    # 旧布局：目录里直接有 _manifest.md，整个目录是一份产物
    cur = root
    for p in inner[:-1]:
        cur = cur / p
        if (cur / "_manifest.md").exists():
            raise CopyError(f"{src} 在目录型产物 {rel(cur)}/ 里，不能单独复制。")
    if not (WS / src).is_file():
        raise CopyError(f"找不到这份文件：{src}。可能已经被移走或重新转换，刷新列表看一眼。", kind="missing")
    return src, inner


def target_of(group: str, inner: list[str]) -> str:
    target = "/".join(["output", group, *inner])
    # 落点路径上已存在的部分不能是符号链接，否则会写到别处去
    cur = WS
    for p in target.split("/"):
        cur = cur / p
        if cur.is_symlink():
            raise CopyError(f"{rel(cur)} 是符号链接，不往里写。")
    return target


def blocked(target: str) -> str:
    """落点被占用时返回占用它的那个已存在路径（落点本身，或中间某一段是个文件），否则空串。"""
    cur = WS
    parts = target.split("/")
    for i, p in enumerate(parts):
        cur = cur / p
        last = i == len(parts) - 1
        if last and (cur.exists() or cur.is_symlink()):
            return rel(cur)
        if not last and cur.exists() and not cur.is_dir():
            return rel(cur)
    return ""


# ---------------------------------------------------------------- 链接重算


def resolve(base_dir: str, target: str) -> str | None:
    """把 target 相对 base_dir 解析成工作空间路径；退出根返回 None。与 rename_output.py 同一写法。"""
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


def relink(raw: str, src_dir: str, dst_dir: str, angle: bool) -> str | None:
    """一条链接目标 → 新位置下的写法；不该改或改不了返回 None。"""
    if not raw or raw.startswith(("#", "/")) or SCHEME_RE.match(raw):
        return None
    cut = min((i for i in (raw.find("#"), raw.find("?")) if i >= 0), default=len(raw))
    path_part, suffix = raw[:cut], raw[cut:]
    if not path_part:
        return None
    resolved = resolve(src_dir, unquote(path_part))
    if not resolved or not (WS / resolved).exists():
        return None
    # 原写法在新位置照样指到同一个文件就不动：converted → docs 同深度，指向 input/ 的图片链接原样就对
    if resolve(dst_dir, unquote(path_part)) == resolved:
        return None
    new =os.path.relpath(resolved, dst_dir or ".").replace(os.sep, "/")
    if not angle:
        new = layout.md_link(new)
    return new + suffix


def rewrite_links(text: str, src: str, dst: str) -> tuple[str, int]:
    src_dir, dst_dir = src.rsplit("/", 1)[0], dst.rsplit("/", 1)[0]
    fences = [m.span() for m in FENCE_RE.finditer(text)]
    in_fence = lambda pos: any(a <= pos < b for a, b in fences)  # noqa: E731
    count = 0

    def md(m: re.Match) -> str:
        nonlocal count
        if in_fence(m.start()):
            return m.group(0)
        target = m.group(2)
        angle = target.startswith("<")
        new = relink(target[1:-1] if angle else target, src_dir, dst_dir, angle)
        if new is None:
            return m.group(0)
        count += 1
        return f"{m.group(1)}{f'<{new}>' if angle else new}{m.group(3)}"

    def img(m: re.Match) -> str:
        nonlocal count
        if in_fence(m.start()):
            return m.group(0)
        quote, target = m.group(2)[0], m.group(2)[1:-1]
        new = relink(target, src_dir, dst_dir, angle=True)
        if new is None:
            return m.group(0)
        count += 1
        return f"{m.group(1)}{quote}{new}{quote}"

    text = MDLINK_RE.sub(md, text)
    text = IMG_RE.sub(img, text)
    return text, count


# ---------------------------------------------------------------- front-matter 留痕


def add_trace(text: str, src: str, at: str) -> str:
    nl = "\r\n" if "\r\n" in text[:4096] else "\n"
    lines = [f"copied_from: {src}", f"copied_at: {at}"]
    m = FRONT_RE.match(text)
    if not m:
        return f"---{nl}{nl.join(lines)}{nl}---{nl}{nl}{text}"
    body = m.group(2) or ""
    # 再复制一份复制件不会走到这里（来源只收转换产物），但旧的留痕行不叠两份
    kept = [ln for ln in body.splitlines(keepends=True) if not ln.split(":", 1)[0].strip() in TRACE_KEYS]
    return f"{m.group(1)}{''.join(kept)}{nl.join(lines)}{nl}{m.group(3)}{text[m.end():]}"


# ---------------------------------------------------------------- 计划与落盘


def build(src: str, inner: list[str], group: str) -> dict:
    target = target_of(group, inner)
    raw = (WS / src).read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise CopyError(f"{src} 不是 UTF-8 文本，不复制。") from exc
    bom = "﻿" if text.startswith("﻿") else ""
    text, links = rewrite_links(text[len(bom):], src, target)
    taken = blocked(target)
    return {
        "ok": True,
        "source": src,
        "group": group,
        "target": target,
        "rewrittenLinks": links,
        "conflict": bool(taken),
        "conflictPath": taken,
        "_text": bom + text,
    }


def write_new(target: str, data: bytes) -> None:
    """只新建：同目录临时文件 + os.link，目标已存在时原子失败。失败只回收本次的临时文件与新建的空目录。"""
    dest = WS / target
    created: list[Path] = []
    tmp = None
    try:
        cur = dest.parent
        missing = []
        while not cur.exists():
            missing.append(cur)
            cur = cur.parent
        for d in reversed(missing):
            try:
                d.mkdir()
            except FileExistsError:
                continue  # 别人刚建出来的目录不归本次回收
            created.append(d)
        fd, tmp = tempfile.mkstemp(prefix=f".{dest.stem}.copy-", suffix=".tmp", dir=dest.parent)
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        try:
            os.link(tmp, dest)
        except FileExistsError:
            raise
        except OSError as exc:
            # 文件系统不支持硬链接：退回独占创建，目标已存在同样会失败
            if exc.errno not in (errno.EPERM, errno.ENOTSUP, errno.EOPNOTSUPP, errno.EXDEV, errno.EMLINK, errno.ENOSYS):
                raise
            with open(dest, "xb") as fh:
                fh.write(data)
    except FileExistsError as exc:
        cleanup(tmp, created)
        raise CopyError(f"已存在 {target}，没有覆盖。换个组，或者先把那份改名。", 2, "conflict") from exc
    except OSError as exc:
        cleanup(tmp, created)
        raise CopyError(f"复制失败：{exc}。没有留下任何文件。", kind="failed") from exc
    if tmp:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def cleanup(tmp: str | None, created: list[Path]) -> None:
    if tmp:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    for d in reversed(created):
        try:
            d.rmdir()  # 只删空目录：别人刚往里放了东西就留着
        except OSError:
            pass


def apply(src: str, inner: list[str], group: str) -> dict:
    plan = build(src, inner, group)
    if plan["conflict"]:
        raise CopyError(f"已存在 {plan['conflictPath']}，没有覆盖。换个组，或者先把那份改名。", 2, "conflict")
    at = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    text = plan.pop("_text")
    bom = "﻿" if text.startswith("﻿") else ""
    write_new(plan["target"], (bom + add_trace(text[len(bom):], src, at)).encode("utf-8"))
    plan["copiedAt"] = at
    return plan


def emit_error(exc: CopyError, as_json: bool) -> int:
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
    ap = argparse.ArgumentParser(description="把一份转换产物 .md 复制进 output/<组>/，子目录结构不变，图片链接按新位置重算")
    ap.add_argument("--source", required=True, help="工作空间相对路径，如 output/converted/资料A/说明.md")
    ap.add_argument("--to", required=True, help=" / ".join(GROUPS))
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="只算落点和要重算的链接，不动磁盘")
    mode.add_argument("--apply", action="store_true", help="执行复制")
    ap.add_argument("--json", action="store_true", help="结果打成一行 JSON")
    args = ap.parse_args()

    try:
        group = check_group(args.to)
        src, inner = check_source(args.source)
        if args.apply:
            result = apply(src, inner, group)
        else:
            result = build(src, inner, group)
            result.pop("_text")
    except CopyError as exc:
        return emit_error(exc, args.json)

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
        return 0
    label = GROUP_LABEL[group]
    if args.apply:
        print(f"已复制到{label}：{result['target']}（重算 {result['rewrittenLinks']} 处链接）")
    elif result["conflict"]:
        print(f"已存在 {result['conflictPath']}，不能复制到{label}。")
    else:
        print(f"将复制到{label}：{result['target']}（重算 {result['rewrittenLinks']} 处链接）")
        print(f"确认无误后执行：python3 scripts/copy_converted.py --source {src} --to {group} --apply")
    return 0


if __name__ == "__main__":
    sys.exit(main())
