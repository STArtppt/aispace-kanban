"""用户决定（提炼第 ②③ 步）的校验，以及「决定 + 采集报告 → profile.json」。

决定的形状（看板经 stdin 传入，终端用 --decisions 文件）::

    {
      "schema": 1,
      "clusters": {                       # 簇 id → 三选一；没写到的簇采用报告里的 suggestedRole
        "c1": {"role": "BodyText"},
        "c2": {"merge": "c1"},            # 并入另一簇（跟随它的角色）
        "c8": {"drop": true}              # 丢弃（目录项、封面残留等）
      },
      "choices": {"BodyText.line": 1.5},  # 同一角色格式不一致时选定的值；没写就取段数多的
      "front": {                          # 前置区（报告里 front 不为空时才有意义），见 front.py
        "disabled": false,                # true = 不要前置区，不写 front.docx
        "fields": {"f1": "title", "f3": "keep"},   # 字段 → title / client / vendor / date / doctype / keep；没写的用 guess
        "tables": {"t1": "keepLabels"},    # 表 → keepHeader / keepLabels / keepHeaderAndLabels / keepAll；没写的用 defaultRule
        "sections": {"s1": "封面"}          # 分节改名（只影响 spec.md 与 profile.json 里的显示）
      }
    }

决定里**不允许出现路径**：键名带 path / file / dir / url 一律拒绝，字符串值里有路径分隔符也拒绝。
这是 AGENTS.md 不变量 1 第九条第 ④ 款在脚本这一侧的校验（看板服务端另校验一次）。

同一角色的冲突计算在看板前端也有一份（第 ③ 步要实时显示），口径以这里为准：
src/app/components/templateRefine/plan.ts。
"""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict

from .spec import ROLES, effective, props_of

MAX_BYTES = 256 * 1024
FORBIDDEN_KEY = re.compile(r"path|file|dir|folder|url", re.I)


class DecisionError(ValueError):
    pass


