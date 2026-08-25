#!/usr/bin/env python3
"""`input/` 的共用约定——`ingest.py` / `pointtable.py` / `realdata.py` 共用一份。

两件事：**哪些资料进转换链路**（`.ingestignore` 忽略清单，见文件末尾）和
**产物落到哪儿**（下面这套镜像规则）。三个脚本各写一套的话，
「点表脚本把被忽略的目录也扫了一遍」这类不一致会反复出现。

为什么要有这个模块
------------------
转换产物早先是一股脑平铺在 `input/converted/` 根下的。资料上千份以后，那个目录既看不出
哪份产物对应 raw 里的哪批资料，也没法按批次删除（客户重发一版站点数据，你得挨个认名字）。
现在**产物目录与 `input/raw/` 一一对齐**，删 `converted/站点数据/0_公共/` 就等于删掉那批资料
的全部产物，不留残渣。

三条规则
--------
1. **镜像**：产物落在 `converted/<源文件在 raw 下的相对目录>/`。

       input/raw/站点数据/0_公共/六大库汛限（正常高）水位.docx
         → input/converted/站点数据/0_公共/六大库汛限(正常高)水位.md

2. **一源多产物**：正文收进镜像目录下的 `SplittingObject/<文件名>/`，摘要
   `_manifest_<文件名>.md` 留在镜像目录里（看板预览点它）。

       input/raw/站点数据/0_公共/7大库闸门底坎库容.xlsx
         → input/converted/站点数据/0_公共/_manifest_7大库闸门底坎库容.md
         → input/converted/站点数据/0_公共/SplittingObject/7大库闸门底坎库容/Sheet1.csv

3. **整目录合并成一份产物**（点表、现场数据这类几百个同构文件汇总成一个库）：正文收进
   `MergedObject/`，摘要 `_manifest_<目录名>批量处理.md`。同一目录里的普通文件不受影响，
   仍按规则 1 / 2 各走各的。

       input/raw/集控点表/（11 个厂站目录）
         → input/converted/集控点表/_manifest_集控点表批量处理.md
         → input/converted/集控点表/MergedObject/测点.sqlite
       input/raw/集控点表/南瑞-水调系统测点.xlsx        ← 同目录的普通表格，走规则 2
         → input/converted/集控点表/_manifest_南瑞-水调系统测点.md
         → input/converted/集控点表/SplittingObject/南瑞-水调系统测点/*.csv

摘要的 frontmatter 里必须写 `payload:`（正文目录，相对摘要自己所在目录），
`ingest.py` 靠它判断产物完不完整，看板靠它把摘要和正文认成同一份产物。
"""

from __future__ import annotations

import os
import re
import unicodedata
from pathlib import Path, PurePosixPath

REPO = Path(__file__).resolve().parent.parent
RAW = REPO / "input" / "raw"
CONVERTED = REPO / "input" / "converted"
# 忽略清单：不进转换、也不在看板上算「待转换」的资料。gitignore 风格，看板同读这一份
IGNOREFILE = REPO / "input" / ".ingestignore"

# 一源多产物：正文收在镜像目录下的这一层
SPLIT_DIR = "SplittingObject"
# 整目录合并成一份产物：正文收在镜像目录下的这一层
MERGE_DIR = "MergedObject"
# 合并型产物的摘要名后缀，跟同名普通文件的摘要区分开
MERGE_SUFFIX = "批量处理"


def safe_component(name: str) -> str:
    """文件 / 目录名 → 落盘安全的名字。

    **尽量保留原名**：下划线、括号、连字符、中文标点都留着，只压掉路径分隔符和控制字符。
    镜像目录要能一眼对回 `input/raw/` 里那份原件，名字改得越少越好。
    """
    name = unicodedata.normalize("NFKC", name)
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "-", name)
    name = re.sub(r"\s+", " ", name).strip()
    name = name.strip(". ")
    return name or "untitled"


def mirror_of(path: Path) -> Path:
    """`input/raw/` 下的一个目录 → `input/converted/` 下与之同构的目录。

    不在 `input/raw/` 下的路径（手工指定了别处的文件）退回 converted/ 根，不猜。
    """
    try:
        rel = path.resolve().relative_to(RAW)
    except ValueError:
        return CONVERTED
    return CONVERTED.joinpath(*(safe_component(part) for part in rel.parts))


