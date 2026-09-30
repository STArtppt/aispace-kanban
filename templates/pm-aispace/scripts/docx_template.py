#!/usr/bin/env python3
"""提炼客户 Word 模板：把一份客户旧 .docx 变成 `output/docx-template/<模板名>/` 下的模板包。

两步走，中间是人的决定（看板「模版洗炼」页的第 ②③ 步，或者你手写一份 JSON）：

    # ① 采集：算出每段的实际生效格式，按格式聚类；报告不含正文
    python3 scripts/docx_template.py collect input/raw/客户旧文档.docx --name 客户甲

    # ② 生成：按「通用规范 + 客户差异」重建样式，写出模板包，并用合成样张反查
    python3 scripts/docx_template.py build --name 客户甲 --source input/raw/客户旧文档.docx
    python3 scripts/docx_template.py build --name 客户甲 --source ... --decisions 决定.json
    python3 scripts/docx_template.py build --name 客户甲 --source ... --decisions -   # 从 stdin 读

不给 --decisions 时全部采用采集报告里的建议角色（suggestedRole）。决定的格式见 docxkit/decisions.py。

写到哪里（只此一个目录）::

    output/docx-template/<模板名>/
      collect/report.json      采集报告（格式簇、大纲、样式使用情况，不含正文）
      collect/paragraphs.jsonl 逐段快照（同样脱敏）
      profile.json             相对通用规范的客户差异，每项 _src 注明来源
      reference.docx           清洗、重建样式后的 pandoc 参照模板（不是客户原件）
      front.docx               前置区骨架（封面 / 签署页 / 版本表 / 目录；字段是占位符、样例数据已清空）；
                               来源没有前置区或决定里 front.disabled 为 true 时不写
      spec.md                  写给写 md 的人看的文字规定
      sample.docx              合成样张的转换效果（需要 pandoc；没有就跳过）

模板名已存在时，collect / build 都要加 --regenerate 才会覆盖。看板「开始分析」「生成模板」调的就是它
（看板只 spawn，自己不写盘；AGENTS.md 不变量 1 第九条）。

退出码：0 成功；1 执行失败；2 参数不合法或文件不在；3 模板名已存在；4 缺依赖。
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
WS = HERE.parent
sys.path.insert(0, str(HERE))

from docxkit import (EXIT_ARGS, EXIT_CONFLICT, EXIT_FAIL, VERSION, ToolError,  # noqa: E402
                     finish, force_utf8)
from docxkit.build import build_reference  # noqa: E402
from docxkit.collect import collect, write_report  # noqa: E402
from docxkit.decisions import MAX_BYTES, DecisionError, derive_profile, front_profile, validate  # noqa: E402
from docxkit.front import ROLE_LABEL, assemble, build_front, fill_values, header_placeholders  # noqa: E402
from docxkit.ooxml import Package, add_marker, heading_numbered, write_atomic  # noqa: E402
from docxkit.pandoc import PandocMissing, find_pandoc, md_to_docx  # noqa: E402
from docxkit.postprocess import postprocess  # noqa: E402
from docxkit.spec import load_base, merged  # noqa: E402
from docxkit.spec_md import generate as spec_markdown  # noqa: E402
from docxkit.verify import verify  # noqa: E402

TEMPLATE_ROOT = WS / "output" / "docx-template"
BAD_NAME_CHARS = set('/\\:*?"<>|\0')


def check_name(name: str) -> str:
    """模板名只接受一层基名。看板服务端 src/server/docxTools.mjs 有同样的校验（两边各拦一次）。"""
    if (not name or name.startswith(".") or ".." in name or len(name) > 80
            or any(c in BAD_NAME_CHARS for c in name) or name != name.strip()):
        raise ToolError(f"模板名不合法：{name!r}", EXIT_ARGS,
                        "模板名是一层目录名：不以 . 开头，不含 / \\ : * ? \" < > | 和 ..，不超过 80 字", "bad-name")
    return name


def rel(p: Path) -> str:
    try:
        return p.resolve().relative_to(WS.resolve()).as_posix()
    except ValueError:
        return str(p)


def check_source(src: Path) -> Path:
    if not src.is_file():
        raise ToolError(f"来源文件不存在：{src}", EXIT_ARGS, None, "no-source")
    if src.suffix.lower() != ".docx":
        raise ToolError(f"来源文件不是 .docx：{src.name}", EXIT_ARGS, "旧版 .doc 请先在 Word 里另存为 .docx", "not-docx")
    try:
        with zipfile.ZipFile(src) as z:
            z.getinfo("word/document.xml")
    except (zipfile.BadZipFile, KeyError, OSError):
        raise ToolError(f"读不了这份 Word：{src.name}", EXIT_ARGS, "可能是加密、损坏或其实是 .doc；在 Word 里另存为 .docx 再试", "bad-docx")
    return src


def cmd_collect(args) -> tuple[dict, str]:
    name = check_name(args.name)
    src = check_source(Path(args.source))
    tdir = TEMPLATE_ROOT / name
    if tdir.exists() and not args.regenerate:
        raise ToolError(f"模板「{name}」已存在", EXIT_CONFLICT, "确认要重新提炼就加 --regenerate（看板里勾选「重新生成」）", "name-taken")
    report, paras = collect(src, rel(src))
    report["toolVersion"] = VERSION
    written = write_report(tdir / "collect", report, paras)
    human = (f"已采集：{len(report['clusters'])} 个格式簇、{report['paragraphs']['nonEmpty']} 个非空段落；"
             f"样式 {report['styles']['total']} 个里有效 {report['styles']['effective']} 个\n"
             + "\n".join(f"  写入 {rel(p)}" for p in written))
    return {"written": [rel(p) for p in written], "clusters": len(report["clusters"])}, human


def read_decisions(arg: str | None):
    if not arg:
        return {}
    raw = sys.stdin.buffer.read(MAX_BYTES + 1) if arg == "-" else Path(arg).read_bytes()
    if len(raw) > MAX_BYTES:
        raise ToolError("决定超过 256KB", EXIT_ARGS, None, "bad-decisions")
    if not raw.strip():
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ToolError(f"决定不是合法的 JSON：{e}", EXIT_ARGS, None, "bad-decisions")


def cmd_build(args) -> tuple[dict, str]:
    name = check_name(args.name)
    tdir = TEMPLATE_ROOT / name
    report_path = tdir / "collect" / "report.json"
    if not report_path.is_file():
        raise ToolError(f"模板「{name}」还没有采集报告", EXIT_ARGS, "先跑 collect（看板里是第 ② 步「开始分析」）", "no-report")
    if (tdir / "reference.docx").exists() and not args.regenerate:
        raise ToolError(f"模板「{name}」已经生成过", EXIT_CONFLICT, "确认要覆盖就加 --regenerate（看板里勾选「重新生成」）", "name-taken")
    src = check_source(Path(args.source))
    report = json.loads(report_path.read_text(encoding="utf-8"))
    try:
        dec = validate(read_decisions(args.decisions), report)
        base = load_base()
        profile, plan = derive_profile(report, dec, base)
    except DecisionError as e:
        raise ToolError(str(e), EXIT_ARGS, None, "bad-decisions")
    fp = front_profile(dec["front"])
    if fp:
        profile["front"] = fp
    spec = merged({k: v for k, v in profile.items() if not k.startswith("_") and k != "front"})

    pkg, log, _ = build_reference(src, spec)
    front_pkg = None
    if fp:
        try:
            front_pkg, flog, originals = build_front(Package.read(src), report["front"], dec["front"])
        except ValueError as e:
            raise ToolError(str(e), EXIT_ARGS, "在看板第 ② 步重新「开始分析」，或终端里重跑 collect", "stale-report")
        add_marker(front_pkg, VERSION)
        log += flog
        # 正文页眉页脚里与封面字段同文的部分（写着文档类型的页眉）也写成占位符，转换时一起填值（D14 第 1 条）
        hits = header_placeholders(pkg, originals)
        if hits:
            log.append("正文页眉页脚：" + "、".join(f"{ROLE_LABEL[r]} {n} 处" for r, n in hits.items()) + "写成占位符")
    add_marker(pkg, VERSION)
    ref_bytes = pkg.to_bytes()
    today = dt.date.today().isoformat()
    spec_text = spec_markdown(name, spec, profile["_roles"], VERSION, today, fp)

    warnings: list[str] = []
    sample_bytes = None
    try:
        pandoc_bin, pandoc_ver = find_pandoc(WS)
    except PandocMissing as e:
        pandoc_bin, pandoc_ver = None, None
        warnings.append(f"跳过样张：{e}")
    if pandoc_bin:
        kit = HERE / "docxkit"
        with tempfile.TemporaryDirectory(prefix="aispace-docx-") as tmp:
            t = Path(tmp)
            shutil.copy(kit / "sample.md", t / "sample.md")
            shutil.copy(kit / "diagram.png", t / "diagram.png")
            (t / "reference.docx").write_bytes(ref_bytes)
            sw, fmt = md_to_docx(pandoc_bin, t / "sample.md", t / "reference.docx", t / "out.docx",
                                 strip_numbers=heading_numbered(pkg), front=front_pkg is not None)
            warnings += sw
            out = Package.read(t / "out.docx")
            log += postprocess(out, VERSION)
            if front_pkg is not None:
                # 样张的封面填示例值，不读 project.yaml：它只是效果预览
                values = fill_values({"client": "示例客户单位", "vendor": "示例编制单位", "doctype": "示例文档"},
                                     fmt["title"], {}, dt.date.today(), date_format=fp.get("dateFormat"))
                assemble(out, front_pkg, values)
            (t / "sample.docx").write_bytes(out.to_bytes())
            vw, _ = verify(t / "sample.docx", spec, skip=("Title",) if front_pkg is not None else ())
            warnings += vw
            sample_bytes = (t / "sample.docx").read_bytes()

    written = []
    for fname, data in (("profile.json", (json.dumps(profile, ensure_ascii=False, indent=2) + "\n").encode("utf-8")),
                        ("reference.docx", ref_bytes), ("spec.md", spec_text.encode("utf-8"))):
        write_atomic(tdir / fname, data)
        written.append(rel(tdir / fname))
    if front_pkg is not None:
        write_atomic(tdir / "front.docx", front_pkg.to_bytes())
        written.append(rel(tdir / "front.docx"))
    elif (tdir / "front.docx").exists():
        # 这次不要前置区（或来源没有）：旧的骨架留着会被转换误用
        (tdir / "front.docx").unlink()
    if sample_bytes is not None:
        write_atomic(tdir / "sample.docx", sample_bytes)
        written.append(rel(tdir / "sample.docx"))
    elif (tdir / "sample.docx").exists():
        # 没有 pandoc 时旧样张已和新模板对不上，留着只会误导
        (tdir / "sample.docx").unlink()

    conflicts = [c for info in plan.values() for c in info["conflicts"]]
    human = "\n".join([*log, *(f"  写入 {w}" for w in written),
                       *(f"  注意：{w}" for w in warnings)] or ["完成"])
    if not warnings and sample_bytes is not None:
        human += "\n样张各角色格式与规范一致"
    return {"written": written, "warnings": warnings, "log": log, "conflicts": conflicts,
            "roles": {r: i["count"] for r, i in plan.items()}, "pandocVersion": pandoc_ver}, human


def main() -> int:
    force_utf8()
    ap = argparse.ArgumentParser(description="提炼客户 Word 模板（collect 采集 / build 生成模板包）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("collect", help="采集旧文档的实际格式")
    c.add_argument("source", help="来源 .docx（一般在 input/raw/ 下）")
    b = sub.add_parser("build", help="按决定生成模板包")
    b.add_argument("--source", required=True, help="来源 .docx（与 collect 时同一份）")
    b.add_argument("--decisions", help="决定 JSON 文件；写 - 表示从 stdin 读；不给就全部采用建议角色")
    for p in (c, b):
        p.add_argument("--name", required=True, help="模板名（一层目录名）")
        p.add_argument("--regenerate", action="store_true", help="模板名已存在时覆盖")
        p.add_argument("--json", action="store_true", help="最后一行打印结果 JSON（给看板用）")
    args = ap.parse_args()
    try:
        result, human = (cmd_collect if args.cmd == "collect" else cmd_build)(args)
        return finish(result, None, args.json, human)
    except ToolError as e:
        return finish(None, e, args.json)
    except Exception as e:  # noqa: BLE001 —— 兜底成一行 JSON，看板才能把原因显示出来
        return finish(None, ToolError(f"{type(e).__name__}: {e}", EXIT_FAIL), args.json)


if __name__ == "__main__":
    sys.exit(main())
