"""OOXML 读写的公共部分：命名空间、zip 读写、生成标记。

只用标准库。改 XML 时两条老规矩（踩过坑）：
- **不要在 `ET.tostring` 的输出上做字符串匹配**：它会把 `w:` 改写成 `ns0:`，
  匹配 `w:instrText`、`wp:inline` 会全部落空。要么直接遍历元素，要么在原始 XML 上做正则。
- 回写整份 XML 时用原始字符串做局部替换，不用 ET 序列化：ET 会丢掉没用到的命名空间声明，
  而 `mc:Ignorable` 里引用的前缀一旦没声明，Word 会拒绝打开。
"""

from __future__ import annotations

import os
import re
import tempfile
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS = {"w": W, "a": A, "wp": WP}
_PREFIX = {"w": W, "a": A, "wp": WP, "r": R}

# 生成标记：工具链写出的每一份 .docx 都带它。md2docx 只覆盖带这个标记的同名文件 ——
# 没有标记的可能是人手改过的成品或客户原件，一律不碰。键名改了要同步看板 src/server/docxTools.mjs
MARKER = "aispace-docx-generator"

CUSTOM_PART = "docProps/custom.xml"
CUSTOM_CT = "application/vnd.openxmlformats-officedocument.custom-properties+xml"
CUSTOM_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties"
FMTID = "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}"


def q(tag: str) -> str:
    p, t = tag.split(":")
    return "{%s}%s" % (_PREFIX[p], t)


def wval(el, attr: str = "val"):
    return None if el is None else el.get(q("w:" + attr))


class Package:
    """一份 docx 的全部部件，按原顺序保存，改完整体写回。"""

    def __init__(self, files: dict[str, bytes], order: list[str]):
        self.files = files
        self.order = order

    @classmethod
    def read(cls, path: Path | str) -> "Package":
        with zipfile.ZipFile(path) as z:
            order = z.namelist()
            return cls({n: z.read(n) for n in order}, order)

    def text(self, part: str) -> str:
        return self.files[part].decode("utf-8")

    def set_text(self, part: str, s: str) -> None:
        # remove() 只删内容不删顺序：删了再加回来的部件（前置区切出时的 custom.xml）不能在顺序表里出现两次，
        # 否则 zip 里会有两个同名条目，Word 会报文件损坏
        if part not in self.order:
            self.order.append(part)
        self.files[part] = s.encode("utf-8")

    def remove(self, part: str) -> None:
        self.files.pop(part, None)

    def to_bytes(self) -> bytes:
        import io

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            # [Content_Types].xml 放第一个，部分阅读器按顺序识别
            names = [n for n in dict.fromkeys(self.order) if n in self.files]
            names.sort(key=lambda n: n != "[Content_Types].xml")
            for n in names:
                z.writestr(n, self.files[n])
        return buf.getvalue()


def write_atomic(path: Path, data: bytes) -> None:
    """先写同目录临时文件再原子替换，失败不留半截文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="." + path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---------- 生成标记 ----------
def add_marker(pkg: Package, version: str) -> None:
    """在 docProps/custom.xml 写入生成标记；没有这个部件就连同内容类型与关系一起补上。"""
    prop = (f'<property fmtid="{FMTID}" pid="{{pid}}" name="{MARKER}">'
            f"<vt:lpwstr>{escape(version)}</vt:lpwstr></property>")
    if CUSTOM_PART in pkg.files:
        x = pkg.text(CUSTOM_PART)
        # 已有同名属性（比如以旧版本生成后再处理）先去掉，再按新版本写
        x = re.sub(r'<property\b[^>]*name="%s"[^>]*>.*?</property>' % re.escape(MARKER), "", x, flags=re.S)
        pids = [int(p) for p in re.findall(r'\bpid="(\d+)"', x)]
        new = prop.replace("{pid}", str(max(pids + [1]) + 1))
        if re.search(r"<Properties\b[^>]*/>", x):
            x = re.sub(r"<Properties\b([^>]*?)\s*/>", lambda m: f"<Properties{m.group(1)}>{new}</Properties>", x, count=1)
        else:
            x = x.replace("</Properties>", new + "</Properties>")
        if "xmlns:vt=" not in x:
            x = x.replace("<Properties ", '<Properties xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes" ', 1)
        pkg.set_text(CUSTOM_PART, x)
    else:
        pkg.set_text(CUSTOM_PART, (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" '
            'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
            + prop.replace("{pid}", "2") + "</Properties>"))
    ct = pkg.text("[Content_Types].xml")
    if 'PartName="/docProps/custom.xml"' not in ct:
        ct = ct.replace("</Types>", f'<Override PartName="/docProps/custom.xml" ContentType="{CUSTOM_CT}"/></Types>')
        pkg.set_text("[Content_Types].xml", ct)
    rels = pkg.text("_rels/.rels")
    if CUSTOM_REL not in rels:
        ids = [int(i) for i in re.findall(r'Id="rId(\d+)"', rels)]
        rid = f"rId{max(ids + [0]) + 1}"
        rels = rels.replace("</Relationships>",
                            f'<Relationship Id="{rid}" Type="{CUSTOM_REL}" Target="docProps/custom.xml"/></Relationships>')
        pkg.set_text("_rels/.rels", rels)


def marker_of(path: Path) -> str | None:
    """读出已有 .docx 的生成标记版本；没有标记、不是 zip、读不了一律返回 None。"""
    try:
        with zipfile.ZipFile(path) as z:
            x = z.read(CUSTOM_PART).decode("utf-8", "ignore")
    except (KeyError, OSError, zipfile.BadZipFile):
        return None
    m = re.search(r'name="%s"[^>]*>\s*<vt:lpwstr>([^<]*)</vt:lpwstr>' % re.escape(MARKER), x)
    return m.group(1) if m else None


def heading_numbered(pkg: Package) -> bool:
    """`heading 1` 样式（沿 basedOn 链）上有没有挂自动编号。有才剥 md 标题里的手写编号，没有就保留原样。"""
    try:
        styles = pkg.text("word/styles.xml")
    except KeyError:
        return False
    blocks = {}
    by_name = {}
    for b in re.findall(r"<w:style\b.*?</w:style>", styles, re.S):
        sid = re.search(r'w:styleId="([^"]+)"', b)
        name = re.search(r'<w:name w:val="([^"]+)"', b)
        if sid:
            blocks[sid.group(1)] = b
            if name:
                by_name[name.group(1).lower()] = sid.group(1)
    sid, seen = by_name.get("heading 1"), set()
    while sid and sid in blocks and sid not in seen:
        seen.add(sid)
        m = re.search(r'<w:numId w:val="(\d+)"', blocks[sid])
        if m:
            return m.group(1) != "0"
        based = re.search(r'<w:basedOn w:val="([^"]+)"', blocks[sid])
        sid = based.group(1) if based else None
    return False
