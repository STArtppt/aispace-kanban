#!/usr/bin/env python3
"""anydoc 本地转换客户端：把 PDF / PPTX 抽成 Markdown，不联网。

为什么单独一个模块：ingest.py 里其它转换都是「调一个 CLI、拿 stdout」，
anydoc 多了两件自己的事，混进去会把主流程撑乱——

1. **找二进制**：看板经 ANYDOC_BIN 注入 npm 包装的 cli.js；自己跑脚本则走 PATH。
   不 fallback 到 npx——npx 首次会联网下载，正好把「本地、不外发」请回去。
2. **识别扫描件**：anydoc 不做 OCR，报错串里自带类型和页数，ingest.py 靠这个
   决定要不要升级 MinerU。

只依赖标准库。Windows 上必须显式 encoding="utf-8"，不能只写 text=True，
否则跟系统 locale 走，中文正文当场炸（和 ingest.py 顶上的 reconfigure 同一个坑）。

单独当命令用（调试时方便）：
    python3 scripts/anydoc.py 某文件.pdf
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ENV_BIN = "ANYDOC_BIN"

# unsupported input: PDF has no extractable text (Scanned, 369 pages): OCR is required
_OCR_RE = re.compile(
    r"PDF has no extractable text \(([^,]+), (\d+) pages?\)",
    re.IGNORECASE,
)


class AnydocError(RuntimeError):
    """anydoc 侧的失败：找不到二进制、用法错、转换失败。"""


class NeedsOcrError(AnydocError):
    """这份 PDF 没有可抽取文字层，必须走 OCR。"""

    def __init__(self, message: str, pdf_type: str = "", pages: int = 0) -> None:
        super().__init__(message)
        self.pdf_type = pdf_type
        self.pages = pages


def find_bin() -> str | None:
    """先读看板注入的 ANYDOC_BIN，再找 PATH 上的 anydoc。不走 npx。"""
    env = (os.environ.get(ENV_BIN) or "").strip()
    if env:
        # 即便路径不存在也认：让 to_markdown 报人话，不悄悄退回 markitdown
        return env
    return shutil.which("anydoc")


def available() -> bool:
    return find_bin() is not None


def _argv(*args: str) -> list[str]:
    """组装 anydoc 命令。npm 包装入口是 cli.js，Windows 上不能直接当二进制跑。"""
    binary = find_bin()
    if not binary:
        raise AnydocError(
            "找不到 anydoc。看板会注入 ANYDOC_BIN；自己跑脚本请把 anydoc 放到 PATH，"
            "或设置 ANYDOC_BIN 指向二进制。不要用 npx（首次会联网下载）。"
        )
    if binary.lower().endswith((".js", ".mjs", ".cjs")):
        node = shutil.which("node") or "node"
        return [node, binary, *args]
    return [binary, *args]


def _run(argv: list[str], timeout: float | None = None) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            argv,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise AnydocError(
            f"找不到 anydoc（{argv[0]}）。检查看板是否装了 @firecrawl/anydoc，"
            f"或自己把 anydoc 放到 PATH。"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise AnydocError(f"anydoc 超时（{timeout:.0f}s）：{' '.join(argv)}") from exc


def version() -> str:
    """`anydoc -V` 直接打印版本号，例如 0.2.3。读不到就空串。"""
    try:
        proc = _run(_argv("-V"), timeout=10)
    except AnydocError:
        return ""
    text = (proc.stdout or proc.stderr or "").strip()
    return text.splitlines()[0].strip() if text else ""


def to_markdown(src: Path) -> str:
    """把 src 转成 Markdown 正文（不含 frontmatter）。扫描件抛 NeedsOcrError。"""
    proc = _run(_argv(str(src)))
    if proc.returncode == 0:
        return proc.stdout
    err = (proc.stderr or proc.stdout or "").strip()
    matched = _OCR_RE.search(err)
    if matched or "OCR is required" in err:
        pdf_type = matched.group(1) if matched else ""
        pages = int(matched.group(2)) if matched else 0
        raise NeedsOcrError(err or "扫描件需 OCR", pdf_type=pdf_type, pages=pages)
    raise AnydocError(err or f"anydoc 退出码 {proc.returncode}")


def main() -> int:
    ap = argparse.ArgumentParser(description="用 anydoc 把文档转成 Markdown（调试用）")
    ap.add_argument("src", type=Path, help="源文件")
    args = ap.parse_args()
    if not args.src.is_file():
        print(f"找不到文件：{args.src}", file=sys.stderr)
        return 2
    try:
        sys.stdout.write(to_markdown(args.src))
    except NeedsOcrError as exc:
        extra = f"（{exc.pdf_type}，{exc.pages} 页）" if exc.pdf_type or exc.pages else ""
        print(f"扫描件需 OCR{extra}：{exc}", file=sys.stderr)
        return 1
    except AnydocError as exc:
        print(exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
