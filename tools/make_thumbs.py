"""把今天日报里的每条视频都截一张缩略图（<家>/thumbs/<id>.jpg），页面卡片直接用缓存。

python tools/make_thumbs.py [日期 可选]
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

HOME = Path(os.environ.get("DSH_DOUYIN_HOME") or (Path.home() / ".dsh" / "douyin-duty"))
PY = HOME / ".venv" / "Scripts" / "python.exe"
SERVER = HOME / "mcp_server.py"
THUMBS = HOME / "thumbs"


def ids_from_report(day: str | None) -> list[str]:
    out = HOME / "out"
    if day:
        files = [out / f"{day}.md"]
    else:
        files = sorted(out.glob("*.md"))[-3:]
    ids: list[str] = []
    for f in files:
        if not f.exists():
            continue
        for m in re.finditer(r"^###\s*(\d{6,})", f.read_text(encoding="utf-8"), flags=re.M):
            if m.group(1) not in ids:
                ids.append(m.group(1))
    return ids


def main() -> int:
    day = sys.argv[1] if len(sys.argv) > 1 else None
    ids = ids_from_report(day)
    if not ids:
        print("没有要截的条目")
        return 0
    THUMBS.mkdir(parents=True, exist_ok=True)
    todo = [i for i in ids if not (THUMBS / f"{i}.jpg").exists()]
    print(f"共 {len(ids)} 条，缺缩略图 {len(todo)} 条")

    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8", DSH_DOUYIN_HOME=str(HOME))
    env.pop("DOUYIN_CDP_URL", None)
    p = subprocess.Popen([str(PY), str(SERVER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, cwd=str(HOME), env=env, text=True, encoding="utf-8", bufsize=1)
    seq = [0]

    def rpc(method, params=None):
        seq[0] += 1
        msg = {"jsonrpc": "2.0", "id": seq[0], "method": method}
        if params is not None:
            msg["params"] = params
        p.stdin.write(json.dumps(msg) + "\n")
        p.stdin.flush()
        while True:
            line = p.stdout.readline()
            if not line:
                raise RuntimeError("MCP exited")
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("id") == seq[0]:
                return o.get("result") or {}

    def call(name, args=None):
        r = rpc("tools/call", {"name": name, "arguments": args or {}})
        t = (r.get("content") or [{}])[0].get("text") or "{}"
        try:
            return json.loads(t)
        except Exception:
            return {"raw": t[:200]}

    ok = 0
    try:
        rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                           "clientInfo": {"name": "thumbs", "version": "1"}})
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        p.stdin.flush()
        for i in todo:
            r = call("douyin_thumb", {"aweme_id": i})
            okk = bool(r.get("ok")) and (THUMBS / f"{i}.jpg").exists()
            ok += 1 if okk else 0
            print(("OK  " if okk else "FAIL"), i, r.get("bytes") or r.get("error") or "", flush=True)
    finally:
        try:
            p.terminate()
        except Exception:
            pass
    total = len(list(THUMBS.glob("*.jpg")))
    print(f"完成：这次成功 {ok}/{len(todo)}；缩略图缓存共 {total} 张")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
