"""docx 工具链的公共包：提炼客户 Word 模板（docx_template.py）、按模板把 .md 转成 .docx（md2docx.py）。

只依赖 Python 3 标准库；md → docx 另需 pandoc 3。模块划分与踩坑清单见同目录 README.md。

入口脚本共用这里的约定：
- 启动时把 stdout / stderr 强制成 UTF-8（Windows 默认代码页会把中文报告打成乱码）；
- `--json` 时**最后一行**是结果 JSON（看板只解析最后一行），总带 `ok` 与 `toolVersion`；
- 退出码：0 成功；1 执行失败；2 参数不合法或文件不在；3 冲突（重名、同名文件不能覆盖）；4 缺依赖（pandoc）。
  看板 src/server/docxTools.mjs 按这张表把退出码映射成 500 / 400 / 409 / 400。
"""

from __future__ import annotations

import json
import sys

# 写进生成标记与结果 JSON。改了生成逻辑（样式、后处理）就升一位，
# 看板靠它提示「工作空间里的脚本比看板自带的旧」。
VERSION = "1.2.0"

EXIT_OK, EXIT_FAIL, EXIT_ARGS, EXIT_CONFLICT, EXIT_DEPENDENCY = 0, 1, 2, 3, 4


class ToolError(Exception):
    def __init__(self, message: str, code: int = EXIT_FAIL, hint: str | None = None, kind: str | None = None):
        super().__init__(message)
        self.code = code
        self.hint = hint
        self.kind = kind


def force_utf8() -> None:
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass


def finish(result: dict | None, err: ToolError | None, as_json: bool, human: str = "") -> int:
    if err is not None:
        payload = {"ok": False, "toolVersion": VERSION, "error": str(err), "exitCode": err.code}
        if err.hint:
            payload["hint"] = err.hint
        if err.kind:
            payload["kind"] = err.kind
        if as_json:
            print(json.dumps(payload, ensure_ascii=False))
        else:
            print(f"失败：{err}", file=sys.stderr)
            if err.hint:
                print(f"出路：{err.hint}", file=sys.stderr)
        return err.code
    result = {"ok": True, "toolVersion": VERSION, **(result or {})}
    if as_json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(human)
    return EXIT_OK
