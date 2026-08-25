#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""两份清单的交叉比对 → 逐条差异明细 CSV + 可回填核对件 xlsx。

这是 pm-list-diff 技能的「半自动」部分：不规则表格的解析和分类口径由你判断，
归一成两份标准 CSV 后，机械的集合运算、缺失度归因、冲突分型和出表交给本脚本。

输入 CSV 的列（`键`、`名称` 必填，其余可选）：
    键 / 名称 / 分组 / 类别 / 属性 / 属性原文 / 来源

旁证 CSV（可选）：
    键 / 旁证 / 旁证明细      旁证列取值「有」才算有；缺省按「无」处理

用法见 --help；典型调用见 SKILL.md「五、跑脚本出产物」。
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
from collections import Counter, OrderedDict, defaultdict

REQUIRED = ("键", "名称")
OPTIONAL = ("分组", "类别", "属性", "属性原文", "来源", "可比")

# 缺失度门槛：一个分组里有多少比例的条目缺失，才算「近乎整组漏列」
NEAR_TOTAL_RATIO = 0.8


# --------------------------------------------------------------------------- 读入


def read_list(path: str, label: str) -> "OrderedDict[str, dict]":
    """读一份归一清单。重复键保留首次出现并在末尾汇总报告。"""
    if not os.path.exists(path):
        sys.exit(f"[错误] {label} 清单不存在：{path}")
    with open(path, encoding="utf-8-sig", newline="") as f:
        rd = csv.DictReader(f)
        if rd.fieldnames is None:
            sys.exit(f"[错误] {label} 清单是空文件：{path}")
        missing = [c for c in REQUIRED if c not in rd.fieldnames]
        if missing:
            sys.exit(
                f"[错误] {label} 清单缺列 {missing}。"
                f"实际列：{rd.fieldnames}\n"
                f"       归一清单的列名固定为 键/名称/分组/类别/属性/属性原文/来源，见 SKILL.md 第三节。"
            )
        out: "OrderedDict[str, dict]" = OrderedDict()
        dup = Counter()
        for r in rd:
            k = (r.get("键") or "").strip()
            if not k:
                continue
            if k in out:
                dup[k] += 1
                continue
            out[k] = {c: (r.get(c) or "").strip() for c in REQUIRED + OPTIONAL}
        if dup:
            print(f"[提示] {label} 清单有 {len(dup)} 个重复键，各保留首次出现："
                  f"{', '.join(list(dup)[:8])}{' …' if len(dup) > 8 else ''}")
    if not out:
        sys.exit(f"[错误] {label} 清单没读到任何条目，检查「键」列是否为空：{path}")
    return out


