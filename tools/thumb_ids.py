"""给指定视频 id 批量截缩略图（看画风用）。用法：python tools/thumb_ids.py <id> [id...]"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

HOME = Path(os.environ.get("DSH_DOUYIN_HOME") or (Path.home() / ".dsh" / "douyin-duty"))
PY = HOME / ".venv" / "Scripts" / "python.exe"
SERVER = HOME / "mcp_server.py"


def main() -> int:
    ids = [x for x in sys.argv[1:] if x.strip()]
    if not ids:
        print("给几个视频 id")
        return 1
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

    try:
        rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                           "clientInfo": {"name": "thumb-ids", "version": "1"}})
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        p.stdin.flush()
        for i in ids:
            r = call("douyin_thumb", {"aweme_id": i})
            print(("OK  " if r.get("ok") else "FAIL"), i, r.get("path") or r.get("error") or "")
    finally:
        try:
            p.terminate()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
