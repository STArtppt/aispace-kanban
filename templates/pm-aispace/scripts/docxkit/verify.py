"""反查：用采集器读生成的样张，逐个角色比对「实际生效格式」与规范。

样张格式对不对以这里为准，不以预览观感为准（浏览器预览不刷新域、缺字体时会回退）。
不一致的项写进 build 结果的 warnings，`pnpm test:docx` 也靠它断言。
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

from .collect import collect
from .decisions import prop_values
from .spec import effective, style_name

# 样张 sample.md 里一定出现的角色（Table = 表格内文字）
CHECK_ROLES = ("BodyText", "FirstParagraph", "Heading1", "Heading2", "Heading3", "Heading4", "Title",
               "TableCaption", "ImageCaption", "SourceCode", "BlockText", "Note", "Compact", "Table")
CHECK_PROPS = ("eastAsia", "ascii", "size", "bold", "jc", "firstLineChars", "line")
PROP_LABEL = {"eastAsia": "中文字体", "ascii": "西文字体", "size": "字号", "bold": "加粗", "jc": "对齐",
              "firstLineChars": "首行缩进(字符)", "line": "行距"}


def verify(docx: Path, spec: dict) -> tuple[list[str], dict]:
    """返回 (warnings, 明细)。明细：角色 → {prop: [期望, 实际]}，只列不一致的。"""
    _, paras = collect(docx)
    warnings, detail = [], {}
    missing = Counter(p["styleId"] for p in paras if p.get("styleMissing") and p["len"])
    for sid, n in missing.items():
        warnings.append(f"样张用到了参照模板里没有定义的样式 {sid}（{n} 段），这些段落会按 Normal 显示")
    for role in CHECK_ROLES:
        if role == "Table":
            ps = [p for p in paras if p["inTable"] and p["len"]]
            props = [k for k in CHECK_PROPS if k not in ("jc", "bold")]  # 列对齐与表头加粗由表格自己决定
        else:
            name = spec["styles"][role]["name"].lower()
            ps = [p for p in paras if not p["inTable"] and p["len"] and p["style"].lower() == name]
            props = list(CHECK_PROPS)
        if not ps:
            warnings.append(f"样张里没有找到「{style_name(spec, role)}」段落，无法核对")
            continue
        key = Counter(tuple(sorted(prop_values(p["fmt"]).items(), key=lambda kv: kv[0])) for p in ps).most_common(1)[0][0]
        actual = dict(key)
        want = effective(spec, role)
        diff = {}
        for k in props:
            a, w = actual.get(k), want.get(k)
            if w is None:
                continue
            if isinstance(w, (int, float)) and isinstance(a, (int, float)) and not isinstance(w, bool):
                if abs(float(a) - float(w)) < 0.05:
                    continue
            elif a == w:
                continue
            diff[k] = [w, a]
            warnings.append(f"「{style_name(spec, role)}」{PROP_LABEL[k]}：期望 {w}，实际 {a}")
        if diff:
            detail[role] = diff
    return warnings, detail