def read_evidence(path: str | None) -> dict[str, str]:
    """读旁证：键 -> 旁证明细。只有「旁证」列为『有』的才计入。"""
    if not path:
        return {}
    if not os.path.exists(path):
        sys.exit(f"[错误] 旁证清单不存在：{path}")
    ev: dict[str, str] = {}
    with open(path, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            k = (r.get("键") or "").strip()
            if not k:
                continue
            if (r.get("旁证") or "有").strip() != "有":
                continue
            detail = (r.get("旁证明细") or "").strip()
            prev = ev.get(k)
            ev[k] = "/".join(sorted({x for x in (prev or "").split("/") if x} | ({detail} if detail else set()))) or ""
    return ev


# --------------------------------------------------------------------------- 归因


def attr_set(rec: dict, sep: str) -> set[str]:
    raw = rec.get("属性", "")
    return {x.strip() for x in raw.split(sep) if x.strip()} if raw else set()


def comparable(a: dict, b: dict) -> bool:
    """两边的属性在不在同一坐标系上。任一侧标「可比=否」就不比。

    真实场景：甲方表里有个 sheet 记的是计算公式和数据库表，没有采集频次列；
    拿它跟我方的「实时/小时/日/旬/月」硬比，会凭空造出几条不存在的冲突。
    """
    return (a.get("可比", "") or "是") != "否" and (b.get("可比", "") or "是") != "否"


def _brief(raw: str, n: int = 14) -> str:
    """冲突类型里嵌原文时截断——类型要能聚合，太长会让每条自成一类。"""
    raw = " ".join(raw.split())
    return raw if len(raw) <= n else raw[:n] + "…"


def conflict_type(a: dict, b: dict, sep: str, a_name: str, b_name: str) -> str:
    """两边都有、但属性口径不一致时，这条冲突属于哪一类。

    分型的意义在于：不同类型对应不同的追问方式。『对方没填』要请他补表，
    『对方标了不提供而我方说有』是口径矛盾，得当面定权威版本。
    """
    if not comparable(a, b):
        return ""
    fa, fb = attr_set(a, sep), attr_set(b, sep)
    if fa == fb:
        return ""
    if not fa and fb:
        raw = a.get("属性原文", "")
        if not raw:
            return f"{a_name}未填，{b_name}声明有"
        return f"{a_name}标注为「{_brief(raw)}」，{b_name}声明有"
    if not fb and fa:
        return f"{b_name}未填，{a_name}声明有"
    if fa - fb and not fb - fa:
        return f"{a_name}多于{b_name}"
    if fb - fa and not fa - fb:
        return f"{b_name}多于{a_name}"
    return "双向不一致"


def missing_kind(group: str, whole: set[str], near: set[str], name: str) -> str:
    """仅 B 有的条目，按其所属分组的缺失程度归类。

    整组漏列和零星漏列要对方做的事完全不同：前者是「这个站/模块你压根没列」，
    后者是「补几条」。混在一起报，对方看不出轻重。
    """
    if group and group in whole:
        return "整组漏列"
    if group and group in near:
        return "近乎整组漏列"
    return "零星漏列"


# --------------------------------------------------------------------------- 出表


def build_tables(A, B, ev, sep, a_name, b_name):
    sa, sb = set(A), set(B)
    only_a = sorted(sa - sb)
    only_b = sorted(sb - sa)
    both = sorted(sa & sb)

    # 分组缺失度：只在 B 侧统计（「我方有、对方没列」才谈得上整组漏列）
    whole, near = set(), set()
    groups = {B[k].get("分组", "") for k in sb if B[k].get("分组")}
    for g in groups:
        tot = sum(1 for k in sb if B[k].get("分组") == g)
        miss = sum(1 for k in only_b if B[k].get("分组") == g)
        if tot and miss == tot:
            whole.add(g)
        elif tot and miss / tot >= NEAR_TOTAL_RATIO:
            near.add(g)

    t1 = [
        [k, A[k]["名称"], A[k].get("类别", ""), A[k].get("分组", ""), A[k].get("来源", ""),
         A[k].get("属性原文") or A[k].get("属性") or "（空）",
         "有" if k in ev else "无", ev.get(k, "")]
        for k in sorted(only_a, key=lambda k: (A[k].get("类别", ""), A[k].get("分组", ""), k))
    ]

    t2 = []
    for k in only_b:
        g = B[k].get("分组", "")
        t2.append([k, B[k]["名称"], B[k].get("类别", ""), g,
                   missing_kind(g, whole, near, B[k]["名称"]),
                   B[k].get("属性原文") or B[k].get("属性") or "",
                   "有" if k in ev else "无", ev.get(k, "")])
    order = {"整组漏列": 0, "近乎整组漏列": 1, "零星漏列": 2}
    t2.sort(key=lambda r: (order[r[4]], r[3], r[0]))

    t3 = []
    for k in both:
        typ = conflict_type(A[k], B[k], sep, a_name, b_name)
        if not typ:
            continue
        t3.append([k, A[k]["名称"], A[k].get("类别", ""), A[k].get("分组", ""), A[k].get("来源", ""),
                   A[k].get("属性原文") or A[k].get("属性") or "（空）",
                   B[k].get("属性原文") or B[k].get("属性") or "（空）",
                   typ, "有" if k in ev else "无", ev.get(k, "")])
    t3.sort(key=lambda r: (r[7], r[3], r[0]))

    return t1, t2, t3, both, whole, near


def write_detail_csv(path, A, B, ev, sep, a_name, b_name, t2_kind):
    sa, sb = set(A), set(B)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["键", "名称", "归属", "类别", "分组", "来源",
                    f"{a_name}属性", f"{b_name}属性", "口径是否一致", "冲突类型",
                    "漏列类型", "旁证", "旁证明细"])
        for k in sorted(sa | sb):
            a, b = A.get(k), B.get(k)
            if a and b:
                own = "① 双方都有"
            elif a:
                own = f"② 仅{a_name}有"
            else:
                own = f"③ 仅{b_name}有"
            rec = a or b
            typ = conflict_type(a, b, sep, a_name, b_name) if (a and b) else ""
            if a and b and not comparable(a, b):
                same = "口径不可比"
            else:
                same = ("一致" if not typ else "不一致") if (a and b) else ""
            w.writerow([
                k, rec["名称"], own, rec.get("类别", ""), rec.get("分组", ""), rec.get("来源", ""),
                (a.get("属性原文") or a.get("属性") or "") if a else "",
                (b.get("属性原文") or b.get("属性") or "") if b else "",
                same, typ, t2_kind.get(k, ""),
                "有" if k in ev else "无", ev.get(k, ""),
            ])