def mirror_dir(src: Path) -> Path:
    """源**文件** → 它的产物该落在哪个镜像目录。"""
    return mirror_of(src.parent)


def single_target(src: Path, suffix: str) -> Path:
    """单产物源文件的落点：镜像目录下的同名文件。"""
    return mirror_dir(src) / f"{safe_component(src.stem)}{suffix}"


def split_paths(src: Path) -> tuple[Path, Path]:
    """一源多产物：→ (摘要 `_manifest_<名>.md`, 正文目录 `SplittingObject/<名>/`)。"""
    base = mirror_dir(src)
    name = safe_component(src.stem)
    return base / f"_manifest_{name}.md", base / SPLIT_DIR / name


def merge_paths(src_dir: Path) -> tuple[Path, Path]:
    """整目录合并：→ (摘要 `_manifest_<目录名>批量处理.md`, 正文目录 `MergedObject/`)。"""
    base = mirror_of(src_dir)
    name = safe_component(src_dir.name)
    return base / f"_manifest_{name}{MERGE_SUFFIX}.md", base / MERGE_DIR


def rel_path(target: Path, start: Path) -> str:
    """target 相对 start 目录的 posix 路径。跨深度的相对链接靠它算，不要手拼 `../`。"""
    return Path(os.path.relpath(target, start)).as_posix()


def md_link(path_str: str) -> str:
    """markdown 链接里的路径。只转义会打断链接语法的字符，中文原样留着——可读性优先。"""
    return (path_str.replace("%", "%25").replace(" ", "%20")
            .replace("(", "%28").replace(")", "%29"))


def repo_rel(path: Path) -> str:
    """相对仓库根的 posix 路径，用于写进 frontmatter 和日志。"""
    return path.relative_to(REPO).as_posix() if path.is_relative_to(REPO) else str(path)


# --------------------------------------------------------------------------- #
# 忽略清单
#
# 客户常常一次性交来上千份存量资料，只有一部分该进分析链路。剩下的既不该转，也不该在
# 看板上一直报「待转换」把真正的缺口淹掉——写进 `input/.ingestignore`，三个转换脚本和
# 看板 `src/server/scan.mjs` 读的是同一份。
# --------------------------------------------------------------------------- #

def load_ignore(extra: list[str] | None = None) -> list[str]:
    """读 input/.ingestignore。gitignore 风格：一行一个模式，# 开头是注释，空行忽略。

    看板 src/server/scan.mjs 读的是同一份文件，两边规则必须一致，改这里记得同步那边。
    """
    patterns = []
    if IGNOREFILE.exists():
        for line in IGNOREFILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                patterns.append(line.rstrip("/"))
    patterns.extend(p.strip().rstrip("/") for p in (extra or []) if p.strip())
    return patterns


def is_ignored(path: Path, patterns: list[str]) -> bool:
    """相对 input/ 的路径匹配上任一模式就忽略。

    给目录也成立（目录模式命中它自己和其下所有文件），自动发现时可以据此**整个目录跳过**，
    不必走进去挨个探测——上千份存量资料逐个读文件头要花好几分钟。
    """
    if not patterns:
        return False
    try:
        rel = path.resolve().relative_to(RAW.parent).as_posix()
    except ValueError:
        return False
    for pat in patterns:
        # 目录前缀命中（写 raw/客户版 就等于 raw/客户版 及其下所有文件）
        if rel == pat or rel.startswith(pat + "/"):
            return True
        # 通配符：整路径匹配，或只对文件名匹配（写 *.bak 不必带路径）
        if PurePosixPath(rel).match(pat) or PurePosixPath(path.name).match(pat):
            return True
    return False


def add_ignore_flags(ap) -> None:
    """给 argparse 装上三个脚本通用的忽略清单开关。"""
    ap.add_argument("--ignore", action="append", metavar="模式", default=[],
                    help="临时追加忽略模式（可多次）。常驻规则写进 input/.ingestignore")
    ap.add_argument("--no-ignore", action="store_true",
                    help="本次不应用 input/.ingestignore，把被忽略的也一起处理")


def ignore_patterns(args) -> list[str]:
    """按 --ignore / --no-ignore 解析出本次生效的忽略模式。"""
    return [] if getattr(args, "no_ignore", False) else load_ignore(getattr(args, "ignore", None))
