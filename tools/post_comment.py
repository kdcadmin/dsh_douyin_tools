"""一次性发评论（用夹带 @ 的正文），自己起 MCP、自己收摊，避开宿主里那份 MCP 的竞争。

python tools/post_comment.py <aweme_id> <text>
"""
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
    aid = sys.argv[1]
    text = sys.argv[2] if len(sys.argv) > 2 else "记下了"
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8", DSH_DOUYIN_HOME=str(HOME))
    env.pop("DOUYIN_CDP_URL", None)
    proc = subprocess.Popen([str(PY), str(SERVER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=str(HOME), env=env, text=True,
                            encoding="utf-8", bufsize=1)
    seq = [0]

    def rpc(method, params=None):
        seq[0] += 1
        msg = {"jsonrpc": "2.0", "id": seq[0], "method": method}
        if params is not None:
            msg["params"] = params
        proc.stdin.write(json.dumps(msg) + "\n")
        proc.stdin.flush()
        while True:
            line = proc.stdout.readline()
            if not line:
                raise RuntimeError("MCP exited: " + (proc.stderr.read() or "")[-300:])
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get("id") == seq[0]:
                if "error" in obj:
                    raise RuntimeError(json.dumps(obj["error"], ensure_ascii=False)[:300])
                return obj.get("result") or {}

    def call(name, args=None):
        r = rpc("tools/call", {"name": name, "arguments": args or {}})
        t = (r.get("content") or [{}])[0].get("text") or "{}"
        try:
            return json.loads(t)
        except Exception:
            return {"raw": t[:300]}

    try:
        rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                           "clientInfo": {"name": "post-comment", "version": "1.0"}})
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        proc.stdin.flush()
        print("CRED", json.dumps(call("douyin_check_credential"), ensure_ascii=False)[:200], flush=True)
        print("POST", json.dumps(call("douyin_comment", {"aweme_id": aid, "text": text}), ensure_ascii=False)[:600], flush=True)
        return 0
    finally:
        try:
            proc.terminate()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
