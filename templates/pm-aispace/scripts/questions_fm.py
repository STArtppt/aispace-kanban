#!/usr/bin/env python3
"""问题文件的扁平 front-matter 解析 —— `check_questions.py` 与 `migrate_questions.py` 共用。

**必须与看板仓库 `src/server/frontmatter.mjs` 的 `parseFrontmatter` 逐行同构。**
看板服务端读的是同一批文件，两边对「什么算一个字段」的理解一旦分叉，
就会出现「脚本说合法、看板显示不出来」这种最难查的病。改这里之前先看那边。

同构的几处细节，都不是随手写的：

- 只认 `key: value` 与 `key:` + `  - item` 两种形态，**不支持嵌套**。
  这是刻意的限制：它强制 `title` 是一句话、`blocks` 是一个交付物名，
  条目长度由结构管住，不靠自觉。
- `key:` 后面什么都没有时，值是**空列表**而不是空字符串（JS 那边也是）。
  所以判断「这个字段填了没有」一律走 `is_blank()`，不要直接 `if meta[k]`。
- 键名字符集是 `[\\w.-]`，正文里的 `## 标题：说明` 不会被误当成字段（它不在 front-matter 段里）。
"""

from __future__ import annotations

import re
from typing import Any

_ITEM = re.compile(r"^\s+-\s+(.*)$")
_KV = re.compile(r"^([\w.-]+):\s*(.*)$")


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str, str]:
    """返回 (meta, body, raw)。没有 front-matter 时 meta 为空、body 是全文。"""
    if not text.startswith("---"):
        return {}, text, ""
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text, ""
    raw = text[text.find("\n") + 1 : end]
    body = text[end + 4 :]
    body = re.sub(r"^\r?\n", "", body)

    meta: dict[str, Any] = {}
    list_key = ""
    for line in raw.split("\n"):
        line = line.rstrip("\r")
        item = _ITEM.match(line)
        if item and list_key:
            meta[list_key].append(item.group(1).strip())
            continue
        kv = _KV.match(line)
        if not kv:
            continue
        key, value = kv.group(1), kv.group(2)
        if value == "":
            list_key = key
            meta[key] = []
        else:
            list_key = ""
            meta[key] = value.strip()
    return meta, body, raw


def is_blank(value: Any) -> bool:
    """字段有没有填。`key:` 解析出来是 `[]`，所以不能直接看真假。"""
    if value is None:
        return True
    if isinstance(value, list):
        return len(value) == 0
    return str(value).strip() == ""


def as_text(value: Any) -> str:
    """把字段值压成一行字符串，供比对与展示用。"""
    if value is None:
        return ""
    if isinstance(value, list):
        return " / ".join(str(v).strip() for v in value)
    return str(value).strip()
