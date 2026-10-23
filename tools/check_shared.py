"""并发验证：两个 MCP 客户端同时跑，第二个应该复用同一个浏览器（mode=shared），
而不是抢 profile 锁失败。用法：python tools/check_shared.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

HOME = Path(os.environ.get("DSH_DOUYIN_HOME") or (Path.home() / ".dsh" / "douyin-duty"))
PY = HOME / ".venv" / "Scripts" / "python.exe"
SERVER = HOME / "mcp_server.py"


def one(tag: str) -> dict:
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
                raise RuntimeError(tag + " mcp exit")
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("id") == seq[0]:
                if "error" in o:
                    raise RuntimeError(str(o["error"])[:200])
                return o.get("result") or {}

    def call(n, a=None):
        r = rpc("tools/call", {"name": n, "arguments": a or {}})
        t = (r.get("content") or [{}])[0].get("text") or "{}"
        try:
            return json.loads(t)
        except Exception:
            return {"raw": t[:200]}

    try:
        rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                           "clientInfo": {"name": tag, "version": "1"}})
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        p.stdin.flush()
        sc = call("douyin_selfcheck")
        return {"tag": tag, "mode": sc.get("mode"), "loggedIn": sc.get("loggedIn"),
                "chrome": sc.get("chrome"), "notes": (sc.get("notes") or [])[:3]}
    finally:
        try:
            p.terminate()
        except Exception:
            pass


def main() -> int:
    first = one("A")
    print("A", json.dumps(first, ensure_ascii=False), flush=True)
    # 保持 A 的浏览器活着：A 进程 terminate 之后浏览器会关，所以这里换一种做法 ——
    # 先用一个常驻进程占住浏览器，再跑 B
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8", DSH_DOUYIN_HOME=str(HOME))
    env.pop("DOUYIN_CDP_URL", None)
    hold = subprocess.Popen([str(PY), str(SERVER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=str(HOME), env=env, text=True, encoding="utf-8", bufsize=1)
    seq = [0]

    def rpc2(method, params=None):
        seq[0] += 1
        msg = {"jsonrpc": "2.0", "id": seq[0], "method": method}
        if params is not None:
            msg["params"] = params
        hold.stdin.write(json.dumps(msg) + "\n")
        hold.stdin.flush()
        while True:
            line = hold.stdout.readline()
            if not line:
                raise RuntimeError("hold exit")
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("id") == seq[0]:
                if "error" in o:
                    raise RuntimeError(str(o["error"])[:200])
                return o.get("result") or {}

    try:
        rpc2("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                            "clientInfo": {"name": "hold", "version": "1"}})
        hold.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        hold.stdin.flush()
        # 触发浏览器
        rpc2("tools/call", {"name": "douyin_check_credential", "arguments": {}})
        time.sleep(2)
        second = one("B")
        print("B", json.dumps(second, ensure_ascii=False), flush=True)
        ok = second.get("chrome") is True and second.get("loggedIn") is True and second.get("mode") == "shared"
        print("PASS 第二个客户端复用了同一个浏览器" if ok else "FAIL 第二个客户端没复用（看上面 mode）")
        return 0 if ok else 1
    finally:
        try:
            hold.terminate()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
