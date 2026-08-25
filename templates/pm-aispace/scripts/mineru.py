#!/usr/bin/env python3
"""MinerU 在线 API 客户端（v4 精度版），用于把 PDF / PPTX 解析成 Markdown。

为什么单独一个模块：MinerU 是异步批量接口（申请上传链接 → PUT 上传 → 轮询 → 下载 zip），
和 ingest.py 里那些同步 CLI 转换的节奏完全不同，混在一起会让主流程难读。

只依赖标准库。两个实现上的坑，都是踩过才知道的：

1. **上传用 http.client 而不是 urllib**：MinerU 的签名上传链接要求**不能带 Content-Type**，
   而 urllib 在有 body 时会强制补上 `application/x-www-form-urlencoded`，没法干净地去掉。
   http.client 可以完全控制请求头。
2. **上传成功不等于任务已提交**：服务端在检测到文件上传完成后才自动排队，
   所以上传后要轮询 batch 结果，中间会经过 waiting-file / pending / running。

环境变量：
    MINERU_API_KEY   必需。在 https://mineru.net/apiManage 创建 API Token。

单独当命令用（调试接口时方便）：
    python3 scripts/mineru.py 某文件.pdf --out /tmp/out
"""

from __future__ import annotations

import argparse
import http.client
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

API_BASE = "https://mineru.net/api/v4"
ENV_KEY = "MINERU_API_KEY"

# 官方限制：单文件 200MB / 200 页，单批 200 个文件
MAX_BYTES = 200 * 1024 * 1024
MAX_BATCH = 200

# 轮询节奏。MinerU 解析一份几十页的 PDF 通常在 1-3 分钟，5 秒一次不会打爆频控
POLL_INTERVAL = 5
POLL_TIMEOUT = 900

SUPPORTED = {".pdf", ".pptx", ".docx", ".xlsx", ".doc", ".ppt", ".xls",
             ".png", ".jpg", ".jpeg", ".html"}


class MineruError(RuntimeError):
    """MinerU 侧的失败：缺 key、接口报错、任务失败、超时。"""


@dataclass
class Result:
    """一个文件的解析结果。失败时 markdown 为 None，err 有原因。"""
    file_name: str
    state: str
    markdown: str | None = None
    images: dict[str, bytes] = field(default_factory=dict)
    err: str | None = None


# --------------------------------------------------------------------------- #
# 环境变量
# --------------------------------------------------------------------------- #

def load_dotenv(path: Path | None = None) -> None:
    """把仓库根目录 .env 里的变量读进 os.environ。已存在的环境变量优先，不覆盖。"""
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


def get_api_key() -> str | None:
    load_dotenv()
    key = (os.environ.get(ENV_KEY) or "").strip()
    return key or None


def available() -> bool:
    """有没有配 key。ingest.py 用它决定走 MinerU 还是退回 markitdown。"""
    return get_api_key() is not None


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

def _api(method: str, path: str, key: str, payload: dict | None = None, timeout: int = 60) -> dict:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        f"{API_BASE}{path}",
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {key}",
            "Accept": "*/*",
            **({"Content-Type": "application/json"} if body else {}),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        if exc.code in (401, 403):
            raise MineruError(f"鉴权失败（HTTP {exc.code}）：检查 {ENV_KEY} 是否正确、是否过期。{detail}") from exc
        if exc.code == 429:
            raise MineruError(f"触发频控或超出配额（HTTP 429）。免费额度是 1000 页/天。{detail}") from exc
        raise MineruError(f"接口报错 HTTP {exc.code}：{detail}") from exc
    except urllib.error.URLError as exc:
        raise MineruError(f"连不上 mineru.net：{exc.reason}") from exc

    if data.get("code") not in (0, "0"):
        raise MineruError(f"接口返回 code={data.get('code')}：{data.get('msg')}（trace_id={data.get('trace_id')}）")
    return data.get("data") or {}


def _put_file(url: str, path: Path, timeout: int = 300) -> None:
    """PUT 上传到签名链接。**刻意不发 Content-Type**，MinerU 明确要求不带。"""
    parts = urllib.parse.urlsplit(url)
    target = parts.path + (f"?{parts.query}" if parts.query else "")
    conn_cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    conn = conn_cls(parts.netloc, timeout=timeout)
    try:
        with path.open("rb") as fh:
            conn.request("PUT", target, body=fh, headers={"Content-Length": str(path.stat().st_size)})
            resp = conn.getresponse()
            payload = resp.read()
        if resp.status not in (200, 201, 204):
            raise MineruError(f"上传失败 HTTP {resp.status}：{payload.decode('utf-8', 'replace')[:300]}")
    finally:
        conn.close()


