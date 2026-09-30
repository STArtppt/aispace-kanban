#!/usr/bin/env python3
"""按模板把一份 .md 转成同目录、同名的 .docx。

    python3 scripts/md2docx.py output/docs/方案.md --template @base      # 通用规范
    python3 scripts/md2docx.py output/docs/方案.md --template 客户甲      # output/docx-template/客户甲/
    python3 scripts/md2docx.py output/docs/方案.md --template 客户甲 --overwrite --json
    python3 scripts/md2docx.py output/delivery/docs/方案/v002.md --template 客户甲   # 交付稿，成品落在交付稿旁边
    python3 scripts/md2docx.py output/docs/方案.md --template 客户甲 --keep-bold     # 不解除段中加粗

转换前由 docxkit/filters/deai-format.lua 做格式处理（只动格式、不改文字，每项计数写进结果的 log）：
开头唯一的 `#` 取作文档标题、其余标题上移一级；模板标题样式带编号时剥掉手写编号；`> [!note]` 转提示框；
只保留段首标签式加粗。
模板带 front.docx（前置区）时，成品 = 前置区 + 正文：封面字段依次取自 md front-matter（title / client / vendor /
date / doctype）→ 开头的 `#` 标题（title）→ project.yaml 的 identity.甲方 / 承建方 → 当天日期；取不到的写
「【待填：…】」并给 warning。`# 某项目 · 文档类型` 这类标题在模板有文档类型字段时拆成标题与文档类型两项；
日期按模板原文的写法（profile.json 的 front.dateFormat）。正文页眉页脚里的 {{角色}} 占位符用同一个值替换。
目录保留为域，成品打开时提示更新域。

需要 pandoc 3（查找顺序：PANDOC_BIN 环境变量 → 工作空间 .env 的 PANDOC_BIN → PATH）。
模板的写作规定在 `output/docx-template/<模板名>/spec.md`；通用规范的在 `scripts/docxkit/base-spec.json`。

它只写一个文件：与 .md 同目录、同基名的 .docx（中间文件在系统临时目录，结束即删）。
同名 .docx 已存在时：
- 带本工具链的生成标记（上次转出来的）→ 加 --overwrite 才替换；
- 没有标记（人手改过另存的、客户给的原件）→ 一律拒绝，请先改名或移走。
  注意：在 Word 里打开成品、改完按原名保存，标记还在 —— 覆盖会丢掉那些修改。

看板产出列表「更多 → 转成 Word」调的就是它（看板只 spawn，自己不写盘；AGENTS.md 不变量 1 第九条）。

退出码：0 成功；1 执行失败；2 参数不合法、文件或模板不在；3 同名文件不能覆盖；4 缺 pandoc。
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
WS = HERE.parent
sys.path.insert(0, str(HERE))

from docxkit import (EXIT_ARGS, EXIT_CONFLICT, EXIT_DEPENDENCY, EXIT_FAIL, VERSION,  # noqa: E402
                     ToolError, finish, force_utf8)
from docxkit.build import build_reference  # noqa: E402
from docxkit.front import assemble, fill_values, read_front_matter, read_identity, roles_in  # noqa: E402
from docxkit.ooxml import Package, add_marker, heading_numbered, marker_of, write_atomic  # noqa: E402
from docxkit.pandoc import PandocMissing, default_reference, find_pandoc, md_to_docx  # noqa: E402
from docxkit.postprocess import postprocess  # noqa: E402
from docxkit.spec import merged  # noqa: E402

BASE = "@base"


def rel(p: Path) -> str:
    try:
        return p.resolve().relative_to(WS.resolve()).as_posix()
    except ValueError:
        return str(p)


def resolve_template(name: str) -> Path | None:
    """返回模板的 reference.docx；@base 返回 None（现生成）。"""
    if name == BASE:
        return None
    from docx_template import check_name  # 模板名规则只写一份

    check_name(name)
    ref = WS / "output" / "docx-template" / name / "reference.docx"
    if not ref.is_file():
        raise ToolError(f"模板「{name}」不存在或还没生成", EXIT_ARGS,
                        "在看板工作台「模版洗炼」里生成它，或改用 --template @base（通用规范）", "no-template")
    return ref


def convert(args) -> tuple[dict, str]:
    md = Path(args.source)
    if not md.is_file() or md.suffix.lower() != ".md":
        raise ToolError(f"来源不是一个存在的 .md 文件：{md}", EXIT_ARGS, None, "no-source")
    md = md.resolve()
    ref = resolve_template(args.template)
    front_path = ref.parent / "front.docx" if ref is not None else None
    front = Package.read(front_path) if front_path is not None and front_path.is_file() else None
    target = md.with_suffix(".docx")
    overwritten = False
    if target.exists():
        if marker_of(target) is None:
            raise ToolError(f"同名的 Word 不是本工具生成的：{rel(target)}", EXIT_CONFLICT,
                            "为避免覆盖人工修改，请先把它改名或移走", "not-generated")
        if not args.overwrite:
            raise ToolError(f"{rel(target)} 已存在（上次转换生成的）", EXIT_CONFLICT,
                            "确认要替换就加 --overwrite；在 Word 里对它做过的修改会丢掉", "exists")
        overwritten = True
    try:
        pandoc_bin, pandoc_ver = find_pandoc(WS)
    except PandocMissing as e:
        raise ToolError(str(e).split("。")[0], EXIT_DEPENDENCY, str(e).split("。", 1)[1], "no-pandoc")

    with tempfile.TemporaryDirectory(prefix="aispace-md2docx-") as tmp:
        t = Path(tmp)
        if ref is None:
            base_pkg = Package.read(_bytes_file(t / "pandoc-default.docx", default_reference(pandoc_bin)))
            pkg, _, _ = build_reference(base_pkg, merged(None), use_spec_page=True)
            add_marker(pkg, VERSION)
            ref = _bytes_file(t / "reference.docx", pkg.to_bytes())
        out_tmp = t / "out.docx"
        numbered = heading_numbered(Package.read(ref))
        warnings, fmt = md_to_docx(pandoc_bin, md, ref, out_tmp, strip_numbers=numbered, keep_bold=args.keep_bold,
                                   front=front is not None)
        out = Package.read(out_tmp)
        log = fmt["log"] + postprocess(out, VERSION)
        if front is not None:
            ref_pkg = Package.read(ref)
            values = fill_values(read_front_matter(md.read_text(encoding="utf-8")), fmt["title"],
                                 read_identity(WS), dt.date.today(),
                                 split_doctype="doctype" in roles_in(front, ref_pkg),
                                 date_format=_front_profile(ref).get("dateFormat"))
            flog, fw = assemble(out, front, values)
            log += flog
            warnings += fw
        write_atomic(target, out.to_bytes())

    human = "\n".join([f"已生成 {rel(target)}（模板：{args.template}）", *log, *(f"注意：{w}" for w in warnings)])
    return {"written": [rel(target)], "target": rel(target), "template": args.template, "overwritten": overwritten,
            "warnings": warnings, "log": log, "pandocVersion": pandoc_ver}, human


def _front_profile(ref: Path) -> dict:
    """模板 profile.json 的 front 段（日期写法等）；旧模板没有就是空。"""
    try:
        front = json.loads((ref.parent / "profile.json").read_text(encoding="utf-8")).get("front")
    except (OSError, ValueError):
        return {}
    return front if isinstance(front, dict) else {}


def _bytes_file(p: Path, data: bytes) -> Path:
    p.write_bytes(data)
    return p


def main() -> int:
    force_utf8()
    ap = argparse.ArgumentParser(description="按模板把 .md 转成同目录、同名的 .docx")
    ap.add_argument("source", help="来源 .md")
    ap.add_argument("--template", required=True, help="模板名（output/docx-template/ 下的目录名）或 @base（通用规范）")
    ap.add_argument("--overwrite", action="store_true", help="同名 .docx 是上次转换生成的时，替换它")
    ap.add_argument("--keep-bold", action="store_true", help="保留 md 里的全部加粗（默认只保留段首标签式加粗）")
    ap.add_argument("--json", action="store_true", help="最后一行打印结果 JSON（给看板用）")
    args = ap.parse_args()
    try:
        result, human = convert(args)
        return finish(result, None, args.json, human)
    except ToolError as e:
        return finish(None, e, args.json)
    except Exception as e:  # noqa: BLE001 —— 兜底成一行 JSON，看板才能把原因显示出来
        return finish(None, ToolError(f"{type(e).__name__}: {e}", EXIT_FAIL), args.json)


if __name__ == "__main__":
    sys.exit(main())
