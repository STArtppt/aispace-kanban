#!/usr/bin/env python3
"""把网页转成 Markdown，落进 `input/converted/`。

正文提取调 `defuddle` CLI，**输入是本地 HTML 文件**而不是 URL ——
defuddle 自己去抓只能拿到初始 HTML，SPA 站点会变成空壳。

两种入口
--------
1. **URL 模式** `web_ingest.py <URL>`
   该 URL 已有 `visualization/references/<slug>/index.html` 就复用它；
   没有就 spawn `single-file` 抓到临时目录，提取完即弃。
   **不向 `visualization/` 写任何文件** —— 公开页的页面快照走看板贴 URL 采集。

2. **收件箱模式** `web_ingest.py --inbox`
   扫描 `visualization/references/` **根上**的散装 `.html` / `.htm`，
   收成一份标准参考（子目录 + `index.html` + `meta.json`，`source: manual`），
   再对尚未有对应 Markdown（或正文摘要已变）的参考抽出正文。
   已有参考目录不覆盖、不改名、不删。看板参考 tab 的刷新走的就是这一条。

`single-file` 是 AGPL-3.0，只 spawn、永不 import（理由见看板仓 `src/server/capture.mjs` 开头）。

落点、`_manifest_` 命名、忽略清单解析全部复用 [`layout.py`](layout.py)，不另起一套。
网页是一源一产物，所以走 `single_target`：`input/converted/web/<host>/<标题>.md`。
虚拟的 `input/raw/web/...` 路径只用来算落点，**不会往 raw/ 写任何东西**。
没有 URL 时 host 用 `dropped`，标题用参考 slug。

正文里的 `data:image`（SingleFile / defuddle 常把整张图内联成几 MB 的 base64）
抽到 `input/assets/<标题>/`，markdown 改成相对产物目录的 `![](...)`。
这和 docx 抽图同一套落点；不抽的话看板点开预览会把几 MB 字符串塞进 markdown 管线。

front-matter 字段名沿用既有转换脚本：`source` / `source_sha256` / `converted_by` / `converted_at`。
`source` 能读到 `http`/`https` 就记这个地址（**含 fragment**，SPA 路由经常在 hash 里）；
读不到就记参考路径。摘要值记**提取出的正文**（不是整页 HTML）。
正文取自参考目录时再记一条 `reference:`，指向该目录。

同一来源重跑且正文摘要一致则跳过。内容已变时**不静默覆盖**，要 `--overwrite` 或 `--as-new`。
收件箱批量下，正文已变的那一份跳过并说明，不连坐其它份。

用法
----
    python3 scripts/web_ingest.py <URL>
    python3 scripts/web_ingest.py <URL> --overwrite   # 正文已变时覆盖旧产物
    python3 scripts/web_ingest.py <URL> --as-new      # 正文已变时另存一份
    python3 scripts/web_ingest.py --inbox             # 收根上散装页面并抽出正文
    python3 scripts/web_ingest.py --inbox --overwrite # 收件箱模式下覆盖已变产物

退出码：0 = 完成或幂等跳过；1 = 抓取/提取失败或（URL 模式）内容已变但没给覆盖参数；2 = 用法/依赖缺失。
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlparse, urlunparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from layout import (  # noqa: E402
    RAW,
    add_ignore_flags,
    ignore_patterns,
    is_ignored,
    md_link,
    rel_path,
    repo_rel,
    safe_component,
    single_target,
)
from questions_fm import parse_frontmatter  # noqa: E402

HERE = Path(__file__).resolve().parent
WS = HERE.parent
REF_ROOT = WS / "visualization" / "references"
CONVERTED = WS / "input" / "converted"
ASSETS = WS / "input" / "assets"

EXT_BY_MIME = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
    "image/svg+xml": ".svg",
    "image/x-icon": ".ico",
    "image/vnd.microsoft.icon": ".ico",
}

DATA_IMAGE_HEADER = re.compile(
    r"data:(image/[a-zA-Z0-9.+-]+)((?:;[a-zA-Z0-9.+-]+=[^;,]+)*)?(;base64)?,",
    re.I,
)

DEFUDDLE_INSTALL = "npm install -g defuddle"
SINGLE_FILE_INSTALL = "npm i -g single-file-cli"
MISSING_DEFUDDLE = (
    "本机 PATH 上找不到 defuddle 命令。网页正文提取靠它，缺了没法转换。装一次即可：\n"
    + DEFUDDLE_INSTALL
)
MISSING_SINGLE_FILE = (
    "本机 PATH 上找不到 single-file 命令。这份 URL 还没有现成的参考页可复用，"
    "取页靠它。装一次即可：\n"
    + SINGLE_FILE_INSTALL
)

SINGLE_FILE_TIMEOUT = 120
DEFUDDLE_TIMEOUT = 60
MAX_HTML_BYTES = 64 * 1024 * 1024

WIKILINK_RE = re.compile(r"!?\[\[([^\]]+)\]\]")
CALLOUT_RE = re.compile(r"^>(\s*)\[![\w-]+\][^\n]*", re.M)
TAG_RE = re.compile(r"^#[^#\s].*$", re.M)
COMMENT_RE = re.compile(r"%%.*?%%", re.S)
BLOCK_ID_RE = re.compile(r"(?:^|\s)\^[A-Za-z0-9_-]+\s*$", re.M)
MATH_RE = re.compile(r"\${1,2}([^$\n]+)\${1,2}")
H1_RE = re.compile(r"^(#)\s+\S")
FENCE_RE = re.compile(r"^(\s*)(`{3,}|~{3,})")
HTML_COMMENT_RE = re.compile(r"<!--(.*?)-->", re.S)
URL_COMMENT_RE = re.compile(r"(?im)^\s*url:\s*(\S+)")
SAVED_DATE_RE = re.compile(r"(?im)^\s*saved date:\s*(.+)$")
JS_DATE_RE = re.compile(
    r"^[A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT([+-]\d{4})"
)


def die(msg: str, code: int = 1) -> int:
    print(msg, file=sys.stderr)
    return code


def normalize_url(url: str) -> str:
    """规范化 http(s) URL。保留 fragment：SPA 的路由经常在 hash 里。"""
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError(f"只接受 http/https URL，收到的是：{url}")
    path = parsed.path.rstrip("/") or "/"
    return urlunparse((parsed.scheme, parsed.netloc.lower(), path, "", parsed.query, parsed.fragment))


def http_url_or_empty(value: str) -> str:
    try:
        return normalize_url(value)
    except ValueError:
        return ""


def which(name: str) -> str | None:
    return shutil.which(name)


def sources_equal(left: str, right: str) -> bool:
    try:
        return normalize_url(left) == normalize_url(right)
    except ValueError:
        return left == right


def find_reference(url: str) -> Path | None:
    if not REF_ROOT.is_dir():
        return None
    want = normalize_url(url)
    for meta_path in sorted(REF_ROOT.glob("*/meta.json")):
        try:
            data = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        if not isinstance(data, dict):
            continue
        src = data.get("sourceUrl")
        if not isinstance(src, str) or not src.strip():
            continue
        try:
            same = normalize_url(src) == want
        except ValueError:
            continue
        if not same:
            continue
        index = meta_path.parent / "index.html"
        if index.is_file():
            return meta_path.parent
    return None


def find_existing_products(source: str) -> list[Path]:
    if not CONVERTED.is_dir():
        return []
    hits = []
    for path in CONVERTED.rglob("*.md"):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        meta, _body, raw = parse_frontmatter(text)
        if not raw:
            continue
        src = meta.get("source")
        if not isinstance(src, str):
            continue
        if sources_equal(src, source):
            hits.append(path)
    return sorted(hits)


def run_single_file(url: str, output: Path) -> None:
    """spawn single-file；退出码 0 但没产物时重试一次（SPA 水合竞态，照搬 capture.mjs）。"""
    last_err: Exception | None = None
    for _attempt in range(2):
        try:
            proc = subprocess.run(
                ["single-file", "--filename-conflict-action=overwrite", url, str(output)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=SINGLE_FILE_TIMEOUT,
                check=False,
            )
        except FileNotFoundError:
            raise RuntimeError("MISSING_SINGLE_FILE") from None
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(
                f"抓取超时：single-file 跑了 {SINGLE_FILE_TIMEOUT} 秒还没结束。"
            ) from exc
        if proc.returncode != 0:
            detail = (proc.stderr or b"").decode("utf-8", "replace").strip()
            last_err = RuntimeError(detail or f"single-file 以退出码 {proc.returncode} 结束")
            continue
        try:
            size = output.stat().st_size
        except OSError:
            last_err = RuntimeError("single-file 跑完了但没有产出文件（目标页可能没加载起来）")
            continue
        if size > MAX_HTML_BYTES:
            raise RuntimeError(
                f"抓下来的页面有 {size / 1024 / 1024:.1f} MB，超过 "
                f"{MAX_HTML_BYTES / 1024 / 1024:.0f} MB 上限，没有写入工作空间。"
                "这种体积通常意味着页面里嵌了大量视频或大图。"
            )
        if size == 0:
            last_err = RuntimeError("single-file 产出了空文件，不像一份网页")
            continue
        return
    raise last_err or RuntimeError("single-file 没有产出文件")


def run_defuddle(html_path: Path) -> tuple[str, str]:
    """返回 (title, markdown)。输入必须是本地文件。"""
    try:
        proc = subprocess.run(
            ["defuddle", "parse", str(html_path), "--markdown", "--json"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=DEFUDDLE_TIMEOUT,
            check=False,
        )
    except FileNotFoundError:
        raise RuntimeError("MISSING_DEFUDDLE") from None
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"提取超时：defuddle 跑了 {DEFUDDLE_TIMEOUT} 秒还没结束。") from exc
    if proc.returncode != 0:
        detail = (proc.stderr or b"").decode("utf-8", "replace").strip()
        raise RuntimeError(detail or f"defuddle 以退出码 {proc.returncode} 结束")
    raw = (proc.stdout or b"").decode("utf-8", "replace")
    title, markdown = _parse_defuddle_output(raw)
    if not markdown.strip():
        raise RuntimeError("defuddle 没有抽出正文。这份 HTML 可能不是网页，或正文全靠前端渲染却没抓到。")
    return title, markdown


def _parse_defuddle_output(raw: str) -> tuple[str, str]:
    text = raw.strip()
    if not text:
        return "", ""
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return "", text
    if not isinstance(data, dict):
        return "", text
    title = ""
    for key in ("title", "Title"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            title = value.strip()
            break
    markdown = ""
    for key in ("markdown", "content", "contentMarkdown"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            markdown = value
            break
    return title, markdown


def html_title(html_path: Path) -> str:
    try:
        head = html_path.read_text(encoding="utf-8", errors="replace")[:8000]
    except OSError:
        return ""
    m = re.search(r"<title[^>]*>([^<]*)</title>", head, re.I)
    return m.group(1).strip() if m else ""


def parse_saved_date(raw: str) -> str:
    text = raw.strip()
    if not text:
        return ""
    try:
        from email.utils import parsedate_to_datetime
        return parsedate_to_datetime(text).astimezone().isoformat(timespec="seconds")
    except (TypeError, ValueError, OverflowError):
        pass
    if JS_DATE_RE.match(text):
        core = text.split(" (")[0].replace("GMT", "", 1).strip()
        try:
            return dt.datetime.strptime(core, "%a %b %d %Y %H:%M:%S %z").isoformat(timespec="seconds")
        except ValueError:
            pass
    return ""


def parse_page_comment(html_path: Path) -> dict[str, str]:
    """从 SingleFile 页头注释抽出 url / saved date。不是合法 http(s) 的地址丢弃。"""
    try:
        head = html_path.read_text(encoding="utf-8", errors="replace")[:8000]
    except OSError:
        return {}
    comments = HTML_COMMENT_RE.findall(head)
    blob = "\n".join(comments) if comments else head
    out: dict[str, str] = {}
    url_m = URL_COMMENT_RE.search(blob)
    if url_m:
        url = http_url_or_empty(url_m.group(1).strip().strip("\"'"))
        if url:
            out["url"] = url
    date_m = SAVED_DATE_RE.search(blob)
    if date_m:
        saved = parse_saved_date(date_m.group(1))
        if saved:
            out["saved"] = saved
    return out


def file_mtime_iso(path: Path) -> str:
    try:
        return dt.datetime.fromtimestamp(path.stat().st_mtime).astimezone().isoformat(timespec="seconds")
    except OSError:
        return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def slugify(title: str, url: str = "") -> str:
    """对齐 capture.mjs：保留中文，去掉路径分隔符与控制字符。"""
    base = (title or "").strip()
    if not base and url:
        parsed = urlparse(url)
        host = parsed.hostname or ""
        base = f"{host}{parsed.path}".rstrip("/")
    safe = re.sub(r"[\u0000-\u001f\u007f]", "", base)
    safe = re.sub(r'[\\/:*?"<>|]', "-", safe)
    safe = re.sub(r"\s+", "-", safe)
    safe = re.sub(r"-{2,}", "-", safe)
    safe = re.sub(r"^[.\-]+|[.\-]+$", "", safe)[:60]
    return safe


def unique_slug(base: str) -> str:
    name = base or "dropped"
    if not (REF_ROOT / name).exists():
        return name
    n = 2
    while True:
        candidate = f"{name}-{n}"
        if not (REF_ROOT / candidate).exists():
            return candidate
        n += 1


def _scan_base64_payload(source: str, from_idx: int) -> int:
    i = from_idx
    n = len(source)
    while i < n:
        c = source[i]
        if (
            ("A" <= c <= "Z")
            or ("a" <= c <= "z")
            or ("0" <= c <= "9")
            or c in "+/=\n\r\t "
        ):
            i += 1
            continue
        break
    return i


def _scan_delimited_payload(source: str, from_idx: int) -> int:
    i = from_idx
    n = len(source)
    while i < n and source[i] not in ')"\'> \n\r\t<':
        i += 1
    return i


def _decode_data_image(mime: str, payload: str, is_base64: bool) -> bytes | None:
    try:
        if is_base64:
            compact = re.sub(r"\s+", "", payload)
            pad = (-len(compact)) % 4
            return base64.b64decode(compact + ("=" * pad))
        return unquote(payload).encode("utf-8")
    except (ValueError, UnicodeError):
        return None


def _image_ext(mime: str) -> str:
    return EXT_BY_MIME.get(mime.lower().split(";", 1)[0].strip(), ".bin")


def _image_stem(markdown: str, uri_start: int, fallback: str) -> str:
    window = markdown[max(0, uri_start - 200) : uri_start]
    alt = re.search(r"!\[([^\]]{1,80})\]\($", window)
    if alt and alt.group(1).strip():
        return safe_component(alt.group(1).strip())[:60]
    html_alt = re.search(r'alt="([^"]{1,80})"[^>]*src=["\']?$', window, re.I)
    if html_alt and html_alt.group(1).strip():
        return safe_component(html_alt.group(1).strip())[:60]
    return fallback


def extract_inline_images(markdown: str, link_prefix: str) -> tuple[str, list[tuple[str, bytes]]]:
    """把 `data:image` 抽成文件名 + 字节，markdown 改成相对产物目录的链接。

    不落盘：调用方在确定要写产物之后再写 `input/assets/<标题>/`。
    同一份正文里相同字节只留一个文件。
    """
    matches: list[tuple[int, int, str, bytes]] = []
    pos = 0
    while True:
        header = DATA_IMAGE_HEADER.search(markdown, pos)
        if not header:
            break
        start = header.start()
        payload_start = header.end()
        is_base64 = bool(header.group(3))
        end = (
            _scan_base64_payload(markdown, payload_start)
            if is_base64
            else _scan_delimited_payload(markdown, payload_start)
        )
        blob = _decode_data_image(header.group(1), markdown[payload_start:end], is_base64)
        pos = end
        if not blob:
            continue
        matches.append((start, end, header.group(1), blob))

    if not matches:
        return markdown, []

    files: list[tuple[str, bytes]] = []
    digest_to_name: dict[str, str] = {}
    used_names: set[str] = set()
    replacements: list[tuple[int, int, str]] = []
    n = 0
    for start, end, mime, blob in matches:
        digest = hashlib.sha256(blob).hexdigest()
        name = digest_to_name.get(digest)
        if name is None:
            n += 1
            stem = _image_stem(markdown, start, f"image{n}")
            ext = _image_ext(mime)
            name = f"{stem}{ext}"
            if name in used_names:
                k = 2
                while f"{stem}-{k}{ext}" in used_names:
                    k += 1
                name = f"{stem}-{k}{ext}"
            used_names.add(name)
            digest_to_name[digest] = name
            files.append((name, blob))
        replacements.append((start, end, name))

    out: list[str] = []
    cursor = 0
    for start, end, name in replacements:
        out.append(markdown[cursor:start])
        out.append(f"{link_prefix}{md_link(name)}")
        cursor = end
    out.append(markdown[cursor:])
    return "".join(out), files


def sanitize_markdown(md: str) -> str:
    """剥除或规整提取结果里的禁用语法，并把多余 H1 降一层。围栏代码块原样保留。"""
    lines: list[str] = []
    in_fence = False
    fence_mark = ""
    h1_seen = 0
    for line in md.split("\n"):
        fence = FENCE_RE.match(line)
        if fence:
            mark = fence.group(2)[0]
            token = mark * len(fence.group(2))
            if not in_fence:
                in_fence = True
                fence_mark = token
                lines.append(line)
                continue
            if line.strip().startswith(fence_mark):
                in_fence = False
                fence_mark = ""
            lines.append(line)
            continue
        if in_fence:
            lines.append(line)
            continue
        if H1_RE.match(line):
            h1_seen += 1
            if h1_seen > 1:
                line = "#" + line
        line = COMMENT_RE.sub("", line)
        line = WIKILINK_RE.sub(lambda m: m.group(1).split("|")[-1].strip(), line)
        line = CALLOUT_RE.sub(">", line)
        if TAG_RE.match(line):
            line = line.lstrip("#")
        line = BLOCK_ID_RE.sub("", line)
        line = MATH_RE.sub(lambda m: m.group(1).strip(), line)
        lines.append(line)
    return "\n".join(lines).strip() + "\n"


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def dump_frontmatter(meta: dict[str, str]) -> str:
    lines = ["---"]
    for key, value in meta.items():
        lines.append(f"{key}: {value}" if value else f"{key}:")
    lines += ["---", ""]
    return "\n".join(lines)


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def virtual_raw(source: str, title: str) -> Path:
    host = "dropped"
    try:
        parsed = urlparse(source)
        if parsed.scheme in ("http", "https") and parsed.netloc:
            host = safe_component(parsed.netloc) or "web"
    except ValueError:
        pass
    name = safe_component(title) or "untitled"
    return RAW / "web" / host / f"{name}.html"


def unique_target(base: Path) -> Path:
    if not base.exists():
        return base
    stem, suffix = base.stem, base.suffix
    n = 2
    while True:
        candidate = base.with_name(f"{stem}-{n}{suffix}")
        if not candidate.exists():
            return candidate
        n += 1


def read_digest(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""
    meta, _body, raw = parse_frontmatter(text)
    if not raw:
        return ""
    value = meta.get("source_sha256")
    return value.strip() if isinstance(value, str) else ""


def render(meta: dict[str, str], body: str) -> str:
    return dump_frontmatter(meta) + body.lstrip("\n")


def ensure_html_size(html_path: Path) -> None:
    try:
        size = html_path.stat().st_size
    except OSError as exc:
        raise RuntimeError(f"读不到 HTML：{exc}") from exc
    if size == 0:
        raise RuntimeError("这份 HTML 是空文件，不像一份网页")
    if size > MAX_HTML_BYTES:
        raise RuntimeError(
            f"这份页面有 {size / 1024 / 1024:.1f} MB，超过 "
            f"{MAX_HTML_BYTES / 1024 / 1024:.0f} MB 上限，没有提取。"
        )


def convert_html(
    html_path: Path,
    source: str,
    *,
    ref_dir: Path | None,
    overwrite: bool,
    as_new: bool,
    patterns: list[str],
    skip_changed: bool,
    title_fallback: str = "",
) -> str:
    """抽出正文并落盘。返回人话状态（已写入 / 跳过）。硬失败抛 RuntimeError。

    skip_changed=True（收件箱）：正文已变且没给覆盖参数时跳过这一份，不抛。
    skip_changed=False（URL 模式）：同样情况抛 RuntimeError，由调用方变成退出码 1。
    """
    ensure_html_size(html_path)
    title, markdown = run_defuddle(html_path)
    title = title or html_title(html_path) or title_fallback
    if not title:
        parsed = urlparse(source)
        title = parsed.path.rsplit("/", 1)[-1] or parsed.netloc or (ref_dir.name if ref_dir else "untitled")
    # defuddle 常把 H1 抽到 title 字段、正文从 H2 起；补回唯一 H1，和写法子集对齐。
    if title and not re.search(r"^#\s+\S", markdown, re.M):
        markdown = f"# {title}\n\n{markdown.lstrip()}"
    body = sanitize_markdown(markdown)
    if not body.strip():
        raise RuntimeError("规整之后正文是空的，没有写入。")

    fake_raw = virtual_raw(source, title)
    if is_ignored(fake_raw, patterns):
        raise RuntimeError(
            f"按 input/.ingestignore，`{repo_rel(fake_raw)}` 会被忽略，本次不写产物。"
            "这条网页资料如果确实要进分析链路，从忽略清单里拿掉对应规则。"
        )

    planned = single_target(fake_raw, ".md")
    img_dir = ASSETS / safe_component(title)
    link_prefix = md_link(f"{rel_path(img_dir, planned.parent)}/")
    if not link_prefix.endswith("/"):
        link_prefix += "/"
    body, images = extract_inline_images(body, link_prefix)
    digest = sha256_text(body)

    existing = find_existing_products(source)
    upgrade_inline = False
    if existing:
        same = [p for p in existing if read_digest(p) == digest]
        if same and not as_new:
            shown = ", ".join(repo_rel(p) for p in same)
            return f"同一来源正文未变（source_sha256={digest[:12]}…），已存在：{shown}。跳过，不覆盖。"
        if not overwrite and not as_new:
            old_has_data = any("data:image" in _read_text(p) for p in existing)
            if old_has_data and images:
                upgrade_inline = True
            else:
                shown = ", ".join(repo_rel(p) for p in existing)
                msg = (
                    f"同一来源的正文已经变了。旧产物：{shown}\n"
                    f"旧摘要 {read_digest(existing[0])[:12]}… / 新摘要 {digest[:12]}…\n"
                    "默认不覆盖（旧产物可能已被分析文档引用）。"
                    "要覆盖加 --overwrite，要另存加 --as-new。"
                )
                if skip_changed:
                    return msg
                raise RuntimeError(msg)

    target = planned
    if (overwrite or upgrade_inline) and existing:
        target = existing[0]
    elif as_new or target.exists():
        if target.exists() and not overwrite and not upgrade_inline:
            target = unique_target(target)

    if images:
        img_dir.mkdir(parents=True, exist_ok=True)
        written = set()
        for name, blob in images:
            (img_dir / name).write_bytes(blob)
            written.add(name)
        if overwrite or upgrade_inline:
            for leftover in img_dir.iterdir():
                if leftover.is_file() and leftover.name not in written:
                    leftover.unlink()

    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    meta = {
        "source": source,
        "source_sha256": digest,
        "converted_by": "web_ingest.py / defuddle",
        "converted_at": now,
    }
    if ref_dir is not None:
        meta["reference"] = repo_rel(ref_dir)
    meta["title"] = title.replace("\n", " ").strip()
    if images:
        meta["extracted_images"] = str(len(images))

    atomic_write(target, render(meta, body))
    msg = f"已写入 {repo_rel(target)}"
    if images:
        msg += f"，抽出 {len(images)} 张图到 {repo_rel(img_dir)}"
    if upgrade_inline:
        msg += "（把内联 data URI 抽成文件）"
    return msg


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def loose_html_files() -> list[Path]:
    if not REF_ROOT.is_dir():
        return []
    out: list[Path] = []
    for path in sorted(REF_ROOT.iterdir()):
        if not path.is_file() or path.name.startswith("."):
            continue
        if path.suffix.lower() in (".html", ".htm"):
            out.append(path)
    return out


def list_reference_dirs() -> list[Path]:
    if not REF_ROOT.is_dir():
        return []
    out: list[Path] = []
    for path in sorted(REF_ROOT.iterdir()):
        if path.is_dir() and not path.name.startswith(".") and (path / "index.html").is_file():
            out.append(path)
    return out


def source_for_reference(ref_dir: Path) -> tuple[str, str]:
    """返回 (front-matter 的 source, 合法 http(s) 或空串)。"""
    index = ref_dir / "index.html"
    comment = parse_page_comment(index)
    url = comment.get("url") or ""
    if not url:
        meta_path = ref_dir / "meta.json"
        try:
            data = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            data = {}
        if isinstance(data, dict):
            src = data.get("sourceUrl")
            if isinstance(src, str) and src.strip():
                url = http_url_or_empty(src)
    if url:
        return url, url
    return repo_rel(index), ""


def ingest_loose_file(src: Path) -> Path:
    """把根上的散装 HTML 收成新参考目录。失败时不留下没有 index.html 的半截目录。"""
    comment = parse_page_comment(src)
    url = comment.get("url") or ""
    title = html_title(src)
    slug = unique_slug(slugify(title or src.stem, url))
    dest_dir = REF_ROOT / slug
    dest_dir.mkdir(parents=True, exist_ok=False)
    captured_at = comment.get("saved") or file_mtime_iso(src)
    meta = {
        "title": title or slug,
        "sourceUrl": url,
        "capturedAt": captured_at,
        "source": "manual",
        "scrubbed": False,
    }
    try:
        (dest_dir / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        shutil.move(str(src), str(dest_dir / "index.html"))
    except Exception:
        shutil.rmtree(dest_dir, ignore_errors=True)
        raise
    return dest_dir


def run_inbox(args: argparse.Namespace) -> int:
    if not which("defuddle"):
        return die(MISSING_DEFUDDLE, 2)

    REF_ROOT.mkdir(parents=True, exist_ok=True)
    patterns = ignore_patterns(args)
    filed = 0
    extracted = 0
    skipped = 0
    failures: list[str] = []

    for src in loose_html_files():
        try:
            dest = ingest_loose_file(src)
            filed += 1
            print(f"已收成参考：{repo_rel(dest)}")
        except Exception as exc:
            failures.append(src.name)
            print(f"规范化失败 {src.name}：{exc}", file=sys.stderr)

    for ref_dir in list_reference_dirs():
        index = ref_dir / "index.html"
        source, _url = source_for_reference(ref_dir)
        try:
            msg = convert_html(
                index,
                source,
                ref_dir=ref_dir,
                overwrite=args.overwrite,
                as_new=args.as_new,
                patterns=patterns,
                skip_changed=True,
                title_fallback=ref_dir.name,
            )
        except RuntimeError as exc:
            text = str(exc)
            if text == "MISSING_DEFUDDLE":
                return die(MISSING_DEFUDDLE, 2)
            failures.append(ref_dir.name)
            print(f"提取失败 {repo_rel(ref_dir)}：{text}", file=sys.stderr)
            continue
        print(f"{repo_rel(ref_dir)}：{msg}")
        if msg.startswith("已写入"):
            extracted += 1
        else:
            skipped += 1

    if filed == 0 and extracted == 0 and skipped == 0 and not failures:
        print("没有需要处理的散装页面，已有参考的正文也未变。跳过，工作空间没有改动。")
        return 0

    summary = f"收件箱完成：收了 {filed} 份，抽出 {extracted} 份，跳过 {skipped} 份"
    if failures:
        summary += f"，失败 {len(failures)} 份（{', '.join(failures)}）"
        print(summary)
        return 1
    print(summary)
    return 0


def run_url(args: argparse.Namespace) -> int:
    if args.overwrite and args.as_new:
        return die("`--overwrite` 和 `--as-new` 不能一起用，选一个。", 2)

    try:
        url = normalize_url(args.url)
    except ValueError as exc:
        return die(str(exc), 2)

    if not which("defuddle"):
        return die(MISSING_DEFUDDLE, 2)

    ref_dir = find_reference(url)
    html_source = "reference" if ref_dir else "single-file"
    if html_source == "single-file" and not which("single-file"):
        return die(MISSING_SINGLE_FILE, 2)

    tmp_ctx = None
    try:
        if ref_dir is not None:
            html_path = ref_dir / "index.html"
            print(f"复用已有参考：{repo_rel(ref_dir)}/index.html")
        else:
            tmp_ctx = tempfile.TemporaryDirectory(prefix="web-ingest-")
            html_path = Path(tmp_ctx.name) / "index.html"
            print("没有现成参考，spawn single-file 抓到临时目录（不会写入 visualization/）")
            try:
                run_single_file(url, html_path)
            except RuntimeError as exc:
                msg = str(exc)
                if msg == "MISSING_SINGLE_FILE":
                    return die(MISSING_SINGLE_FILE, 2)
                return die(f"抓取失败：{msg}", 1)

        try:
            msg = convert_html(
                html_path,
                url,
                ref_dir=ref_dir,
                overwrite=args.overwrite,
                as_new=args.as_new,
                patterns=ignore_patterns(args),
                skip_changed=False,
            )
        except RuntimeError as exc:
            text = str(exc)
            if text == "MISSING_DEFUDDLE":
                return die(MISSING_DEFUDDLE, 2)
            # URL 模式：正文已变没给覆盖参数，走退出码 1
            return die(text if "正文已经变了" in text or text.startswith("按 input/") else f"提取失败：{text}", 1)

        print(msg)
        if html_source == "single-file" and msg.startswith("已写入"):
            print("临时 HTML 已丢弃，visualization/ 下没有新增文件。")
        return 0
    finally:
        if tmp_ctx is not None:
            tmp_ctx.cleanup()


def main() -> int:
    ap = argparse.ArgumentParser(description="把网页转成 Markdown 落进 input/converted/")
    ap.add_argument("url", nargs="?", help="要转换的网页 URL（与 --inbox 互斥）")
    ap.add_argument("--inbox", action="store_true", help="扫描 visualization/references/ 根上的散装页面并抽出正文")
    ap.add_argument("--overwrite", action="store_true", help="正文已变时覆盖旧产物")
    ap.add_argument("--as-new", action="store_true", help="正文已变时另存一份，不覆盖旧产物")
    add_ignore_flags(ap)
    args = ap.parse_args()

    if args.inbox and args.url:
        return die("`--inbox` 和 URL 不能一起用。收件箱自己扫根目录，不接受地址。", 2)
    if not args.inbox and not args.url:
        return die("请给一个 URL，或加 --inbox 处理 visualization/references/ 根上的散装页面。", 2)
    if args.overwrite and args.as_new:
        return die("`--overwrite` 和 `--as-new` 不能一起用，选一个。", 2)

    if args.inbox:
        return run_inbox(args)
    return run_url(args)


if __name__ == "__main__":
    raise SystemExit(main())
