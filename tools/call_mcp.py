"""直接调 MCP 的某个工具（给没有宿主封装的工具用，比如 B站 投稿）。

用法：
  python tools/call_mcp.py <tool_name> '<json args>'
  python tools/call_mcp.py --list
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

HOME = Path(os.environ.get("DSH_DOUYIN_HOME") or (Path.home() / ".dsh" / "douyin-duty"))
DEFAULT_PY = HOME / ".venv" / "Scripts" / "python.exe"


def main() -> int:
    home = Path(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] != "--list" else HOME
    py = home / ".venv" / "Scripts" / "python.exe"
    server = home / "mcp_server.py"
    if not server.exists():
        print("找不到 MCP：", server)
        return 1
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8", DSH_DOUYIN_HOME=str(home))
    p = subprocess.Popen([str(py if py.exists() else DEFAULT_PY), str(server)],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         cwd=str(home), env=env, text=True, encoding="utf-8", bufsize=1)
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

    try:
        init = rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                  "clientInfo": {"name": "cli", "version": "1"}})
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        p.stdin.flush()
        if len(sys.argv) > 2 and sys.argv[2] == "--list":
            tools = (init.get("capabilities") or {}).get("tools") or {}
            print("server:", json.dumps(tools, ensure_ascii=False)[:200])
            lst = rpc("tools/list", {})
            for t in lst.get("tools", []):
                print("-", t.get("name"), "|", (t.get("description") or "")[:60].replace("\n", " "))
            return 0
        name = sys.argv[2] if len(sys.argv) > 2 else ""
        raw_args = sys.argv[3] if len(sys.argv) > 3 else "{}"
        if raw_args.startswith("@"):
            raw_args = Path(raw_args[1:]).read_text(encoding="utf-8")
        args = json.loads(raw_args)
        r = rpc("tools/call", {"name": name, "arguments": args})
        text = (r.get("content") or [{}])[0].get("text") or ""
        try:
            print(json.dumps(json.loads(text), ensure_ascii=False)[:2500])
        except Exception:
            print(text[:2500])
        return 0
    finally:
        try:
            p.terminate()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
