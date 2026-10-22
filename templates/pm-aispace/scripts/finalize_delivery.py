#!/usr/bin/env python3
"""定稿：把「最后交出去的那份 Word」记到原稿的交付稿镜像目录里。

    python3 scripts/finalize_delivery.py output/docs/方案/总体设计.md --docx ~/Downloads/客户反馈版.docx
    python3 scripts/finalize_delivery.py output/docs/方案/总体设计.md \\
        --docx output/delivery/docs/方案/总体设计/v002.docx --note "发给甲方 · 第二轮评审" --json

镜像目录 = `output/delivery/<原稿在 output/ 下的相对路径去掉 .md>/`（与交付稿同一个目录，不存在就建）。
1. 选中的 .docx 就在镜像目录里 → 不复制，直接以它为本次定稿；
   来自其他目录 → 复制进镜像目录，命名 `<原基名>-<定稿时间 YYYYMMDDHHmm>.docx`，重名追加 -2、-3，**只新建不覆盖**；
2. 用本地 anydoc 把它转成 Markdown，覆盖写 `定稿.md`，图片整目录替换为 `定稿.assets/`；
   先写临时件再替换，转换失败时上一份 `定稿.md` / `定稿.assets/` 原样保留（已复制的 .docx 也保留，结果里写明）；
3. 每次定稿的记录写在 `定稿.md` 的 front-matter（`history` 逐次追加），**只记文件名，不记工作空间外的路径**。

`定稿.md` 由看板「定稿」按钮经本脚本生成（AGENTS.md 不变量 1 第十条），AI 不要手改它；
权威是那份 .docx，`定稿.md` 只是可读、可对比的文字快照。
除镜像目录里的上述三样外，本脚本不写任何文件；镜像目录里已有的 v*.md、v*.docx 和其他 .docx 一个字节不动。

退出码：0 成功；1 执行失败；2 参数不合法、文件不在；4 缺 anydoc / node。
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import os
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
WS = HERE.parent
sys.path.insert(0, str(HERE))

from docxkit import EXIT_ARGS, EXIT_DEPENDENCY, EXIT_FAIL, ToolError, finish, force_utf8  # noqa: E402

GROUPS = ("analysis", "docs", "decisions")
DELIVERY = "output/delivery"
FINAL_MD = "定稿.md"
FINAL_ASSETS = "定稿.assets"
NOTE_MAX = 60


def rel(p: Path) -> str:
    return p.relative_to(WS.resolve()).as_posix()


def clean_note(raw: str | None) -> str:
    """单行备注：换行与 `|`（history 行的分隔符）换成空格，压掉多余空白。看板侧做同样的清洗。"""
    text = re.sub(r"[\r\n|\x00-\x1f]+", " ", raw or "")
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > NOTE_MAX:
        raise ToolError(f"备注超过 {NOTE_MAX} 字", EXIT_ARGS, "删短一点再试", "bad-note")
    return text


def display_name(name: str) -> str:
    """写进 history 行的文件名：`|` 是分隔符，换成全角；控制字符去掉。"""
    return re.sub(r"[\x00-\x1f]", "", name).replace("|", "｜")


def mirror_of(source: str) -> tuple[str, Path]:
    """原稿相对路径 → (原稿相对路径, 镜像目录绝对路径)。只认产出三组里的 .md。"""
    src = (WS / source).resolve()
    root = WS.resolve()
    try:
        src_rel = src.relative_to(root).as_posix()
    except ValueError:
        raise ToolError(f"原稿不在工作空间里：{source}", EXIT_ARGS, None, "no-source")
    parts = src_rel.split("/")
    if len(parts) < 3 or parts[0] != "output" or parts[1] not in GROUPS or not src_rel.lower().endswith(".md"):
        raise ToolError(f"只能给产出三组（{' / '.join(GROUPS)}）里的 .md 原稿定稿：{src_rel}", EXIT_ARGS, None, "no-source")
    if not src.is_file():
        raise ToolError(f"原稿不存在：{src_rel}", EXIT_ARGS, None, "no-source")
    mirror = root / DELIVERY / src_rel[len("output/"):-len(".md")]
    # 镜像目录（或它的某一级）若是指向工作空间外的符号链接，写进去就越界了
    probe = mirror
    while not probe.exists() and probe != root:
        probe = probe.parent
    if not probe.resolve().is_relative_to(root):
        raise ToolError(f"交付稿目录指向了工作空间以外：{rel(mirror)}", EXIT_ARGS, None, "bad-mirror")
    return src_rel, mirror


def stamp_name(stem: str, when: dt.datetime) -> str:
    """复制名的基名：`<原基名>-<YYYYMMDDHHmm>`。原名只换掉分隔符和空字符，其余照留（它来自用户本机文件名）。"""
    safe = re.sub(r"[/\\\x00]", "-", stem).strip() or "定稿"
    return f"{safe}-{when.strftime('%Y%m%d%H%M')}"


def copy_new(src: Path, mirror: Path, base: str) -> Path:
    """以「只新建」语义复制进镜像目录：重名追加 -2、-3，`xb` 保证不覆盖任何已有文件。"""
    n = 1
    while True:
        dst = mirror / (f"{base}.docx" if n == 1 else f"{base}-{n}.docx")
        try:
            with src.open("rb") as fin, dst.open("xb") as fout:
                shutil.copyfileobj(fin, fout)
            shutil.copystat(src, dst)
            return dst
        except FileExistsError:
            n += 1


def read_history(final_md: Path) -> list[str]:
    """上一份 `定稿.md` front-matter 里的 history 行；没有或认不出就是空。"""
    try:
        text = final_md.read_text(encoding="utf-8").replace("\r\n", "\n")
    except OSError:
        return []
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not m:
        return []
    out, inside = [], False
    for line in m.group(1).split("\n"):
        if re.match(r"^history:\s*$", line):
            inside = True
            continue
        item = re.match(r"^\s+-\s+(.*)$", line)
        if inside and item:
            out.append(item.group(1).strip())
        elif inside:
            inside = False
    return out


def check_converter() -> None:
    """缺 anydoc / node 在动手之前就报，保证「工作空间不变」。"""
    import anydoc

    if not anydoc.find_bin():
        raise ToolError("找不到 anydoc，没法把 Word 转成 Markdown", EXIT_DEPENDENCY,
                        "从看板启动过一次就会记下它自带的 anydoc；自己跑请把 anydoc 放到 PATH 或设置 ANYDOC_BIN", "no-anydoc")
    if not (shutil.which("node") or anydoc._runtime_path("node")):
        raise ToolError("找不到 node，没法把 Word 转成 Markdown", EXIT_DEPENDENCY,
                        "装好 Node.js，或从看板启动一次让它记下 node 的位置", "no-node")


def remove_tree(p: Path) -> None:
    if p.is_dir() and not p.is_symlink():
        shutil.rmtree(p, ignore_errors=True)
    elif p.exists() or p.is_symlink():
        p.unlink()


def finalize(args) -> tuple[dict, str]:
    note = clean_note(args.note)
    source, mirror = mirror_of(args.source)
    docx = Path(args.docx).expanduser()
    if docx.suffix.lower() != ".docx":
        raise ToolError(f"选中的不是 .docx：{docx.name}", EXIT_ARGS, "只能用 Word 文档（.docx）定稿", "not-docx")
    if not docx.is_file():
        raise ToolError("选中的文件已经不在了", EXIT_ARGS, "请重新选择", "docx-gone")
    check_converter()

    import anydoc
    from layout import md_link

    now = dt.datetime.now().astimezone().replace(microsecond=0)
    # 场景判定以这里为准（看板 pick 时判过一次，只用于确认框文案）：
    # 父目录的真实路径就是镜像目录才算「镜像目录」；子目录、符号链接文件一律按「其他目录」，宁可多复制一份
    in_mirror = (mirror.is_dir() and not docx.is_symlink()
                 and Path(os.path.realpath(docx.parent)) == Path(os.path.realpath(mirror)))
    mirror.mkdir(parents=True, exist_ok=True)
    if in_mirror:
        used = mirror / docx.name
    else:
        used = copy_new(docx, mirror, stamp_name(docx.stem, now))

    final_md = mirror / FINAL_MD
    assets = mirror / FINAL_ASSETS
    tmp_md = mirror / f"{FINAL_MD}.tmp"
    tmp_assets = mirror / f"{FINAL_ASSETS}.tmp"
    old_assets = mirror / f"{FINAL_ASSETS}.old"
    for leftover in (tmp_md, tmp_assets, old_assets):  # 上次中断留下的临时件
        remove_tree(leftover)

    history = read_history(final_md)
    line = f"{now.strftime('%Y-%m-%d %H:%M')} | {display_name(used.name)} | " + (
        "镜像目录" if in_mirror else f"其他目录（原名 {display_name(docx.name)}）")
    if note:
        line += f" | 备注 {note}"
    history.append(line)
    sha = hashlib.sha256(used.read_bytes()).hexdigest()[:16]

    try:
        # 链接前缀写最终目录名：图片先落进临时目录，替换后链接正好指向它
        body = anydoc.to_markdown_with_assets(used, tmp_assets, md_link(f"{FINAL_ASSETS}/"))
        front = ["---", "kind: delivery-final", f"source: {source}",
                 f"finalized_at: {now.isoformat()}", f"docx: {rel(used.resolve())}", f"docx_sha: {sha}",
                 f"count: {len(history)}", *([f"note: {note}"] if note else []),
                 "history:", *(f"  - {h}" for h in history), "---", ""]
        tmp_md.write_text("\n".join(front) + body.lstrip("\n"), encoding="utf-8")
        os.replace(tmp_md, final_md)
    except Exception as e:  # noqa: BLE001 —— 失败要清临时件、保住上一份，并说清已复制的文件
        remove_tree(tmp_md)
        remove_tree(tmp_assets)
        kept = "" if in_mirror else f"已复制进镜像目录的 {used.name} 保留着；"
        raise ToolError(f"Word 转 Markdown 失败：{e}", EXIT_FAIL,
                        f"{kept}{FINAL_MD} 保持上一次的内容。确认文件能在 Word 里正常打开、已保存后再试", "convert-failed")

    # 定稿.assets/ 整目录替换：旧的先挪开，新的就位，再删旧的（这是本脚本唯一的删除，只限这个目录）
    if assets.exists():
        os.replace(assets, old_assets)
    if tmp_assets.exists():
        os.replace(tmp_assets, assets)
    remove_tree(old_assets)

    written = [rel(final_md.resolve())] + ([] if in_mirror else [rel(used.resolve())])
    human = "\n".join([
        f"第 {len(history)} 次定稿：{rel(final_md.resolve())}",
        f"所用 Word：{rel(used.resolve())}" + ("（镜像目录里的原件）" if in_mirror else f"（由 {docx.name} 复制）"),
        *([f"备注：{note}"] if note else []),
    ])
    return {"written": written, "final": rel(final_md.resolve()), "docx": rel(used.resolve()),
            "inMirror": in_mirror, "count": len(history), **({"copiedAs": used.name} if not in_mirror else {})}, human


def main() -> int:
    force_utf8()
    ap = argparse.ArgumentParser(description="把交出去的那份 Word 记为原稿的定稿（写 定稿.md）")
    ap.add_argument("source", help="原稿 .md（工作空间相对路径，产出三组里的）")
    ap.add_argument("--docx", required=True, help="交出去的那份 .docx（可以在工作空间外）")
    ap.add_argument("--note", default="", help=f"可选备注，单行、不超过 {NOTE_MAX} 字，写进 history")
    ap.add_argument("--json", action="store_true", help="最后一行打印结果 JSON（给看板用）")
    args = ap.parse_args()
    try:
        result, human = finalize(args)
        return finish(result, None, args.json, human)
    except ToolError as e:
        return finish(None, e, args.json)
    except Exception as e:  # noqa: BLE001 —— 兜底成一行 JSON，看板才能把原因显示出来
        return finish(None, ToolError(f"{type(e).__name__}: {e}", EXIT_FAIL), args.json)


if __name__ == "__main__":
    sys.exit(main())
