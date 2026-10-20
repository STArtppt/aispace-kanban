#!/usr/bin/env python3
"""把看板模板的新版本更新进这个工作空间。

为什么要有它
------------
工作空间是从模板一次性铺出来的，之后模板修好的脚本、新加的技能到不了这里。
手工比对复制的问题是**没有基线**：一个文件和模板新版不同，分不清是这边改过、还是模板改过。
所以每次铺设和更新都在 `.aispace/template.lock.json` 记下「当时模板每个文件的 SHA-256」，
下一次更新拿它当三方合并的基线。

判定口径（只对「模板管理」的文件；分类见模板 template.yaml 的 sync 段）
-----------------------------------------------------------------
记 base = lock 里的哈希（上次铺设/更新时模板那一版），cur = 工作空间现在的，new = 模板新版的。

    cur == new                      → 一致，不动（登记进 lock）
    没有 base，cur 不存在            → 新增
    没有 base，cur 存在且不同        → 冲突（首次接入，或实例里恰好有同名文件）
    cur == base，new 不同            → 覆盖（这边没改过）
    cur != base，new == base         → 保留（这边改过或删了，模板没变）
    cur != base，new != base         → 冲突（两边都改了）
    base 有、模板新版里没有了        → 模板已删除（只列出，不删）

seedOnly 文件（project.yaml、.gitignore、规则库…）归工作空间所有：
模板那边相对 base 变了（或新增了），只列进「seedOnly 有新版」并给 diff，永远不写。

lock 里记的一直是**模板那一版**的哈希，不是工作空间的：
冲突合并完用 `--resolved` 登记，记的是「已合并到本次模板版本」—— 于是下次
cur（合并结果）!= base（模板这一版），仍被当作本地改过，模板不变就保留，模板再变才冲突。

它做的事
--------
    plan     取模板新版，出计划。只读，不写工作空间。
             既没有 --from 也没有 --ref 时：看板从源码启动、且本工作空间在它的实例清单里、
             源码中有对应模板目录，就读本机模板；否则从 GitHub 下载（--ref 缺省 main）。
    apply    按计划执行「新增」「覆盖」两组，逐个原子替换，然后重写 lock。
             冲突文件一个字节不写，lock 里它的哈希也不前移。
             出计划之后工作空间或 lock 又变了，整体拒绝，要求重出计划。
    apply --resolved <文件>…   冲突合并完，把这些文件登记为「已合并到本次版本」。
    compare  冲突对照：按 lock 记的来源再取一次基线版本，只取冲突文件，给两份 diff
             （基线 → 工作空间、基线 → 模板新版）。

它**不删除任何文件**，不碰 input/、output/ 里的资料和产出，不碰 visualization/。
只 import Python 标准库。

用法
----
    python3 scripts/template_update.py plan                      # 本机条件成立时读本机模板，否则 GitHub main
    python3 scripts/template_update.py plan --ref <分支|标签|提交号>
    python3 scripts/template_update.py plan --from <本地模板目录>  # 显式本地目录，优先于本机判定
    python3 scripts/template_update.py apply --plan <计划文件>
    python3 scripts/template_update.py apply --plan <计划文件> --resolved AGENTS.md scripts/x.py
    python3 scripts/template_update.py compare --plan <计划文件> [--base-ref <提交号> | --base-from <目录>]

每个子命令都可以加 --json，标准输出打一个 JSON 对象给程序用。

退出码：0 = 成功；1 = 执行失败（网络、读写出错）；2 = 参数不对或前提不满足（计划过期、没有 lock 等）。
"""

from __future__ import annotations

import argparse
import datetime as dt
import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath

# Windows 控制台默认不是 UTF-8，输出中文会直接 UnicodeEncodeError
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
WS = HERE.parent

REPO = "STArtppt/aispace-kanban"
TEMPLATE_SUBDIR = "templates/pm-aispace"
LOCK_REL = ".aispace/template.lock.json"
PLAN_KIND = "aispace-template-plan"

# 这些永远不分发：系统垃圾、Python 缓存，以及本机专属的文件
# （settings.local.json 里是本机绝对路径，.env 里是密钥）。
JUNK_NAMES = {".DS_Store", "Thumbs.db", "__pycache__", ".git", "node_modules"}
JUNK_SUFFIXES = (".pyc",)
LOCAL_ONLY = {".claude/settings.local.json", ".env", ".env.local"}

