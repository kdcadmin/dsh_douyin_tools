"""一次性验证写操作（点赞 + 取消点赞）。用法：python tools/check_like.py <aweme_id>"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

HOME = Path(os.environ.get("DSH_DOUYIN_HOME") or (Path.home() / ".dsh" / "douyin-duty"))
PY = HOME / ".venv" / "Scripts" / "python.exe"
SERVER = HOME / "mcp_server.py"
AID = sys.argv[1] if len(sys.argv) > 1 else "7683311350021508390"


def main() -> int:
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
                raise RuntimeError("MCP exited")
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
        text = (r.get("content") or [{}])[0].get("text") or "{}"
        try:
            return json.loads(text)
        except Exception:
            return {"raw": text[:300]}

    try:
        rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                           "clientInfo": {"name": "check-like", "version": "1.0"}})
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        proc.stdin.flush()
        print("WORDS", json.dumps(call("douyin_selfcheck"), ensure_ascii=False)[:160])
        print("LIKE", json.dumps(call("douyin_like", {"aweme_id": AID, "undo": False}), ensure_ascii=False)[:400])
        print("UNDO", json.dumps(call("douyin_like", {"aweme_id": AID, "undo": True}), ensure_ascii=False)[:400])
        return 0
    finally:
        try:
            proc.terminate()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
