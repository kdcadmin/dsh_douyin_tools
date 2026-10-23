"""扫码登录取证：自己起 MCP -> 出码 -> 每 3 秒查一次，状态写进 login-watch.log。

python tools/login_watch2.py [秒数]
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
LOG = HOME / "login-watch.log"
QR = HOME / "login-qr.png"
DEADLINE = float(sys.argv[1]) if len(sys.argv) > 1 else 240.0


def log(msg: str) -> None:
    line = time.strftime("%H:%M:%S") + " " + msg
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def main() -> int:
    LOG.write_text("", encoding="utf-8")
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8", DSH_DOUYIN_HOME=str(HOME))
    env.pop("DOUYIN_CDP_URL", None)
    proc = subprocess.Popen(
        [str(PY), str(SERVER)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=str(HOME), env=env, text=True, encoding="utf-8", bufsize=1,
    )
    seq = [0]

    def rpc(method: str, params=None) -> dict:
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

    def call(name: str, args=None) -> dict:
        r = rpc("tools/call", {"name": name, "arguments": args or {}})
        content = (r.get("content") or [{}])[0]
        text = content.get("text") or "{}"
        try:
            return json.loads(text)
        except Exception:
            return {"raw": text[:300]}

    try:
        rpc("initialize", {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "login-watch", "version": "1.1"},
        })
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        proc.stdin.flush()

        qr = call("douyin_login_qr")
        log("QR " + json.dumps({k: qr.get(k) for k in ("ok", "png", "bytes", "hint")}, ensure_ascii=False))
        log("QR_FILE exists=%s size=%s" % (QR.exists(), QR.stat().st_size if QR.exists() else 0))

        t0 = time.time()
        last = ""
        while time.time() - t0 < DEADLINE:
            time.sleep(3)
            st = call("douyin_login_poll")
            key = json.dumps(st, ensure_ascii=False)[:400]
            if key != last:
                log("POLL " + key)
                last = key
            if st.get("loggedIn"):
                log("LOGGED_IN " + json.dumps({k: st.get(k) for k in ("nickname", "uid")}, ensure_ascii=False))
                return 0
        log("TIMEOUT")
        return 2
    finally:
        try:
            proc.terminate()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
