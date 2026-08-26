#!/usr/bin/env python3
"""读工作空间根目录的 .env —— anydoc.py 与 mineru.py 共用一份。

为什么值得单独一个模块：这段代码原本长在 mineru.py 里，只有「问 MinerU 要 key」时
才会跑到。而 ingest.py 判定引擎的顺序是**先问 anydoc、再问 mineru**，轮到 anydoc 那一步
.env 还没被读进来 —— 用户在 .env 里写的 ANYDOC_BIN 配了等于没配，而且不报错，
只是安静地退回 MinerU（唯一会把文件传出去的那条路）。
放到两边都能先调到的地方，这个先后顺序就不再是个坑。

只依赖标准库。
"""

from __future__ import annotations

import os
from pathlib import Path


def load_dotenv(path: Path | None = None) -> None:
    """把仓库根目录 .env 里的变量读进 os.environ。已存在的环境变量优先，不覆盖。

    不覆盖是有意的：看板 spawn 脚本时会注入 ANYDOC_BIN，那份指向的是看板自带、
    与发布包锁死同一版本的 cli.js，不该被工作空间里一行陈年配置顶掉。
    """
    path = path or Path(__file__).resolve().parent.parent / ".env"
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value