def _download(url: str, timeout: int = 300, retries: int = 5) -> bytes:
    """下载结果 zip。大文件偶发 SSL EOF，加重试；仍失败再退到 curl。"""
    import subprocess
    last_exc: Exception | None = None
    for attempt in range(1, retries + 1):
        req = urllib.request.Request(url, headers={"Accept": "*/*", "Connection": "close"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as exc:
            last_exc = exc
            if attempt < retries:
                time.sleep(min(2 ** attempt, 20))
                continue
    # urllib 连续失败：curl 对部分 CDN/SSL 更稳
    try:
        proc = subprocess.run(
            ["curl", "-fsSL", "--retry", "3", "--retry-delay", "2",
             "--connect-timeout", "30", "--max-time", str(timeout), url],
            capture_output=True, timeout=timeout + 30, check=False,
        )
        if proc.returncode == 0 and proc.stdout:
            return proc.stdout
        detail = (proc.stderr or b"").decode("utf-8", "replace")[:300]
        raise MineruError(f"下载结果 zip 失败（urllib: {last_exc}；curl: {detail or proc.returncode}）")
    except FileNotFoundError as exc:
        raise MineruError(f"下载结果 zip 失败：{last_exc}") from last_exc
    except subprocess.TimeoutExpired as exc:
        raise MineruError(f"下载结果 zip 超时（urllib: {last_exc}；curl 也超时）") from exc


# --------------------------------------------------------------------------- #
# 结果解包
# --------------------------------------------------------------------------- #

def unpack_zip(blob: bytes) -> tuple[str, dict[str, bytes]]:
    """从结果 zip 里取出 markdown 正文和图片。"""
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        names = zf.namelist()
        mds = [n for n in names if n.lower().endswith(".md")]
        if not mds:
            raise MineruError(f"结果 zip 里没有 .md 文件，只有：{names[:10]}")
        # 正常情况下叫 full.md；万一改名了就挑最大的那个当正文
        pick = next((n for n in mds if Path(n).name == "full.md"), None) or \
            max(mds, key=lambda n: zf.getinfo(n).file_size)
        markdown = zf.read(pick).decode("utf-8", "replace")
        images = {
            Path(n).name: zf.read(n)
            for n in names
            if not n.endswith("/") and Path(n).suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
        }
    return markdown, images


def rewrite_image_links(markdown: str, prefix: str) -> str:
    """把 markdown 里的 images/xxx.jpg 改写成相对 converted/ 的路径。"""
    def repl(m: re.Match) -> str:
        return f"{m.group(1)}{prefix}/{Path(m.group(2)).name}{m.group(3)}"
    # ![alt](images/x.jpg) 和 <img src="images/x.jpg">
    markdown = re.sub(r"(!\[[^\]]*\]\()([^)\s]+\.(?:png|jpe?g|webp))(\))", repl, markdown, flags=re.I)
    markdown = re.sub(r"(<img[^>]*src=\")([^\"]+\.(?:png|jpe?g|webp))(\")", repl, markdown, flags=re.I)
    return markdown


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #

def parse_batch(
    files: list[Path],
    *,
    is_ocr: bool = False,
    language: str = "ch",
    model_version: str = "pipeline",
    enable_formula: bool = True,
    enable_table: bool = True,
    timeout: int = POLL_TIMEOUT,
    log=print,
) -> dict[str, Result]:
    """把一批本地文件交给 MinerU 解析，返回 {文件名: Result}。

    整批一次提交，因为轮询是按 batch_id 的——20 个 PDF 分 20 次提交要轮询 20 轮，
    合成一批只轮询一次，也更省频控额度。
    """
    key = get_api_key()
    if not key:
        raise MineruError(f"没有配置 {ENV_KEY}。复制 .env.example 为 .env 并填入 token，"
                          f"token 在 https://mineru.net/apiManage 创建。")
    if not files:
        return {}
    if len(files) > MAX_BATCH:
        raise MineruError(f"单批最多 {MAX_BATCH} 个文件，这次有 {len(files)} 个。请分批处理。")

    for f in files:
        if f.stat().st_size > MAX_BYTES:
            raise MineruError(f"{f.name} 有 {f.stat().st_size / 1024 / 1024:.0f}MB，"
                              f"超过单文件 200MB 上限。请拆分后再转。")

    # 同名文件会让结果对不上号（结果是按 file_name 回传的），提前拦住
    names = [f.name for f in files]
    dupes = {n for n in names if names.count(n) > 1}
    if dupes:
        raise MineruError(f"这批文件里有同名文件：{sorted(dupes)}。MinerU 按文件名回传结果，请先改名。")

    payload = {
        "model_version": model_version,
        "enable_formula": enable_formula,
        "enable_table": enable_table,
        "language": language,
        "files": [{"name": f.name, "is_ocr": is_ocr} for f in files],
    }
    log(f"  MinerU：申请上传链接（{len(files)} 个文件）…")
    data = _api("POST", "/file-urls/batch", key, payload)
    batch_id, urls = data.get("batch_id"), data.get("file_urls") or []
    if not batch_id or len(urls) != len(files):
        raise MineruError(f"接口返回异常：batch_id={batch_id}，拿到 {len(urls)} 个链接但有 {len(files)} 个文件")

    for f, url in zip(files, urls):
        log(f"  MinerU：上传 {f.name}（{f.stat().st_size / 1024 / 1024:.1f}MB）…")
        _put_file(url, f)

    log(f"  MinerU：已提交，batch_id={batch_id}，开始轮询（最多等 {timeout}s）…")
    results = _poll(batch_id, key, set(names), timeout, log)

    out: dict[str, Result] = {}
    for name, item in results.items():
        state = item.get("state", "unknown")
        if state != "done":
            out[name] = Result(name, state, err=item.get("err_msg") or f"最终状态 {state}")
            continue
        zip_url = item.get("full_zip_url")
        if not zip_url:
            out[name] = Result(name, state, err="state=done 但没有 full_zip_url")
            continue
        try:
            markdown, images = unpack_zip(_download(zip_url))
        except MineruError as exc:
            out[name] = Result(name, state, err=str(exc))
            continue
        out[name] = Result(name, state, markdown=markdown, images=images)
    return out


def _poll(batch_id: str, key: str, expected: set[str], timeout: int, log) -> dict[str, dict]:
    """轮询到全部文件进入终态（done / failed）或超时。"""
    deadline = time.monotonic() + timeout
    latest: dict[str, dict] = {}
    announced: set[str] = set()

    while True:
        data = _api("GET", f"/extract-results/batch/{batch_id}", key)
        for item in data.get("extract_result") or []:
            name = item.get("file_name") or ""
            latest[name] = item
            state = item.get("state")
            if state == "running" and name not in announced:
                announced.add(name)
                prog = item.get("extract_progress") or {}
                total = prog.get("total_pages")
                log(f"  MinerU：{name} 开始解析" + (f"（共 {total} 页）" if total else ""))

        done = {n for n, i in latest.items() if i.get("state") in ("done", "failed")}
        if expected <= done:
            return latest

        if time.monotonic() > deadline:
            for name in expected - done:
                latest.setdefault(name, {})["state"] = latest.get(name, {}).get("state", "timeout")
                latest[name]["err_msg"] = (f"等待超过 {timeout}s 仍未完成（最后状态 "
                                           f"{latest[name].get('state')}）。大文件可以调高 --mineru-timeout。")
            return latest

        pending = sorted(expected - done)
        states = ", ".join(f"{n}={latest.get(n, {}).get('state', 'pending')}" for n in pending[:3])
        log(f"  MinerU：等待中（{states}{'…' if len(pending) > 3 else ''}）")
        time.sleep(POLL_INTERVAL)


# --------------------------------------------------------------------------- #
# 调试用 CLI
# --------------------------------------------------------------------------- #

def main() -> int:
    ap = argparse.ArgumentParser(description="用 MinerU 解析单个或多个文件（调试用）")
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, default=Path("."), help="产物输出目录")
    ap.add_argument("--ocr", action="store_true", help="强制 OCR（扫描版 PDF 需要）")
    ap.add_argument("--language", default="ch")
    ap.add_argument("--model-version", default="pipeline", choices=["pipeline", "vlm", "MinerU-HTML"])
    ap.add_argument("--timeout", type=int, default=POLL_TIMEOUT)
    args = ap.parse_args()

    try:
        results = parse_batch(args.files, is_ocr=args.ocr, language=args.language,
                              model_version=args.model_version, timeout=args.timeout)
    except MineruError as exc:
        print(f"✗ {exc}", file=sys.stderr)
        return 1

    args.out.mkdir(parents=True, exist_ok=True)
    failed = 0
    for name, res in results.items():
        if res.markdown is None:
            print(f"✗ {name}：{res.err}", file=sys.stderr)
            failed += 1
            continue
        stem = Path(name).stem
        (args.out / f"{stem}.md").write_text(res.markdown, encoding="utf-8")
        if res.images:
            img_dir = args.out / f"{stem}-images"
            img_dir.mkdir(exist_ok=True)
            for img_name, blob in res.images.items():
                (img_dir / img_name).write_bytes(blob)
        print(f"✓ {name} → {args.out / f'{stem}.md'}（{len(res.images)} 张图）")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
