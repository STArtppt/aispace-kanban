"""找 pandoc、调 pandoc。

查找顺序：`PANDOC_BIN` 环境变量 → 工作空间 `.env` 的 `PANDOC_BIN` → `PATH`，要求主版本 ≥ 3
（3.x 之前题注、表格的样式名不一样）。看板服务端 src/server/platform.mjs 的 findPandoc 是同一顺序，改一边要改另一边。

md → docx 需要 pandoc：模板样式的继承、列表、脚注、代码高亮、图片都靠它的 docx writer。
提炼模板不需要 pandoc，缺了只是跳过样张。
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

MIN_MAJOR = 3
INSTALL_HINT = ("请安装 pandoc 3 以上：macOS 用 `brew install pandoc`，Windows 用 `winget install JohnMacFarlane.Pandoc`，"
                "Linux 从 https://github.com/jgm/pandoc/releases 下载；装在非标准位置时在工作空间 .env 里写 PANDOC_BIN=<路径>")


class PandocMissing(RuntimeError):
    pass


def _env_file_value(ws: Path, key: str) -> str | None:
    """只从 .env 里取这一个键，不把整份 .env 读进环境变量（别的脚本对 .env 有自己的约定）。"""
    p = ws / ".env"
    try:
        lines = p.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    for line in lines:
        line = line.strip()
        if line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        if k.strip() == key:
            return v.strip().strip("'\"") or None
    return None


def version_of(bin_: str) -> str | None:
    try:
        out = subprocess.run([bin_, "--version"], capture_output=True, text=True, timeout=15,
                             encoding="utf-8", errors="replace").stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.match(r"pandoc(?:\.exe)?\s+(\d+(?:\.\d+)*)", out.strip())
    return m.group(1) if m else None


def find_pandoc(ws: Path) -> tuple[str, str]:
    """返回 (可执行文件, 版本)；找不到或版本过低抛 PandocMissing（带中文出路）。"""
    candidates = [os.environ.get("PANDOC_BIN"), _env_file_value(ws, "PANDOC_BIN"), shutil.which("pandoc")]
    too_old = None
    for c in candidates:
        if not c:
            continue
        v = version_of(c)
        if not v:
            continue
        if int(v.split(".")[0]) >= MIN_MAJOR:
            return c, v
        too_old = (c, v)
    if too_old:
        raise PandocMissing(f"pandoc 版本过低（{too_old[1]}），需要 3 以上。{INSTALL_HINT}")
    raise PandocMissing(f"未找到 pandoc。{INSTALL_HINT}")


def default_reference(bin_: str) -> bytes:
    """pandoc 自带的 reference.docx，「通用规范」拿它当底。"""
    r = subprocess.run([bin_, "--print-default-data-file", "reference.docx"], capture_output=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError("pandoc 取默认参照模板失败：" + r.stderr.decode("utf-8", "replace").strip())
    return r.stdout


MISSING_RE = re.compile(r"Could not (?:fetch|find) (?:resource|image) '?([^'\n]+?)'?(?::|$)", re.M)


def md_to_docx(bin_: str, md: Path, reference: Path, out: Path, timeout: int = 110) -> list[str]:
    """把 md 转成 docx 写到 out（调用方给的临时路径）。返回 warnings（缺图等）。

    以 .md 所在目录为资源路径，`![](../assets/a.png)` 这种相对路径才找得到图。
    `east_asian_line_breaks`：中文段落里的换行不插空格。
    """
    cmd = [bin_, str(md.name), "-f", "markdown+east_asian_line_breaks", "-t", "docx",
           "--reference-doc", str(reference), "--resource-path", str(md.parent), "-o", str(out)]
    r = subprocess.run(cmd, cwd=str(md.parent), capture_output=True, timeout=timeout,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError("pandoc 转换失败：" + (r.stderr.strip() or f"退出码 {r.returncode}")[:800])
    warnings = []
    for m in MISSING_RE.finditer(r.stderr):
        warnings.append(f"缺少图片：{m.group(1).strip()}（成品里以图片说明文字代替）")
    for line in r.stderr.splitlines():
        if "[WARNING]" in line and "Could not" not in line:
            warnings.append("pandoc 提示：" + line.replace("[WARNING]", "").strip())
    return warnings