DIFF_MAX_LINES = 200

GROUP_LABELS = {
    "add": "新增",
    "overwrite": "覆盖",
    "keep": "保留（这边改过，模板没变）",
    "conflict": "冲突（两边都改了，或首次接入对不上）",
    "deleted": "模板已删除（只列出，不删）",
    "seed": "seedOnly 有新版（未覆盖）",
}


class UpdateError(Exception):
    """执行期错误。exit_code 2 = 参数 / 前提不满足，1 = 网络或读写失败。"""

    def __init__(self, message: str, exit_code: int = 1) -> None:
        super().__init__(message)
        self.exit_code = exit_code


# ---------------------------------------------------------------- 模板分类


def read_template_meta(template_dir: Path) -> dict:
    """
    读模板 template.yaml 里的 id 与 sync 段。只认本模板用到的最小 YAML 形状
    （顶层 `key: value`，`sync:` 下两个字符串列表），不引第三方库 —— 工作空间脚本默认零依赖。
    没有 sync 段时 `sync` 为 None，调用方据此认定这份模板不支持更新。
    """
    path = template_dir / "template.yaml"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {"id": "", "sync": None}
    meta: dict = {"id": "", "sync": None}
    section = ""
    key = ""
    for raw in text.splitlines():
        line = raw.split(" #", 1)[0].rstrip() if not raw.lstrip().startswith("#") else ""
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        stripped = line.strip()
        if indent == 0:
            section, key = "", ""
            if stripped == "sync:":
                section = "sync"
                meta["sync"] = {"seedOnly": [], "exclude": []}
            elif stripped.startswith("id:"):
                meta["id"] = _unquote(stripped[3:].strip())
            continue
        if section != "sync":
            continue
        if stripped.endswith(":") and not stripped.startswith("-"):
            key = stripped[:-1].strip()
            continue
        if stripped.startswith("- ") and key in ("seedOnly", "exclude"):
            meta["sync"][key].append(_unquote(stripped[2:].strip()))
    return meta


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        return value[1:-1]
    return value


def _glob_re(pattern: str) -> re.Pattern:
    """`*` 不跨目录，`**` 跨任意层（`a/**` 匹配 a 下的一切）。"""
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out))


def _matches(rel: str, patterns: list[str]) -> bool:
    return any(_glob_re(p).fullmatch(rel) for p in patterns)


def template_files(template_dir: Path, sync: dict) -> dict[str, dict]:
    """
    模板里要分发的文件：{相对路径: {"abs": 绝对路径, "kind": "managed" | "seed"}}。

    - 软链接一律不跟（模板根的 skills/ 是 .claude/skills 的别名，由铺设脚本现建）；
    - npm 打包会把 .gitignore 改名成 gitignore 存（npm 无条件剔除 .gitignore），这里认回来；
    - exclude 和本机专属文件不算。
    """
    files: dict[str, dict] = {}
    for dirpath, dirnames, filenames in os.walk(template_dir):
        base = Path(dirpath)
        dirnames[:] = sorted(
            d for d in dirnames if d not in JUNK_NAMES and not (base / d).is_symlink()
        )
        for name in sorted(filenames):
            full = base / name
            if name in JUNK_NAMES or name.endswith(JUNK_SUFFIXES) or full.is_symlink():
                continue
            rel = full.relative_to(template_dir).as_posix()
            if name == "gitignore" and not (base / ".gitignore").exists():
                rel = rel[: -len("gitignore")] + ".gitignore"
            if rel in LOCAL_ONLY or _matches(rel, sync.get("exclude", [])):
                continue
            kind = "seed" if _matches(rel, sync.get("seedOnly", [])) else "managed"
            files[rel] = {"abs": full, "kind": kind}
    return files


# ---------------------------------------------------------------- 哈希与 lock


def sha256_file(path: Path) -> str | None:
    try:
        h = hashlib.sha256()
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 16), b""):
                h.update(chunk)
        return h.hexdigest()
    except (FileNotFoundError, IsADirectoryError, NotADirectoryError):
        return None


def load_lock(ws: Path) -> dict | None:
    path = ws / LOCK_REL
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise UpdateError(f"{LOCK_REL} 读不出来（{exc}）。别手改这份文件；实在坏了就删掉它，按「首次接入」重来。", 2)
    if not isinstance(data, dict) or not isinstance(data.get("files"), dict):
        raise UpdateError(f"{LOCK_REL} 的结构不对，缺 files。删掉它按「首次接入」重来。", 2)
    return data