def _scan_forbidden(obj, where="决定") -> None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            if not isinstance(k, str) or FORBIDDEN_KEY.search(k):
                raise DecisionError(f"{where} 里不允许出现路径类字段：{k!r}")
            _scan_forbidden(v, f"{where}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _scan_forbidden(v, f"{where}[{i}]")
    elif isinstance(obj, str) and ("/" in obj or "\\" in obj or ".." in obj):
        raise DecisionError(f"{where} 的值不能含路径分隔符：{obj!r}")


def validate(dec, report: dict) -> dict:
    """校验并规范化；不合法抛 DecisionError（入口脚本转成退出码 2）。"""
    if dec is None:
        dec = {}
    if not isinstance(dec, dict):
        raise DecisionError("决定必须是一个 JSON 对象")
    _scan_forbidden(dec)
    unknown = set(dec) - {"schema", "clusters", "choices", "front"}
    if unknown:
        raise DecisionError(f"决定里有不认识的字段：{', '.join(sorted(unknown))}")
    ids = {c["id"] for c in report["clusters"]}
    clusters = dec.get("clusters") or {}
    if not isinstance(clusters, dict):
        raise DecisionError("clusters 必须是对象")
    for cid, d in clusters.items():
        if cid not in ids:
            raise DecisionError(f"采集报告里没有格式簇 {cid}（报告可能已重新采集，请回到第 ② 步）")
        if not isinstance(d, dict) or len(d) != 1:
            raise DecisionError(f"格式簇 {cid} 的决定只能是 role / merge / drop 三者之一")
        (k, v), = d.items()
        if k == "role" and v not in ROLES:
            raise DecisionError(f"格式簇 {cid} 的角色 {v!r} 不认识")
        if k == "merge" and (v not in ids or v == cid):
            raise DecisionError(f"格式簇 {cid} 要并入的 {v!r} 不存在")
        if k == "drop" and v is not True:
            raise DecisionError(f"格式簇 {cid} 的 drop 只能是 true")
        if k not in ("role", "merge", "drop"):
            raise DecisionError(f"格式簇 {cid} 的决定 {k!r} 不认识")
    choices = dec.get("choices") or {}
    if not isinstance(choices, dict):
        raise DecisionError("choices 必须是对象")
    for key in choices:
        role, _, prop = key.partition(".")
        if role not in ROLES or prop not in props_of(role):
            raise DecisionError(f"choices 的键 {key!r} 应写成「角色.属性」")
    return {"clusters": clusters, "choices": choices, "front": _validate_front(dec.get("front"), report.get("front"))}


def _validate_front(fd, rf) -> dict:
    """前置区决定 → 规范化后的完整决定（没写到的字段、表格按报告的猜测补齐）。报告里没有前置区时一律视为不要。"""
    from .front import FIELD_CHOICES, TABLE_RULES

    if fd is None:
        fd = {}
    if not isinstance(fd, dict):
        raise DecisionError("front 必须是对象")
    unknown = set(fd) - {"disabled", "fields", "tables", "sections"}
    if unknown:
        raise DecisionError(f"front 里有不认识的字段：{', '.join(sorted(unknown))}")
    if "disabled" in fd and not isinstance(fd["disabled"], bool):
        raise DecisionError("front.disabled 只能是 true / false")
    if not rf or fd.get("disabled"):
        return {"disabled": True}
    parts = {"fields": ({f["id"]: f for f in rf["fields"]}, FIELD_CHOICES),
             "tables": ({t["id"]: t for t in rf["tables"]}, TABLE_RULES),
             "sections": ({s["id"]: s for s in rf["sections"]}, None)}
    out = {"disabled": False}
    for key, (known, allowed) in parts.items():
        got = fd.get(key) or {}
        if not isinstance(got, dict):
            raise DecisionError(f"front.{key} 必须是对象")
        for k, v in got.items():
            if k not in known:
                raise DecisionError(f"采集报告的前置区里没有 {k}（报告可能已重新采集，请回到第 ② 步）")
            if allowed is not None and v not in allowed:
                raise DecisionError(f"front.{key}.{k} 的取值 {v!r} 不认识")
            if allowed is None and (not isinstance(v, str) or not v.strip() or len(v) > 20):
                raise DecisionError(f"front.sections.{k} 的名称要是 1–20 字的文字")
    out["fields"] = {i: (fd.get("fields") or {}).get(i, f["guess"] or "keep") for i, f in parts["fields"][0].items()}
    out["tables"] = {i: (fd.get("tables") or {}).get(i, t["defaultRule"]) for i, t in parts["tables"][0].items()}
    out["sections"] = {i: (fd.get("sections") or {}).get(i, SECTION_NAME.get(s["guess"], "其它"))
                       for i, s in parts["sections"][0].items()}
    return out


SECTION_NAME = {"cover": "封面", "signoff": "签署页", "revisions": "版本跟踪表", "toc": "目录", "other": "其它"}


def front_profile(fd: dict) -> dict | None:
    """profile.json 的 front 段：字段映射、表格清空规则、分节名。不要前置区时为 None（profile 里不出现 front）。"""
    if fd.get("disabled"):
        return None
    return {"_about": "前置区（封面 / 签署页 / 版本跟踪表 / 目录）的骨架在 front.docx；fields 是字段 → 角色（keep = 保持原样），"
                      "tables 是表格清空规则。转换时封面字段依次取自 md front-matter → 文档标题 → project.yaml → 当天日期。",
            "fields": fd["fields"], "tables": fd["tables"], "sections": fd["sections"]}


def role_map(report: dict, dec: dict) -> dict:
    """簇 id → 角色（None = 丢弃）。merge 沿链找到最终的簇，成环就当丢弃。"""
    by_id = {c["id"]: c for c in report["clusters"]}
    out = {}
    for cid in by_id:
        seen, cur = set(), cid
        while True:
            d = dec["clusters"].get(cur)
            if d is None:
                out[cid] = by_id[cur].get("suggestedRole")
                break
            if "role" in d:
                out[cid] = d["role"]
                break
            if "drop" in d or cur in seen:
                out[cid] = None
                break
            seen.add(cur)
            cur = d["merge"]
    return out


def _chars(v, pt, size):
    # 显式「四舍五入到 0.5」：Python 的 round 是银行家舍入，前端 plan.ts 的 Math.round 不是，两边要算出同一个值
    if v is not None:
        return v
    if pt is not None and size:
        return math.floor(pt / size * 2 + 0.5) / 2
    return 0


def prop_values(fmt: dict) -> dict:
    """格式簇的生效格式 → 规范口径的属性值（前端 plan.ts 同口径）。"""
    size = fmt.get("size")
    before = fmt["beforeLines"] * 12 if fmt.get("beforeLines") is not None else fmt.get("before", 0)
    after = fmt["afterLines"] * 12 if fmt.get("afterLines") is not None else fmt.get("after", 0)
    if fmt.get("lineExact") is not None:
        line = f"{fmt['lineExact']:g}pt"
    elif fmt.get("lineAtLeast") is not None:
        line = f"{fmt['lineAtLeast']:g}pt"
    else:
        line = fmt.get("line") or 1.0
    return {
        "eastAsia": fmt.get("eastAsia"),
        "ascii": fmt.get("ascii"),
        "size": size,
        "bold": bool(fmt.get("bold")),
        "jc": fmt.get("jc") or "left",
        "firstLineChars": 0 if fmt.get("hanging") else _chars(fmt.get("firstLineChars"), fmt.get("firstLinePt"), size),
        "leftChars": _chars(fmt.get("leftChars"), fmt.get("leftPt"), size),
        # 段前段后来自 缇/20 或 行×12，保留两位不会碰到「正好一半」的舍入分歧
        "before": round(before, 2),
        "after": round(after, 2),
        "line": line,
    }


def _match(want, candidates):
    """选定值对上采集到的取值；数值允许 0.01 的误差（前端 JSON 往返后的浮点差）。"""
    for v in candidates:
        if type(v) is type(want) and v == want:
            return v
        if isinstance(v, (int, float)) and isinstance(want, (int, float)) \
                and not isinstance(v, bool) and not isinstance(want, bool) and abs(v - want) < 0.01:
            return v
    return None


def plan(report: dict, dec: dict) -> dict:
    """按角色汇总：每个角色有哪些簇、每个属性各取值的段数、最后选了哪个值。"""
    roles = role_map(report, dec)
    groups = defaultdict(list)
    for c in report["clusters"]:
        r = roles[c["id"]]
        if r:
            groups[r].append(c)
    out = {}
    for role, cs in groups.items():
        props, conflicts = {}, []
        for prop in props_of(role):
            cnt = Counter()
            for c in cs:
                v = prop_values(c["fmt"])[prop]
                if v is not None:
                    cnt[v] += c["count"]
            if not cnt:
                continue
            options = [{"value": v, "count": n} for v, n in cnt.most_common()]
            chosen = options[0]["value"]
            key = f"{role}.{prop}"
            src = "extracted"
            if len(options) > 1:
                if key in dec["choices"]:
                    want = _match(dec["choices"][key], cnt)
                    if want is None:
                        raise DecisionError(f"{key} 选定的值 {dec['choices'][key]!r} 不在采集到的取值里")
                    chosen, src = want, "decision"
                conflicts.append({"key": key, "options": options, "chosen": chosen})
            props[prop] = (chosen, src)
        out[role] = {"clusters": [c["id"] for c in cs], "count": sum(c["count"] for c in cs),
                     "props": props, "conflicts": conflicts}
    return out


def _style_patch(vals: dict) -> dict:
    s = {}
    font = {k: vals[k] for k in ("eastAsia", "ascii") if k in vals}
    if font:
        s["font"] = font
    for k in ("size", "bold", "jc", "before", "after"):
        if k in vals:
            s[k] = vals[k]
    for k in ("firstLineChars", "leftChars"):
        if k in vals:
            s[k] = int(round(vals[k] * 100))
    if "line" in vals:
        v = vals["line"]
        if isinstance(v, str) and v.endswith("pt"):
            s["lineExact"] = float(v[:-2])
        else:
            s["line"] = v
    return s


def derive_profile(report: dict, dec: dict, base: dict) -> tuple[dict, dict]:
    """返回 (profile, plan)。profile 只写与通用规范不同的部分，每一节用 `_src` 标出每个属性的来源。"""
    p = plan(report, dec)
    profile: dict = {"_about": "相对通用规范（scripts/docxkit/base-spec.json）的客户差异，由 docx_template.py build 生成。"
                               "_src：extracted = 从旧文档实际生效格式采集；decision = 在看板里人工选定。",
                     "styles": {}}
    for role, info in p.items():
        base_eff = effective(base, role)
        diff = {k: v for k, (v, _) in info["props"].items() if base_eff.get(k) != v}
        src = {k: info["props"][k][1] for k in diff}
        if not diff:
            continue
        if role == "Table":
            t = {}
            if "size" in diff:
                t["font_size"] = diff["size"]
            if "line" in diff and not isinstance(diff["line"], str):
                t["line"] = diff["line"]
            if t:
                t["_src"] = {("font_size" if k == "size" else k): src[k] for k in ("size", "line") if k in diff}
                profile["table"] = t
            continue
        if role == "BodyText":
            # 字体、字号、行距写进 docDefaults、Normal 保持为空 —— 这样表格样式的字号、行距才压得过正文
            # （docDefaults 的行距只认倍数，固定值行距留在 Body Text 自己身上）
            dd_keys = {"eastAsia", "ascii", "size"} & set(diff)
            if "line" in diff and not isinstance(diff["line"], str):
                dd_keys.add("line")
            if dd_keys:
                dd = _style_patch({k: diff[k] for k in dd_keys})
                dd["_src"] = {k: src[k] for k in dd_keys}
                profile["doc_defaults"] = dd
                diff = {k: v for k, v in diff.items() if k not in dd_keys}
            if not diff:
                continue
        st = _style_patch(diff)
        st["_src"] = {k: src[k] for k in diff}
        profile["styles"][role] = st

    # 标题编号：采到自动编号就沿用客户的编号格式（如 "%1." 或 "%1、" + chineseCounting）
    levels = list(base["heading_numbering"]["levels"])
    formats = list(base["heading_numbering"].get("formats") or ["decimal"] * len(levels))
    got = False
    for o in report.get("outline", []):
        i = o["level"] - 1
        if 0 <= i < len(levels) and o.get("autoNum"):
            text = next(iter(o["autoNum"]))
            fmt = next(iter(o.get("autoNumFmt") or {}), "decimal")
            if text and (text != levels[i] or fmt != formats[i]):
                levels[i], formats[i], got = text, fmt, True
    if got:
        profile["heading_numbering"] = {"levels": levels, "formats": formats, "_src": "extracted"}

    profile["_roles"] = {r: {"clusters": i["clusters"], "count": i["count"]} for r, i in p.items()}
    return profile, p
