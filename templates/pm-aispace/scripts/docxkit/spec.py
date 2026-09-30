"""规范：通用规范 base-spec.json + 客户 profile.json 的合并，以及「某个角色最终长什么样」。

派生 profile（decisions.py）、生成 spec.md（spec_md.py）、反查样张（verify.py）
都要回答「这个角色的生效格式是什么」，口径只写在这里一份。
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASE_SPEC = HERE / "base-spec.json"

# 可以在界面上把格式簇映射过去的角色。键是 base-spec.json 的 styles 键，外加表格内文字 Table。
# 界面文案在看板 src/app/components/templateRefine/roles.ts，增删角色两边一起改。
ROLES = (
    "BodyText", "Heading1", "Heading2", "Heading3", "Heading4", "Title",
    "Caption", "TableCaption", "ImageCaption", "Compact", "SourceCode", "BlockText", "Note",
    "FootnoteText", "TOCHeading", "Table",
)

# 从格式簇带进规范的属性（段落格式 + 字符格式）
PROPS = ("eastAsia", "ascii", "size", "bold", "jc", "firstLineChars", "leftChars", "before", "after", "line")


def props_of(role: str) -> tuple[str, ...]:
    """表格内文字只从旧文档取字号与行距：表头加粗、列对齐由表格样式和 md 分隔行决定，不算冲突。"""
    return ("size", "line") if role == "Table" else PROPS


def deep_merge(a: dict, b: dict) -> dict:
    out = dict(a)
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_base() -> dict:
    return json.loads(BASE_SPEC.read_text(encoding="utf-8"))


def merged(profile: dict | None) -> dict:
    return deep_merge(load_base(), profile or {})


def _line_of(s: dict):
    """规范里的行距：倍数用数字，固定值用 "28pt" 这种字符串（与 decisions 的取值口径一致）。"""
    if "lineExact" in s:
        return f"{s['lineExact']:g}pt"
    if "line" in s:
        return s["line"]
    return None


def _apply(out: dict, s: dict) -> None:
    f = s.get("font") or {}
    if "eastAsia" in f:
        out["eastAsia"] = f["eastAsia"]
    if "ascii" in f:
        out["ascii"] = f["ascii"]
    if "size" in s:
        out["size"] = float(s["size"])
    if "bold" in s:
        out["bold"] = bool(s["bold"])
    if "jc" in s:
        out["jc"] = s["jc"]
    if "firstLineChars" in s:
        out["firstLineChars"] = s["firstLineChars"] / 100
    if "leftChars" in s:
        out["leftChars"] = s["leftChars"] / 100
    if "before" in s:
        out["before"] = float(s["before"])
    if "after" in s:
        out["after"] = float(s["after"])
    ln = _line_of(s)
    if ln is not None:
        out["line"] = ln


def effective(spec: dict, role: str) -> dict:
    """角色的生效格式（单位：pt / 字符 / 倍），层叠顺序与 Word 一致：
    docDefaults → （表格样式）→ 段落样式链（根 → 叶）。"""
    dd = spec["doc_defaults"]
    out = {"eastAsia": None, "ascii": None, "size": 10.0, "bold": False, "jc": "left",
           "firstLineChars": 0, "leftChars": 0, "before": 0.0, "after": 0.0, "line": 1.0}
    _apply(out, {"font": dd.get("font") or {}, "size": dd.get("size", 10), "line": dd.get("line", 1.0)})
    styles = spec["styles"]
    if role == "Table":
        t = spec["table"]
        out.update(size=float(t["font_size"]), line=t["line"], jc="left", firstLineChars=0, before=0.0, after=0.0)
        role = "TableText"
    chain, r, seen = [], role, set()
    while r and r in styles and r not in seen:
        seen.add(r)
        chain.append(styles[r])
        r = styles[r].get("basedOn")
    for s in reversed(chain):
        _apply(out, s)
    return out


def style_name(spec: dict, role: str) -> str:
    if role == "Table":
        return "表格内文字"
    return spec["styles"][role]["name"]
