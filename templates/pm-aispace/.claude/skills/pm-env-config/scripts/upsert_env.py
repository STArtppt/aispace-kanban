#!/usr/bin/env python3
"""把 KEY=VALUE 写入工作空间根目录的 .env，不回显任何值。

口令走 stdin 的 JSON 对象，不要写在命令行参数里（会进进程列表）。

    python3 upsert_env.py --env .env --comment "本系统测试库" <<'JSON'
    {"AI_SMART_DB_USER": "readonly", "AI_SMART_DB_PASSWORD": "…"}
    JSON

    python3 upsert_env.py --env .env --print-keys
    python3 upsert_env.py --gitignore .gitignore
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def quote_value(value: str) -> str:
    if any(ch in value for ch in ' \t#\'"\\') or value != value.strip():
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return value


def parse_keys(text: str) -> list[str]:
    keys = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key = line.split("=", 1)[0].strip()
        if key:
            keys.append(key)
    return keys


def upsert(path: Path, updates: dict[str, str], comment: str | None) -> dict[str, str]:
    """返回每个 key 的动作：created / updated。值不进返回。"""
    if path.is_file():
        text = path.read_text(encoding="utf-8")
    else:
        text = ""
    lines = text.splitlines(keepends=True)
    if lines and not lines[-1].endswith("\n"):
        lines[-1] += "\n"
    actions: dict[str, str] = {}
    pending = dict(updates)

    for i, raw in enumerate(lines):
        stripped = raw.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key = stripped.split("=", 1)[0].strip()
        if key in pending:
            nl = "\n" if raw.endswith("\n") else ""
            lines[i] = f"{key}={quote_value(pending.pop(key))}{nl}"
            actions[key] = "updated"

    if pending:
        block = []
        if lines and lines[-1].strip():
            block.append("\n")
        if comment:
            block.append(f"# {comment}\n")
        for key, value in pending.items():
            block.append(f"{key}={quote_value(value)}\n")
            actions[key] = "created"
        lines.extend(block)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(lines), encoding="utf-8")
    return actions


def ensure_gitignore(path: Path) -> str:
    if path.is_file():
        text = path.read_text(encoding="utf-8")
        lines = text.splitlines()
    else:
        text, lines = "", []
    if any(line.strip() == ".env" for line in lines):
        return "present"
    suffix = "" if text.endswith("\n") or text == "" else "\n"
    path.write_text(text + suffix + ".env\n", encoding="utf-8")
    return "appended"


def main() -> int:
    parser = argparse.ArgumentParser(description="Upsert keys into .env without echoing values")
    parser.add_argument("--env", default=".env")
    parser.add_argument("--comment", default="")
    parser.add_argument("--print-keys", action="store_true")
    parser.add_argument("--gitignore", default="")
    args = parser.parse_args()

    env_path = Path(args.env)
    if args.gitignore:
        print(f"gitignore:.env:{ensure_gitignore(Path(args.gitignore))}")
        return 0
    if args.print_keys:
        if not env_path.is_file():
            print("keys:")
            return 0
        print("keys:" + ",".join(parse_keys(env_path.read_text(encoding="utf-8"))))
        return 0

    raw = sys.stdin.read().strip()
    if not raw:
        print("stdin 需要一份 JSON 对象，例如 {\"KEY\":\"value\"}", file=sys.stderr)
        return 2
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as err:
        print(f"stdin 不是合法 JSON：{err}", file=sys.stderr)
        return 2
    if not isinstance(data, dict) or not data:
        print("stdin JSON 必须是非空对象", file=sys.stderr)
        return 2
    updates: dict[str, str] = {}
    for key, value in data.items():
        if not KEY_RE.match(str(key)):
            print(f"非法环境变量名：{key}", file=sys.stderr)
            return 2
        if value is None:
            print(f"{key} 的值是空", file=sys.stderr)
            return 2
        text = str(value)
        if "\n" in text or "\r" in text:
            print(f"{key} 的值含换行，拒绝写入", file=sys.stderr)
            return 2
        updates[str(key)] = text

    actions = upsert(env_path, updates, args.comment or None)
    parts = [f"{k}:{v}" for k, v in actions.items()]
    print("ok " + " ".join(parts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
