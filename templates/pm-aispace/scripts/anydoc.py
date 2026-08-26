#!/usr/bin/env python3
"""anydoc 本地转换客户端：把 PDF / PPTX 抽成 Markdown，不联网。

为什么单独一个模块：ingest.py 里其它转换都是「调一个 CLI、拿 stdout」，
anydoc 多了两件自己的事，混进去会把主流程撑乱——

1. **找二进制**：见 find_bin() 的四级查找链。不 fallback 到 npx——npx 首次会联网下载，
   正好把「本地、不外发」请回去。
2. **识别扫描件**：anydoc 不做 OCR，报错串里自带类型和页数，ingest.py 靠这个
   决定要不要升级 MinerU。

只依赖标准库。Windows 上必须显式 encoding="utf-8"，不能只写 text=True，
否则跟系统 locale 走，中文正文当场炸（和 ingest.py 顶上的 reconfigure 同一个坑）。

单独当命令用（调试时方便）：
    python3 scripts/anydoc.py 某文件.pdf
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from envfile import load_dotenv  # 与本脚本同目录；mineru.py 也用同一份

ENV_BIN = "ANYDOC_BIN"
# 看板每次启动写在这里，记着它自带的那份 anydoc 在哪。
# 让「终端里跑脚本」和「看板点转换」用同一个二进制，用户什么都不用配。
RUNTIME_FILE = Path.home() / ".pmwork" / "dashboard" / "runtime.json"

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


def _runtime_info() -> dict:
    """看板配置目录里那份运行时信息。读不到 / 坏了都当空，静默跳过。"""
    try:
        info = json.loads(RUNTIME_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return info if isinstance(info, dict) else {}


def _runtime_path(key: str) -> str | None:
    """runtime.json 里的一个路径字段，校验文件还在才认。

    必须校验：看板升级、npx 缓存被清之后这些路径就是死的，
    认下来只会让每个文件都报一遍「找不到」，不如往下退回 PATH。
    """
    candidate = str(_runtime_info().get(key) or "").strip()
    return candidate if candidate and Path(candidate).is_file() else None


def find_bin() -> str | None:
    """按四级查找链找 anydoc。不走 npx。

        ① ANYDOC_BIN 环境变量  —— 看板 spawn 时注入的，最权威
        ② 工作空间根目录 .env  —— 用户显式覆盖（CI、特殊机器）
        ③ 看板配置目录 runtime.json —— 零配置的常规路径：终端里跑脚本时用的
           就是看板自带那份，两条触发路径结果一致
        ④ PATH 上的 anydoc     —— 用户自己 npm i -g 的

    ② 必须自己调 load_dotenv：agent 在终端里跑 ingest.py 时没有看板注入，
    而 ingest.py 判定引擎是**先问 anydoc 再问 mineru**——.env 从前只由 mineru 那边
    顺带读入，轮到这里时还是空的，用户写在 .env 里的 ANYDOC_BIN 会被安静地无视。
    """
    load_dotenv()
    env = (os.environ.get(ENV_BIN) or "").strip()
    if env:
        # 即便路径不存在也认：显式配的就该报人话，不悄悄退回别处
        return env
    return _runtime_path("anydocBin") or shutil.which("anydoc")


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
        # PATH 上的 node 优先；退回看板记下的那个——agent 的非交互 shell 里
        # nvm / volta 装的 node 常常不在 PATH 上，那时 cli.js 根本起不来
        node = shutil.which("node") or _runtime_path("node") or "node"
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