# --------------------------------------------------------------------------- xlsx

HDR_BG, HDR_FILL_BG, ALT_BG, FILL_BG = "1F4E79", "BF8F00", "F2F7FB", "FFF2CC"


def write_xlsx(path, t1, t2, t3, meta, notes_text, fills):
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
        from openpyxl.utils import get_column_letter
    except ImportError:
        sys.exit("[错误] 需要 openpyxl 才能出核对件：pip3 install openpyxl")

    hdr_fill, hdr_in = PatternFill("solid", fgColor=HDR_BG), PatternFill("solid", fgColor=HDR_FILL_BG)
    alt, fill_in = PatternFill("solid", fgColor=ALT_BG), PatternFill("solid", fgColor=FILL_BG)
    hdr_font, body = Font(color="FFFFFF", bold=True, size=10), Font(size=10)
    thin = Side(style="thin", color="D0D7DE")
    bd = Border(left=thin, right=thin, top=thin, bottom=thin)

    wb = Workbook()
    wb.remove(wb.active)

    # ---- 核对说明 ----
    ws = wb.create_sheet("核对说明")
    ws.column_dimensions["A"].width = 4
    ws.column_dimensions["B"].width = 118
    ws.sheet_view.showGridLines = False

    def L(text="", style=None, height=None):
        ws.append(["", text])
        c = ws.cell(ws.max_row, 2)
        c.alignment = Alignment(wrap_text=True, vertical="top")
        c.font = {"h1": Font(size=16, bold=True, color=HDR_BG),
                  "h2": Font(size=12, bold=True, color=HDR_BG),
                  "k": Font(size=10, bold=True)}.get(style, Font(size=10))
        if height:
            ws.row_dimensions[ws.max_row].height = height

    L(); L(meta["title"], "h1", 26); L(meta["project"])
    L()
    L("一、这份表是怎么来的", "h2", 20)
    L(f"把《{meta['a_name']}》的 {meta['n_a']:,} 条，与《{meta['b_name']}》的 {meta['n_b']:,} 条"
      f"逐「{meta['key_label']}」比对"
      + (f"，并以{meta['ev_name']}（实际有数 {meta['n_ev']:,} 条）作为旁证。" if meta["n_ev"] else "。")
      + "对齐一律走编码，不走名称——两边名称可能存在字形差异。", None, 44)
    L()
    L("二、三张表", "h2", 20)
    L(f"① 仅{meta['a_name']}有（{len(t1)} 条）：贵方列了、我方没有。", None)
    L(f"② 仅{meta['b_name']}有（{len(t2)} 条）：我方有、贵方没列"
      + (f"，其中 {sum(1 for r in t2 if r[6] == '有')} 条{meta['ev_name']}已有数。" if meta["n_ev"] else "。"), None)
    L(f"③ 口径冲突（{len(t3)} 条）：两边都有，但属性标注对不上"
      f"（占两表交集 {len(t3) / meta['n_both'] * 100:.0f}%）。" if meta["n_both"] else "③ 口径冲突（0 条）", None)
    L()
    L("三、请回填的列", "h2", 20)
    L("每张表右侧的浅黄色列留给贵方填写，其余列请勿改动——编码是唯一对齐依据，"
      "改动后回传的表无法对回。回填完整表回传即可，不必删行。", None, 30)
    if notes_text:
        L()
        for line in notes_text.rstrip().splitlines():
            s = line.strip()
            if not s:
                L(); continue
            if s.startswith("## "):
                L(s[3:], "h2", 20)
            elif s.startswith("# "):
                L(s[2:], "h2", 20)
            else:
                L(s, None, 30 if len(s) > 60 else None)
    L()
    L("口径说明", "h2", 20)
    if meta["n_ev"]:
        L(f"·「旁证」来自{meta['ev_name']}，只说明统计窗口内出现过该条目，"
          "不代表长期稳定采集，也不代表数据质量合格。", None, 30)
    L("·「类别」「分组」用于分组浏览，非正式分类。", None)
    L("· 回填人 / 回填日期：", "k")

    # ---- 三张数据表 ----
    def sheet(title, headers, rows, widths, n_fixed):
        s = wb.create_sheet(title)
        s.append(["序号"] + headers)
        for i, c in enumerate(s[1], start=1):
            c.fill = hdr_fill if i - 1 <= n_fixed else hdr_in
            c.font = hdr_font
            c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            c.border = bd
        for n, r in enumerate(rows, start=1):
            s.append([n] + list(r))
            for i, c in enumerate(s[s.max_row], start=1):
                c.font, c.border = body, bd
                c.alignment = Alignment(vertical="center", wrap_text=(i > 2))
                if i - 1 > n_fixed:
                    c.fill = fill_in
                elif n % 2 == 0:
                    c.fill = alt
        s.freeze_panes = "C2"
        s.auto_filter.ref = f"A1:{get_column_letter(len(headers) + 1)}{s.max_row}"
        s.row_dimensions[1].height = 34
        for i, w in enumerate([6] + widths, start=1):
            s.column_dimensions[get_column_letter(i)].width = w
        return s

    ev_cols = ["旁证", "旁证明细"] if meta["n_ev"] else []
    ev_w = [10, 18] if meta["n_ev"] else []
    t1r = [r if meta["n_ev"] else r[:6] for r in t1]
    t2r = [r if meta["n_ev"] else r[:6] for r in t2]
    t3r = [r if meta["n_ev"] else r[:8] for r in t3]

    h1 = [meta["key_label"], "名称", "类别", "分组", "来源", f"{meta['a_name']}属性"] + ev_cols
    sheet(f"① 仅{meta['a_name'][:8]}有({len(t1)})", h1 + fills["a"],
          [r + [None] * len(fills["a"]) for r in t1r],
          [14, 26, 14, 14, 14, 26] + ev_w + [22] * len(fills["a"]), len(h1))

    h2 = [meta["key_label"], "名称", "类别", "分组", "漏列类型", f"{meta['b_name']}属性"] + ev_cols
    sheet(f"② 仅{meta['b_name'][:8]}有({len(t2)})", h2 + fills["b"],
          [r + [None] * len(fills["b"]) for r in t2r],
          [14, 26, 14, 14, 14, 20] + ev_w + [22] * len(fills["b"]), len(h2))

    h3 = [meta["key_label"], "名称", "类别", "分组", "来源",
          f"{meta['a_name']}属性", f"{meta['b_name']}属性", "冲突类型"] + ev_cols
    sheet(f"③ 口径冲突({len(t3)})", h3 + fills["c"],
          [r + [None] * len(fills["c"]) for r in t3r],
          [14, 26, 14, 14, 14, 20, 20, 32] + ev_w + [22] * len(fills["c"]), len(h3))

    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    wb.save(path)