def lock_digest(ws: Path) -> str | None:
    return sha256_file(ws / LOCK_REL)


def build_lock(template_id: str, source: str, files: dict[str, str]) -> dict:
    return {
        "template": template_id,
        "source": source,
        "synced_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "files": dict(sorted(files.items())),
    }


def write_lock(ws: Path, lock: dict) -> None:
    path = ws / LOCK_REL
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(lock, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def _git_text(cwd: Path, args: list[str]) -> str | None:
    """调系统 git。找不到 git、或不在仓库里，返回 None。只用标准库。"""
    try:
        proc = subprocess.run(
            ["git", "-C", str(cwd), *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout


def local_source(template_dir: Path) -> str:
    """
    lock 要入库，只记目录名和提交号，不记绝对路径。
    取得到提交号时是 local:<目录名>@<提交号>；该目录有未提交改动再加 +dirty。
    找不到 git、或不在仓库里，退回 local:<目录名>。
    """
    name = template_dir.name
    raw = _git_text(template_dir, ["rev-parse", "HEAD"])
    if raw is None:
        return f"local:{name}"
    sha = raw.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{7,40}", sha):
        return f"local:{name}"
    dirty = _git_text(template_dir, ["status", "--porcelain", "--", "."])
    if dirty is None:
        return f"local:{name}@{sha}"
    if dirty.strip():
        return f"local:{name}@{sha}+dirty"
    return f"local:{name}@{sha}"


DIRTY_WARNING = "来源有未提交改动，冲突对照的基线不精确"
RUNTIME_FILE = Path.home() / ".pmwork" / "dashboard" / "runtime.json"
LOCAL_LOCK_RE = re.compile(r"^local:[^@+]+@([0-9a-f]{7,40})(?:\+dirty)?$")


def _source_warnings(source: str) -> list[str]:
    if source.endswith("+dirty"):
        return [DIRTY_WARNING]
    return []


def _same_dir(a: str, b: str) -> bool:
    """两边都 realpath；Windows 再 normcase。对不上就当不是同一个工作空间。"""
    try:
        left = os.path.realpath(a)
        right = os.path.realpath(b)
    except OSError:
        return False
    if os.name == "nt":
        left = os.path.normcase(left)
        right = os.path.normcase(right)
    return left == right


def _read_runtime() -> dict | None:
    """读不到、解析失败、或没有 launch：按 npm 包处理，调用方走 GitHub。"""
    try:
        data = json.loads(RUNTIME_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or "launch" not in data:
        return None
    return data


def _template_id_of(ws: Path) -> str:
    lock = load_lock(ws)
    if lock:
        raw = lock.get("template")
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return "pm-aispace"


def _safe_template_id(raw: str) -> str | None:
    if not raw or raw in (".", "..") or "/" in raw or "\\" in raw or raw.startswith("."):
        return None
    return raw


def resolve_local(ws: Path) -> tuple[Path | None, Path | None, str, str]:
    """
    本机三条都成立时返回 (模板目录, repoRoot, 模板 id, "")。
    launch 为 source 但后两条不成立时，最后一项是要打到 stderr 的说明，目录为 None。
    读不到 runtime、或 launch 不是 source：四项里说明为空，调用方静默走 GitHub。
    """
    runtime = _read_runtime()
    if runtime is None or runtime.get("launch") != "source":
        return None, None, "", ""
    instances = runtime.get("instances")
    registered = False
    if isinstance(instances, list):
        for item in instances:
            root = item.get("root") if isinstance(item, dict) else None
            if isinstance(root, str) and _same_dir(root, str(ws)):
                registered = True
                break
    if not registered:
        return None, None, "", "本工作空间未在本机看板登记，改从 GitHub 取模板。"
    repo = runtime.get("repoRoot")
    if not isinstance(repo, str) or not repo.strip():
        return None, None, "", "本机源码位置是空的，改从 GitHub 取模板。"
    template_id = _safe_template_id(_template_id_of(ws))
    if template_id is None:
        return None, None, "", "lock 里的模板 id 不能用来拼本机目录，改从 GitHub 取模板。"
    template_dir = Path(repo) / "templates" / template_id
    if not (template_dir / "template.yaml").is_file():
        return None, None, "", f"本机源码里没有模板 {template_id}（template.yaml 不存在），改从 GitHub 取模板。"
    return template_dir, Path(repo), template_id, ""


# ---------------------------------------------------------------- 取模板


def _http_get(url: str, accept: str, timeout: int) -> bytes:
    req = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": "aispace-template-update"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def resolve_commit(ref: str) -> str | None:
    """ref → 提交号。匿名接口有频率限制，失败返回 None，由调用方给 warning。"""
    if re.fullmatch(r"[0-9a-f]{40}", ref):
        return ref
    url = f"https://api.github.com/repos/{REPO}/commits/{urllib.parse.quote(ref, safe='')}"
    try:
        sha = _http_get(url, "application/vnd.github.sha", 20).decode("ascii", "replace").strip()
    except (urllib.error.URLError, OSError, ValueError):
        return None
    return sha if re.fullmatch(r"[0-9a-f]{40}", sha) else None


def network_hint(exc: Exception) -> str:
    return (
        f"从 GitHub 取模板失败：{exc}。\n"
        "两条出路：\n"
        "  1. 设置代理后重试，例如 export HTTPS_PROXY=http://127.0.0.1:7890（Windows 用 set）；\n"
        "  2. 手里有看板仓库或 npm 包时，用 --from <那里的 templates/pm-aispace 目录> 走本地。\n"
        "工作空间没有任何文件变化。"
    )


def fetch_github(ref: str, dest: Path, only: set[str] | None = None) -> tuple[str, list[str]]:
    """
    下载源码包，只把 templates/pm-aispace/ 解到 dest。返回（来源串，warnings）。
    先查提交号再按提交号下载：内容和记下的版本号一定对得上。
    only 给了就只解这些相对路径（冲突对照取基线时用）。
    """
    warnings: list[str] = []
    sha = resolve_commit(ref)
    if sha is None:
        warnings.append(
            f"没查到 {ref} 对应的提交号（GitHub 接口可能限流），来源先记为 {ref}。"
            "判定不受影响；只是之后冲突对照取基线时，可能取到别的版本。"
        )
    tar_ref = sha or ref
    url = f"https://codeload.github.com/{REPO}/tar.gz/{urllib.parse.quote(tar_ref, safe='')}"
    with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as tmp:
        tar_path = Path(tmp.name)
    try:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "aispace-template-update"})
            with urllib.request.urlopen(req, timeout=60) as resp, tar_path.open("wb") as out:
                shutil.copyfileobj(resp, out)
        except (urllib.error.URLError, OSError) as exc:
            if isinstance(exc, urllib.error.HTTPError) and exc.code == 404:
                raise UpdateError(f"GitHub 上没有这个版本：{ref}。检查 --ref 写对没有。", 2)
            raise UpdateError(network_hint(exc), 1)
        count = _extract_template(tar_path, dest, only)
    finally:
        tar_path.unlink(missing_ok=True)
    if count == 0:
        raise UpdateError(f"源码包里没有 {TEMPLATE_SUBDIR}/（版本 {ref}）。这个版本可能还没有这份模板。", 2)
    return f"github:{REPO}@{tar_ref}", warnings


def _extract_template(tar_path: Path, dest: Path, only: set[str] | None) -> int:
    """只解普通文件，拒绝绝对路径和 `..`，软链接一律跳过。"""
    count = 0
    try:
        with tarfile.open(tar_path, "r:gz") as tar:
            for member in tar:
                if not member.isfile():
                    continue
                parts = PurePosixPath(member.name).parts
                # 第一层是 <仓库>-<版本>/，后面要正好是 templates/pm-aispace/
                if len(parts) < 4 or "/".join(parts[1:3]) != TEMPLATE_SUBDIR:
                    continue
                rel_parts = parts[3:]
                if any(p in ("", ".", "..") for p in rel_parts) or member.name.startswith("/"):
                    continue
                rel = "/".join(rel_parts)
                if only is not None and rel not in only:
                    continue
                target = dest.joinpath(*rel_parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                src = tar.extractfile(member)
                if src is None:
                    continue
                with src, target.open("wb") as out:
                    shutil.copyfileobj(src, out)
                if member.mode & 0o111:
                    target.chmod(0o755)
                count += 1
    except (tarfile.TarError, OSError) as exc:
        raise UpdateError(f"源码包解不开：{exc}。重试一次；还不行就用 --from 走本地。", 1)
    return count


def obtain_template(ref: str | None, from_dir: str, ws: Path) -> tuple[Path, str, list[str], Path]:
    """返回（模板目录，来源串，warnings，本次的临时目录）。计划文件也写进这个临时目录。"""
    work = Path(tempfile.mkdtemp(prefix="aispace-template-"))
    if from_dir:
        src = Path(from_dir).expanduser().resolve()
        if not (src / "template.yaml").is_file():
            shutil.rmtree(work, ignore_errors=True)
            raise UpdateError(f"--from 指的不是模板目录（里面没有 template.yaml）：{src}", 2)
        source = local_source(src)
        return src, source, _source_warnings(source), work
    # 没传 --ref（缺省 None，不是字符串 "main"）才看本机。显式 --ref 仍下载 GitHub。
    if not ref:
        local_dir, _repo, _template_id, reason = resolve_local(ws)
        if reason:
            print(reason, file=sys.stderr)
        if local_dir is not None:
            source = local_source(local_dir)
            return local_dir, source, _source_warnings(source), work
    dest = work / "template"
    dest.mkdir()
    try:
        source, warnings = fetch_github(ref or "main", dest)
    except UpdateError:
        shutil.rmtree(work, ignore_errors=True)
        raise
    return dest, source, warnings, work


# ---------------------------------------------------------------- plan


def _read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def text_diff(a_path: Path | None, b_path: Path | None, a_label: str, b_label: str) -> str:
    a = "" if a_path is None or not a_path.exists() else _read_text(a_path)
    b = "" if b_path is None or not b_path.exists() else _read_text(b_path)
    if a is None or b is None:
        return "（二进制文件，不给 diff）"
    lines = list(
        difflib.unified_diff(a.splitlines(), b.splitlines(), fromfile=a_label, tofile=b_label, lineterm="")
    )
    if len(lines) > DIFF_MAX_LINES:
        lines = lines[:DIFF_MAX_LINES] + [f"…（diff 太长，只给前 {DIFF_MAX_LINES} 行）"]
    return "\n".join(lines)


def make_plan(ws: Path, template_dir: Path, source: str, warnings: list[str]) -> dict:
    meta = read_template_meta(template_dir)
    if meta["sync"] is None:
        raise UpdateError("取到的模板没有 sync 段（template.yaml），这一版模板还不支持更新。", 2)
    lock = load_lock(ws)
    base_files: dict[str, str] = lock["files"] if lock else {}
    tfiles = template_files(template_dir, meta["sync"])

    groups: dict[str, list[dict]] = {k: [] for k in GROUP_LABELS}
    same: list[dict] = []
    for rel, info in tfiles.items():
        new = sha256_file(info["abs"])
        cur = sha256_file(ws / rel)
        base = base_files.get(rel)
        entry = {"path": rel, "instance_sha": cur, "template_sha": new, "base_sha": base}

        if info["kind"] == "seed":
            if cur == new or new == base:
                same.append(entry)
            else:
                if cur is None:
                    entry["reason"] = "工作空间里没有这份文件"
                else:
                    entry["reason"] = "没有基线，和模板不一致" if base is None else "模板这边有新版"
                entry["diff"] = text_diff(ws / rel if cur else None, info["abs"], f"工作空间/{rel}", f"模板新版/{rel}")
                groups["seed"].append(entry)
            continue

        if cur == new:
            same.append(entry)
        elif base is None:
            if cur is None:
                groups["add"].append(entry)
            else:
                entry["reason"] = "首次接入，没有基线" if lock is None else "工作空间里已有同名文件"
                groups["conflict"].append(entry)
        elif cur == base:
            groups["overwrite"].append(entry)
        elif new == base:
            entry["reason"] = "工作空间删掉了它" if cur is None else "工作空间改过"
            groups["keep"].append(entry)
        else:
            entry["reason"] = "工作空间删掉了它，模板又改了" if cur is None else "两边都改过"
            groups["conflict"].append(entry)

    for rel, base in sorted(base_files.items()):
        if rel in tfiles:
            continue
        cur = sha256_file(ws / rel)
        if cur is None:
            continue  # 两边都没了，下次 lock 里自然不再有它
        groups["deleted"].append(
            {
                "path": rel,
                "instance_sha": cur,
                "template_sha": None,
                "base_sha": base,
                "reason": "工作空间没改过" if cur == base else "工作空间改过",
            }
        )

    return {
        "kind": PLAN_KIND,
        "version": 1,
        "created_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "workspace": str(ws),
        "template": meta["id"],
        "source": source,
        "template_dir": str(template_dir),
        "first_time": lock is None,
        "lock_source": lock.get("source") if lock else None,
        "lock_sha": lock_digest(ws),
        "warnings": warnings,
        "groups": groups,
        "same": same,
    }


def cmd_plan(args: argparse.Namespace) -> dict:
    ws = WS
    template_dir, source, warnings, work = obtain_template(args.ref, args.from_dir, ws)
    try:
        plan = make_plan(ws, template_dir, source, warnings)
    except UpdateError:
        shutil.rmtree(work, ignore_errors=True)
        raise
    plan_path = work / "plan.json"
    plan["plan_file"] = str(plan_path)
    plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return plan


# ---------------------------------------------------------------- apply


def load_plan(path: str, ws: Path) -> dict:
    try:
        plan = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise UpdateError(f"计划文件读不出来：{exc}。重新跑一次 plan。", 2)
    if not isinstance(plan, dict) or plan.get("kind") != PLAN_KIND:
        raise UpdateError("这不是 template_update.py plan 出的计划文件。", 2)
    if Path(plan.get("workspace", "")).resolve() != ws.resolve():
        raise UpdateError(f"这份计划是给另一个工作空间出的：{plan.get('workspace')}。", 2)
    return plan


def _stale(message: str) -> UpdateError:
    return UpdateError(f"{message}。计划已经过期，工作空间没有任何文件变化；重新跑一次 plan。", 2)


def _replace_atomic(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{dst.name}.", suffix=".tmp", dir=dst.parent)
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        shutil.copyfile(src, tmp)
        shutil.copymode(src, tmp)
        os.replace(tmp, dst)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def cmd_apply(args: argparse.Namespace) -> dict:
    ws = WS
    plan = load_plan(args.plan, ws)
    if args.resolved:
        return resolve(ws, plan, args.resolved)

    # 先把所有前提核一遍，一条不满足就一个字节都不写
    if lock_digest(ws) != plan.get("lock_sha"):
        raise _stale(f"出计划之后 {LOCK_REL} 变了（可能这份计划已经执行过）")
    template_dir = Path(plan["template_dir"])
    groups = plan["groups"]
    writes = groups["add"] + groups["overwrite"]
    for entry in writes:
        rel = entry["path"]
        if sha256_file(ws / rel) != entry["instance_sha"]:
            raise _stale(f"出计划之后工作空间里的 {rel} 变了")
        if sha256_file(_template_path(template_dir, rel)) != entry["template_sha"]:
            raise _stale(f"模板临时目录里的 {rel} 不见了或变了")

    for entry in writes:
        rel = entry["path"]
        _replace_atomic(_template_path(template_dir, rel), ws / rel)

    files: dict[str, str] = {}
    for entry in plan["same"] + groups["add"] + groups["overwrite"] + groups["keep"] + groups["seed"]:
        files[entry["path"]] = entry["template_sha"]
    for entry in groups["conflict"]:
        # 冲突的基线不前移：合并完 --resolved 之前，下次 plan 仍会报它
        if entry.get("base_sha"):
            files[entry["path"]] = entry["base_sha"]
    write_lock(ws, build_lock(plan.get("template", ""), plan["source"], files))

    return {
        "ok": True,
        "source": plan["source"],
        "written": [e["path"] for e in writes],
        "conflicts": [e["path"] for e in groups["conflict"]],
        "seed": [e["path"] for e in groups["seed"]],
        "deleted": [e["path"] for e in groups["deleted"]],
        "lock": LOCK_REL,
    }


def _template_path(template_dir: Path, rel: str) -> Path:
    path = template_dir / rel
    if not path.exists() and PurePosixPath(rel).name == ".gitignore":
        alt = path.with_name("gitignore")  # npm 包里的改名
        if alt.exists():
            return alt
    return path


def resolve(ws: Path, plan: dict, paths: list[str]) -> dict:
    lock = load_lock(ws)
    if lock is None or lock.get("source") != plan["source"]:
        raise UpdateError("还没按这份计划执行 apply（lock 的来源对不上）。先 apply，再逐个合并冲突、登记。", 2)
    conflicts = {e["path"]: e for e in plan["groups"]["conflict"]}
    unknown = [p for p in paths if p not in conflicts]
    if unknown:
        raise UpdateError(f"这些文件不在计划的冲突组里：{'、'.join(unknown)}。只有冲突文件需要登记。", 2)
    for rel in paths:
        lock["files"][rel] = conflicts[rel]["template_sha"]
    write_lock(ws, build_lock(lock.get("template", ""), lock["source"], lock["files"]))
    left = [p for p in conflicts if lock["files"].get(p) != conflicts[p]["template_sha"]]
    return {"ok": True, "resolved": paths, "remaining": left, "lock": LOCK_REL}


def _materialize_local_baseline(repo_root: Path, sha: str, template_id: str, rels: set[str], dest: Path) -> bool:
    """用 git show 把那一版冲突文件写到临时目录。一个都取不到就返回 False。"""
    got = 0
    for rel in sorted(rels):
        rel_path = PurePosixPath(rel)
        if rel_path.is_absolute() or ".." in rel_path.parts:
            continue
        spec = f"{sha}:templates/{template_id}/{rel}"
        try:
            proc = subprocess.run(
                ["git", "-C", str(repo_root), "show", spec],
                capture_output=True,
                timeout=30,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return False
        if proc.returncode != 0:
            continue
        target = dest.joinpath(*rel_path.parts)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(proc.stdout)
        except OSError:
            continue
        got += 1
    return got > 0


# ---------------------------------------------------------------- compare


def cmd_compare(args: argparse.Namespace) -> dict:
    ws = WS
    plan = load_plan(args.plan, ws)
    conflicts = plan["groups"]["conflict"]
    template_dir = Path(plan["template_dir"])
    if not conflicts:
        return {"ok": True, "items": [], "warnings": []}

    warnings: list[str] = []
    wanted = {e["path"] for e in conflicts if e.get("base_sha")}
    base_dir: Path | None = None
    work: Path | None = None
    lock_source = plan.get("lock_source") or ""

    def _baseline_unavailable() -> str:
        return (
            f"lock 的来源是 {lock_source or '（空）'}，取不回那一版模板。"
            "有那一版的目录就用 --base-from，知道提交号就用 --base-ref；否则只能两方对照。"
        )

    if wanted:
        if args.base_from:
            base_dir = Path(args.base_from).expanduser().resolve()
        else:
            ref = args.base_ref
            local_match = LOCAL_LOCK_RE.fullmatch(lock_source)
            # 没指定基线来源、lock 带提交号、且本机三条成立：从本机仓库取出那一版
            if not ref and local_match:
                _local_dir, repo_root, template_id, _reason = resolve_local(ws)
                if repo_root is not None and template_id:
                    work = Path(tempfile.mkdtemp(prefix="aispace-template-base-"))
                    base_dir = work / "template"
                    base_dir.mkdir()
                    if not _materialize_local_baseline(repo_root, local_match.group(1), template_id, wanted, base_dir):
                        warnings.append(_baseline_unavailable())
                        shutil.rmtree(work, ignore_errors=True)
                        work = None
                        base_dir = None
                else:
                    warnings.append(_baseline_unavailable())
            else:
                if not ref and lock_source.startswith(f"github:{REPO}@"):
                    ref = lock_source.split("@", 1)[1]
                if ref:
                    work = Path(tempfile.mkdtemp(prefix="aispace-template-base-"))
                    base_dir = work / "template"
                    base_dir.mkdir()
                    _, fetch_warnings = fetch_github(ref, base_dir, only=wanted)
                    warnings.extend(fetch_warnings)
                else:
                    warnings.append(_baseline_unavailable())

    items = []
    for entry in conflicts:
        rel = entry["path"]
        item = {"path": rel, "reason": entry.get("reason", ""), "base": "none"}
        base_file = _template_path(base_dir, rel) if base_dir and entry.get("base_sha") else None
        if base_file is not None and base_file.exists():
            item["base"] = "exact" if sha256_file(base_file) == entry["base_sha"] else "inexact"
            item["diff_local"] = text_diff(base_file, ws / rel, f"基线/{rel}", f"工作空间/{rel}")
            item["diff_template"] = text_diff(base_file, _template_path(template_dir, rel), f"基线/{rel}", f"模板新版/{rel}")
            if item["base"] == "inexact":
                warnings.append(f"{rel}：取到的基线和 lock 记的哈希对不上，三方对照只能参考，拿不准以工作空间版为准。")
        else:
            item["diff_direct"] = text_diff(ws / rel, _template_path(template_dir, rel), f"工作空间/{rel}", f"模板新版/{rel}")
        items.append(item)
    if work is not None:
        shutil.rmtree(work, ignore_errors=True)
    return {"ok": True, "items": items, "warnings": warnings}


# ---------------------------------------------------------------- 输出


def print_plan(plan: dict) -> None:
    print(f"模板来源：{plan['source']}")
    if plan["first_time"]:
        print("首次接入：这个工作空间还没有 .aispace/template.lock.json，和模板新版不一致的文件都列为冲突。")
    for w in plan["warnings"]:
        print(f"注意：{w}")
    print(f"和模板新版一致：{len(plan['same'])} 个文件")
    for key, label in GROUP_LABELS.items():
        rows = plan["groups"][key]
        if not rows:
            continue
        print(f"\n{label}：{len(rows)}")
        for row in rows:
            reason = f"（{row['reason']}）" if row.get("reason") else ""
            print(f"  {row['path']}{reason}")
    print(f"\n计划文件：{plan['plan_file']}")
    print("确认后执行：python3 scripts/template_update.py apply --plan " + plan["plan_file"])


def main() -> int:
    ap = argparse.ArgumentParser(description="把看板模板的新版本更新进这个工作空间")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_plan = sub.add_parser("plan", help="取模板新版、出计划（只读）")
    src = p_plan.add_mutually_exclusive_group()
    src.add_argument("--ref", default=None, help="GitHub 上的分支 / 标签 / 提交号。不传则在本机条件成立时读本机模板，否则用 main")
    src.add_argument("--from", dest="from_dir", default="", help="本地模板目录（显式选项，离线或维护者用）")
    p_plan.add_argument("--json", action="store_true", help="标准输出打完整计划 JSON")

    p_apply = sub.add_parser("apply", help="按计划执行新增与覆盖；或 --resolved 登记已合并的冲突")
    p_apply.add_argument("--plan", required=True, help="plan 输出的计划文件")
    p_apply.add_argument("--resolved", nargs="+", default=[], metavar="文件", help="已合并完的冲突文件（相对工作空间根）")
    p_apply.add_argument("--json", action="store_true")

    p_cmp = sub.add_parser("compare", help="冲突对照：取基线版本，给三方 diff")
    p_cmp.add_argument("--plan", required=True)
    base = p_cmp.add_mutually_exclusive_group()
    base.add_argument("--base-ref", default="", help="基线的 GitHub 提交号（lock 来源不是 GitHub 时用）")
    base.add_argument("--base-from", default="", help="基线那一版的本地模板目录")
    p_cmp.add_argument("--json", action="store_true")

    args = ap.parse_args()
    try:
        if args.cmd == "plan":
            result = cmd_plan(args)
        elif args.cmd == "apply":
            result = cmd_apply(args)
        else:
            result = cmd_compare(args)
    except UpdateError as exc:
        if getattr(args, "json", False):
            print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            print(str(exc), file=sys.stderr)
        return exc.exit_code

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif args.cmd == "plan":
        print_plan(result)
    elif args.cmd == "apply" and "resolved" in result:
        print(f"已登记为合并完成：{'、'.join(result['resolved'])}")
        print(f"还没登记的冲突：{'、'.join(result['remaining']) or '无'}")
    elif args.cmd == "apply":
        print(f"已写入 {len(result['written'])} 个文件，lock 已更新（来源 {result['source']}）。")
        for rel in result["written"]:
            print(f"  {rel}")
        if result["conflicts"]:
            print(f"\n冲突 {len(result['conflicts'])} 个，没动，等合并后用 --resolved 登记：")
            for rel in result["conflicts"]:
                print(f"  {rel}")
        if result["seed"]:
            print(f"\nseedOnly 有新版、没覆盖：{'、'.join(result['seed'])}")
        if result["deleted"]:
            print(f"\n模板已删除、没删：{'、'.join(result['deleted'])}")
    else:
        for w in result["warnings"]:
            print(f"注意：{w}")
        for item in result["items"]:
            print(f"\n==== {item['path']}（{item['reason']}，基线：{item['base']}）")
            if "diff_local" in item:
                print("---- 基线 → 工作空间\n" + (item["diff_local"] or "（无差异）"))
                print("---- 基线 → 模板新版\n" + (item["diff_template"] or "（无差异）"))
            else:
                print("---- 工作空间 → 模板新版（没有基线）\n" + (item["diff_direct"] or "（无差异）"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
