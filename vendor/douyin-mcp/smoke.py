#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
最小 MCP stdio 客户端 —— 只用来验收 douyin-mcp 的协议握手 + douyin_selfcheck。

    set PYTHONUTF8=1
    python smoke.py
    python smoke.py --python D:\\path\\python.exe

做的事：
  1) 起 `python mcp_server.py`（stdio）
  2) initialize → notifications/initialized
  3) tools/list（应看到 10 个 douyin_* 工具）
  4) tools/call douyin_selfcheck
  5) 打印结果 JSON（stderr 上的服务端日志原样透出）

stdout 只打最终结果，方便宿主/人直接看。
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROTOCOL = "2025-06-18"


class StdioClient:
    def __init__(self, cmd: list[str], timeout: float = 90.0):
        env = dict(os.environ)
        env["PYTHONUTF8"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        self.proc = subprocess.Popen(
            cmd,
            cwd=str(HERE),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        self.timeout = timeout
        self.lines: queue.Queue[str] = queue.Queue()
        self.next_id = 1
        threading.Thread(target=self._reader, daemon=True).start()
        threading.Thread(target=self._err_reader, daemon=True).start()

    def _reader(self) -> None:
        assert self.proc.stdout is not None
        for raw in self.proc.stdout:
            try:
                line = raw.decode("utf-8", "replace").strip()
            except Exception:
                continue
            if line:
                self.lines.put(line)

    def _err_reader(self) -> None:
        assert self.proc.stderr is not None
        for raw in self.proc.stderr:
            try:
                print("[server] " + raw.decode("utf-8", "replace").rstrip(), file=sys.stderr)
            except Exception:
                pass

    def send(self, obj: dict) -> None:
        assert self.proc.stdin is not None
        data = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def request(self, method: str, params: dict | None = None, timeout: float | None = None) -> dict:
        rid = self.next_id
        self.next_id += 1
        msg = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            msg["params"] = params
        self.send(msg)
        end = time.time() + (timeout or self.timeout)
        while time.time() < end:
            try:
                line = self.lines.get(timeout=max(0.1, end - time.time()))
            except queue.Empty:
                break
            try:
                obj = json.loads(line)
            except Exception:
                print(f"[skip non-json] {line[:200]}", file=sys.stderr)
                continue
            if obj.get("id") == rid:
                return obj
            # 服务端通知/日志帧忽略
        raise TimeoutError(f"{method} 超时（{timeout or self.timeout}s）")

    def notify(self, method: str, params: dict | None = None) -> None:
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        self.send(msg)

    def close(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", default=sys.executable, help="解释器路径")
    parser.add_argument("--timeout", type=float, default=120.0)
    args = parser.parse_args()

    client = StdioClient([args.python, str(HERE / "mcp_server.py")], timeout=args.timeout)
    result: dict = {"ok": False}
    try:
        init = client.request("initialize", {
            "protocolVersion": PROTOCOL,
            "capabilities": {},
            "clientInfo": {"name": "douyin-mcp-smoke", "version": "0.1.0"},
        })
        server_info = (init.get("result") or {}).get("serverInfo") or {}
        client.notify("notifications/initialized")

        tools = client.request("tools/list", {})
        names = [t.get("name") for t in ((tools.get("result") or {}).get("tools") or [])]

        call = client.request("tools/call", {"name": "douyin_selfcheck", "arguments": {}},
                              timeout=max(args.timeout, 120))
        content = (call.get("result") or {}).get("content") or []
        payload = None
        for part in content:
            if part.get("type") == "text":
                try:
                    payload = json.loads(part.get("text") or "")
                except Exception:
                    payload = part.get("text")
                break

        result = {
            "ok": True,
            "protocolVersion": (init.get("result") or {}).get("protocolVersion"),
            "serverInfo": server_info,
            "toolCount": len(names),
            "tools": names,
            "selfcheck": payload,
        }
    except Exception as exc:  # noqa: BLE001
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    finally:
        client.close()

    print(json.dumps(result, ensure_ascii=False, indent=2))
    selfcheck = result.get("selfcheck") or {}
    return 0 if result.get("ok") and isinstance(selfcheck, dict) and selfcheck.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
