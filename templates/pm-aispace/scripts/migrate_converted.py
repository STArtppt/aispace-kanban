#!/usr/bin/env python3
"""把旧版平铺的 `input/converted/` 搬成镜像 `input/raw/` 的目录结构。**一次性脚本**。

背景
----
旧版 ingest.py 把所有产物平铺在 `input/converted/` 根下，文件名是源文件名的 slug。
资料上千份以后那个目录既看不出产物对应 raw 里的哪批资料，也没法按批次删除。
新规则见 `scripts/layout.py`。这个脚本负责把已有产物搬过去，**不重新转换**——
MinerU 转出来的 PDF 要花在线额度，重转一遍不划算。

怎么搬
------
不看产物的 frontmatter，而是**从 `input/raw/` 正推**：每份原始资料按旧规则算出它当年
落在哪儿、按新规则算出该落到哪儿，然后搬。这样不依赖 frontmatter 是否齐全
（旧版拷进来的 .csv 根本没有 frontmatter），也能把认不出主人的产物挑出来单独报。

- **单文件产物**（.md / .csv / 图片）→ 直接搬，顺带把正文里 `../assets/x/` 这类
  图片链接按新的目录深度改写。搬过去 sha256 还对得上，重跑 ingest.py 会认作「未变化」跳过。
- **目录型产物**（xlsx 拆表、html 原型包、点表、现场数据）→ **删掉**，交给对应脚本本地重建。
  它们的摘要里全是相对链接，搬完还得逐条改写，不如重建干净；这几类重建都不调在线接口。
- **认不出主人的**（原件已删、或旧版遗留）→ 原地不动，最后列出来给人判断。

用法
----
    python3 scripts/migrate_converted.py --dry-run    # 先看计划（强烈建议）
    python3 scripts/migrate_converted.py              # 执行

搬完按提示依次跑 ingest.py / pointtable.py / realdata.py 补齐目录型产物。
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ingest  # noqa: E402  复用格式分派表和忽略清单，保证和转换脚本判断一致
import layout  # noqa: E402

REPO = layout.REPO
RAW = layout.RAW
CONVERTED = layout.CONVERTED
ASSETS = REPO / "input" / "assets"
UNSORTED = ASSETS / "未分类"


def log(msg: str) -> None:
    print(msg, flush=True)


def repo_rel(path: Path) -> str:
    return path.relative_to(REPO).as_posix()


def old_slugify(name: str) -> str:
    """旧版 ingest.py 的命名规则。搬迁要靠它算出「这份资料当年落在哪儿」。"""
    name = unicodedata.normalize("NFKC", name)
    name = re.sub(r"[\s_]+", "-", name.strip())
    name = re.sub(r"[^\w一-鿿.-]+", "", name)
    name = re.sub(r"-{2,}", "-", name).strip("-.")
    return name or "untitled"


def old_target(src: Path) -> tuple[Path, str] | None:
    """这份原始资料在旧布局下的产物路径 + 形态（file / dir / image）。"""
    ext = src.suffix.lower()
    slug = old_slugify(src.stem)
    if ext in ingest.SPREADSHEET or ext in ingest.LEGACY_SPREADSHEET:
        return CONVERTED / slug, "dir"
    if ext in ingest.HTML_PROTOTYPE:
        return CONVERTED / slug, "dir"
    if ext in ingest.PANDOC or ext in ingest.MINERU or ext in ingest.MARKITDOWN:
        return CONVERTED / f"{slug}.md", "file"
    if ext in ingest.PASSTHROUGH:
        if ext in {".md", ".markdown", ".txt"}:
            return CONVERTED / f"{slug}.md", "file"
        return CONVERTED / f"{slug}{ext}", "file"
    if ext in ingest.IMAGES:
        return UNSORTED / f"{slug}{ext}", "image"
    return None


def new_target(src: Path) -> tuple[Path, str]:
    """这份原始资料在新布局下的落点 + 形态。"""
    ext = src.suffix.lower()
    if (ext in ingest.SPREADSHEET or ext in ingest.LEGACY_SPREADSHEET
            or ext in ingest.HTML_PROTOTYPE):
        return layout.split_paths(src)[0], "dir"
    if ext in ingest.PANDOC or ext in ingest.MINERU or ext in ingest.MARKITDOWN:
        return layout.single_target(src, ".md"), "file"
    if ext in ingest.PASSTHROUGH:
        suffix = ".md" if ext in {".md", ".markdown", ".txt"} else ext
        return layout.single_target(src, suffix), "file"
    return UNSORTED / f"{layout.safe_component(src.stem)}{ext}", "image"


def rewrite_asset_links(md: Path, old_name: str, new_name: str) -> bool:
    """把正文里指向 assets/ 的相对链接改写成新深度、新目录名。改了返回 True。

    旧产物都在 converted/ 根下，链接一律是 `../assets/<旧名>/`；新产物在镜像目录里，
    深度不一，得按 md 自己的位置重算。
    """
    try:
        body = md.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False
    old_prefix = f"../assets/{old_name}/"
    if old_prefix not in body:
        return False
    new_prefix = layout.rel_path(ASSETS / new_name, md.parent) + "/"
    md.write_text(body.replace(old_prefix, new_prefix), encoding="utf-8")
    return True


def escape_asset_links(md: Path, names: list[str]) -> bool:
    """把正文里 `assets/<目录名>/` 的目录名做 markdown 转义。改了返回 True。

    图片目录随源文件取名，`古田 Z-V 曲线(2015复核后)` 这种名字里的空格和括号会当场打断
    `![](...)` 语法——渲染出来的链接停在第一个 `)`，图全裂。百分号编码后渲染器能还原。
    只按 assets/ 下真实存在的目录名替换，所以重复跑不会二次编码。
    """
    try:
        body = md.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False
    out = body
    for name in names:
        escaped = layout.md_link(name)
        if escaped != name:
            out = out.replace(f"assets/{name}/", f"assets/{escaped}/")
    if out == body:
        return False
    md.write_text(out, encoding="utf-8")
    return True


# 引用后面跟着这些字符才算「这个路径引到此为止」，避免 `.../集控点表` 把
# `.../集控点表补充` 也一起改了
BOUNDARY = set('/)，,。、`"\'）」 \t\n*　')
# 引用里一段路径的取值范围。括号不当终止符——`客户意见响应说明(07-25).md` 这种名字本来就带括号
TOKEN_RE = re.compile(r"input/converted/[^\s`\"'，。、）」|<>]+")


def already_resolves(body: str, i: int) -> bool:
    """从 i 起的这段引用是不是已经指得到东西了。

    搬完之后旧产物目录名往往正好等于新的镜像目录名（`converted/现场数据/`），
    光靠「旧路径是不是前缀」判不出来——`converted/现场数据/_manifest_wds_real_data.md`
    已经是对的，再套一次映射会变成 `现场数据/SplittingObject/wds_real_data/_manifest_...`。
    指得到就别动，这条判据同时保证脚本可以重复跑。
    """
    m = TOKEN_RE.match(body, i)
    if not m:
        return False
    raw = m.group(0)
    # markdown 链接的收尾 `)` 会被 TOKEN_RE 吃进来，所以带括号和不带都试一遍
    for cand in (raw, raw.rstrip("/"), raw.split(")")[0], raw.rstrip(").,")):
        if cand.startswith("input/converted/") and (REPO / cand).exists():
            return True
    return False


def old_name_of(rel_parts: tuple[str, ...]) -> str:
    """正文目录里某个文件在旧命名下叫什么。逐段套旧 slug，扩展名保持不变。"""
    out = []
    for i, part in enumerate(rel_parts):
        last = i == len(rel_parts) - 1
        stem, dot, ext = part.rpartition(".") if last and "." in part else (part, "", "")
        out.append(old_slugify(stem) + dot + ext)
    return "/".join(out)


def payload_citations(old_dir: Path, new_dir: Path) -> dict[str, str]:
    """正文目录里逐个文件的旧路径 → 新路径。

    产物名和 sheet 名的命名规则一起变了（`t01_measure.csv` 从前叫 `t01-measure.csv`），
    只映射目录不够，引用里带具体文件名的会照样指空。正文目录还没重建时返回空——
    重建完再跑一次 `--citations-only` 就能补上。
    """
    if not new_dir.is_dir():
        return {}
    out = {}
    for f in sorted(new_dir.rglob("*")):
        if not f.is_file() or f.name.startswith("."):
            continue
        rel = f.relative_to(new_dir).parts
        out[f"{repo_rel(old_dir)}/{old_name_of(rel)}"] = f"{repo_rel(new_dir)}/{'/'.join(rel)}"
    return out


def fix_citations(mapping: dict[str, str], dry_run: bool) -> list[tuple[Path, int]]:
    """把 output/ 下文档里指向旧产物路径的溯源引用改成新路径。

    溯源是这个工作空间的硬要求——搬完产物却留一堆指不到东西的来源，等于把已经建立的
    追溯链断掉。按最长前缀替换，只碰 `input/converted/` 开头的路径。
    """
    keys = sorted(mapping, key=len, reverse=True)
    touched = []
    for md in sorted((REPO / "output").rglob("*.md")):
        try:
            body = md.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        out, hits, i = [], 0, 0
        while i < len(body):
            for key in keys:
                if not body.startswith(key, i):
                    continue
                # 已经指得到东西的引用不碰；正文目录还没重建时退回「新路径是不是已经在那儿了」，
                # 两条都是为了重复跑不摞成 .../MergedObject/MergedObject/
                if already_resolves(body, i) or body.startswith(mapping[key], i):
                    continue
                nxt = body[i + len(key)] if i + len(key) < len(body) else "\n"
                if nxt not in BOUNDARY:
                    continue
                out.append(mapping[key])
                i += len(key)
                hits += 1
                break
            else:
                out.append(body[i])
                i += 1
        if hits:
            touched.append((md, hits))
            if not dry_run:
                md.write_text("".join(out), encoding="utf-8")
    return touched


def main() -> int:
    ap = argparse.ArgumentParser(description="把平铺的 input/converted/ 搬成镜像 input/raw/ 的结构")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划，不动文件")
    ap.add_argument("--citations-only", action="store_true",
                    help="只改 output/ 里指向旧产物路径的溯源引用，不搬文件。"
                         "搬完并重建完目录型产物后再跑一次，把带具体文件名的引用也补上")
    args = ap.parse_args()

    if not CONVERTED.exists():
        log("input/converted/ 不存在，没什么可搬的。")
        return 0

    files, _ = ingest.collect([], layout.load_ignore())

    moves: list[tuple[Path, Path]] = []          # (旧产物, 新产物) 单文件
    asset_renames: dict[str, str] = {}           # assets/ 下的目录改名
    rebuild: list[Path] = []                     # 要删掉重建的目录型产物
    claimed: set[Path] = set()                   # 已认领的旧产物，用来挑孤儿
    todo_scripts: set[str] = set()

    # 点表 / 现场数据按顶层目录归堆，下面单独处理。探测要读文件内容，只做这一趟
    pt_dirs: set[str] = set()
    rd_files: dict[str, list[Path]] = {}
    for src in files:
        # 点表 / 现场数据不按单文件走（它们整目录或整文件成库，产物在下面单独处理）。
        # 不排掉的话，某个点表小文件的旧 slug 可能撞上别人的产物目录，把人家删了。
        top = src.relative_to(RAW).parts[0] if src.is_relative_to(RAW) else ""
        if ingest.is_pointtable(src):
            pt_dirs.add(top)
            continue
        if ingest.is_realdata(src):
            rd_files.setdefault(top, []).append(src)
            continue
        old = old_target(src)
        if not old:
            continue
        old_path, old_kind = old
        new_path, new_kind = new_target(src)
        # 新旧落点都记上：搬完再跑一次本脚本时，新落点不该被当成认不出主人的孤儿
        claimed.update({old_path, new_path})

        if old_kind == "dir":
            todo_scripts.add("ingest")
            if old_path.is_dir():
                rebuild.append(old_path)
            continue

        # 图片和单文件产物：搬过去就行
        if old_path.is_file() and old_path != new_path:
            moves.append((old_path, new_path))
        if new_kind == "file" and src.suffix.lower() in (set(ingest.PANDOC) | ingest.MINERU):
            old_name, new_name = old_slugify(src.stem), layout.safe_component(src.stem)
            if old_name != new_name and (ASSETS / old_name).is_dir():
                asset_renames[old_name] = new_name

    # 点表 / 现场数据：整目录合并或按文件成集，产物都要重建
    for child in sorted(RAW.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        legacy = CONVERTED / old_slugify(child.name)
        # 只认**旧布局**的产物目录：目录里直接躺着 _manifest.md。搬完之后同名目录还在
        # （它成了镜像目录），少了这个判据，重复跑会把刚搬好的产物连窝端掉。
        if not (legacy / "_manifest.md").is_file():
            continue
        if child.name in pt_dirs:
            claimed.add(legacy)
            rebuild.append(legacy)
            todo_scripts.add("pointtable")
        elif child.name in rd_files:
            claimed.add(legacy)
            rebuild.append(legacy)
            todo_scripts.add("realdata")

    # 旧路径 → 新路径，用来修 output/ 里的溯源引用
    citations: dict[str, str] = {}
    for src in files:
        if ingest.is_pointtable(src) or ingest.is_realdata(src):
            continue
        old = old_target(src)
        if not old or old[0] == UNSORTED:
            continue
        old_path, old_kind = old
        # 目录型产物引用的是正文所在目录，单文件产物引用的就是那个文件
        new_path = (layout.split_paths(src)[1] if old_kind == "dir" else new_target(src)[0])
        if old_kind == "dir":
            citations.update(payload_citations(old_path, new_path))
        if old_path != new_path:
            citations[repo_rel(old_path)] = repo_rel(new_path)
    for child in sorted(RAW.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        # 上面那趟已经按内容分好堆了，不看旧 manifest 还在不在
        # （搬迁那一步已经把它删了，重复跑时读不到）
        legacy = CONVERTED / old_slugify(child.name)
        if child.name in pt_dirs:
            payload = layout.merge_paths(child)[1]
            citations.update(payload_citations(legacy, payload))
            citations[repo_rel(legacy)] = repo_rel(payload)
        # 旧版整目录一个库，新版一份导出文件一个库。只有一份文件时能一一对上，
        # 多份就说不清引用指的是哪个库了——不猜，留给人改
        data = rd_files.get(child.name, [])
        if len(data) == 1:
            payload = layout.split_paths(data[0])[1]
            citations.update(payload_citations(legacy, payload))
            citations[repo_rel(legacy)] = repo_rel(payload)
            # 旧版摘要在产物目录里，新版提到镜像目录并改了名
            citations[f"{repo_rel(legacy)}/_manifest.md"] = repo_rel(layout.split_paths(data[0])[0])

    # 认不出主人的：原件删了，或者旧版遗留。不动它们，只报出来。
    # 搬完的新结构不算——镜像目录（raw/ 下有同名目录）和正文容器都是本脚本自己造的，
    # 重复跑时会撞上，报成孤儿会误导人去删。
    skip = ({layout.safe_component(d.name) for d in RAW.iterdir() if d.is_dir()}
            | {layout.SPLIT_DIR, layout.MERGE_DIR})
    targets = {m[1] for m in moves}
    orphans = [p for p in sorted(CONVERTED.iterdir())
               if not p.name.startswith(".") and p not in claimed and p not in targets
               and not (p.is_dir() and p.name in skip)]

    if args.citations_only:
        cited = fix_citations(citations, args.dry_run)
        total = sum(n for _, n in cited)
        log(f"{len(cited)} 份文档、共 {total} 处溯源引用{'待改写' if args.dry_run else '已改写'}：")
        for md, n in cited:
            log(f"  {md.relative_to(REPO)}  {n} 处")
        return 0

    log(f"搬迁计划：{len(moves)} 份单文件产物搬位置，{len(rebuild)} 份目录型产物删除重建，"
        f"{len(asset_renames)} 个图片目录改名，{len(orphans)} 份认不出主人。\n")
    for old_path, new_path in moves[:10]:
        log(f"  搬  {old_path.relative_to(REPO)}  →  {new_path.relative_to(REPO)}")
    if len(moves) > 10:
        log(f"  …… 另外 {len(moves) - 10} 份")
    for p in rebuild:
        log(f"  重建 {p.relative_to(REPO)}")
    for old_name, new_name in sorted(asset_renames.items()):
        log(f"  改名 input/assets/{old_name}  →  input/assets/{new_name}")
    if orphans:
        log("\n认不出主人（原地保留，请人工判断是删是留）：")
        for p in orphans:
            log(f"  ? {p.relative_to(REPO)}")

    cited = fix_citations(citations, args.dry_run)
    if cited:
        total = sum(n for _, n in cited)
        log(f"\noutput/ 下 {len(cited)} 份文档、共 {total} 处溯源引用指向旧产物路径，"
            f"{'待改写' if args.dry_run else '已改写'}：")
        for md, n in cited:
            log(f"  {md.relative_to(REPO)}  {n} 处")

    if args.dry_run:
        log("\n（--dry-run，什么都没动）")
        return 0

    # 先删要重建的目录型产物，再搬单文件。顺序不能反：旧的 `converted/集控点表/`
    # 正好是新布局里那批产物的镜像目录，先搬后删会把刚搬进去的一起删掉。
    for p in rebuild:
        if p.is_dir():
            shutil.rmtree(p)

    conflicts = 0
    for old_path, new_path in moves:
        new_path.parent.mkdir(parents=True, exist_ok=True)
        if new_path.exists():
            log(f"⚠ 目标已存在，跳过：{new_path.relative_to(REPO)}")
            conflicts += 1
            continue
        shutil.move(str(old_path), str(new_path))

    for old_name, new_name in sorted(asset_renames.items()):
        dst = ASSETS / new_name
        if dst.exists():
            continue
        shutil.move(str(ASSETS / old_name), str(dst))

    # 图片链接：改名和深度一起改写
    for _, new_path in moves:
        if new_path.suffix != ".md" or not new_path.is_file():
            continue
        for old_name, new_name in asset_renames.items():
            rewrite_asset_links(new_path, old_name, new_name)
        # 没改名的目录也要按新深度重算
        for hit in re.findall(r"\.\./assets/([^/)\s]+)/", new_path.read_text(encoding="utf-8")):
            rewrite_asset_links(new_path, hit, hit)

    # 深度算完了再统一转义目录名：拿 assets/ 下的真实目录名比对，重复跑也不会二次编码
    asset_names = sorted((d.name for d in ASSETS.iterdir() if d.is_dir()), key=len, reverse=True)
    escaped = sum(escape_asset_links(md, asset_names)
                  for md in CONVERTED.rglob("*.md") if md.is_file())
    if escaped:
        log(f"· {escaped} 份产物的图片链接做了 markdown 转义（路径里有空格或括号）")

    # 空掉的旧目录清掉，别留一堆空壳
    for p in sorted(CONVERTED.rglob("*"), key=lambda x: -len(x.parts)):
        if p.is_dir() and not any(p.iterdir()):
            p.rmdir()

    log(f"\n搬迁完成{'（有 %d 处冲突已跳过）' % conflicts if conflicts else ''}。接下来跑：")
    if "ingest" in todo_scripts:
        log("  python3 scripts/ingest.py          # 重建 xlsx / html 的目录型产物，刷新台账")
    if "pointtable" in todo_scripts:
        log("  python3 scripts/pointtable.py      # 重建点表主表和 sqlite")
    if "realdata" in todo_scripts:
        log("  python3 scripts/realdata.py        # 重建现场数据时序库")
    log("  python3 scripts/migrate_converted.py --citations-only"
        "   # 重建完再跑一次，补上引用里带具体文件名的那些")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