# --------------------------------------------------------------------------- main


def main():
    p = argparse.ArgumentParser(
        description="两份清单交叉比对 → 差异明细 CSV + 可回填核对件 xlsx",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__)
    p.add_argument("--a", required=True, help="A 侧归一清单 CSV（通常是对方给的）")
    p.add_argument("--b", required=True, help="B 侧归一清单 CSV（通常是我方的）")
    p.add_argument("--a-name", default="甲方清单")
    p.add_argument("--b-name", default="我方清单")
    p.add_argument("--evidence", help="旁证 CSV（键/旁证/旁证明细），可选")
    p.add_argument("--evidence-name", default="现场实测")
    p.add_argument("--attr-sep", default="/", help="属性列的多值分隔符（默认 /）")
    p.add_argument("--key-label", default="编码", help="核对件里编码列的表头（如「测点点号」）")
    p.add_argument("--title", default="清单核对件")
    p.add_argument("--project", default="")
    p.add_argument("--notes", help="核对说明补充：一个 md/txt，「## 」开头的行渲染成小标题")
    p.add_argument("--fill-a", default="【回填】该条实际情况,【回填】可提供属性,【回填】计划时间,【回填】备注")
    p.add_argument("--fill-b", default="【回填】是否补入,【回填】来源,【回填】可提供属性,【回填】备注")
    p.add_argument("--fill-c", default="【回填】以哪份为准,【回填】实际属性,【回填】备注")
    p.add_argument("--out-xlsx")
    p.add_argument("--out-csv")
    p.add_argument("--dry-run", action="store_true", help="只打印统计，不写文件")
    args = p.parse_args()

    A = read_list(args.a, args.a_name)
    B = read_list(args.b, args.b_name)
    ev = read_evidence(args.evidence)

    t1, t2, t3, both, whole, near = build_tables(A, B, ev, args.attr_sep, args.a_name, args.b_name)
    t2_kind = {r[0]: r[4] for r in t2}

    # ---- 统计 ----
    print(f"\n{'=' * 62}\n{args.title}\n{'=' * 62}")
    print(f"{args.a_name:<22} {len(A):>6,} 条")
    print(f"{args.b_name:<22} {len(B):>6,} 条")
    if ev:
        print(f"{args.evidence_name + '（有数）':<22} {len(ev):>6,} 条"
              f"　其中不在两表内 {len(set(ev) - set(A) - set(B)):,} 条")
    n_na = sum(1 for k in both if not comparable(A[k], B[k]))
    print(f"\n  ① 双方都有       {len(both):>6,}　其中口径冲突 {len(t3):,}"
          + (f"，口径不可比 {n_na:,}（已排除）" if n_na else ""))
    print(f"  ② 仅{args.a_name}有  {len(t1):>6,}" + (f"　其中旁证有数 {sum(1 for r in t1 if r[6] == '有'):,}" if ev else ""))
    print(f"  ③ 仅{args.b_name}有  {len(t2):>6,}" + (f"　其中旁证有数 {sum(1 for r in t2 if r[6] == '有'):,}" if ev else ""))

    def dist(title, counter, total):
        if not counter:
            return
        print(f"\n{title}")
        for k, v in counter.most_common():
            print(f"    {k or '（未分类）':<28} {v:>5}  {v / total * 100:>5.1f}%")

    dist(f"② 仅{args.a_name}有 · 按类别", Counter(r[2] for r in t1), max(len(t1), 1))
    dist(f"③ 仅{args.b_name}有 · 按漏列类型", Counter(r[4] for r in t2), max(len(t2), 1))
    if whole or near:
        print(f"\n  整组漏列的分组：{'、'.join(sorted(whole)) or '（无）'}")
        print(f"  近乎整组漏列（≥{NEAR_TOTAL_RATIO:.0%}）：{'、'.join(sorted(near)) or '（无）'}")
    dist("③ 口径冲突 · 按冲突类型", Counter(r[7] for r in t3), max(len(t3), 1))

    if args.dry_run:
        print("\n[dry-run] 未写文件。确认分类口径合适后去掉 --dry-run。\n")
        return

    if args.out_csv:
        write_detail_csv(args.out_csv, A, B, ev, args.attr_sep, args.a_name, args.b_name, t2_kind)
        print(f"\n[写出] 差异明细 {args.out_csv}（{len(set(A) | set(B)):,} 行）")

    if args.out_xlsx:
        notes = ""
        if args.notes:
            if not os.path.exists(args.notes):
                sys.exit(f"[错误] --notes 文件不存在：{args.notes}")
            notes = open(args.notes, encoding="utf-8").read()
        meta = {"title": args.title, "project": args.project,
                "a_name": args.a_name, "b_name": args.b_name, "ev_name": args.evidence_name,
                "n_a": len(A), "n_b": len(B), "n_ev": len(ev), "n_both": len(both),
                "key_label": args.key_label}
        fills = {"a": [x for x in args.fill_a.split(",") if x],
                 "b": [x for x in args.fill_b.split(",") if x],
                 "c": [x for x in args.fill_c.split(",") if x]}
        write_xlsx(args.out_xlsx, t1, t2, t3, meta, notes, fills)
        print(f"[写出] 核对件   {args.out_xlsx}（4 sheet）")
    print()


if __name__ == "__main__":
    main()
