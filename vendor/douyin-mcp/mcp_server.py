#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
抖音 MCP 服务（douyin-mcp）
==========================

用 Playwright 驱动**本机已安装的 Chrome**（`channel="chrome"`），持久化 profile 记住登录态，
给 dsh-douyin-life 宿主半边提供 10 个工具。接口契约见插件根目录 SPEC.md 第 2 节。

设计要点
--------
* MCP over stdio（FastMCP）；stdout 只出协议帧，日志全部走 stderr。
* 所有工具都有超时（默认 45s），异常统一转成 {"ok": false, ...}，不崩。
* 未登录：{"ok": false, "needLogin": true, "hint": "..."}。
* 登录态证据 = cookie（sessionid / sessionid_ss / sid_tt）+ 页面头像，两样都报出来。
* 数据优先从页面自身发出的 XHR 里抓（/aweme/detail/、/comment/list/、search/single），
  因为 DOM class 是哈希的；DOM 只做兜底。抓不到就返回空数组 + notes，**不编数据**。
* 选择器全部多套候选，`data-e2e` 优先。

本地调试
--------
    set PYTHONUTF8=1
    python mcp_server.py --selftest
    python smoke.py                 # 最小 stdio 客户端握手 + douyin_selfcheck

家目录
------
%USERPROFILE%\\.dsh\\douyin-duty\\        （可用 DSH_DOUYIN_HOME 覆盖）
    browser\\         Playwright 持久化 profile
    login-qr.png     最近一次二维码
"""
from __future__ import annotations

import argparse
import asyncio
from contextvars import ContextVar
import base64
import hashlib
import functools
import inspect
import json
import os
import re
import subprocess
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

try:  # 宿主已设 PYTHONUTF8=1；这里再兜一层，避免 GBK 控制台炸
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # pragma: no cover
    pass

from mcp.server.fastmcp import FastMCP

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

APP_NAME = "douyin-mcp"
# 按本插件任务口径：家目录固定在 %USERPROFILE%\.dsh\douyin-duty（宿主会把脚本铺到这里再启动）。
# 需要换位置时用 DSH_DOUYIN_HOME（宿主可传），不要用 DSH_HOME —— 那是 dsh 自己的家。
HOME = Path(os.environ.get("DSH_DOUYIN_HOME") or (Path.home() / ".dsh" / "douyin-duty"))
PROFILE_DIR = HOME / "browser"
QR_PNG = HOME / "login-qr.png"

HOME_URL = "https://www.douyin.com/"
VIDEO_URL = "https://www.douyin.com/video/{aweme_id}"
NOTE_URL = "https://www.douyin.com/note/{aweme_id}"

# aweme_id -> aweme_type（68/211 图文，0/55 视频）；detail XHR 一到就记下来
_AWEME_TYPE_CACHE: dict[str, int] = {}
SEARCH_URL = "https://www.douyin.com/search/{kw}?type={type}"
CREATOR_UPLOAD = "https://creator.douyin.com/creator-micro/content/upload"

HEADLESS = os.environ.get("DOUYIN_HEADLESS", "1") != "0"
# 带界面打开时，若为登录流程，浏览器起来后自动打开抖音登录页（扫码/短信都在这个窗口完成）
OPEN_LOGIN = os.environ.get("DOUYIN_OPEN_LOGIN", "0") == "1"
# ⭐ 复用「本人已经登录的 Chrome」：宿主设了 DOUYIN_CDP_URL（默认 http://127.0.0.1:9222）就先连它。
#   连不上才退回插件自己的持久 profile（那条要扫一次码）。
CDP_URL = (os.environ.get("DOUYIN_CDP_URL") or "").strip()
DEFAULT_TIMEOUT = float(os.environ.get("DOUYIN_MCP_TIMEOUT", "45"))
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
)

# 登录/二维码（实测 2026-10-23）
PANEL_SELS = [
    "#douyin_login_comp_flat_panel",
    "#douyin_login_landing_flat_container",
    "article[id*='login']",
]
QR_SELS = [
    "img[aria-label='二维码']",
    "#animate_qrcode_container img",
    "#douyin_login_comp_scan_code img",
    "img[aria-label*='二维码']",
]
AVATAR_SELS = [
    "[data-e2e='user-avatar']",
    "header img[src*='aweme-avatar']",
    "header [class*='avatar'] img",
    "img[aria-label='头像']",
]

SEND_TEXTS = ["发送", "评论"]
LOGIN_TEXTS = ["登录"]


# ---------------------------------------------------------------------------
# 日志 / JSON
# ---------------------------------------------------------------------------

def log(msg: str) -> None:
    print(f"[{APP_NAME}] {msg}", file=sys.stderr, flush=True)


def j(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)


RUNTIME = {"version": "0.2.1", "pid": os.getpid(), "script": str(Path(__file__).resolve()), "scriptHash": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}

def _ok(**kw):
    d = {"ok": True, "runtime": RUNTIME}
    d.update(kw)
    return d


def _err(msg: str, **kw):
    d = {"ok": False, "error": msg, "runtime": RUNTIME}
    d.update(kw)
    return d


def _need_login(hint: str, **kw):
    d = {"ok": False, "needLogin": True, "hint": hint}
    d.update(kw)
    return d


def _fmt_ts(ts) -> str:
    try:
        ts = int(ts)
        if ts <= 0:
            return ""
        return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return ""


def _extract_aweme_id(value: str) -> str:
    if not value:
        return ""
    s = str(value).strip()
    m = re.search(r"/video/(\d{6,})", s)
    if m:
        return m.group(1)
    m = re.search(r"(?:aweme_id|modal_id|item_id)=(\d{6,})", s)
    if m:
        return m.group(1)
    m = re.fullmatch(r"(\d{6,})", s)
    if m:
        return m.group(1)
    m = re.search(r"(\d{15,})", s)
    return m.group(1) if m else ""


def _num(text) -> int:
    """把 '3.0万' / '1.2亿' / '2120' 这类展示值换成整数；失败返回 0。"""
    if text is None:
        return 0
    if isinstance(text, (int, float)):
        return int(text)
    s = str(text).strip().replace(",", "").replace(" ", "")
    if not s:
        return 0
    mult = 1
    if s.endswith("万") or s.endswith("w") or s.endswith("W"):
        mult, s = 10000, s[:-1]
    elif s.endswith("亿"):
        mult, s = 100000000, s[:-1]
    try:
        return int(float(s) * mult)
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# 浏览器
# ---------------------------------------------------------------------------

SHARED_PORT = int(os.environ.get("DOUYIN_PROFILE_PORT", "9333"))

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    str(Path(os.environ.get("LOCALAPPDATA") or "") / "Google" / "Chrome" / "Application" / "chrome.exe"),
    str(Path(os.environ.get("LOCALAPPDATA") or "") / "Chromium" / "Application" / "chrome.exe"),
]


def _find_chrome() -> str:
    env = os.environ.get("DOUYIN_CHROME_PATH", "").strip()
    if env and Path(env).is_file():
        return env
    for c in CHROME_CANDIDATES:
        if c and Path(c).is_file():
            return c
    return ""


EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    str(Path(os.environ.get("LOCALAPPDATA") or "") / "Microsoft" / "Edge" / "Application" / "msedge.exe"),
]


def _find_edge() -> str:
    env = os.environ.get("DOUYIN_EDGE_PATH", "").strip()
    for c in ([env] if env else []) + EDGE_CANDIDATES:
        try:
            if c and Path(c).is_file():
                return c
        except Exception:
            continue
    return ""


def _browser_channel():
    """返回 (channel, exe)：优先 Chrome，没有就 Edge，都没有就 None（用 Playwright 自带 Chromium）。"""
    explicit = os.environ.get("DOUYIN_BROWSER_CHANNEL", "").strip().lower()
    chrome, edge = _find_chrome(), _find_edge()
    if explicit in ("chrome", "msedge", "msedge-beta", "msedge-dev", "msedge-canary"):
        return explicit, (chrome if explicit == "chrome" else edge)
    if chrome:
        return "chrome", chrome
    if edge:
        return "msedge", edge
    return None, ""


BROWSER_CHANNEL, BROWSER_EXE = _browser_channel()


def _port_open(port: int, timeout: float = 0.6) -> bool:
    import socket
    s = socket.socket()
    s.settimeout(timeout)
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    finally:
        try:
            s.close()
        except Exception:
            pass


def _launch_chrome_detached() -> bool:
    """把 Chrome 当**独立进程**拉起来（不挂在 Playwright 上）。

    2026-10-23 事故：浏览器是 MCP 用 launch_persistent_context 起的 ⇒ MCP 一收摊，浏览器跟着死 ⇒
    那一轮后面的点赞/评论全部 `TargetClosedError`（「没发出去」）。改成独立进程 + CDP 连接后，
    MCP 重启多少次浏览器都还活着，登录态也一直在。
    """
    exe = _find_chrome()
    if not exe:
        log("没找到 chrome.exe（可用 DOUYIN_CHROME_PATH 指定）")
        return False
    args = [
        exe,
        f"--remote-debugging-port={SHARED_PORT}",
        "--remote-allow-origins=*",
        f"--user-data-dir={PROFILE_DIR}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled",
        # 与探针（headless 新无头）保持同一套渲染：带界面的窗口里抖音会换一套更"精简"的评论区，
        # 「发送」按钮不出现（2026-10-23 实测：同样代码 headless 能提交、带界面不行）
        "--mute-audio",
        # ⭐ 必须是**带界面**的窗口：无头模式下抖音给的是"精简版"评论区（没有发送按钮、没有 @ 联想面板）。
        #    实测对比：headless=new ⇒ 找不到发送、打 @ 不出人；headed + 1440×900 ⇒ 正常。
        "--window-size=1440,900",
        "--window-position=-32000,-32000",
    ]
    try:
        creationflags = 0
        if os.name == "nt":
            creationflags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=creationflags, close_fds=True)
        log(f"独立拉起 Chrome：{exe} --remote-debugging-port={SHARED_PORT}")
        return True
    except Exception as exc:  # noqa: BLE001
        log(f"独立拉起 Chrome 失败：{type(exc).__name__}: {exc}")
        return False


class BrowserManager:
    def __init__(self) -> None:
        self._pw = None
        self._ctx = None
        self._browser = None
        self._own_page = None
        self._chat_page = None
        self.owned_pages = set()
        self.mode = "profile"          # profile | cdp
        self._login_page_opened = False
        self.cdp_note = ""
        self.lock = asyncio.Lock()

    async def _connect_cdp(self):
        """连本人已经登录的 Chrome（CDP）。连不上抛异常，由调用方退回持久 profile。"""
        browser = await self._pw.chromium.connect_over_cdp(CDP_URL, timeout=8000)
        ctx = browser.contexts[0] if browser.contexts else await browser.new_context(locale="zh-CN")
        self._browser = browser
        self.mode = "cdp"
        self.cdp_note = f"CDP {CDP_URL}"
        return ctx

    async def context(self):
        if self._ctx is not None:
            try:
                if self._browser is not None and not self._browser.is_connected():
                    raise RuntimeError("CDP 已断连")
                if self._browser is None and not self._ctx.pages:
                    raise RuntimeError("浏览器上下文已关闭")
                return self._ctx
            except Exception:
                self._ctx = None
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "没装 playwright，先跑 pip install -r requirements.txt"
            ) from exc

        HOME.mkdir(parents=True, exist_ok=True)
        PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        self._pw = await async_playwright().start()

        # ⭐ 先看有没有**别的会话**已经把这个 profile 的 Chrome 开着了（同一份 profile 只允许一个 Chrome）。
        #    2026-10-23 事故：交互会话 + 值班那一轮各起了一个 MCP ⇒ 4 个 MCP / 10 个 Chrome 抢同一份 profile，
        #    抢输的那个 launch 直接 TargetClosedError ⇒ 读不到 cookie ⇒ 报告里写成 "needLogin"（其实是锁冲突）。
        #    解法：插件自己固定一个调试端口；端口通就连它（共享同一个浏览器），不通才由本进程拉起。
        try:
            if CDP_URL:
                raise RuntimeError("优先使用显式 CDP 地址")
            self._browser = await self._pw.chromium.connect_over_cdp(f"http://127.0.0.1:{SHARED_PORT}", timeout=3000)
            self._ctx = self._browser.contexts[0] if self._browser.contexts else await self._browser.new_context(locale="zh-CN")
            self._ctx.set_default_timeout(15000)
            self._ctx.set_default_navigation_timeout(40000)
            self.mode = "shared"
            self.cdp_note = f"复用已开的浏览器（端口 {SHARED_PORT}）"
            log(f"复用已开的浏览器：127.0.0.1:{SHARED_PORT}（别的会话开着同一个 profile）")
            return self._ctx
        except Exception:
            self._browser = None
            self._ctx = None

        # ⭐ 端口不通 ⇒ 默认用 **Playwright 拉起**（带上 9333 端口，别人可以连进来共享）。
        #    为什么不用裸 chrome.exe：实测（2026-10-23）裸 chrome + CDP 连过去时，抖音给的是
        #    "精简版"评论区 —— **没有发送按钮、打 @ 也不出联想面板**；Playwright 拉起的那份是完整 UI
        #    （Ctrl+Enter 能提交、@ 有候选）。所以"owner"必须由 Playwright 起，其它会话连过来共享。
        #    需要裸 chrome（只想读、不要写）时设 DOUYIN_DETACHED=1。
        if os.environ.get("DOUYIN_DETACHED") == "1" and not _port_open(SHARED_PORT) and _find_chrome():
            _launch_chrome_detached()
            for _ in range(20):
                await asyncio.sleep(0.5)
                if _port_open(SHARED_PORT):
                    break
        if _port_open(SHARED_PORT) and os.environ.get("DOUYIN_DETACHED") == "1":
            try:
                self._browser = await self._pw.chromium.connect_over_cdp(f"http://127.0.0.1:{SHARED_PORT}", timeout=8000)
                self._ctx = self._browser.contexts[0] if self._browser.contexts else await self._browser.new_context(locale="zh-CN")
                self._ctx.set_default_timeout(15000)
                self._ctx.set_default_navigation_timeout(40000)
                self.mode = "shared"
                self.cdp_note = f"独立 Chrome（端口 {SHARED_PORT}）"
                log(f"已连上独立进程的 Chrome：127.0.0.1:{SHARED_PORT}")
                return self._ctx
            except Exception as exc:  # noqa: BLE001
                log(f"连独立 Chrome 失败（退回 Playwright 拉起）：{type(exc).__name__}: {exc}")
                self._browser = None
                self._ctx = None

        if CDP_URL:
            try:
                self._ctx = await self._connect_cdp()
                self._ctx.set_default_timeout(15000)
                self._ctx.set_default_navigation_timeout(40000)
                log(f"已连上本人 Chrome：{CDP_URL}（登录态直接用）")
                return self._ctx
            except Exception as exc:  # noqa: BLE001
                # ⭐ 默认不因为 CDP 没开就整个失败：退回插件自己的持久 profile（首次扫码）。
                #    想强制 CDP 才用 DOUYIN_CDP_STRICT=1。
                if os.environ.get("DOUYIN_CDP_STRICT") == "1":
                    try:
                        await self._pw.stop()
                    except Exception:
                        pass
                    self._pw = None
                    self._browser = None
                    raise RuntimeError(f"显式 CDP 地址不可用：{CDP_URL}") from exc
                log(f"CDP 地址不可用（{CDP_URL}），退回插件自有 profile：{type(exc).__name__}: {exc}")
                self._browser = None
                self._ctx = None
        try:
            self._ctx = await self._pw.chromium.launch_persistent_context(
                str(PROFILE_DIR),
                **({"channel": BROWSER_CHANNEL} if BROWSER_CHANNEL else {}),
                headless=HEADLESS,
                locale="zh-CN",
                viewport={"width": 1440, "height": 900},
                user_agent=UA,
                accept_downloads=True,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-features=Translate",
                    # ⭐ 让"本进程拉起的这个 Chrome"能被别的 MCP 进程连上（共享同一份 profile）
                    f"--remote-debugging-port={SHARED_PORT}",
                    "--remote-allow-origins=*",
                ],
            )
        except Exception:
            try:
                await self._pw.stop()
            finally:
                self._pw = None
            raise
        self._ctx.set_default_timeout(15000)
        self._ctx.set_default_navigation_timeout(40000)
        self.mode = "profile"
        log(f"浏览器起来了：channel={BROWSER_CHANNEL or 'bundled'} profile={PROFILE_DIR} headless={HEADLESS}")
        if OPEN_LOGIN and not self._login_page_opened:
            self._login_page_opened = True
            try:
                pg = await self._ctx.new_page()
                await _goto(pg, "https://www.douyin.com/jingxuan", settle=3)
                for sel in ("text=登录", "[data-e2e='login-button']"):
                    try:
                        loc = pg.locator(sel).first
                        if await loc.count():
                            await loc.click(timeout=4000)
                            break
                    except Exception:
                        continue
                log("登录页已打开（带界面）：扫码或短信验证码都在这个窗口里完成")
            except Exception as exc:
                log(f"打开登录页失败：{type(exc).__name__}: {exc}")
        return self._ctx

    async def page_chat(self):
        """私信/聊天专用的第二个标签页：刷视频那一页在跑的时候，回消息不抢同一个页面。"""
        ctx = await self.context()
        if self._chat_page is not None and not self._chat_page.is_closed():
            return self._chat_page
        self._chat_page = await ctx.new_page()
        return self._chat_page

    async def page(self):
        ctx = await self.context()
        if self._own_page is not None and not self._own_page.is_closed():
            return self._own_page
        self.owned_pages.discard(self._own_page)
        self._own_page = await ctx.new_page()
        self.owned_pages.add(self._own_page)
        return self._own_page

    async def close(self) -> None:
        watcher = globals().get('_dm_event_watcher')
        if watcher is not None:
            await watcher.close()
        # cdp / shared 模式：只关我们开的那一个标签页 + 断开连接，
        # **不许关掉浏览器/上下文**（那可能是别的会话正在用的同一个 Chrome）
        shared = self.mode in ("cdp", "shared")
        try:
            if shared and self._own_page is not None and not self._own_page.is_closed():
                await self._own_page.close()
            if shared and self._chat_page is not None and not self._chat_page.is_closed():
                await self._chat_page.close()
        except Exception:
            pass
        self._own_page = None
        self.owned_pages.clear()
        try:
            if self._ctx is not None and not shared:
                await self._ctx.close()
        except Exception:
            pass
        try:
            if self._browser is not None and not shared:
                await self._browser.close()
        except Exception:
            pass
        try:
            if self._pw is not None:
                await self._pw.stop()   # 对 CDP 连接来说这只是断开，不会杀掉浏览器
        except Exception:
            pass
        self._ctx = None
        self._pw = None
        self._browser = None


_browser = BrowserManager()


class DmEventWatcher:
    """Wake-up hints only. No frame payload, credentials or message text leave this watcher."""
    SELECTOR = '[data-message-id],[data-msg-id],[data-e2e="conversation-item"],[class*="MessageItem"],[class*="MessageList"]'

    def __init__(self):
        self.context = None
        self.pages = {}
        self.tasks = set()
        self.queue = asyncio.Queue(maxsize=1)
        self.stopped = False
        self.sequence = 0

    def _spawn(self, coro):
        if self.stopped:
            coro.close()
            return
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        task.add_done_callback(lambda t: None if t.cancelled() else t.exception())

    def _emit(self, reason):
        if self.stopped: return
        self.sequence += 1
        if self.queue.full():
            try: self.queue.get_nowait()
            except asyncio.QueueEmpty: pass
        self.queue.put_nowait({"changed": True, "reason": reason, "sequence": self.sequence})

    @staticmethod
    def _douyin(page):
        host = (urlparse(str(page.url)).hostname or '').lower()
        return host == 'douyin.com' or host.endswith('.douyin.com')

    async def start(self, context):
        if self.context is context and not self.stopped:
            return
        if self.context is not None:
            await self.close()
        self.stopped = False
        self.context = context
        self._on_page = lambda page: self._spawn(self.bind(page))
        context.on('page', self._on_page)
        for page in list(context.pages):
            await self.bind(page)
        self._emit('connected')

    async def bind(self, page):
        for old in list(self.pages):
            if old.is_closed(): self.pages.pop(old, None)
        if page in self.pages or len(self.pages) >= 8 or self.stopped:
            return
        info = {"listeners": [], "signature": None, "pending": False}
        self.pages[page] = info
        def listen(target, event, fn):
            target.on(event, fn)
            info['listeners'].append((target, event, fn))
        def hint(reason):
            self._hint(page, reason)
        def socket(ws):
            # Actual transport names vary; a frame only schedules a DOM comparison.
            # Heartbeats and irrelevant frames cannot trigger a reply without a changed snapshot.
            listen(ws, 'framereceived', lambda *_: hint('websocket'))
        listen(page, 'websocket', socket)
        listen(page, 'response', lambda r: hint('http') if any(s in str(r.url).lower() for s in ('/im/', '/message/', '/conversation/', '/inbox/')) else None)
        listen(page, 'domcontentloaded', lambda *_: self._spawn(self._install(page, info)))
        try:
            await page.expose_function('__dshDyMessageChanged', lambda: hint('dom'))
        except Exception:
            pass  # Binding can already exist after navigation or watcher restart.
        await self._install(page, info)

    def _hint(self, page, reason):
        # Resolve current state on each callback: exposed bindings survive restart/navigation.
        info = self.pages.get(page)
        if info is not None and not self.stopped and self._douyin(page) and not info['pending']:
            info['pending'] = True
            self._spawn(self._changed(page, info, reason))

    async def _install(self, page, info):
        if self.stopped or page.is_closed() or not self._douyin(page): return
        try:
            await page.evaluate(r"""(selector) => {
                window.__dshDyMessageObserver?.disconnect();
                const relevant=n=>{const e=n?.nodeType===1?n:n?.parentElement;return !!e&&(e.matches(selector)||e.closest(selector)||e.querySelector(selector))};
                window.__dshDyMessageObserver=new MutationObserver(changes=>{
                    if(changes.some(c=>relevant(c.target)||[...c.addedNodes,...c.removedNodes].some(relevant)))
                        window.__dshDyMessageChanged?.();
                });
                window.__dshDyMessageObserver.observe(document.body,{subtree:true,childList:true,characterData:true,
                    attributes:true,attributeFilter:['src','data-message-id','data-msg-id','data-direction']});
            }""", self.SELECTOR)
            await self._changed(page, info, 'page-ready')
        except Exception:
            pass  # Page navigation/disconnection is repaired on the next start/reconcile.

    async def _changed(self, page, info, reason, emit=True):
        try:
            await asyncio.sleep(0.15)
            if self.stopped or page.is_closed() or not self._douyin(page): return
            value = await page.evaluate(r"""(selector) => Array.from(document.querySelectorAll(selector)).slice(-120).map(e=>[
                e.getAttribute('data-message-id')||e.getAttribute('data-msg-id')||'',
                (e.innerText||'').slice(-1500),Array.from(e.querySelectorAll('img')).map(x=>x.currentSrc||x.src)
            ])""", self.SELECTOR)
            signature = hashlib.sha256(json.dumps(value, ensure_ascii=False).encode()).hexdigest()
            if signature != info['signature']:
                info['signature'] = signature
                if emit: self._emit(reason)
        except Exception:
            pass
        finally:
            info['pending'] = False

    async def acknowledge(self):
        # Switching conversations during a read creates DOM changes of our own.
        # Settle those before draining hints; next incoming change still wakes the waiter.
        pending = list(self.tasks)
        if pending: await asyncio.gather(*pending, return_exceptions=True)
        for page, info in list(self.pages.items()):
            await self._changed(page, info, 'reconciled', emit=False)
        while not self.queue.empty():
            try: self.queue.get_nowait()
            except asyncio.QueueEmpty: break

    async def wait(self, seconds=25):
        try:
            event = await asyncio.wait_for(self.queue.get(), timeout=max(0.01, min(float(seconds), 30)))
        except asyncio.TimeoutError:
            event = {"changed": False, "reason": "heartbeat", "sequence": self.sequence}
        closed = event.get('reason') == 'closed'
        return {"ok": not closed, "mode": "events", **event, **({"error": "消息监听已关闭"} if closed else {})}

    async def close(self):
        self.stopped = True
        if self.context:
            try: self.context.remove_listener('page', self._on_page)
            except Exception: pass
        for page, info in list(self.pages.items()):
            for target, event, fn in info['listeners']:
                try: target.remove_listener(event, fn)
                except Exception: pass
            if not page.is_closed() and self._douyin(page):
                try: await asyncio.wait_for(page.evaluate('() => window.__dshDyMessageObserver?.disconnect()'), 2)
                except Exception: pass
        tasks = list(self.tasks)
        for task in tasks: task.cancel()
        if tasks: await asyncio.gather(*tasks, return_exceptions=True)
        self.pages.clear()
        self.context = None
        while not self.queue.empty():
            try: self.queue.get_nowait()
            except asyncio.QueueEmpty: break
        self.queue.put_nowait({"changed": False, "reason": "closed", "sequence": self.sequence})


_dm_event_watcher = None


_OPERATION = ContextVar("douyin_operation", default=None)


def _submitted():
    operation = _OPERATION.get()
    if operation is not None:
        operation["submitted"] = True


async def _guard(factory, timeout=DEFAULT_TIMEOUT):
    operation = {"submitted": False}
    async def inner():
        async with _browser.lock:
            token = _OPERATION.set(operation)
            try:
                return await factory()
            finally:
                _OPERATION.reset(token)
    try:
        return await asyncio.wait_for(inner(), timeout=timeout)
    except asyncio.TimeoutError:
        return _err("操作超时", status="unknown" if operation["submitted"] else "failed", timeout=timeout)
    except Exception as exc:
        log(traceback.format_exc())
        if "needLogin:" in str(exc):
            return _need_login(str(exc))
        return _err(f"{type(exc).__name__}: {exc}", status="unknown" if operation["submitted"] else "failed")


CAPTCHA_FLAG = HOME / ".need-captcha"


def _captcha_flag_set() -> bool:
    try:
        return CAPTCHA_FLAG.exists()
    except Exception:
        return False


async def _note_captcha(page) -> bool:
    """看到抖音验证码就留个标记，插件那边会据此把浏览器切到「带界面」，等本人手动过。"""
    try:
        hit = await page.evaluate("""() => {
            // 只认「真的显示出来」的验证码框：抖音页面里常驻一个隐藏的 verify iframe，不能据此判断
            const fs = Array.from(document.querySelectorAll('iframe[src*="nocaptcha"], iframe[src*="captcha"], [class*="captcha"]'));
            return fs.some((e) => {
                const r = e.getBoundingClientRect();
                const st = getComputedStyle(e);
                return r.width > 120 && r.height > 120 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity || 1) > 0.1;
            });
        }""")
    except Exception:
        hit = False
    try:
        if hit:
            CAPTCHA_FLAG.write_text(str(time.time()), encoding="utf-8")
        elif CAPTCHA_FLAG.exists():
            CAPTCHA_FLAG.unlink()
    except Exception:
        pass
    return bool(hit)


async def _goto(page, url: str, settle: float = 3.0) -> None:
    """跳页面，容忍抖音常见的 ERR_ABORTED / 连接被重置（重试两次，最后用 commit 兜底）。"""
    last = None
    for attempt in range(3):
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            last = None
            break
        except Exception as exc:
            last = exc
            msg = f"{type(exc).__name__}: {exc}"
            # 已经跳到目标页（只是资源没加载完）就算成功
            try:
                cur = page.url or ""
            except Exception:
                cur = ""
            if url.split("?")[0].rstrip("/") in cur:
                log(f"goto {url} 容忍：{msg[:80]}")
                last = None
                break
            log(f"goto {url} 第 {attempt + 1} 次失败：{msg[:100]}")
            await page.wait_for_timeout(1500)
            if attempt == 2:
                try:
                    await page.goto(url, wait_until="commit", timeout=20000)
                    last = None
                except Exception as exc2:
                    last = exc2
    if last is not None:
        raise last
    if settle > 0:
        await page.wait_for_timeout(int(settle * 1000))


async def _sweep_tabs(page, keep_max: int = 3) -> None:
    """把开出来的多余标签页收掉（之前共用 Chrome 时泄漏到 39 个标签，越跑越卡）。"""
    try:
        ctx = page.context
        pages = list(ctx.pages)
        if len(pages) <= keep_max:
            return
        keep = {id(page)}
        # 保留当前页 + 第一个 douyin 页
        for pg in pages:
            try:
                if "douyin.com" in (pg.url or "") and len(keep) < 2:
                    keep.add(id(pg))
                    break
            except Exception:
                continue
        closed = 0
        for pg in pages:
            if id(pg) in keep:
                continue
            try:
                await pg.close()
                closed += 1
            except Exception:
                continue
        if closed:
            log(f"收掉多余标签 {closed} 个（剩 {len(ctx.pages)}）")
    except Exception:
        pass


async def _first_of(page, selectors, timeout_ms: int = 1200):
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            if await loc.count() and await loc.is_visible(timeout=timeout_ms):
                return loc
        except Exception:
            continue
    return None


async def _visible_text(page, text: str, exact: bool = True, limit: int = 12):
    try:
        loc = page.get_by_text(text, exact=exact)
        n = await loc.count()
    except Exception:
        return None
    for i in range(min(n, limit)):
        try:
            item = loc.nth(i)
            if await item.is_visible(timeout=400):
                return item
        except Exception:
            continue
    return None


async def _click_text(page, text: str, exact: bool = True) -> bool:
    loc = await _visible_text(page, text, exact=exact)
    if loc is None:
        return False
    try:
        await loc.click(timeout=5000)
        return True
    except Exception as exc:
        log(f"click '{text}' fail: {exc}")
        return False


async def _body_text(page, limit: int = 4000) -> str:
    try:
        return (await page.inner_text("body"))[:limit]
    except Exception:
        return ""


async def _has_login_wall(page) -> bool:
    t = await _body_text(page, 16000)
    if ("登录后即可搜索" in t) or ("扫码登录" in t) or ("请先登录" in t):
        return True
    return await _first_of(page, QR_SELS + PANEL_SELS, 400) is not None


async def _login_state(page, ctx) -> dict:
    """cookie + 页面头像两种证据。"""
    session = ""
    uid = ""
    try:
        cookies = await ctx.cookies(["https://www.douyin.com", "https://creator.douyin.com"])
        vals = {c.get("name"): c.get("value") or "" for c in cookies}
        session = vals.get("sessionid") or vals.get("sessionid_ss") or vals.get("sid_tt") or ""
        uid = vals.get("uid_tt") or vals.get("uid_tt_ss") or ""
    except Exception as exc:
        log(f"read cookies fail: {exc}")

    avatar = False
    nickname = ""
    if page is not None:
        for sel in AVATAR_SELS:
            try:
                loc = page.locator(sel).first
                if await loc.count() and await loc.is_visible(timeout=500):
                    avatar = True
                    nickname = (await loc.get_attribute("alt")) or ""
                    break
            except Exception:
                continue

    login_prompt = False
    if page is not None:
        try:
            login_prompt = bool(await _visible_text(page, "登录", exact=True, limit=3))
        except Exception:
            login_prompt = False

    logged_in = bool(session) or avatar
    # cookie 在但页面明确还在喊登录 => 视为过期
    if session and not avatar and login_prompt:
        logged_in = False
    if logged_in and not nickname and page is not None:
        # 头像没有 alt 时从 DOM 里找一下，找不到就留空，不编
        try:
            nickname = await page.evaluate(
                r"""() => {
                    const img = document.querySelector('header img[src*="aweme-avatar"]');
                    if (img && img.alt) return img.alt;
                    const el = document.querySelector('[data-e2e="user-avatar"]');
                    return el ? (el.getAttribute('alt') || '') : '';
                }"""
            ) or ""
        except Exception:
            nickname = ""

    return {
        "loggedIn": logged_in,
        "cookie": bool(session),
        "avatar": avatar,
        "loginPrompt": login_prompt,
        "nickname": nickname,
        "uid": uid,
    }


class Net:
    """抓页面自己发出的 JSON XHR；class 名是哈希的，接口名不是。"""

    def __init__(self, page, matcher):
        self.page = page
        self.matcher = matcher
        self.items: list[dict] = []
        self._tasks: set[asyncio.Task] = set()
        self.operation = _OPERATION.get()
        self.submitted_requests = set()
        self.requires_submission = False
        page.on("request", self._on_request)
        page.on("response", self._on)

    def _on_request(self, request):
        try:
            if self.operation and self.operation.get("submitted") and self.matcher(request.url):
                self.submitted_requests.add(request)
        except Exception:
            pass

    def _on(self, resp) -> None:
        try:
            url = resp.url
        except Exception:
            return
        try:
            if not self.matcher(url):
                return
        except Exception:
            return
        task = asyncio.create_task(self._grab(resp, url))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _grab(self, resp, url: str) -> None:
        try:
            ctype = (resp.headers.get("content-type") or "").lower()
            if "json" not in ctype:
                return
            body = await resp.text()
            if not body or len(body) > 8_000_000:
                return
            data = json.loads(body)
            if isinstance(data, dict):
                self.items.append({"url": url.split("?")[0], "data": data, "method": resp.request.method,
                                   "afterSubmit": resp.request in self.submitted_requests})
        except Exception:
            return

    async def wait_for(self, predicate, timeout: float = 10.0, poll: float = 0.25):
        end = time.time() + timeout
        while time.time() < end:
            for item in list(self.items):
                if self.requires_submission and not item.get("afterSubmit"):
                    continue
                try:
                    if predicate(item["url"], item["data"]):
                        return item
                except Exception:
                    continue
            await asyncio.sleep(poll)
        return None

    def close(self) -> None:
        try:
            self.page.remove_listener("response", self._on)
            self.page.remove_listener("request", self._on_request)
        except Exception:
            pass
        for task in list(self._tasks):
            task.cancel()
        self._tasks.clear()
        self.submitted_requests.clear()


# ---------------------------------------------------------------------------
# 数据解析
# ---------------------------------------------------------------------------

def _parse_aweme(aw: dict) -> dict:
    stats = aw.get("statistics") or {}
    author = aw.get("author") or {}
    video = aw.get("video") or {}
    cover_list = ((video.get("cover") or {}).get("url_list") or [])
    aid = str(aw.get("aweme_id") or "")
    return {
        "aweme_id": aid,
        "title": (aw.get("desc") or "").strip().split("\n")[0][:120],
        "author": author.get("nickname") or "",
        "digg": _num(stats.get("digg_count", 0)),
        "comment": _num(stats.get("comment_count", 0)),
        "share": _num(stats.get("share_count", 0)),
        "duration": _num(video.get("duration") or aw.get("duration") or 0),
        "url": VIDEO_URL.format(aweme_id=aid),
        "cover": cover_list[0] if cover_list else "",
    }


def _parse_comment(c: dict) -> dict:
    user = c.get("user") or {}
    attachments = []
    def collect(value, kind="image"):
        if isinstance(value, list):
            for item in value: collect(item, kind)
        elif isinstance(value, dict):
            for url in value.get("url_list") or []:
                if isinstance(url, str) and url.startswith(("https://", "http://")):
                    attachments.append({"url": url, "kind": kind, "alt": str(value.get("alt") or value.get("description") or "")[:200]})
            for key in ("image", "origin", "display_image", "thumb_image"):
                if key in value: collect(value[key], kind)
    collect(c.get("image_list") or [])
    collect(c.get("sticker") or c.get("emoji") or {}, "sticker")
    attachments = list({x["url"]: x for x in attachments}.values())[:8]
    return {
        "cid": str(c.get("cid") or ""),
        "user": user.get("nickname") or "",
        "text": (c.get("text") or "").strip(),
        "digg": _num(c.get("digg_count", 0)),
        "time": _fmt_ts(c.get("create_time")),
        "kind": "sticker" if any(x["kind"] == "sticker" for x in attachments) else "image" if attachments else "text",
        "media": [x["url"] for x in attachments],
        "attachments": attachments,
    }


def _parse_search_payload(data: dict) -> list[dict]:
    out: list[dict] = []
    for item in data.get("data") or []:
        if not isinstance(item, dict):
            continue
        aw = item.get("aweme_info") or item.get("aweme") or {}
        if aw.get("aweme_id"):
            out.append(_parse_aweme(aw))
    if not out:
        for aw in data.get("aweme_list") or []:
            if isinstance(aw, dict) and aw.get("aweme_id"):
                out.append(_parse_aweme(aw))
    return out


def _is_detail_url(url: str) -> bool:
    return "/aweme/detail/" in url


def _is_comment_list_url(url: str) -> bool:
    return "/comment/list/" in url


def _is_comment_publish_url(url: str) -> bool:
    return "/comment/publish/" in url


def _is_search_url(url: str) -> bool:
    if "/aweme/" not in url:
        return False
    return ("search/single" in url) or ("search/item" in url) or ("search/general" in url)


def _is_digg_url(url: str) -> bool:
    return "/commit/item/digg/" in url


def _search_items_ok(data: dict) -> bool:
    if not isinstance(data, dict):
        return False
    data_list = data.get("data")
    if isinstance(data_list, list) and data_list:
        return any(
            isinstance(x, dict) and (x.get("aweme_info") or x.get("aweme"))
            for x in data_list
        )
    return bool(data.get("aweme_list"))


# ---------------------------------------------------------------------------
# 搜索 / 详情 / 评论（核心实现，供工具和 selfcheck 复用；调用方负责持锁）
# ---------------------------------------------------------------------------

async def _search_core(page, keyword: str, num: int, order: str) -> dict:
    keyword = (keyword or "").strip()
    if not keyword:
        return _err("keyword 不能为空")
    num = max(1, min(int(num or 10), 50))

    # SPEC：搜索也要接受整条链接并抽 id。给链接就按单条视频详情返回（不需要登录）。
    if "/video/" in str(keyword):
        aid = _extract_aweme_id(keyword)
        if aid:
            vid = await _video_core(page, aid)
            if vid.get("ok") and vid.get("title"):
                item = {
                    "aweme_id": vid.get("aweme_id") or aid,
                    "title": vid.get("title") or "",
                    "author": vid.get("author") or "",
                    "digg": vid.get("digg") or 0,
                    "comment": vid.get("comment_count") or 0,
                    "share": vid.get("share") or 0,
                    "duration": vid.get("duration") or 0,
                    "url": vid.get("url") or VIDEO_URL.format(aweme_id=aid),
                    "cover": "",
                }
                return _ok(keyword=keyword, count=1, items=[item], source="detail-link")

    # 实测：未登录时搜索页根本不发 search XHR，只挂登录墙。
    # 先用 cookie/头像判一次，省得白等 12s 还拿不到结果。
    try:
        st = await _login_state(page, page.context)
        if not st["loggedIn"]:
            return _need_login(
                "抖音搜索需要登录：先 douyin_login_qr 出二维码 → 手机扫码 → douyin_login_poll",
                keyword=keyword,
                items=[],
            )
    except Exception as exc:
        log(f"search login precheck fail: {exc}")

    type_map = {"general": "general", "video": "video", "latest": "general", "like": "general"}
    sort_map = {"general": "0", "video": "0", "latest": "1", "like": "2"}
    stype = type_map.get(order, "general")
    sort_type = sort_map.get(order, "0")

    from urllib.parse import quote

    url = SEARCH_URL.format(kw=quote(keyword), type=stype)
    if sort_type != "0":
        url += f"&sort_type={sort_type}"

    net = Net(page, _is_search_url)
    notes: list[str] = []
    try:
        await _goto(page, url, settle=4.0)
        hit = await net.wait_for(lambda u, d: _search_items_ok(d), timeout=12.0)
        if hit:
            items = _parse_search_payload(hit["data"])
            return _ok(keyword=keyword, count=len(items[:num]), items=items[:num], source="xhr")

        if await _has_login_wall(page):
            return _need_login(
                "抖音搜索需要登录：先 douyin_login_qr 出二维码 → 手机扫码 → douyin_login_poll",
                keyword=keyword,
                items=[],
            )

        # DOM 兜底（互动数拿不到，不编，用 0 + notes 说明）
        dom_items = await page.evaluate(
            '() => {\n                const seen = new Set(); const out = [];\n                const anchors = Array.from(document.querySelectorAll(\n                    \'[data-e2e="scroll-list"] a[href*="/video/"], a[href*="/video/"]\'\n                ));\n                for (const a of anchors) {\n                    const m = (a.href || \'\').match(/\\/video\\/(\\d{6,})/);\n                    if (!m || seen.has(m[1])) continue;\n                    seen.add(m[1]);\n                    let card = a.closest(\'li\') || a.closest(\'[data-e2e="search-result-card"]\');\n                    if (!card) { let p = a; for (let i = 0; i < 4 && p.parentElement; i++) p = p.parentElement; card = p; }\n                    const img = (card || a).querySelector(\'img\');\n                    const text = ((card && card.innerText) || a.innerText || \'\').trim();\n                    out.push({\n                        aweme_id: m[1],\n                        title: ((img && img.alt) || text.split(\'\\n\')[0] || \'\').slice(0, 120),\n                        author: \'\',\n                        digg: 0, comment: 0, share: 0, duration: 0,\n                        url: \'https://www.douyin.com/video/\' + m[1],\n                        cover: (img && img.src) || \'\',\n                        _text: text.slice(0, 300)\n                    });\n                }\n                return out;\n            }'
        )
        if dom_items:
            notes.append("搜索结果来自 DOM 兜底：互动数/作者没取到，已留 0")
            return _ok(keyword=keyword, count=len(dom_items[:num]), items=dom_items[:num],
                       source="dom", notes=notes)

        notes.append("页面上没找到搜索结果，也没抓到 search XHR（可能被风控或页面结构变了）")
        if "验证" in (await _body_text(page, 2000)):
            notes.append("页面出现「验证」字样，可能是滑块/验证码")
        return _ok(keyword=keyword, count=0, items=[], source="none", notes=notes)
    finally:
        net.close()


async def _video_core(page, aweme_id: str) -> dict:
    aid = _extract_aweme_id(aweme_id)
    if not aid:
        return _err("aweme_id 不合法（要 19 位数字，或 /video/<id> 链接）")

    net = Net(page, _is_detail_url)
    notes: list[str] = []
    try:
        await _goto(page, VIDEO_URL.format(aweme_id=aid), settle=3.5)
        hit = await net.wait_for(
            lambda u, d: bool((d.get("aweme_detail") or {}).get("aweme_id")),
            timeout=10.0,
        )
        if hit:
            aw = hit["data"]["aweme_detail"]
            stats = aw.get("statistics") or {}
            return _ok(
                aweme_id=str(aw.get("aweme_id") or aid),
                title=(aw.get("desc") or "").strip().split("\n")[0][:200],
                desc=aw.get("desc") or "",
                author=(aw.get("author") or {}).get("nickname") or "",
                digg=_num(stats.get("digg_count", 0)),
                comment_count=_num(stats.get("comment_count", 0)),
                share=_num(stats.get("share_count", 0)),
                duration=_num((aw.get("video") or {}).get("duration") or 0),
                url=VIDEO_URL.format(aweme_id=aid),
                publish_time=_fmt_ts(aw.get("create_time")),
                source="xhr",
            )

        # DOM 兜底
        dom = await page.evaluate(
            '() => {\n                const info = document.querySelector(\'[data-e2e="detail-video-info"]\');\n                const id = (info && info.getAttribute(\'data-e2e-aweme-id\'))\n                    || ((location.pathname.match(/\\/video\\/(\\d+)/) || [])[1] || \'\');\n                const title = (info && info.querySelector(\'h1\') && info.querySelector(\'h1\').innerText.trim())\n                    || (document.title || \'\').replace(/\\s*-\\s*抖音$/, \'\');\n                const authorImg = document.querySelector(\'[data-e2e="user-info"] img[alt]\');\n                const num = t => {\n                    if (!t) return 0;\n                    t = String(t).replace(/,/g, \'\').trim();\n                    let m = 1;\n                    if (t.endsWith(\'万\')) { m = 10000; t = t.slice(0, -1); }\n                    else if (t.endsWith(\'亿\')) { m = 100000000; t = t.slice(0, -1); }\n                    const v = parseFloat(t);\n                    return isNaN(v) ? 0 : Math.round(v * m);\n                };\n                const digg = document.querySelector(\'[data-e2e="video-player-digg"]\');\n                const cmt = document.querySelector(\'[data-e2e="feed-comment-icon"]\');\n                const share = document.querySelector(\'[data-e2e="video-player-share"]\');\n                const pub = document.querySelector(\'[data-e2e="detail-video-publish-time"]\');\n                return {\n                    aweme_id: id, title: title, desc: title,\n                    author: (authorImg && authorImg.alt) || \'\',\n                    digg: num(digg && digg.innerText),\n                    comment_count: num(cmt && cmt.innerText),\n                    share: num(share && share.innerText),\n                    publish_time: pub ? pub.innerText.replace(\'发布时间：\', \'\').trim() : \'\'\n                };\n            }'
        )
        if dom and dom.get("aweme_id") and dom.get("title"):
            notes.append("视频详情来自 DOM 兜底（没抓到 aweme/detail XHR）")
            return _ok(**dom, url=VIDEO_URL.format(aweme_id=aid), source="dom", notes=notes)

        notes.append("没抓到 aweme/detail XHR，DOM 也没解析出标题（可能视频被删/地区限制）")
        return _ok(aweme_id=aid, title="", desc="", author="", digg=0, comment_count=0,
                   share=0, url=VIDEO_URL.format(aweme_id=aid), publish_time="",
                   source="none", notes=notes)
    finally:
        net.close()


def _detail_comment_count(net) -> int | None:
    """详情 XHR 里的 statistics.comment_count —— 这是一级评论数。

    ⭐ 2026-10-24 实测：评论列表 XHR 的 `total` 把楼中楼回复也算进去了
    （某条视频 total=3，一级评论只有 1 条），DOM 上的 feed-comment-icon 同样是 3。
    所以"只拿到 1 条"到底是不是加载失败，只能跟这里的数字比。
    """
    try:
        for item in list(net.items):
            aw = (item.get("data") or {}).get("aweme_detail") or {}
            stats = aw.get("statistics") or {}
            if stats.get("comment_count") is not None:
                return int(stats.get("comment_count") or 0)
    except Exception:  # noqa: BLE001
        return None
    return None


async def _scrape_comments_dom(page, num: int = 30) -> list[dict]:
    """从评论面板里抠评论（XHR 拿不到时的兜底）：cid 用页面上的 data 属性，没有就留空。"""
    try:
        for _ in range(4):
            try:
                await page.evaluate(
                    r"""() => {
                        const box = document.querySelector('[data-e2e="comment-list"]')
                            || document.querySelector('[class*="comment"]');
                        if (box && box.parentElement) box.parentElement.scrollTop = box.parentElement.scrollHeight;
                        window.scrollBy(0, 1200);
                    }"""
                )
            except Exception:
                pass
            await page.wait_for_timeout(1500)
        items = await page.evaluate(
            r"""(num) => {
                const out = [];
                const nodes = Array.from(document.querySelectorAll('[data-e2e="comment-item"], [class*="commentItem"], [class*="CommentItem"]'));
                for (const n of nodes) {
                    if (out.length >= num) break;
                    const txt = (n.innerText || '').replace(/\s+/g, ' ').trim();
                    const images=Array.from(n.querySelectorAll('img')).filter(x=>!x.closest('[class*="avatar"],[class*="Avatar"]'));
                    if ((!txt || txt.length < 2) && !images.length) continue;
                    const cidNode = n.querySelector('[data-cid]');
                    let user = '';
                    try {
                        const userA = n.querySelector('a[href*="/user/"]');
                        if (userA) user = (userA.innerText || '').trim().split(/\s+/)[0].slice(0, 20);
                    } catch (e) { user = ''; }
                    out.push({
                        cid: cidNode ? cidNode.getAttribute('data-cid') : "",
                        user: user,
                        text: txt.slice(0, 200),
                        kind: images.length?'image':'text',
                        media: images.map(x=>x.currentSrc||x.src),
                        attachments: images.map(x=>({url:x.currentSrc||x.src,alt:x.alt||'',kind:'image'})),
                    });
                }
                return out;
            }""",
            max(1, int(num or 30)),
        )
        return [i for i in (items or []) if i.get("text")]
    except Exception:
        return []


async def _fetch_reply_children(page, aweme_id: str, parent_cid: str) -> list[dict]:
    """取某条评论的回复列表（父 cid 为空时退回一级评论列表），用来做发表后的回执确认。"""
    try:
        if parent_cid:
            data = await page.evaluate("""async ({aid, cid}) => {
                const q = '/aweme/v1/web/comment/list/reply/?device_platform=webapp&aid=6383&channel=channel_pc_web'
                    + '&item_id=' + aid + '&comment_id=' + cid + '&cursor=0&count=50&item_type=0';
                const ctl = new AbortController();
                const t = setTimeout(() => ctl.abort(), 12000);
                try {
                    const r = await fetch(q, {credentials: 'include', signal: ctl.signal});
                    clearTimeout(t);
                    return r.ok ? await r.json() : null;
                } catch (e) { clearTimeout(t); return null; }
            }""", {"aid": aweme_id, "cid": parent_cid})
        else:
            data = await page.evaluate("""async (aid) => {
                const q = '/aweme/v1/web/comment/list/?device_platform=webapp&aid=6383&channel=channel_pc_web'
                    + '&aweme_id=' + aid + '&cursor=0&count=50&item_type=0';
                const ctl = new AbortController();
                const t = setTimeout(() => ctl.abort(), 12000);
                try {
                    const r = await fetch(q, {credentials: 'include', signal: ctl.signal});
                    clearTimeout(t);
                    return r.ok ? await r.json() : null;
                } catch (e) { clearTimeout(t); return null; }
            }""", aweme_id)
        return [_parse_comment(c) for c in ((data or {}).get("comments") or [])]
    except Exception:
        return []


async def _fetch_comments_api(page, aweme_id: str, num: int = 30) -> list[dict]:
    """直接问评论接口要一级评论（图文作品常常不抛 XHR，DOM 里也没有 cid，这条最稳）。"""
    out: list[dict] = []
    seen: set[str] = set()
    cursor = 0
    rounds = max(1, min(int(num or 30), 100) // 20 + 3)
    for _ in range(rounds):
        try:
            data = await page.evaluate("""async ({aid, cursor}) => {
                const url = '/aweme/v1/web/comment/list/?device_platform=webapp&aid=6383&channel=channel_pc_web'
                    + '&aweme_id=' + aid + '&cursor=' + cursor + '&count=20&item_type=0';
                const r = await fetch(url, {credentials: 'include'});
                if (!r.ok) throw new Error('comment HTTP ' + r.status);
                return await r.json();
            }""", {"aid": aweme_id, "cursor": cursor})
        except Exception:
            break
        if not isinstance(data, dict) or data.get("status_code") not in (0, None):
            break
        for c in (data.get("comments") or []):
            cid = str((c or {}).get("cid") or "")
            if not cid or cid in seen:
                continue
            seen.add(cid)
            out.append(_parse_comment(c))
        if not data.get("has_more") or len(out) >= num:
            break
        cursor = int(data.get("cursor") or (cursor + 20))
        await page.wait_for_timeout(400)
    return out[:num]


async def _comments_core(page, aweme_id: str, num: int) -> dict:
    aid = _extract_aweme_id(aweme_id)
    if not aid:
        return _err("aweme_id 不合法（要 19 位数字，或 /video/<id> 链接）")
    num = max(1, min(int(num or 30), 100))

    net = Net(page, _is_comment_list_url)
    detail_net = Net(page, _is_detail_url)   # 顺手取一级评论数（statistics.comment_count）
    notes: list[str] = []
    try:
        await _goto(page, VIDEO_URL.format(aweme_id=aid), settle=3.0)
        got = await net.wait_for(lambda u, d: isinstance(d.get("comments"), list), timeout=6.0)
        # ⭐ 2026-10-26：类型以 aweme_type 为准（68/211/150 = 图文；0/55 = 视频），页面没 <video> 只当辅助信号
        try:
            det = await detail_net.wait_for(lambda u, d: bool(d.get("aweme_detail")), timeout=3.0)
            item = ((det or {}).get("data") or {}).get("aweme_detail") or {}
            if isinstance(item, dict) and item.get("aweme_type") is not None:
                _AWEME_TYPE_CACHE[aid] = int(item.get("aweme_type"))
        except Exception:
            pass
        try:
            _det = _AWEME_TYPE_CACHE.get(aid)
            if _det is not None:
                is_note_now = _det in (68, 211, 150)
                notes.append(f"作品类型 aweme_type={_det}（{'图文' if is_note_now else '视频'}）")
            else:
                is_note_now = await page.evaluate("() => !document.querySelector('video')")
        except Exception:
            is_note_now = False
        if is_note_now and not got:
            await page.wait_for_timeout(1500)
            api_items = await _fetch_comments_api(page, aid, num)
            if api_items:
                notes.append(f"图文作品：评论接口直接拿到 {len(api_items)} 条（含 cid）")
                return _ok(aweme_id=aid, count=len(api_items), items=api_items, notes=notes, source="api")
            dom_items = await _scrape_comments_dom(page, num)
            if dom_items:
                notes.append(f"图文作品：直接 DOM 抠到 {len(dom_items)} 条")
                return _ok(aweme_id=aid, count=len(dom_items), items=dom_items, notes=notes, source="dom")
        if not got:
            try:
                is_note = await page.evaluate("() => !document.querySelector('video')")
            except Exception:
                is_note = False
            if is_note:
                await _goto(page, NOTE_URL.format(aweme_id=aid), settle=3.5)
                got = await net.wait_for(lambda u, d: isinstance(d.get("comments"), list), timeout=10.0)
                if got:
                    notes.append("这是图文作品，用 /note/ 页面取到了评论")
        await page.wait_for_timeout(1200)

        def collect() -> tuple[list[dict], bool]:
            seen: set[str] = set()
            out: list[dict] = []
            has_more = False
            for item in list(net.items):
                data = item["data"]
                for c in data.get("comments") or []:
                    cid = str(c.get("cid") or "")
                    if cid and cid in seen:
                        continue
                    seen.add(cid)
                    out.append(_parse_comment(c))
                if data.get("has_more"):
                    has_more = True
            return out, has_more

        comments, has_more = collect()
        for _ in range(6):
            if len(comments) >= num:
                break
            before = len(comments)
            clicked = await _click_text(page, "点击加载更多", exact=True)
            if not clicked:
                clicked = await _click_text(page, "加载更多", exact=True)
            if not clicked:
                try:
                    await page.evaluate(
                        r"""() => {
                            const list = document.querySelector('[data-e2e="comment-list"]');
                            if (list && list.parentElement) { list.parentElement.scrollTop = list.parentElement.scrollHeight; }
                            window.scrollBy(0, 1400);
                        }"""
                    )
                except Exception:
                    pass
            await page.wait_for_timeout(2000)
            comments, has_more = collect()
            if len(comments) == before and not clicked:
                break

        if not comments:
            # ⭐ 先试直连接口（含 cid），不行再从面板里抠
            api_items = await _fetch_comments_api(page, aid, num)
            if api_items:
                notes.append(f"接口没抛 XHR，直连评论接口拿到 {len(api_items)} 条（含 cid）")
                return _ok(aweme_id=aid, count=len(api_items), items=api_items, notes=notes, source="api")
            dom_items = await _scrape_comments_dom(page, num)
            if dom_items:
                notes.append(f"接口没给，改成从页面里抠到 {len(dom_items)} 条")
                return _ok(aweme_id=aid, count=len(dom_items), items=dom_items, notes=notes, source="dom")
            notes.append("这条还没有评论（接口 total=0）")
            return _ok(aweme_id=aid, count=0, items=[], notes=notes, source="none")

        if len(comments) < num:
            total = _detail_comment_count(detail_net)
            if total is not None and total <= len(comments):
                notes.append(
                    f"这条视频一共就 {len(comments)} 条一级评论（已全部取到），不是加载失败；不编数据。"
                )
            else:
                shown = f"这条视频共 {total} 条" if total is not None else "没核到总数"
                notes.append(
                    f"只拿到 {len(comments)} 条（要 {num} 条；{shown}）："
                    "「点击加载更多」没继续出数据，可能被风控/需要登录；不编数据。"
                )
        return _ok(aweme_id=aid, count=len(comments[:num]), items=comments[:num],
                   source="xhr", **({"notes": notes} if notes else {}))
    finally:
        detail_net.close()
        net.close()


# ---------------------------------------------------------------------------
# 登录
# ---------------------------------------------------------------------------

async def _ensure_login_panel(page) -> str:
    """返回 'qr' / 'panel' / 'none'。"""
    if await _first_of(page, QR_SELS, 1500) is not None:
        return "qr"
    if await _first_of(page, PANEL_SELS, 1000) is not None:
        # 2026-10-30 的登录窗是左右同时开的：左边二维码，右边验证码/密码。
        # 不要再点「扫码登录」把右边收起来。
        return "qr" if await _first_of(page, QR_SELS, 1000) is not None else "panel"

    clicked = False
    try:
        loc = page.get_by_text("登录", exact=True)
        n = await loc.count()
        # 页头的「登录」通常是最后一个精确匹配
        for i in range(n - 1, max(-1, n - 6), -1):
            item = loc.nth(i)
            if await item.is_visible(timeout=400):
                await item.click(timeout=5000)
                clicked = True
                break
    except Exception as exc:
        log(f"click 登录 fail: {exc}")

    if not clicked:
        for sel in ["[data-e2e='login-button']", "button:has-text('登录')"]:
            try:
                loc = page.locator(sel).first
                if await loc.count() and await loc.is_visible(timeout=600):
                    await loc.click(timeout=5000)
                    clicked = True
                    break
            except Exception:
                continue

    if not clicked:
        return "none"

    for _ in range(24):
        await page.wait_for_timeout(500)
        if await _first_of(page, QR_SELS, 300) is not None:
            return "qr"
        if await _first_of(page, PANEL_SELS, 300) is not None:
            return "panel"
    return "none"


async def _login_qr_core(page, ctx) -> dict:
    # ⭐ 每次出码都强制刷新首页（带时间戳）：否则 SPA 会复用旧弹层里那张**过期二维码** ——
    #    表现就是「扫完没反应」（2026-10-23 使用者实测踩到）。
    await _goto(page, f"{HOME_URL}?_t={int(time.time() * 1000)}", settle=3.5)
    st = await _login_state(page, ctx)
    if st["loggedIn"]:
        return _ok(png="", loggedIn=True, hint="已经登录，不用再扫码；直接调 douyin_search")

    state = await _ensure_login_panel(page)
    qr = await _first_of(page, QR_SELS, 3000)
    notes: list[str] = []
    if qr is None:
        notes.append(f"登录弹层状态={state}，但没找到二维码元素（选择器：{QR_SELS}）")
        return _ok(png="", loggedIn=False, needLogin=True, notes=notes,
                   hint="没抓到二维码：抖音登录弹层结构可能变了；可先 douyin_check_credential 看状态")

    try:
        await qr.scroll_into_view_if_needed(timeout=2000)
    except Exception:
        pass
    await page.wait_for_timeout(400)

    written = False
    try:
        await qr.screenshot(path=str(QR_PNG), type="png")
        written = QR_PNG.exists() and QR_PNG.stat().st_size > 800
    except Exception as exc:
        notes.append(f"元素截图失败：{type(exc).__name__}: {exc}")

    if not written:
        # 抖音的二维码是 data:image/png;base64 的 <img>，截图失败就直接解 base64
        try:
            src = await qr.get_attribute("src") or ""
            if src.startswith("data:image"):
                QR_PNG.write_bytes(base64.b64decode(src.split(",", 1)[1]))
                written = QR_PNG.exists() and QR_PNG.stat().st_size > 800
                notes.append("二维码从 data:image base64 解码")
        except Exception as exc:
            notes.append(f"解码二维码失败：{type(exc).__name__}: {exc}")

    if not written:
        return _ok(png="", loggedIn=False, needLogin=True, notes=notes,
                   hint="二维码元素找到了但图片没存下来（截图/解码都失败）")

    size = QR_PNG.stat().st_size
    try:
        sha = hashlib.sha1(QR_PNG.read_bytes()).hexdigest()[:12]
    except Exception:
        sha = ""
    log(f"二维码已存盘：{QR_PNG} ({size} bytes, sha={sha})")
    return _ok(
        png=str(QR_PNG),
        loggedIn=False,
        needLogin=True,
        bytes=size,
        qrSha=sha,
        hint="同一个登录窗左边是二维码、右边是手机号和验证码，两条路都开着，不用关掉重开。"
             "扫码用抖音「扫一扫」，扫完调 douyin_login_poll；"
             "要改走短信就在这个窗口上调 douyin_login_sms，它不会刷新二维码。",
        smsVisible=await _sms_fields_visible(page),
        methods=["qr", "sms"] if await _sms_fields_visible(page) else ["qr"],
        notes=notes,
    )


# ---------------------------------------------------------------------------
# 短信验证码登录（使用者 2026-10-23：「除了扫码还要验证码，下次点收短信验证让我输入」）
# ---------------------------------------------------------------------------

SMS_PHONE_SELS = [
    "input[placeholder*='手机号']",
    "input[placeholder*='手机']",
    "input[name='mobile']",
    "input[type='tel']",
    "input[maxlength='11']",
]
SMS_CODE_SELS = [
    "input[placeholder*='验证码']",
    "input[name='verify_code']",
    "input[name='code']",
    "input[maxlength='6']",
]


async def _sms_fields_visible(page) -> bool:
    return await _first_of(page, SMS_PHONE_SELS, 400) is not None


async def _captcha_visible(page) -> bool:
    """图形验证真的盖在登录窗上时才算。页面里常驻的隐藏 verify iframe 不算。"""
    try:
        return bool(await page.evaluate("""() => {
            const fs = Array.from(document.querySelectorAll('iframe[src*="nocaptcha"], iframe[src*="captcha"], [class*="captcha"]'));
            return fs.some((e) => {
                const r = e.getBoundingClientRect();
                const st = getComputedStyle(e);
                return r.width > 120 && r.height > 120 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity || 1) > 0.1;
            });
        }"""))
    except Exception:
        return False


async def _switch_to_sms_tab(page) -> bool:
    """右边已经是手机号输入时什么都不点。只有停在「密码登录」时才切到验证码。"""
    if await _sms_fields_visible(page):
        return True
    for label in ("验证码登录", "短信验证登录", "验证码 登录"):
        if await _click_text(page, label, exact=False):
            await page.wait_for_timeout(900)
            return await _sms_fields_visible(page)
    return False


async def _receive_code_visible(page) -> bool:
    """扫码之后的二次验证上，先出现「收验证码」，点开才有「获取验证码」。"""
    if await _visible_text(page, "收验证码", exact=True) is not None:
        return True
    return await _visible_text(page, "接收验证码", exact=False) is not None


async def _open_receive_code(page) -> bool:
    """先点「收验证码」。这一下没点，后面的「获取验证码」出不来。"""
    if await _click_text(page, "收验证码", exact=True):
        await page.wait_for_timeout(900)
        return True
    if await _click_text(page, "接收验证码", exact=False):
        await page.wait_for_timeout(900)
        return True
    return False


async def _click_get_code(page) -> bool:
    for label in ("获取验证码", "发送验证码", "获取短信验证码"):
        if await _click_text(page, label, exact=False):
            return True
    return False


async def _sms_start_core(page, ctx, phone: str) -> dict:
    """二次验证：先点「收验证码」，再点「获取验证码」。号码已经带在弹层上时不用重填。"""
    digits = re.sub(r"\D", "", str(phone or ""))
    if digits and len(digits) != 11:
        return _err("手机号要给 11 位数字", phone=phone)
    second = await _receive_code_visible(page)
    panel_open = (
        second
        or await _first_of(page, PANEL_SELS, 600) is not None
        or await _first_of(page, QR_SELS, 400) is not None
    )
    # 二次验证或登录窗已经开着就留在这一页，刷新会把扫码结果清掉。
    if not panel_open:
        await _goto(page, f"{HOME_URL}?_t={int(time.time() * 1000)}", settle=3.0)
        st = await _login_state(page, ctx)
        if st["loggedIn"]:
            return _ok(loggedIn=True, already=True, hint="已经登录了，不用再发短信")
        await _ensure_login_panel(page)
    else:
        st = await _login_state(page, ctx)
        if st["loggedIn"]:
            return _ok(loggedIn=True, already=True, hint="已经登录了，不用再发短信")
    receive_clicked = await _open_receive_code(page)
    if not await _sms_fields_visible(page) and not receive_clicked:
        if not await _switch_to_sms_tab(page):
            # 二次验证可能只剩按钮，没有「验证码登录」tab
            if not await _click_get_code(page):
                notes = [(await _body_text(page, 300))[:200]]
                return _err("没找到「收验证码」或「获取验证码」（弹层可能改版）", notes=notes)
            await page.wait_for_timeout(1800)
            return await _sms_sent_result(page, digits, receive_clicked=False)
    box = await _first_of(page, SMS_PHONE_SELS, 2000)
    if box is not None:
        current = ""
        readonly = False
        try:
            current = re.sub(r"\D", "", await box.input_value() or "")
        except Exception:
            current = ""
        try:
            readonly = bool(await box.get_attribute("readonly") or await box.get_attribute("disabled"))
        except Exception:
            readonly = False
        if not readonly and len(current) < 4:
            if len(digits) != 11:
                return _err(
                    "二次验证的手机号是空的。把 11 位号码给我，我再点「获取验证码」。",
                    needPhone=True,
                    receiveClicked=receive_clicked,
                )
            try:
                await box.click(timeout=3000)
                await box.fill(digits)
            except Exception as exc:
                return _err(f"填手机号失败：{type(exc).__name__}: {exc}", receiveClicked=receive_clicked)
            await page.wait_for_timeout(300)
    if not await _click_get_code(page):
        notes = [(await _body_text(page, 300))[:200]]
        return _err(
            "已经点了「收验证码」，但没找到「获取验证码」",
            receiveClicked=receive_clicked,
            notes=notes,
        )
    await page.wait_for_timeout(1800)
    return await _sms_sent_result(page, digits, receive_clicked=receive_clicked)


async def _sms_sent_result(page, digits: str, receive_clicked: bool) -> dict:
    body = await _body_text(page, 1200)
    sent = ("秒后" in body) or ("重新获取" in body) or ("已发送" in body)
    captcha = await _captcha_visible(page)
    qr_visible = await _first_of(page, QR_SELS, 400) is not None
    if captcha:
        hint = "点了「获取验证码」之后弹出图形验证。请本人在这个窗口里拖完滑块，不要关窗口，也不要重新出二维码。拖完后短信到了再提交验证码。"
    elif sent:
        hint = "短信已发出。把收到的验证码给我（调 douyin_login_sms_submit）。不要重新出二维码。"
    else:
        hint = "已经按顺序点了「收验证码」和「获取验证码」，但没看到倒计时（可能没发出去）。不要重新出二维码。"
    shown = f"{digits[:3]}****{digits[-2:]}" if len(digits) == 11 else "弹层自带号码"
    log(f"短信验证码：phone={shown} sent={sent} captcha={captcha} qr={qr_visible} receive={receive_clicked}")
    return _ok(
        needCode=True,
        phone=digits,
        sent=sent,
        needCaptcha=captcha,
        qrVisible=qr_visible,
        receiveClicked=receive_clicked,
        hint=hint,
    )


async def _sms_submit_core(page, ctx, code: str) -> dict:
    """填验证码 + 点登录，然后等登录态（最多 ~15 秒）。"""
    digits = re.sub(r"\D", "", str(code or ""))
    if len(digits) < 4:
        return _err("验证码要是数字（短信里那 4~6 位）", code=code)
    box = await _first_of(page, SMS_CODE_SELS, 4000)
    if box is None:
        return _err("没找到验证码输入框：先调 douyin_login_sms 把短信发出来", code=digits)
    try:
        await box.click(timeout=3000)
        await box.fill(digits)
    except Exception as exc:
        return _err(f"填验证码失败：{type(exc).__name__}: {exc}", code=digits)
    await page.wait_for_timeout(300)
    clicked = False
    for sel in [
        f"{PANEL_SELS[0]} button:has-text('登录')",
        f"{PANEL_SELS[0]} div[role='button']:has-text('登录')",
        f"{PANEL_SELS[1]} button:has-text('登录')" if len(PANEL_SELS) > 1 else "body",
    ]:
        try:
            loc = page.locator(sel).first
            if await loc.count() and await loc.is_visible(timeout=800):
                await loc.click(timeout=5000)
                clicked = True
                break
        except Exception:
            continue
    if not clicked:
        clicked = await _click_text(page, "登录", exact=True)
    if not clicked:
        for label in ("验证", "确认", "确定", "提交"):
            if await _click_text(page, label, exact=True):
                clicked = True
                break
    if not clicked:
        return _err("验证码填好了，但找不到「登录」或「验证」按钮", code=digits)
    await page.wait_for_timeout(2500)
    for _ in range(10):
        st = await _login_state(page, ctx)
        if st["loggedIn"]:
            out = _ok(loggedIn=True, hint="短信验证通过，登录态已经写进 profile")
            if st.get("nickname"):
                out["nickname"] = st["nickname"]
            if st.get("uid"):
                out["uid"] = st["uid"]
            log("短信验证码登录成功")
            return out
        await page.wait_for_timeout(1200)
    notes = [(await _body_text(page, 400))[:200]]
    return _err("提交了验证码但没登上（验证码错/过期，或还要图形验证）", code=digits, notes=notes)


async def _login_poll_core(page, ctx) -> dict:
    st = await _login_state(page, ctx)
    if st["loggedIn"]:
        out = _ok(loggedIn=True, state="ok", hint="登录成功，登录态已写进 profile，后续工具可以直接用")
        if st["nickname"]:
            out["nickname"] = st["nickname"]
        if st["uid"]:
            out["uid"] = st["uid"]
        return out
    qr_visible = await _first_of(page, QR_SELS, 800) is not None
    # ⭐ 分状态回报（使用者 2026-10-23：「扫完了没反应」—— 之前只说 loggedIn=false，
    #    人分不清"没扫" / "扫了但没在手机上确认" / "码已经没了"）
    body = ""
    try:
        body = await _body_text(page, 1500)
    except Exception:
        body = ""
    scanned = any(k in body for k in ("已扫描", "请在手机", "确认登录", "手机上确认", "扫码成功"))
    captcha = await _captcha_visible(page)
    sms_visible = await _sms_fields_visible(page)
    receive = await _receive_code_visible(page)
    second_copy = any(k in body for k in ("二次验证", "身份验证", "安全验证", "验证身份", "为保障账号安全"))
    first_panel = ("请输入手机号" in body and "扫码登录" in body) or ("登录后免费畅享" in body)
    state = "waiting_scan" if qr_visible else "no_qr"
    if scanned and qr_visible:
        state = "scanned_need_confirm"
    if receive or (second_copy and not first_panel):
        state = "need_sms"
    if captcha:
        state = "need_captcha"
    hints = {
        "waiting_scan": "还没扫到。扫完如果弹出二次验证，接着调 douyin_login_sms，它会先点「收验证码」再点「获取验证码」。",
        "scanned_need_confirm": "扫到了，但手机上还没点「确认登录」—— 去手机上点一下那一步",
        "no_qr": "二维码已经不在页面上了。如果是扫完弹出了二次验证，调 douyin_login_sms，不要重新出码。",
        "need_sms": "扫码之后弹出了二次验证。接着调 douyin_login_sms：先点「收验证码」，再点「获取验证码」。不要重新出二维码。号码如果弹层里已经有，phone 可以空着。",
        "need_captcha": "同一个窗口里弹出了图形验证。请本人拖完滑块，不要关窗口，也不要重新出码。",
    }
    return _ok(loggedIn=False, needLogin=True, state=state, qrVisible=qr_visible,
               smsVisible=sms_visible, needCaptcha=captcha, receiveVisible=receive,
               scanned=scanned, hint=hints[state],
               evidence={"cookie": st["cookie"], "avatar": st["avatar"]})


# ---------------------------------------------------------------------------
# 点赞 / 评论 / 投稿
# ---------------------------------------------------------------------------

def _digged(state: str) -> bool:
    s = (state or "").lower()
    if "no-digged" in s or "no_digged" in s:
        return False
    return "digged" in s or "digg" in s


async def _digg_state(page, aweme_id: str) -> dict:
    """读页面里点赞按钮的真实状态（不靠点赞数）。

    ⭐ 2026-10-24 实测：桌面端详情页经常把整条右侧互动栏 `display:none`，
       `[data-e2e='video-player-digg']` 节点还在、`data-e2e-state` 也读得到，
       但 rect = 0×0 ⇒ Playwright 的可见性点击必然超时。
       所以状态判定一律走 DOM 属性；点赞数是被所有人推动的全局计数，
       既会把"假成功"变成真，也会把"真成功"判成失败。
    """
    try:
        info = await page.evaluate(
            r"""() => {
                const el = document.querySelector("[data-e2e='video-player-digg']");
                if (!el) return {present: false};
                const r = el.getBoundingClientRect();
                return {
                    present: true,
                    state: el.getAttribute('data-e2e-state') || '',
                    nw: Math.round(r.width),
                    nh: Math.round(r.height),
                };
            }"""
        )
    except Exception:
        return {"present": False}
    if not info or not info.get("present"):
        return {"present": False}
    state = str(info.get("state") or "")
    return {
        "present": True,
        "state": state,
        "liked": _digged(state),
        "visible": int(info.get("nw") or 0) > 4 and int(info.get("nh") or 0) > 4,
    }


async def _like_core(page, ctx, aweme_id: str, undo: bool) -> dict:
    aid = _extract_aweme_id(aweme_id)
    if not aid:
        return _err("aweme_id 不合法")
    await _goto(page, VIDEO_URL.format(aweme_id=aid), settle=3.0)
    st = await _login_state(page, ctx)
    if not st["loggedIn"]:
        return _need_login("点赞要登录：先 douyin_login_qr → 扫码 → douyin_login_poll", aweme_id=aid)

    target = not undo          # 目标状态：点赞 = True，取消 = False
    dom = await _digg_state(page, aid)
    for _ in range(3):         # 首屏偶尔要等一帧才把按钮挂上
        if dom["present"]:
            break
        await page.wait_for_timeout(800)
        dom = await _digg_state(page, aid)

    if dom["present"]:
        if dom["liked"] == target:
            return _ok(aweme_id=aid, liked=dom["liked"], changed=False,
                       state=dom["state"], verified=True,
                       note="本来就是目标状态，没动")

        _submitted()
        note = ""
        if dom["visible"]:
            try:
                await page.locator("[data-e2e='video-player-digg']").first.click(timeout=5000)
                note = "点了页面上的点赞按钮"
            except Exception as exc:  # noqa: BLE001
                return _err(f"点击过程异常，未重复点击：{type(exc).__name__}: {exc}", status="unknown", aweme_id=aid)
        else:
            note = "点赞按钮 rect=0×0（互动栏 display:none），改用 JS 直点"

        if not note.startswith("点了页面"):
            # JS 派发 click 不受 display:none 影响：事件照走，抖音照样发请求
            await page.evaluate(
                r"""() => {
                    const el = document.querySelector("[data-e2e='video-player-digg']");
                    if (el) el.click();
                }"""
            )

        final = dom
        for _ in range(20):
            await page.wait_for_timeout(300)
            final = await _digg_state(page, aid)
            if final["present"] and final["liked"] != dom["liked"]:
                break

        if final["present"] and final["liked"] == target:
            return _ok(aweme_id=aid, liked=final["liked"], changed=True,
                       state=final["state"], verified=True, note=note)

        qr = await _first_of(page, QR_SELS, 300)   # 登录态失效会弹扫码框
        if qr is not None:
            return _need_login("点了点赞但弹出登录框：登录态失效了，重新扫码", aweme_id=aid)
        return _err("点了但 data-e2e-state 没翻转（可能被风控/页面结构变了）",
                    aweme_id=aid, liked=final.get("liked"),
                    status="unknown", before=dom["state"], after=final.get("state"), note=note)

    # 页面上压根没有这个节点
    if undo:
        return _err("这条视频页没有可用的点赞按钮（互动栏未渲染），双击只能点赞、无法取消；"
                    "要取消请换一条视频页重试，或到「我 → 喜欢」里手动取消", aweme_id=aid)
    try:
        vid = page.locator("video").first
        if await vid.count() == 0:
            return _err("页面里没有 video 元素，点赞按钮也找不到", aweme_id=aid)
        await vid.scroll_into_view_if_needed(timeout=3000)
        _submitted()
        await vid.dblclick(timeout=5000, force=True)
    except Exception as exc:  # noqa: BLE001
        return _err(f"找不到点赞按钮，双击兜底也失败：{type(exc).__name__}: {exc}", aweme_id=aid)

    await page.wait_for_timeout(1800)
    after = await _digg_state(page, aid)
    if after["present"] and after["liked"]:
        return _ok(aweme_id=aid, liked=True, changed=True, state=after["state"],
                   verified=True, note="没有按钮节点，双击视频点赞（状态已核对）")
    if after["present"]:
        return _err("双击了但状态仍是未点赞（这条视频可能不支持双击点赞）",
                    aweme_id=aid, status="unknown", state=after["state"])
    return _err("没有点赞按钮，双击后也读不到状态节点（无法核对，不敢报成功）", status="unknown", aweme_id=aid)


def _norm_comment_text(s: str) -> str:
    """评论正文归一化：去掉 [看] 这类表情码、空白、标点，只留中英数字，便于模糊匹配。"""
    import re
    s = str(s or "")
    s = re.sub(r"\[[^\]]{1,8}\]", "", s)
    s = re.sub(r"\s+", "", s)
    s = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", s)
    return s


async def _find_media_comment(items, source, cid):
    """Match a media comment by real CID or unique media+author, never API row order."""
    expected = {urlparse(x['url']).path for x in _parse_comment(source or {}).get('attachments', [])}
    nickname = str(((source or {}).get('user') or {}).get('nickname') or '')
    direct, matches = [], []
    for i in range(min(await items.count(), 100)):
        item = items.nth(i)
        data = await item.evaluate(r"""el => ({
            cid:el.getAttribute('data-cid')||el.getAttribute('data-comment-id')||'',
            users:Array.from(el.querySelectorAll('a[href*="/user/"],[data-e2e="comment-user-name"]')).map(x=>(x.innerText||'').trim()),
            media:Array.from(el.querySelectorAll('img')).filter(x=>!x.closest('[class*="avatar"],[class*="Avatar"]')).map(x=>x.currentSrc||x.src)
        })""")
        if str(data.get('cid') or '') == str(cid): direct.append(item)
        actual = {urlparse(u).path for u in data.get('media', []) if isinstance(u, str)}
        if expected and expected.intersection(actual) and nickname and nickname in data.get('users', []):
            matches.append(item)
    if len(direct) == 1: return direct[0]
    return matches[0] if not direct and len(matches) == 1 else None


async def _comment_core(page, ctx, aweme_id: str, text: str, reply_cid: str, mention: str = "", reply_index: int = -1) -> dict:
    aid = _extract_aweme_id(aweme_id)
    if not aid:
        return _err("aweme_id 不合法")
    text = (text or "").strip()
    if not text:
        return _err("text 不能为空")
    if len(text) > 500:
        return _err("text 太长（抖音评论一般 ≤ 500 字）")

    net = Net(page, _is_comment_publish_url)
    net.requires_submission = True
    cmt_net = Net(page, _is_comment_list_url)
    notes: list[str] = []
    try:
        await _goto(page, VIDEO_URL.format(aweme_id=aid), settle=3.0)
        st = await _login_state(page, ctx)
        if not st["loggedIn"]:
            return _need_login("发评论要登录：先 douyin_login_qr → 扫码 → douyin_login_poll", aweme_id=aid)
        # ⭐ 图文作品：/video/<id> 里没有播放器和评论面板 ⇒ 换成 /note/<id>
        try:
            is_note = await page.evaluate("() => !document.querySelector('video')")
        except Exception:
            is_note = False
        if is_note:
            await _goto(page, NOTE_URL.format(aweme_id=aid), settle=3.5)
            notes.append("这是图文作品，改用 /note/ 页面")
            # 打开右侧评论面板：点右侧竖排那个「评论」图标（data-e2e 带 comment 的那个）
            opened = False
            for sel in ["[data-e2e*='comment']", "[data-e2e='feed-comment-icon']"]:
                loc = page.locator(sel).first
                try:
                    if await loc.count():
                        bx = await loc.bounding_box()
                        if bx:
                            await page.mouse.click(bx["x"] + bx["width"] / 2, bx["y"] + bx["height"] / 2)
                            await page.wait_for_timeout(2500)
                            opened = await page.evaluate("() => (document.body.innerText || '').indexOf('全部评论') >= 0")
                            if opened:
                                break
                except Exception:
                    continue
            if not opened:
                await _click_text(page, "评论", exact=True)
                await page.wait_for_timeout(2000)
                opened = await page.evaluate("() => (document.body.innerText || '').indexOf('全部评论') >= 0 || !!document.querySelector('input[placeholder*=\"留下你的精彩评论\"]')")
            notes.append("评论面板已打开" if opened else "评论面板没打开")

        if reply_index is not None and int(reply_index) >= 0:
            # ⭐ 按序号回（图文作品 XHR 不给评论、也没有 data-e2e 容器）
            idx = int(reply_index)
            pos = await page.evaluate(
                """(idx) => {
                    const W = innerWidth;
                    const cands = Array.from(document.querySelectorAll('div,span,a,button'))
                        .filter((e) => {
                            const t = (e.textContent || '').trim();
                            const r = e.getBoundingClientRect();
                            return t === '回复' && r.width > 4 && r.height > 4 && r.x > W * 0.3;
                        });
                    if (cands.length <= idx) return { ok: false, n: cands.length };
                    const r = cands[idx].getBoundingClientRect();
                    return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2, n: cands.length };
                }""",
                idx,
            )
            if not pos or not pos.get("ok"):
                diag = await page.evaluate(
                    r"""() => {
                        const all = Array.from(document.querySelectorAll('div,span,a,button'));
                        const hit = all.filter((e) => (e.textContent || '').indexOf('回复') >= 0)
                            .map((e) => ((e.textContent || '').trim().slice(0, 12) + ' @' + e.tagName + ' ' + (e.className || '').toString().slice(0, 16)))
                            .slice(0, 6);
                        return { n: hit.length, sample: hit, hasComposer: !!document.querySelector('input[placeholder*=\"回复\"], textarea') };
                    }"""
                )
                return _err(f"没找到第 {idx} 个「回复」链接", aweme_id=aid, diag=diag)
            await page.mouse.move(pos["x"], pos["y"])
            await page.wait_for_timeout(300)
            await page.mouse.click(pos["x"], pos["y"])
            notes.append(f"按「回复」序号 {idx} 回（页面共 {pos.get('n')} 个）")
        elif reply_cid:
            # DOM 里没有 cid 属性；用 /comment/list/ 的顺序把 cid 映射到第几条评论
            await cmt_net.wait_for(lambda u, d: isinstance(d.get("comments"), list), timeout=8.0)
            idx = None
            ordered: list[str] = []
            for item in list(cmt_net.items):
                for c in item["data"].get("comments") or []:
                    cid = str(c.get("cid") or "")
                    if cid:
                        ordered.append(cid)
            if str(reply_cid) in ordered:
                idx = ordered.index(str(reply_cid))
            api_text = ""
            api_items = []
            if idx is None:
                # 图文作品不抛 /comment/list/ 这个 XHR：直接问接口拿顺序，再按序号映射回 DOM
                try:
                    api_items = await _fetch_comments_api(page, aid, 50)
                except Exception:
                    api_items = []
                api_ordered = [str(x.get("cid") or "") for x in api_items if x.get("cid")]
                api_text = next((str(x.get("text") or "") for x in api_items
                                 if str(x.get("cid")) == str(reply_cid)), "")
                if api_ordered and str(reply_cid) in api_ordered:
                    ordered = api_ordered
                    idx = api_ordered.index(str(reply_cid))
            if idx is None:
                return _err(
                    f"找不到 cid={reply_cid} 对应的评论（DOM 不暴露 cid，接口里也没有）",
                    aweme_id=aid, notes=notes,
                )
            # 先把评论面板打开（图文页默认可能没展开）
            try:
                panel_visible = await page.evaluate(r"""() => {
                    const l = document.querySelector('[data-e2e="comment-list"]');
                    return !!(l && l.getClientRects().length);
                }""")
            except Exception:
                panel_visible = False
            if not panel_visible:
                try:
                    icon = page.locator("[data-e2e='feed-comment-icon'],[data-e2e*='comment-icon']").first
                    if await icon.count():
                        await icon.click(timeout=5000)
                        await page.wait_for_timeout(2000)
                except Exception:
                    pass

            items = page.locator("[data-e2e='comment-item']")
            source_comment = next((c for item in cmt_net.items for c in item["data"].get("comments", [])
                                   if str(c.get("cid")) == str(reply_cid)), None)
            source_comment = source_comment or next((c for c in api_items if str(c.get('cid')) == str(reply_cid)), None)
            need_text = str((source_comment or {}).get("text") or api_text or "").strip()
            target = None
            if _parse_comment(source_comment or {}).get('attachments') or not need_text:
                target = await _find_media_comment(items, source_comment, reply_cid)
                if target is None:
                    return _err('图片/表情评论无法唯一定位，未回复；请展开评论后重试', aweme_id=aid)
            elif need_text:
                # DOM 不暴露 cid，而且渲染顺序可能和接口顺序不一致 ⇒ 按正文找（只要可见的），找不到就滚
                need_norm = _norm_comment_text(need_text)
                head = need_norm[:24]
                tail = need_norm[-24:] if len(need_norm) > 24 else ""
                for _ in range(12):
                    cnt = await items.count()
                    for i in range(cnt):
                        it = items.nth(i)
                        try:
                            if not await it.is_visible():
                                continue
                            raw = await it.inner_text()
                            if not raw:
                                continue
                            if need_text[:20] in raw:
                                target = it
                                break
                            got = _norm_comment_text(raw)
                            if got and head and head in got:
                                target = it
                                break
                            if got and tail and tail in got:
                                target = it
                                break
                            nick = str(((source_comment or {}).get("user") or {}).get("nickname") or "").strip()
                            if nick and nick in raw and need_norm:
                                if need_norm[:8] in got or need_norm[-8:] in got:
                                    target = it
                                    break
                        except Exception:
                            continue
                    if target is not None:
                        break
                    try:
                        await page.evaluate(r"""() => {
                            const l = document.querySelector('[data-e2e="comment-list"]');
                            if (l) l.scrollTop = l.scrollHeight;
                            window.scrollBy(0, 900);
                        }""")
                    except Exception:
                        pass
                    await page.wait_for_timeout(1200)
                if target is None:
                    return _err("评论面板里没找到这条评论（滚了 12 屏），未回复", aweme_id=aid, notes=notes)

            try:
                # Playwright 的 scroll_into_view 要求元素本来就可见；先用 JS 滚进视野，再 JS 点「回复」
                await target.evaluate("el => el.scrollIntoView({block: 'center'})")
                await page.wait_for_timeout(700)
                clicked = await target.evaluate("""el => {
                    const btns = Array.from(el.querySelectorAll('div,span,button'))
                        .filter(b => (b.innerText || '').trim() === '回复' && b.getClientRects().length);
                    if (!btns.length) return false;
                    btns[btns.length - 1].click();
                    return true;
                }""")
                if not clicked:
                    return _err("这条评论里没找到「回复」按钮", aweme_id=aid)
                await page.wait_for_timeout(900)
            except Exception as exc:
                return _err(f"回复入口不可用：{type(exc).__name__}: {exc}", aweme_id=aid)

        box = await _first_of(page, [
            "[data-e2e='comment-input']",
            "div[contenteditable='true'][data-e2e*='comment']",
            "div.public-DraftEditor-content",
            "div[contenteditable='true']",
            "textarea[placeholder*='评论']",
            "input[placeholder*='评论']",
            "textarea[placeholder*='善语']",
        ], 4000)
        if box is None:
            # ⭐ 2026-10-23 实测：登录后桌面端视频页**没有** contenteditable / textarea，
            #    只放一个「留下你的精彩评论」的占位块，点了才出现 Draft.js 编辑器。
            for label in ("留下你的精彩评论", "写评论", "善语结善缘", "说点什么"):
                try:
                    ph = page.get_by_text(label, exact=False).first
                    if await ph.count() and await ph.is_visible(timeout=800):
                        await ph.click(timeout=4000)
                        notes.append(f"点开了评论框占位：「{label}」")
                        await page.wait_for_timeout(2500)
                        break
                except Exception:
                    continue
            box = await _first_of(page, [
                "div.public-DraftEditor-content",
                "div[contenteditable='true']",
                "textarea",
            ], 4000)
        if box is None:
            return _err("没找到评论输入框（点了占位也没出编辑器）", aweme_id=aid, notes=notes)

        # Draft.js 用真实键盘事件最稳：先点进编辑器本体，再一个字一个字打
        try:
            ed = page.locator("div.public-DraftEditor-content").first
            if await ed.count():
                box = ed
        except Exception:
            pass
        try:
            await box.click(timeout=3000)
        except Exception:
            pass

        await box.click(timeout=3000)
        await page.keyboard.press("Control+A")
        await page.keyboard.press("Backspace")

        # ⭐ @ 真人提醒（2026-10-23 实测跑通）：打 "@昵称" → 等联想面板 → 点那一行（整行，207×88 那种）
        #    纯文本 @ 不算提醒；必须点到候选项，编辑器里才会变成真正的 mention。
        mention = str(mention or "").strip().lstrip("@")
        body_text = text
        if mention:
            body_text = re.sub(r"^\s*@" + re.escape(mention) + r"\s*", "", body_text).strip() or body_text
            try:
                await page.keyboard.type("@" + mention, delay=55)
                await page.wait_for_timeout(2400)
                rows = await page.evaluate(
                    r"""(nick) => {
                        const els = Array.from(document.querySelectorAll('div,li,span'));
                        const out = [];
                        els.forEach((e) => {
                            const t = (e.innerText || '').trim();
                            const r = e.getBoundingClientRect();
                            if (!t || !Array.from(e.querySelectorAll("span,a,div")).some(n => (n.textContent||"").trim() === nick)) return;
                            if (r.width < 150 || r.width > 280 || r.height < 40 || r.height > 110) return;
                            out.push({ t, x: r.x | 0, y: r.y | 0, w: r.width | 0, h: r.height | 0 });
                        });
                        return out.slice(0, 5);
                    }""",
                    mention,
                )
                if len(rows) == 1:
                    await page.mouse.click(rows[0]["x"] + 10, rows[0]["y"] + rows[0]["h"] / 2)
                    await page.wait_for_timeout(800)
                    notes.append(f"点了 @ 联想面板里的「{rows[0]['t']}」")
                else:
                    return _err("没有找到唯一的 @ 候选，未发送", aweme_id=aid)
            except Exception as exc:
                return _err(f"@ 联想失败：{type(exc).__name__}: {exc}", aweme_id=aid)

        typed = False
        try:
            await page.keyboard.type(body_text, delay=25)
            typed = True
        except Exception as exc:
            notes.append(f"键盘输入失败：{type(exc).__name__}: {exc}")
        if not typed:
            try:
                await box.fill(body_text, timeout=4000)
                typed = True
            except Exception:
                return _err("评论内容填不进去", aweme_id=aid, notes=notes)
        # Submit exactly once. An absent acknowledgement is unknown, never a retry.
        try:
            before_cmt_text = await page.evaluate("""() => {
                const l = document.querySelector('[data-e2e="comment-list"]');
                return (l ? l.innerText : document.body.innerText) || '';
            }""")
        except Exception:
            before_cmt_text = ""
        try:
            before_children = {c["cid"] for c in await _fetch_reply_children(page, aid, str(reply_cid or "")) if c.get("cid")}
        except Exception:
            before_children = set()
        _submitted()
        await page.keyboard.press("Enter")
        hit = await net.wait_for(lambda u, d: "status_code" in d or bool(d.get("comment")), timeout=12.0)
        if not hit:
            # 图文作品的评论不抛回执 XHR ⇒ 用回复/评论列表接口确认（最可靠），再退 DOM 文本
            for _ in range(10):
                await page.wait_for_timeout(1200)
                try:
                    kids = await _fetch_reply_children(page, aid, str(reply_cid or ""))
                except Exception:
                    kids = []
                for c in kids:
                    cid2 = str(c.get("cid") or "")
                    if not cid2 or cid2 in before_children:
                        continue
                    if text and str(c.get("text") or "").strip() == text.strip():
                        notes.append("接口回执：回复列表里出现了这句")
                        return _ok(aweme_id=aid, cid=cid2, text=text, reply_cid=str(reply_cid or ""),
                                   verified=True, evidence="reply-list-api", notes=notes)
            try:
                for _ in range(4):
                    await page.wait_for_timeout(800)
                    now_text = await page.evaluate("""() => {
                        const l = document.querySelector('[data-e2e="comment-list"]');
                        return (l ? l.innerText : document.body.innerText) || '';
                    }""")
                    if text and text in now_text and text not in before_cmt_text:
                        return _ok(aweme_id=aid, cid="", text=text, reply_cid=str(reply_cid or ""),
                                   verified=True, evidence="comment-text-appears", notes=notes)
            except Exception:
                pass
            return _err("已提交但没有平台回执，未自动重发", status="unknown", aweme_id=aid)
        data = hit["data"]
        if data.get("status_code", 0) != 0:
            return _err("平台拒绝评论", status="failed", status_code=data.get("status_code"), aweme_id=aid)
        comment = data.get("comment") or {}
        cid = str(comment.get("cid") or "")
        posted_aid = str(comment.get("aweme_id") or "")
        parent = str(comment.get("reply_id") or comment.get("reply_to_reply_id") or "")
        if not cid or posted_aid != aid or (reply_cid and parent != str(reply_cid)) or (not reply_cid and parent not in ("", "0")):
            return _err("平台回执缺少 CID 或目标/父评论不匹配", status="unknown", aweme_id=aid)
        return _ok(aweme_id=aid, cid=cid, text=comment.get("text") or text, reply_cid=parent,
                   verified=True, evidence="comment-publish-response", notes=notes)
    finally:
        net.close()
        cmt_net.close()


async def _publish_unverified_core(page, ctx, video_path: str, title: str, tags: str, draft: bool, ai_declare: bool = True, cover_path: str = "") -> dict:
    if isinstance(draft, str):
        draft = draft.strip().lower() not in ("0", "false", "no", "off", "")
    path = Path(str(video_path or "").strip())
    if not str(path):
        return _err("video_path 不能为空")
    if not path.is_file():
        return _err(f"视频文件不存在：{path}")
    title = (title or "").strip()
    if not title:
        return _err("title 不能为空")

    notes: list[str] = []
    await _goto(page, CREATOR_UPLOAD, settle=4.0)

    session_cookie = False
    try:
        cookies = await ctx.cookies(["https://creator.douyin.com", "https://www.douyin.com"])
        vals = {c.get("name"): c.get("value") or "" for c in cookies}
        session_cookie = bool(vals.get("sessionid") or vals.get("sessionid_ss") or vals.get("sid_tt"))
    except Exception:
        pass
    if not session_cookie:
        return _need_login("投稿要登录：先 douyin_login_qr → 扫码 → douyin_login_poll",
                           video_path=str(path))

    file_input = page.locator("input[type='file']").first
    if await file_input.count() == 0:
        return _err("没找到上传框 input[type=file]（创作者中心可能改版/被风控）",
                    notes=notes, url=page.url)

    try:
        # file input 通常是 display:none，不能要求 visible；set_input_files 对隐藏 input 有效
        await file_input.set_input_files(str(path))
    except Exception as exc:
        return _err(f"set_input_files 失败：{type(exc).__name__}: {exc}", url=page.url)

    # 等上传进入编辑页
    title_box = None
    deadline = time.time() + 45
    while time.time() < deadline:
        await page.wait_for_timeout(1000)
        title_box = await _first_of(page, [
            "input[placeholder*='标题']",
            "textarea[placeholder*='标题']",
            "[data-e2e='title-input'] input",
            "[data-e2e='title-input']",
            "input[placeholder*='作品']",
        ], 500)
        if title_box is not None:
            break
        if "publish" in (page.url or ""):
            await page.wait_for_timeout(3000)
            title_box = await _first_of(page, [
                "input[placeholder*='标题']",
                "textarea[placeholder*='标题']",
                "[data-e2e='title-input']",
            ], 800)
            if title_box is not None:
                break
    if title_box is None:
        notes.append(f"上传后没找到标题输入框；当前 URL={page.url}")
        return _err("上传后没进入编辑页（可能还在转码，或选择器过期）", notes=notes, url=page.url)

    try:
        await title_box.click(timeout=3000)
        await title_box.fill(title[:55], timeout=4000)
        actual_title = await title_box.evaluate("(e) => e.value === undefined ? e.textContent : e.value")
        if str(actual_title or "").strip() != title[:55].strip():
            return _err("标题回读不一致，未投稿")
    except Exception as exc:
        return _err(f"填标题失败，未投稿：{type(exc).__name__}: {exc}")

    tag_list = [t.strip().lstrip("#") for t in re.split(r"[,，\s]+", tags or "") if t.strip()]
    if tag_list:
        desc = await _first_of(page, [
            "[data-e2e='desc-input']",
            "div[contenteditable='true'][data-e2e*='desc']",
            "div[contenteditable='true']",
            "textarea[placeholder*='简介']",
        ], 2500)
        if desc is None:
            notes.append("没找到简介/话题输入框，话题没填")
        else:
            try:
                await desc.click(timeout=3000)
                for tag in tag_list[:5]:
                    await page.keyboard.type(f" #{tag}", delay=30)
                    await page.wait_for_timeout(700)
                    await page.keyboard.press("Enter")
                    await page.wait_for_timeout(300)
            except Exception as exc:
                notes.append(f"填话题失败：{type(exc).__name__}: {exc}")

    await page.wait_for_timeout(800)

    # ⭐ 2026-10-24：自定义封面（设置封面 → 上传封面 → 裁剪弹层点「完成」）
    #    踩坑：传完图会弹 ReactCrop 裁剪层，不点「完成」它就一直在，后面所有点击被它吃掉。
    if cover_path and os.path.isfile(cover_path):
        try:
            opened = False
            for sel in ["text=设置封面", "text=选择封面", "text=更换封面", "text=编辑封面"]:
                loc = page.locator(sel).first
                if await loc.count():
                    await loc.click(timeout=6000, force=True)
                    opened = True
                    break
            if opened:
                await page.wait_for_timeout(2500)
                img_input = page.locator("input[type=file][accept*='image']").last
                await img_input.set_input_files(cover_path)
                # 等裁剪层出现
                try:
                    await page.wait_for_selector(".ReactCrop__image", timeout=20000)
                except Exception:
                    notes.append("没等到裁剪层（可能直接用了原图）")
                await page.wait_for_timeout(2000)
                # ⭐ 弹层里的确认键叫「保存」（不是「完成」）——2026-10-24 抓 DOM 确认
                clicked_done = await page.evaluate(
                    r"""() => {
                        const bs = Array.from(document.querySelectorAll('button'));
                        const save = bs.find((x) => (x.innerText || '').trim() === '保存' && /primary/i.test(x.className || ''));
                        const any = save || bs.find((x) => (x.innerText || '').trim() === '保存');
                        if (any) { any.click(); return true; }
                        return false;
                    }"""
                )
                await page.wait_for_timeout(4000)
                # 等裁剪层消失
                for _ in range(10):
                    still = await page.evaluate("() => !!document.querySelector('.ReactCrop__image')")
                    if not still:
                        break
                    await page.wait_for_timeout(1200)
                else:
                    await page.keyboard.press("Escape")
                    await page.wait_for_timeout(1500)
                notes.append(("已上传自定义封面：" if clicked_done else "封面图已选但没点到「完成」：") + os.path.basename(cover_path))
            else:
                notes.append("⚠️ 没找到封面入口（设置封面/选择封面）")
        except Exception as exc:
            notes.append(f"上传封面失败：{type(exc).__name__}: {exc}")

    # ⭐ 2026-10-23：发布前先点「自主声明」→ 勾「内容由AI生成」
    #    不勾这个，AI 视频会被判"未声明"，轻则限流重则下架。
    if ai_declare:
        declaration_verified = False
        try:
            opened = False
            for sel in ["text=请选择自主声明", "[class*=selectBox]", "text=自主声明"]:
                loc = page.locator(sel).first
                if await loc.count():
                    await loc.click(timeout=4000)
                    opened = True
                    break
            if opened:
                await page.wait_for_timeout(1500)
                picked = False
                # 那行是 <label class="semi-radio"><span>内容由AI生成</span></label>
                # 点 span 会被 label 挡（pointer events 被 label 拦截）⇒ 点 label 本身并 force
                for sel in ["label.semi-radio:has-text('内容由AI生成')", "label:has-text('内容由AI生成')",
                            "text=内容由AI生成"]:
                    opt = page.locator(sel).first
                    if await opt.count():
                        await opt.click(timeout=5000, force=True)
                        picked = True
                        break
                if picked:
                    await page.wait_for_timeout(1200)
                    for sel in ["button:has-text('确定')", "button:has-text('完成')",
                                "button:has-text('我知道了')"]:
                        b = page.locator(sel).first
                        if await b.count():
                            try:
                                await b.click(timeout=2500, force=True)
                                await page.wait_for_timeout(600)
                            except Exception:
                                pass
                    try:
                        await page.keyboard.press("Escape")
                        await page.wait_for_timeout(500)
                    except Exception:
                        pass
                    declaration_verified = await page.evaluate("""() => {
                        const nodes=Array.from(document.querySelectorAll('label.semi-radio-checked,label:has(input:checked),[role="radio"][aria-checked="true"]'));
                        return nodes.some(e=>(e.innerText||'').includes('内容由AI生成'));
                    }""")
                    notes.append("AI 声明状态已回读" if declaration_verified else "AI 声明未确认")
                else:
                    notes.append("⚠️ 打开声明面板但没找到「内容由AI生成」")
            else:
                notes.append("⚠️ 没找到「自主声明」入口")
        except Exception as exc:
            notes.append(f"勾声明失败：{type(exc).__name__}: {exc}")
        if not declaration_verified:
            return _err("AI 内容声明未确认，未投稿", notes=notes)

    if draft:
        _submitted()
        # ⭐ 2026-10-23 实测：创作页没有「存草稿」，草稿动作叫**「暂存离开」**
        clicked = await _click_text(page, "暂存离开", exact=True)
        if not clicked:
            clicked = await _click_text(page, "存草稿", exact=True)
        if not clicked:
            clicked = await _click_text(page, "保存草稿", exact=True)
        if not clicked:
            return _err("没找到草稿按钮（创作页可能改版；现在叫「暂存离开」）", url=page.url, notes=notes)
        await page.wait_for_timeout(3000)
        notes.append("draft=True：点了「暂存离开」，只存草稿，没有发布")
        return _ok(url=page.url, draft=True, notes=notes)

    clicked = False
    attempted = False
    try:
        loc = page.locator("button:has-text('发布')")
        n = await loc.count()
        for i in range(n):
            item = loc.nth(i)
            if await item.is_visible(timeout=300):
                txt = ((await item.inner_text()) or "").strip()
                if txt in ("发布", "发布作品"):
                    attempted = True
                    _submitted()
                    await item.click(timeout=5000)
                    clicked = True
                    break
    except Exception as exc:
        if attempted:
            return _err(f"发布点击过程异常，未再次提交：{type(exc).__name__}: {exc}", status="unknown")
        notes.append(f"发布按钮读取失败：{type(exc).__name__}: {exc}")
    if not clicked:
        _submitted()
        clicked = await _click_text(page, "发布", exact=True)
    if not clicked:
        return _err("没找到可点的「发布」按钮", url=page.url, notes=notes)
    await page.wait_for_timeout(4000)
    return _ok(url=page.url, draft=False, notes=notes)


async def _publish_core(page, ctx, video_path, title, tags, draft, ai_declare=True, cover_path=""):
    matcher = lambda u: any(x in u for x in ("/aweme/create", "/item/create", "/draft/save", "/save_draft", "/aweme/publish"))
    net = Net(page, matcher)
    try:
        result = await _publish_unverified_core(page, ctx, video_path, title, tags, draft, ai_declare, cover_path)
        if not result.get("ok"):
            return result
        for _ in range(12):
            for item in net.items:
                if item.get("method") != "POST" or not item.get("afterSubmit"):
                    continue
                data = item["data"]
                if data.get("status_code", 0) != 0:
                    return _err("平台拒绝投稿或保存草稿", status="failed", status_code=data.get("status_code"))
                obj = data.get("draft") or data.get("aweme") or data.get("data") or data
                identity = str((obj.get("draft_id") if draft else obj.get("aweme_id") or obj.get("item_id")) or "")
                if identity:
                    return _ok(draft=bool(draft), verified=True, platformId=identity, aweme_id="" if draft else identity,
                               draftId=identity if draft else "", url="" if draft else VIDEO_URL.format(aweme_id=identity), evidence="publish-response")
            await page.wait_for_timeout(500)
        return _err("已提交但未收到带作品/草稿 ID 的回执，请核对平台后再操作", status="unknown", draft=bool(draft))
    finally:
        net.close()


# ---------------------------------------------------------------------------
# selfcheck
# ---------------------------------------------------------------------------

async def _selfcheck_core() -> dict:
    notes: list[str] = []
    out = {
        "ok": False,
        "chrome": False,
        "profile": str(PROFILE_DIR),
        "cdpUrl": CDP_URL,
        "mode": "cdp" if CDP_URL else "profile",
        "loggedIn": False,
        "searched": False,
        "notes": notes,
    }
    import importlib.util
    import shutil
    model = os.environ.get("DOUYIN_WHISPER_MODEL", "base")
    hub = Path(os.environ.get("HUGGINGFACE_HUB_CACHE", str(HOME / "models" / "hub")))
    model_dir = Path(model) if Path(model).is_dir() else hub / ("models--Systran--faster-whisper-" + model)
    out["media"] = {
        "ffmpeg": _ffmpeg_path(),
        "ffmpegReady": bool(shutil.which(_ffmpeg_path())),
        "dependenciesReady": all(importlib.util.find_spec(x) is not None for x in ("numpy", "faster_whisper", "httpx")),
        "model": model,
        "modelCached": (model_dir / "model.bin").is_file() or any(model_dir.glob("snapshots/*/model.bin")),
        "modelCache": str(model_dir),
    }
    try:
        ctx = await _browser.context()
        out["chrome"] = True
        out["mode"] = _browser.mode
        if _browser.cdp_note:
            notes.append(_browser.cdp_note)
        if _browser.mode == "cdp":
            notes.append(f"用的是本人已经登录的 Chrome（{CDP_URL}）")
    except Exception as exc:
        notes.append(f"Chrome 起不来：{type(exc).__name__}: {exc}")
        out["error"] = f"Chrome 启动失败：{exc}"
        return out

    page = await _browser.page()
    try:
        await _goto(page, HOME_URL, settle=3.0)
        notes.append(f"首页 URL={page.url}（会重定向到 /jingxuan 抖音精选）")
        st = await _login_state(page, ctx)
        out["loggedIn"] = st["loggedIn"]
        out["evidence"] = {"cookie": st["cookie"], "avatar": st["avatar"], "loginPrompt": st["loginPrompt"]}
        if st["nickname"]:
            out["nickname"] = st["nickname"]
        if st["uid"]:
            out["uid"] = st["uid"]

        if st["loggedIn"]:
            res = await _search_core(page, "AI", 2, "general")
            out["searched"] = bool(res.get("ok") and res.get("items"))
            if not out["searched"]:
                notes.append(f"搜索没出结果：{res.get('error') or res.get('notes') or res.get('hint')}")
            else:
                notes.append(f"搜索 OK，拿到 {len(res.get('items') or [])} 条")
        else:
            out["needLogin"] = True
            notes.append("未登录：搜索/点赞/评论/投稿都会返回 needLogin；先调 douyin_login_qr 扫码")
            if await _has_login_wall(page):
                notes.append("页面上能看到登录弹层/登录墙文案（搜索页写的是「登录后即可搜索更多精彩视频」）")

        out["ok"] = True
        return out
    except Exception as exc:
        log(traceback.format_exc())
        notes.append(f"{type(exc).__name__}: {exc}")
        out["error"] = f"{type(exc).__name__}: {exc}"
        return out


async def _selftest() -> dict:
    started = time.time()
    try:
        sc = await asyncio.wait_for(_selfcheck_core(), timeout=50)
    except asyncio.TimeoutError:
        sc = {"ok": False, "chrome": False, "profile": str(PROFILE_DIR), "loggedIn": False,
              "searched": False, "notes": ["selfcheck 50s 超时"], "error": "timeout"}
    try:
        cred = await asyncio.wait_for(_check_credential_core(), timeout=20)
    except Exception as exc:
        cred = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    result = {
        "selftest": True,
        "ok": bool(sc.get("ok")),
        "chrome": sc.get("chrome"),
        "profile": sc.get("profile"),
        "loggedIn": sc.get("loggedIn"),
        "needLogin": bool(sc.get("needLogin", not sc.get("loggedIn"))),
        "searched": sc.get("searched"),
        "notes": sc.get("notes", []),
        "checkCredential": cred,
        "home": str(HOME),
        "headless": HEADLESS,
        "cdpUrl": CDP_URL,
        "mode": sc.get("mode", "cdp" if CDP_URL else "profile"),
        "tools": 10,
        "seconds": round(time.time() - started, 2),
    }
    if sc.get("error"):
        result["error"] = sc["error"]
    return result


async def _hot_core(page, limit: int = 30) -> dict:
    """热榜：先直接同源请求 hot/search/list（带页面 cookie），不行再拦 XHR。**不需要登录**。"""
    limit = max(1, min(int(limit or 30), 100))
    notes: list[str] = []
    words: list[dict] = []
    seen: set[str] = set()

    def take(payload: dict) -> None:
        data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
        for w in (data.get("word_list") or []):
            word = str(w.get("word") or "").strip()
            if not word or word in seen:
                continue
            seen.add(word)
            words.append({
                "word": word,
                "sentence_id": str(w.get("sentence_id") or ""),
                "hot_value": int(w.get("hot_value") or 0),
                "discuss_video_count": int(w.get("discuss_video_count") or 0),
            })

    try:
        try:
            resp = await page.request.get(
                "https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&detail_list=1",
                headers={"referer": HOME_URL},
                timeout=15000,
            )
            if resp.ok:
                take(await resp.json())
                if words:
                    notes.append("热榜走同源请求（不需要登录）")
        except Exception as exc:  # noqa: BLE001
            notes.append(f"同源请求失败：{type(exc).__name__}: {exc}")

        if not words:
            net = Net(page, lambda u: "hot/search/list" in u)
            try:
                await _goto(page, HOME_URL, settle=5.0)
                for _ in range(4):
                    if net.items:
                        break
                    await page.wait_for_timeout(2500)
                for item in list(net.items):
                    take(item["data"])
                if words:
                    notes.append("热榜走页面 XHR 拦截")
            finally:
                net.close()

        if not words:
            notes.append("没拿到热榜（同源请求和 XHR 都没出数据）")
            return _ok(items=[], count=0, notes=notes, needLogin=False)
        return _ok(items=words[:limit], count=min(len(words), limit), total=len(words), notes=notes)
    finally:
        pass


async def _hot_videos_core(page, sentence_id: str = "", word: str = "", num: int = 10) -> dict:
    """某条热点下的视频：开 /hot/<sentence_id>，从 DOM 里收 /video/<id>。**不需要登录**。"""
    num = max(1, min(int(num or 10), 60))
    sid = str(sentence_id or "").strip()
    notes: list[str] = []
    if not sid:
        w = str(word or "").strip()
        if not w:
            return _err("给 sentence_id 或 word 其中一个")
        hot = await _hot_core(page, 100)
        for it in hot.get("items") or []:
            if it.get("word") == w or w in str(it.get("word") or ""):
                sid = str(it.get("sentence_id") or "")
                break
        if not sid:
            return _err(f"热榜里没找到「{w}」", notes=["先把 word 写全，或直接用 douyin_hot 拿 sentence_id"])
    try:
        await _goto(page, f"https://www.douyin.com/hot/{sid}", settle=5.0)
        for _ in range(3):
            if len(await page.eval_on_selector_all("a[href*='/video/']", "e => e")) >= num:
                break
            await page.mouse.wheel(0, 1500)
            await page.wait_for_timeout(1200)
        raw = await page.eval_on_selector_all(
            "a[href*='/video/']",
            "els => els.map(e => ({href: e.getAttribute('href'), text: (e.innerText||'').trim().slice(0,120)}))",
        )
        items: list[dict] = []
        seen: set[str] = set()
        for it in raw or []:
            m = re.search(r"/video/(\d+)", str(it.get("href") or ""))
            if not m:
                continue
            aid = m.group(1)
            if aid in seen:
                continue
            seen.add(aid)
            items.append({"aweme_id": aid, "url": VIDEO_URL.format(aweme_id=aid), "title": it.get("text") or ""})
        title = await page.title()
        if not items:
            notes.append("热点页没收到视频链接（可能要登录，或这条热点没有视频）")
        else:
            notes.append(f"热点页标题：{title[:60]}；视频链接来自 DOM（不需要登录）")
        return _ok(sentence_id=sid, page_title=title, items=items[:num], count=min(len(items), num), notes=notes)
    finally:
        pass


async def _thumb_core(page, aweme_id: str) -> dict:
    """没封面 URL 时，自己截一张：把视频播放器那块截下来存 <家>/thumbs/<id>.jpg。"""
    aid = _extract_aweme_id(aweme_id)
    if not aid:
        return _err("aweme_id 不合法")
    thumbs = HOME / "thumbs"
    thumbs.mkdir(parents=True, exist_ok=True)
    dest = thumbs / f"{aid}.jpg"
    if dest.exists() and dest.stat().st_size > 2000:
        return _ok(aweme_id=aid, path=str(dest), cached=True)

    await _goto(page, VIDEO_URL.format(aweme_id=aid), settle=4.0)
    await page.wait_for_timeout(1200)
    shot = None
    for sel in ["[data-e2e='player-container']", "[data-e2e='video-detail']", "video"]:
        try:
            loc = page.locator(sel).first
            if await loc.count() and await loc.is_visible(timeout=800):
                shot = await loc.screenshot(type="jpeg", quality=72)
                break
        except Exception:
            continue
    if shot is None:
        try:
            shot = await page.screenshot(type="jpeg", quality=72)
        except Exception as exc:  # noqa: BLE001
            return _err(f"截图失败：{type(exc).__name__}: {exc}")
    dest.write_bytes(shot)
    # 统一缩成 320 宽，并把播放器底部那条控制栏裁掉（留着像"截屏"，不好看）
    try:
        from PIL import Image
        with Image.open(dest) as im:
            im = im.convert("RGB")
            w, h = im.size
            im = im.crop((0, 0, w, int(h * 0.88)))
            w, h = im.size
            nw = 320
            im.resize((nw, max(1, int(h * nw / w))), Image.LANCZOS).save(dest, "JPEG", quality=78)
    except Exception as exc:  # noqa: BLE001
        log(f"缩略图后处理失败（保留原图）：{type(exc).__name__}: {exc}")
    log(f"缩略图已存：{dest} ({dest.stat().st_size} bytes)")
    return _ok(aweme_id=aid, path=str(dest), cached=False, bytes=dest.stat().st_size)


async def _check_credential_core() -> dict:
    ctx = await _browser.context()
    page = await _browser.page()
    await _goto(page, HOME_URL, settle=3.0)
    st = await _login_state(page, ctx)
    out = {"ok": True, "loggedIn": st["loggedIn"],
           "evidence": {"cookie": st["cookie"], "avatar": st["avatar"], "loginPrompt": st["loginPrompt"]}}
    if st["loggedIn"]:
        if st["nickname"]:
            out["nickname"] = st["nickname"]
        if st["uid"]:
            out["uid"] = st["uid"]
        out["hint"] = "已登录：搜索/点赞/评论/投稿都能用"
    else:
        out["needLogin"] = True
        out["hint"] = "未登录：先 douyin_login_qr 出二维码，手机扫码后再 douyin_login_poll"
    return out


# ---------------------------------------------------------------------------
# MCP 工具（名字/入参严格按 SPEC.md）
# ---------------------------------------------------------------------------

mcp = FastMCP(APP_NAME)


WRITE_TOOL_NAMES = {"douyin_like", "douyin_comment", "douyin_publish", "douyin_share_video", "douyin_chat_send", "douyin_chat_sticker", "douyin_chat_batch"}
TOOL_ALLOWLIST = {x.strip() for x in os.environ.get("DOUYIN_MCP_TOOLS", "").split(",") if x.strip()}


def restricted_tool():
    def decorate(fn):
        allowed = not TOOL_ALLOWLIST or fn.__name__ in TOOL_ALLOWLIST
        if fn.__name__ in WRITE_TOOL_NAMES and os.environ.get("DOUYIN_ALLOW_WRITES") != "1":
            allowed = False
        if not allowed:
            return fn
        proxy_url = os.environ.get("DOUYIN_PROXY_URL", "")
        if proxy_url:
            signature = inspect.signature(fn)
            @functools.wraps(fn)
            async def proxied(*args, **kwargs):
                import httpx
                from urllib.parse import urlparse
                url = urlparse(proxy_url)
                if url.scheme != "http" or url.hostname != "127.0.0.1" or url.path != "/action":
                    return j(_err("无效宿主代理地址"))
                bound = signature.bind(*args, **kwargs)
                bound.apply_defaults()
                try:
                    async with httpx.AsyncClient(timeout=920, trust_env=False) as client:
                        response = await client.post(proxy_url, headers={"Authorization": "Bearer " + os.environ.get("DOUYIN_PROXY_TOKEN", "")}, json={"name": fn.__name__, "args": dict(bound.arguments)})
                        response.raise_for_status()
                        return j(response.json())
                except Exception as exc:
                    return j(_err("宿主代理请求失败：" + str(exc), status="unknown" if fn.__name__ in WRITE_TOOL_NAMES else "failed"))
            return mcp.tool()(proxied)
        return mcp.tool()(fn)
    return decorate


@restricted_tool()
async def douyin_hot(limit: int = 30) -> str:
    """抖音热榜（**不用登录**就能拿）。

    返回 {ok, items:[{word, sentence_id, hot_value, discuss_video_count}], count, notes?}。
    sentence_id 可以喂给 douyin_hot_videos 去看这条热点的视频。
    """
    async def _impl():
        page = await _browser.page()
        return await _hot_core(page, limit)

    return j(await _guard(_impl, 45))


@restricted_tool()
async def douyin_hot_videos(sentence_id: str = "", word: str = "", num: int = 10) -> str:
    """看某条热点的视频列表（**不用登录**）。给 sentence_id（推荐）或 word。

    返回 {ok, sentence_id, word, items:[{aweme_id,url,title}], count, notes?}。
    """
    async def _impl():
        page = await _browser.page()
        return await _hot_videos_core(page, sentence_id, word, num)

    return j(await _guard(_impl, 60))


@restricted_tool()
async def douyin_login_sms(phone: str = "") -> str:
    """扫码后的二次验证：先点「收验证码」，再点「获取验证码」。

    弹层里已经带出手机号时 phone 可以空着。返回 {ok, needCode, sent, hint}；
    短信到了再调 douyin_login_sms_submit(code)。不要为了发短信重新出二维码。
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        return await _sms_start_core(page, ctx, phone)

    return j(await _guard(_impl, 60))


@restricted_tool()
async def douyin_login_sms_submit(code: str) -> str:
    """短信验证码登录第二步：填 6 位验证码并点登录，最多等 15 秒确认登录态。

    返回 {ok, loggedIn, nickname?, uid?, hint}。
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        return await _sms_submit_core(page, ctx, code)

    return j(await _guard(_impl, 60))


@restricted_tool()
async def douyin_thumb(aweme_id: str) -> str:
    """给一条视频截缩略图（没封面 URL 时用）。存 <家>/thumbs/<id>.jpg，返回 {ok, path}。"""
    async def _impl():
        page = await _browser.page()
        return await _thumb_core(page, aweme_id)

    return j(await _guard(_impl, 60))


@restricted_tool()
async def douyin_check_credential() -> str:
    """检查抖音登录态（cookie sessionid + 页面头像两种证据）。

    返回 {ok, loggedIn, nickname?, uid?, evidence?, hint?}。
    """
    return j(await _guard(_check_credential_core, 45))


@restricted_tool()
async def douyin_login_qr() -> str:
    """打开抖音首页，唤出扫码登录弹层，把二维码截图存到 <家>/login-qr.png。

    返回 {ok, png, hint, loggedIn, needLogin?, bytes?, notes?}。
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        return await _login_qr_core(page, ctx)

    return j(await _guard(_impl, 60))


@restricted_tool()
async def douyin_login_poll() -> str:
    """轮询登录态（手机扫码后调用）。

    返回 {ok, loggedIn, nickname?, uid?, hint, needLogin?}。
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        return await _login_poll_core(page, ctx)

    return j(await _guard(_impl, 30))



def _drop_live(items):
    """直播不进候选：抖音的直播间没有时长/是 live 类型，标题常带「直播中」「正在直播」。
    这里按几种特征一起判断，宁可多滤掉也不让直播混进挑片列表。"""
    keep = []
    dropped = 0
    for it in items or []:
        title = str(it.get("title") or "")
        url = str(it.get("url") or "")
        dur = it.get("duration")
        is_live = (
            "/live/" in url
            or "直播" in title
            or "正在直播" in title
            or (it.get("is_live") is True)
            or (it.get("live") is True)
            or (dur in (0, None, "") and it.get("source") == "live")
        )
        if is_live:
            dropped += 1
            continue
        keep.append(it)
    return keep, dropped

async def _feed_core(page, ctx, num: int, scrolls: int, skip_live: bool = True) -> dict:
    """刷推荐流：打开首页推荐，滚几屏，把露出的视频收下来（不搜关键词）。"""
    notes = []
    await _goto(page, "https://www.douyin.com/", settle=5.0)
    st = await _login_state(page, ctx)
    if not st["loggedIn"]:
        notes.append("没登录：推荐流会更窄，仍然能刷")
    seen = {}

    async def _on_resp(resp):
        try:
            u = resp.url or ""
            if "tab/feed" not in u and "module/feed" not in u:
                return
            data = await resp.json()
            for a in (data or {}).get("aweme_list") or []:
                aid = str(a.get("aweme_id") or "")
                if not aid or aid in seen:
                    continue
                desc = str(a.get("desc") or "")
                seen[aid] = {"aweme_id": aid, "title": desc[:60],
                             "url": "https://www.douyin.com/video/" + aid,
                             "duration": (a.get("video") or {}).get("duration") or a.get("duration") or 0,
                             "author": ((a.get("author") or {}).get("nickname") or "")[:20],
                             "digg": (a.get("statistics") or {}).get("digg_count") or 0}
        except Exception:
            return

    page.on("response", _on_resp)
    try:
        await _goto(page, "https://www.douyin.com/jingxuan", settle=4.0)
        # 精选页默认不拉推荐流 ⇒ 点一下「推荐」
        try:
            await page.evaluate(r"""() => {
                const n = Array.from(document.querySelectorAll('div,span,a')).find((e) => (e.innerText || '').trim() === '推荐');
                if (n) n.click();
            }""")
        except Exception:
            pass
        await page.wait_for_timeout(4000)
        st = await _login_state(page, ctx)
        if not st["loggedIn"]:
            notes.append("没登录：推荐流会更窄，仍然能刷")
        idle = 0
        for i in range(max(1, scrolls)):
            if len(seen) >= num or idle >= 3:
                break
            before = len(seen)
            try:
                await page.mouse.wheel(0, 1800)
                await page.wait_for_timeout(2200)
            except Exception:
                break
            if len(seen) == before:
                idle += 1
            else:
                idle = 0
        if not seen:
            notes.append("推荐流的接口没抓到东西（可能要登录/风控）")
    finally:
        try:
            page.remove_listener("response", _on_resp)
        except Exception:
            pass

    items = list(seen.values())[:num]
    items, dropped = _drop_live(items) if skip_live else (items, 0)
    if dropped:
        notes.append(f"跳过 {dropped} 条直播")
    return _ok(items=items, count=len(items), source="feed", notes=notes or None)

# ---------------------------------------------------------------------------
# 真·看视频：抓媒体 → 抽音轨 → 转写
# ---------------------------------------------------------------------------

def _ffmpeg_path() -> str:
    import shutil
    for c in ("ffmpeg", "ffmpeg.exe"):
        hit = shutil.which(c)
        if hit:
            return hit
    cand = Path.home() / "AppData" / "Local" / "Microsoft" / "WinGet" / "Packages"
    for p in cand.glob("Gyan.FFmpeg*/**/bin/ffmpeg.exe"):
        return str(p)
    return "ffmpeg"


def _media_url_allowed(url):
    from urllib.parse import urlparse
    u = urlparse(url)
    host = (u.hostname or "").lower()
    domains = ("douyin.com", "douyinvod.com", "douyincdn.com", "amemv.com", "bytecdn.cn", "byteimg.com", "ibytedtos.com", "toutiaovod.com")
    return u.scheme == "https" and not u.username and not u.password and any(host == d or host.endswith("." + d) for d in domains)


async def _run_ffmpeg(cmd, timeout=90):
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        **({"creationflags": 0x08000000} if os.name == "nt" else {}))
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout)
        return type("ProcessResult", (), {"returncode": proc.returncode, "stdout": stdout, "stderr": stderr})()
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


async def _download_media(page, url, dest, max_bytes=64 * 1024 * 1024):
    import httpx
    from urllib.parse import urljoin
    jar = httpx.Cookies()
    for c in await page.context.cookies([url]):
        jar.set(c["name"], c["value"], domain=c.get("domain", ""), path=c.get("path", "/"))
    async with httpx.AsyncClient(cookies=jar, timeout=90, follow_redirects=False) as client:
        for _ in range(4):
            if not _media_url_allowed(url):
                raise ValueError("视频媒体地址不在允许的 HTTPS 域名内")
            async with client.stream("GET", url, headers={"Referer": HOME_URL, "User-Agent": UA}) as response:
                if response.is_redirect:
                    url = urljoin(url, response.headers.get("location", ""))
                    continue
                response.raise_for_status()
                if int(response.headers.get("content-length", 0)) > max_bytes:
                    raise ValueError("视频超过下载大小上限")
                total = 0
                with dest.open("wb") as f:
                    async for chunk in response.aiter_bytes(65536):
                        total += len(chunk)
                        if total > max_bytes:
                            raise ValueError("视频超过下载大小上限")
                        f.write(chunk)
                return
    raise ValueError("媒体重定向次数过多")


def _transcribe_sync(wav):
    import wave
    import numpy as np
    with wave.open(str(wav), "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError("音轨必须为 16kHz 单声道 PCM16")
        audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    if not len(audio):
        raise ValueError("音轨没有可用音频帧")
    model_name = os.environ.get("DOUYIN_WHISPER_MODEL", "base")
    segments, info = _whisper_model(model_name).transcribe(audio, language="zh", vad_filter=True, beam_size=1)
    return {"transcript": " ".join(s.text.strip() for s in segments if s.text and s.text.strip())[:4000], "language": info.language}


async def _transcribe_wav(wav):
    proc = await asyncio.create_subprocess_exec(sys.executable, str(Path(__file__).resolve()), "--transcribe-wav", str(wav),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        **({"creationflags": 0x08000000} if os.name == "nt" else {}))
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), 180)
        if proc.returncode:
            raise RuntimeError(stderr.decode("utf-8", "replace")[-1000:])
        return json.loads(stdout.decode("utf-8"))
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


async def _watch_core(page, aweme_id: str, seconds: int = 300, frames: int = 10) -> dict:
    """看片：交给「视频理解原型」(video-understanding-lab) 下载 + 抽音轨 + 本地转写。

    2026-10-27：原来的 ffmpeg 直连 CDN 方案经常 Timeout / 超大小上限，改成复用原型：
      run.py capture -> prepare -> asr -> transcript.json
    这样走的是浏览器 cookie 下载，稳定性高得多。
    """
    aid = _extract_aweme_id(str(aweme_id))
    if not aid or not aid.isdigit():
        return _err("aweme_id 不合法")
    seconds = max(15, min(int(seconds), 600))
    media_dir = HOME / "media"
    media_dir.mkdir(parents=True, exist_ok=True)
    cache = media_dir / f"{aid}.{seconds}.v4.json"
    if cache.exists():
        try:
            data = json.loads(cache.read_text(encoding="utf-8"))
            # v4 起校验时长：旧版 duration=0/partial=false 的错误缓存必须重跑
            if data.get("schemaVersion") == 4 and data.get("ok") is True and float(data.get("duration") or 0) > 0:
                return {**data, "cached": True}
        except Exception:
            pass

    lab_candidates = []
    if os.environ.get("DOUYIN_VIDEO_LAB"):
        lab_candidates.append(Path(os.environ["DOUYIN_VIDEO_LAB"]))
    here = globals().get("__file__")
    if here:
        script = Path(here).resolve()
        lab_candidates.append(script.parent / "video-understanding-lab")
        if len(script.parents) > 2:
            lab_candidates.append(script.parents[2] / "video-understanding-lab")
    lab_dir = next((p for p in lab_candidates if (p / "run.py").is_file()), None)
    if lab_dir is None:
        return _err("找不到视频理解原型 run.py（安装包应自带 video-understanding-lab；也可设 DOUYIN_VIDEO_LAB）", path="video-understanding-lab/run.py")
    entry = lab_dir / "run.py"
    case = media_dir / "lab" / f"{aid}-{int(time.time())}"
    case.parent.mkdir(parents=True, exist_ok=True)
    cdp = (CDP_URL if _browser.mode == "cdp" else "") or f"http://127.0.0.1:{SHARED_PORT}"
    notes: list[str] = []
    phase = "capture"

    async def run_lab(args, timeout):
        proc = await asyncio.create_subprocess_exec(
            sys.executable, str(entry), *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            **({"creationflags": 0x08000000} if os.name == "nt" else {}))
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except Exception:
                pass
            try:
                await asyncio.wait_for(proc.wait(), 10)
            except Exception:
                pass
            step = args[0] if args else ""
            return 124, "", f"本步超时（{timeout}s）：{step}"
        finally:
            if proc.returncode is None:
                try:
                    proc.kill()
                except Exception:
                    pass
                await proc.wait()
        return proc.returncode, (out or b"").decode("utf-8", "replace"), (err or b"").decode("utf-8", "replace")

    try:
        if _browser.mode == "cdp":
            # CDP 模式：原型的 capture 直接连本人 Chrome
            rc, out, err = await run_lab(
                ["capture", "--url", f"https://www.douyin.com/video/{aid}", "--out", str(case), "--cdp-url", cdp],
                240)
            if rc != 0:
                tail = (err or out).strip()[-300:] or "capture 失败"
                await _note_captcha(page)
                return _err(f"原型下载失败：{tail}", phase=phase, aweme_id=aid)
        else:
            # profile 模式：Playwright 拉起的 Chrome 不一定暴露调试端口，capture 连不上 9333。
            # 直接用当前页面（已登录）拿 play_addr + cookie 下载，再交给原型的 prepare/asr。
            case.mkdir(parents=True, exist_ok=True)
            net = Net(page, _is_detail_url)
            try:
                await _goto(page, VIDEO_URL.format(aweme_id=aid), settle=3.5)
                hit = await net.wait_for(lambda u, d: bool((d.get("aweme_detail") or {}).get("aweme_id")), timeout=12.0)
                aw = ((hit or {}).get("data") or {}).get("aweme_detail") or {}
                if not aw:
                    await _note_captcha(page)
                    return _err("没拿到视频详情，无法下载（可能被风控/删除）", phase=phase, aweme_id=aid)
                video = aw.get("video") or {}
                urls = []
                for addr in [video.get("play_addr")] + [b.get("play_addr") for b in video.get("bit_rate") or [] if isinstance(b, dict)]:
                    for u in (addr or {}).get("url_list") or []:
                        if _media_url_allowed(u):
                            urls.append(u)
                urls = list(dict.fromkeys(urls))
                if not urls:
                    return _err("详情里没有可信的视频直链（可能图文/受保护）", phase=phase, aweme_id=aid)
                await _download_media(page, urls[0], case / "source.mp4", max_bytes=64 * 1024 * 1024)
                duration = float(video.get("duration") or aw.get("duration") or 0) / 1000.0
                (case / "source.json").write_text(json.dumps({"actualDuration": duration}, ensure_ascii=False), encoding="utf-8")
                notes.append("本地 cookie 下载（无需 CDP 调试端口）")
            finally:
                net.close()
        phase = "prepare"
        # ⭐ 抽帧数可调（设置里的 watchFrames，默认 10）：间隔 = 片长 / 帧数，最少 0.4 秒
        try:
            dur = float((json.loads((case / "source.json").read_text(encoding="utf-8")) or {}).get("actualDuration") or 0)
        except Exception:
            dur = 0
        want = max(3, min(int(frames or 10), 48))
        # ⭐ watchSeconds 是「最多看前多少秒」的硬预算：传给 prepare 截断，不能只拿来做缓存名
        analyze_dur = min(dur, float(seconds)) if dur and seconds else dur
        step = max(0.4, round((analyze_dur / want) if analyze_dur > 0 else 2.0, 2))
        rc, out, err = await run_lab(
            ["prepare", str(case / "source.mp4"), "--out", str(case), "--step", str(step),
             "--limit-seconds", str(max(1, int(seconds or 600)))], 240)
        if rc != 0:
            tail = (err or out).strip()[-300:] or "prepare 失败"
            return _err(f"原型抽帧/音轨失败：{tail}", phase=phase, aweme_id=aid)
        phase = "transcription"
        model_name = os.environ.get("DOUYIN_WHISPER_MODEL", "base") or "base"
        model_cache = str(HOME / "models" / "hub")
        # ⭐ 模型名和缓存路径必须传给 ASR；首次运行允许下载（asr.py 不再强制离线）
        rc, out, err = await run_lab(
            ["asr", str(case), "--model", model_name, "--cache", model_cache], 900)
        if rc != 0:
            tail = (err or out).strip()[-300:] or "asr 失败"
            return _err(f"原型转写失败：{tail}", phase=phase, aweme_id=aid)
        tr_path = case / "transcript.json"
        if not tr_path.exists():
            return _err("原型没生成 transcript.json", phase=phase, aweme_id=aid)
        tr = json.loads(tr_path.read_text(encoding="utf-8"))
        segs = tr.get("segments") or []
        text = " ".join(str(s.get("text") or "").strip() for s in segs if str(s.get("text") or "").strip())[:4000]
        # 真实 ASR 输出字段是 audioDuration；兼容旧的 duration
        duration = float(tr.get("audioDuration") or tr.get("duration") or 0)
        if not duration:
            try:
                packet = json.loads((case / "packet.json").read_text(encoding="utf-8"))
                duration = float((packet.get("audio") or {}).get("duration") or 0)
            except Exception:
                duration = 0
        partial = bool(dur and duration and duration + 0.5 < dur)
        if not text:
            return _err("音轨中未识别出语音", phase=phase, aweme_id=aid, labCase=str(case))
        result = _ok(aweme_id=aid, duration=duration, fullDuration=dur or duration, transcript=text, schemaVersion=4,
                     model=model_name,
                     sampledRanges=[[0, duration]], partial=partial,
                     notes=notes + [f"视频理解原型：{case.name}"] + (["只转写了前 %d 秒（partial=true）" % duration] if partial else []),
                     labCase=str(case))
        tmp = cache.with_suffix(".tmp")
        tmp.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        tmp.replace(cache)
        return result
    except asyncio.TimeoutError:
        return _err("原型处理超时", phase=phase, aweme_id=aid, labCase=str(case))
    except Exception as exc:
        return _err(f"{type(exc).__name__}: {exc}", phase=phase, aweme_id=aid, labCase=str(case))


_WHISPER_CACHE: dict = {}


def _whisper_model(name: str):
    # 国内直连 huggingface 常常拉不动 ⇒ 默认走镜像（可用 HF_ENDPOINT 覆盖）
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    # 模型缓存放到插件家里（C:\Users\...\.cache 经常没写权限）
    os.environ.setdefault("HF_HOME", str(HOME / "models"))
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(HOME / "models" / "hub"))
    if name not in _WHISPER_CACHE:
        from faster_whisper import WhisperModel
        _WHISPER_CACHE[name] = WhisperModel(name, device="cpu", compute_type="int8")
    return _WHISPER_CACHE[name]


@restricted_tool()
async def memory_write(content: str, type: str = "fact", tags: str = "", importance: float = 0.6, workspace_path: str = "") -> str:
    """把一条记忆写进「记忆插件」的库（memory.db）。私信/视频互动的记忆共用这一份。"""
    import sqlite3
    import uuid
    _dsh_home = os.environ.get("DSH_HOME") or str(Path.home() / ".dsh")
    db = os.environ.get("DSH_MEMORY_DB") or str(Path(_dsh_home) / "memory-system" / "memory.db")
    try:
        conn = sqlite3.connect(db, timeout=10)
        cur = conn.cursor()
        ws_id = None
        try:
            rows = cur.execute("select id, path from workspaces").fetchall()
            target = str(workspace_path or "").strip()
            if target:
                for rid, p in rows:
                    if p and os.path.normcase(os.path.normpath(str(p))) == os.path.normcase(os.path.normpath(target)):
                        ws_id = rid
                        break
            if ws_id is None and rows:
                ws_id = rows[0][0]
        except Exception:
            ws_id = None
        cur.execute(
            "insert into memories (id, type, content, tags, source, importance, privacy_level, related_ids, created_at, last_accessed, access_count, superseded_by, embedding, scope, workspace_id) "
            "values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (str(uuid.uuid4()), str(type or "fact"), str(content or "")[:2000], str(tags or ""),
             "douyin-plugin", float(importance or 0.6), "normal", "[]",
             __import__("datetime").datetime.now().isoformat(timespec="seconds"),
             __import__("datetime").datetime.now().isoformat(timespec="seconds"), 0, None, None,
             "global", ws_id),
        )
        conn.commit()
        conn.close()
        return j(_ok(written=True))
    except Exception as exc:
        return _err(f"写记忆失败：{type(exc).__name__}: {exc}")


@restricted_tool()
async def memory_recent(limit: int = 12) -> str:
    """读「记忆插件」的最近记忆（所有工作区共享），给私信/评论回复当上下文。"""
    import sqlite3
    _dsh_home = os.environ.get("DSH_HOME") or str(Path.home() / ".dsh")
    db = os.environ.get("DSH_MEMORY_DB") or str(Path(_dsh_home) / "memory-system" / "memory.db")
    try:
        conn = sqlite3.connect(db, timeout=10)
        rows = conn.execute(
            "select type, content, created_at from memories where superseded_by is null order by created_at desc limit ?",
            (max(1, min(int(limit), 50)),),
        ).fetchall()
        conn.close()
        return j(_ok(items=[{"type": r[0], "content": str(r[1])[:300], "at": r[2]} for r in rows]))
    except Exception as exc:
        return _err(f"读记忆失败：{type(exc).__name__}: {exc}")



@restricted_tool()
async def memory_context(limit: int = 16) -> str:
    """读「记忆插件」里最该带上的上下文：角色卡（称呼/风格/约束）+ 最近记忆。给私信快回当上下文用。"""
    import sqlite3
    _dsh_home = os.environ.get("DSH_HOME") or str(Path.home() / ".dsh")
    db = os.environ.get("DSH_MEMORY_DB") or str(Path(_dsh_home) / "memory-system" / "memory.db")
    try:
        conn = sqlite3.connect(db, timeout=10)
        conn.row_factory = sqlite3.Row
        lines = []
        try:
            row = conn.execute("select data from character_card where id=1").fetchone()
            card = json.loads(row["data"]) if row and row["data"] else {}
            ident = card.get("identity") or {}
            prefs = card.get("preferences") or {}
            cons = card.get("constraints") or []
            who = []
            if ident.get("name"):
                who.append("称呼：" + str(ident["name"]))
            if prefs.get("communication_style"):
                who.append("说话风格：" + str(prefs["communication_style"]))
            if cons:
                who.append("约束：" + "；".join(str(x) for x in cons[:3]))
            if who:
                lines.append("【你是谁】" + " · ".join(who))
        except Exception:
            pass
        rows = conn.execute(
            "select type, content, created_at from memories where superseded_by is null "
            "order by created_at desc limit ?", (max(3, min(int(limit), 40)),)
        ).fetchall()
        conn.close()
        items = []
        for r in rows:
            c = str(r["content"] or "").replace("\n", " ").strip()
            if not c or c.startswith("我:") or c.startswith("大肥鱼:"):
                continue
            items.append("- [%s] %s" % (r["type"], c[:70]))
        if items:
            lines.append("【最近的记忆】\n" + "\n".join(items[:14]))
        return j(_ok(context="\n".join(lines), count=len(items)))
    except Exception as exc:
        return _err(f"读记忆失败：{type(exc).__name__}: {exc}")


@restricted_tool()
async def douyin_dm_events(wait_seconds: float = 25, acknowledge: bool = False, stop: bool = False) -> str:
    """Internal long poll: wake on page message changes, never return transport payloads."""
    global _dm_event_watcher
    try:
        if stop:
            if _dm_event_watcher is not None: await _dm_event_watcher.close()
            return j(_ok(stopped=True, mode='events', changed=False))
        async with _browser.lock:
            context = await _browser.context()
            page = await _browser.page_chat()
            # A fresh page needs the IM entry page, but existing conversations stay in place.
            if page.url in ('about:blank', ''):
                await _goto(page, 'https://www.douyin.com/jingxuan', settle=1)
            if _dm_event_watcher is None:
                _dm_event_watcher = DmEventWatcher()
            await _dm_event_watcher.start(context)
            if acknowledge:
                await _dm_event_watcher.acknowledge()
        # Crucial: waiting for an event must not hold the account/browser lock.
        return j(await _dm_event_watcher.wait(wait_seconds))
    except Exception as exc:
        return j(_err('消息监听未连接：' + str(exc), mode='events'))


@restricted_tool()
async def douyin_dm_snapshot(nickname: str = "", limit: int = 20) -> str:
    """只读：按时间顺序返回私信 ID、方向、文本及媒体附件；未知方向不猜测。"""
    async def impl():
        ctx = await _browser.context()
        page = await _browser.page_chat()
        await _open_conversation(page, ctx, nickname)
        try:
            await page.evaluate("""() => {
                const box = document.querySelector('[class*="MessageList"],[class*="messageList"],[class*="MessageItem"]');
                let el = box;
                while (el && !(el.scrollHeight > el.clientHeight + 10)) el = el.parentElement;
                if (el) el.scrollTop = el.scrollHeight;
            }""")
        except Exception:
            pass
        await page.wait_for_timeout(1000)
        msgs = await _message_snapshot(page)
        tail = msgs[-max(1, min(int(limit), 50)):]
        try:
            brief = [f"{m.get('direction')}|{str(m.get('text') or '')[:16]}|{m.get('kind')}" for m in tail[-4:]]
            geo = await page.evaluate(r"""() => {
                const v=e=>e.getClientRects().length && getComputedStyle(e).visibility!=='hidden';
                const sels=['[class*="MessageItemTextbubbleContent"]','[class*="MessageItemEmojiemojiBox"]'];
                const rows=[];
                for(const sel of sels){ for(const e of Array.from(document.querySelectorAll(sel))){ if(!v(e))continue; const r=e.getBoundingClientRect(); rows.push({e,r,txt:(e.innerText||'').slice(0,12)}); } }
                rows.sort((a,b)=>a.r.top-b.r.top);
                return rows.slice(-4).map(o=>{
                    const chain=[];
                    let p=o.e;
                    for(let i=0;i<9&&p;i++){ const pr=p.getBoundingClientRect(); chain.push((p.className||'').toString().slice(0,70)); p=p.parentElement; }
                    // 找同一行里的头像 img
                    let av=null;
                    let q=o.e;
                    for(let i=0;i<8&&q;i++){
                        const img=q.querySelector('img[src*="avatar"], img');
                        if(img && img.getBoundingClientRect().width>10 && img.getBoundingClientRect().width<80){ const ir=img.getBoundingClientRect(); av={x:Math.round(ir.x),w:Math.round(ir.width)}; break; }
                        q=q.parentElement;
                    }
                    return {txt:o.txt, x:Math.round(o.r.x), w:Math.round(o.r.width), av, chain};
                });
            }""")
            with open(HOME / "dm-snapshot-debug.log", "a", encoding="utf-8") as fh:
                fh.write(f"[dm-snapshot] nick={nickname} n={len(tail)} url={page.url} last4={brief}\n")
                fh.write(f"[dm-geo] {geo}\n")
        except Exception as exc:
            try:
                with open(HOME / "dm-snapshot-debug.log", "a", encoding="utf-8") as fh:
                    fh.write(f"[dm-geo-error] {exc}\n")
            except Exception:
                pass
        return _ok(items=tail, count=len(tail))
    return j(await _guard(impl, 90))


@restricted_tool()
async def douyin_watch(aweme_id: str, seconds: int = 300, frames: int = 10) -> str:
    """真·看视频：下载这条视频 → 抽音轨 → 本地转写成文字（faster-whisper）。

    用途：评论/转发之前先「看完」，别只看标题。
    seconds: 最多转写前多少秒（长视频跳着看就用它截断）
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        return await _watch_core(page, aweme_id, seconds, frames)

    return j(await _guard(_impl, 600))


@restricted_tool()
async def douyin_feed(num: int = 10, scrolls: int = 6, skip_live: bool = True) -> str:
    """刷抖音推荐流（**不搜索**）：打开首页推荐，往下滚几屏，把露出的视频收下来。

    Args:
        num: 想要几条（默认 10）
        scrolls: 最多滚几屏（默认 6）

    返回 {ok, items:[{aweme_id,title,url}], count, notes?}
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        return await _feed_core(page, ctx, max(1, min(int(num or 10), 50)), max(1, min(int(scrolls or 6), 30)), skip_live=skip_live)

    return j(await _guard(_impl, 120))


@restricted_tool()
async def douyin_search(keyword: str, num: int = 10, order: str = "general") -> str:
    """搜索抖音视频（需登录）。

    Args:
        keyword: 搜索词
        num: 返回条数，默认 10，最大 50
        order: general=综合（默认）/ video=视频 / latest=最新 / like=最多点赞

    返回 {ok, items:[{aweme_id,title,author,digg,comment,share,duration,url,cover}], count, notes?}
    """
    async def _impl():
        page = await _browser.page()
        res = await _search_core(page, keyword, num, order)
        items, dropped = _drop_live(res.get("items") or [])
        if dropped:
            res["items"] = items
            res["count"] = len(items)
            res.setdefault("notes", []).append(f"跳过 {dropped} 条直播")
        return res

    return j(await _guard(_impl, 55))


@restricted_tool()
async def douyin_video(aweme_id: str) -> str:
    """获取单条抖音视频信息（接受数字 id 或整条 /video/<id> 链接）。

    返回 {ok, aweme_id,title,desc,author,digg,comment_count,share,url,publish_time}。
    """
    async def _impl():
        page = await _browser.page()
        return await _video_core(page, aweme_id)

    return j(await _guard(_impl, 45))


@restricted_tool()
async def douyin_comments(aweme_id: str, num: int = 30, compact: bool = False,
                          exclude_cids: list[str] | None = None) -> str:
    """获取视频热门评论（越多越慢，会自动滚动评论区）。

    Args:
        num: 取几条
        compact: True ⇒ 只回 {cid,user,text(30字)}，省 token（回评论时用这个）
        exclude_cids: 已回过的 cid，服务端直接过滤掉（不回传，进一步省 token）

    返回 {ok, items, count, notes?}。
    """
    async def _impl():
        page = await _browser.page()
        res = await _comments_core(page, aweme_id, num)
        items = res.get("items") or []
        if exclude_cids:
            skip = {str(x) for x in exclude_cids}
            items = [x for x in items if str(x.get("cid")) not in skip]
        if compact:
            items = [{"cid": str(x.get("cid")), "user": x.get("user", ""), "text": str(x.get("text", ""))[:30],
                      "kind": x.get("kind", "text"), "media": x.get("media", []), "attachments": x.get("attachments", [])} for x in items]
        res["items"] = items
        res["count"] = len(items)
        return res

    return j(await _guard(_impl, 60))


@restricted_tool()
async def douyin_check_reply(aweme_id: str, parent_cid: str = "", text: str = "") -> str:
    """只读核对：这条回复是不是已经发出去了（查回复列表，返回命中的 cid）。"""
    async def impl():
        page = await _browser.page()
        try:
            if 'douyin.com' not in (page.url or ''):
                await _goto(page, 'https://www.douyin.com/jingxuan', settle=2)
        except Exception:
            pass
        kids = await _fetch_reply_children(page, str(aweme_id), str(parent_cid or ""))
        want = (text or "").strip()
        for c in kids:
            if want and str(c.get("text") or "").strip() == want:
                return _ok(found=True, cid=str(c.get("cid") or ""), text=want)
        return _ok(found=False, count=len(kids))
    return j(await _guard(impl, 50))


@restricted_tool()
async def douyin_like(aweme_id: str, undo: bool = False) -> str:
    """点赞 / 取消点赞（需登录）。undo=True 取消。

    返回 {ok, liked, changed, note?}。
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        return await _like_core(page, ctx, aweme_id, undo)

    return j(await _guard(_impl, 45))


@restricted_tool()
async def douyin_my_posts(days: int = 1) -> str:
    """返回指定日历天数内本人作品，按游标分页并限制总量。"""
    async def _impl():
        import datetime
        count_days = max(1, min(int(days), 90))
        ctx = await _browser.context()
        page = await _browser.page()
        await _goto(page, "https://www.douyin.com/user/self", settle=2)
        login = await _login_state(page, ctx)
        if not login["loggedIn"]:
            return _need_login("读取本人作品需要登录")
        sec = await page.evaluate(r"() => (location.pathname.match(/user\/([^/?]+)/) || [])[1] || ''")
        if not sec or sec == "self":
            sec = await page.evaluate(r"""() => {
                const a=document.querySelector('[data-e2e="user-avatar"] a[href*="/user/"],a[data-e2e="user-profile-link"]');
                return a ? ((a.href.match(/user\/([^/?]+)/)||[])[1]||'') : '';
            }""")
        if not sec or sec == "self":
            # 2026-10-27：/user/self 不再跳转到 /user/<sec_uid>，头像链接选择器也已失效，
            # 改成问平台自己的「本人信息」接口（登录态下会返回 user.sec_uid）。
            try:
                me = await page.evaluate("""async () => {
                    const r = await fetch('/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383', {credentials: 'include'});
                    if (!r.ok) return {};
                    return await r.json();
                }""")
                sec = ((me or {}).get("user") or {}).get("sec_uid") or ""
            except Exception:
                sec = ""
        if not sec or sec == "self":
            return _err("没有取得本人 sec_user_id，未使用其他用户链接")
        cutoff = time.mktime((datetime.date.today() - datetime.timedelta(days=count_days-1)).timetuple())
        items = {}
        cursor = 0
        complete = False
        for _ in range(15):
            data = await page.evaluate("""async ({uid,cursor}) => {
                const r=await fetch('/aweme/v1/web/aweme/post/?device_platform=webapp&aid=6383&channel=channel_pc_web&sec_user_id='+encodeURIComponent(uid)+'&max_cursor='+cursor+'&count=20',{credentials:'include'});
                if(!r.ok) throw new Error('作品接口 HTTP '+r.status);
                return await r.json();
            }""", {"uid": sec, "cursor": cursor})
            if data.get("status_code", 0) != 0:
                return _err("作品接口拒绝请求", status_code=data.get("status_code"))
            videos = data.get("aweme_list") or []
            for v in videos:
                ct = int(v.get("create_time") or 0)
                aid = str(v.get("aweme_id") or "")
                if ct >= cutoff and aid:
                    items[aid] = {"aweme_id": aid, "title": str(v.get("desc") or "")[:120], "create_time": ct,
                                  "day": time.strftime("%Y-%m-%d", time.localtime(ct))}
            next_cursor = data.get("max_cursor")
            if not data.get("has_more") or not videos or (next_cursor == cursor):
                complete = True
                break
            cursor = next_cursor
        return _ok(items=list(items.values()), count=len(items), days=count_days, complete=complete, sec_user_id=sec)
    return j(await _guard(_impl, 90))


@restricted_tool()
async def douyin_comment(aweme_id: str, text: str, reply_cid: str = "", mention: str = "", reply_index: int = -1) -> str:
    """发评论或回复某条评论（需登录）。reply_cid 非空时回复该评论；
    mention 非空时走**真人 @ 提醒**（打 @昵称 → 点联想面板那一行），不是纯文本 @。

    返回 {ok, cid, text, url, reply_cid?, notes?}。
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        return await _comment_core(page, ctx, aweme_id, text, reply_cid, mention, reply_index)

    return j(await _guard(_impl, 150))


async def _share_core(page, ctx, aweme_id: str, nickname: str) -> dict:
    """转发：视频页 → **鼠标悬停**分享图标 → 面板「分享给朋友」→ 点那个人右边的「分享」。

    2026-10-25 实测：这个面板是 **hover 打开**的（click 不弹）。面板里每行是「头像+昵称 … [分享]」。
    """
    notes = []
    (HOME / "thumbs").mkdir(parents=True, exist_ok=True)
    aid = _extract_aweme_id(str(aweme_id)) or str(aweme_id)
    await _open_conversation(page, ctx, nickname)
    before_msgs = await _message_snapshot(page)
    before_ids = {m["messageId"] for m in before_msgs if m.get("messageId")}
    try:
        before_share = await page.evaluate(r"""() => document.querySelectorAll('[class*="MessageItemShareAwemecontainer"]').length""")
    except Exception:
        before_share = 0
    await _goto(page, VIDEO_URL.format(aweme_id=aid), settle=4.0)
    st = await _login_state(page, ctx)
    if not st["loggedIn"]:
        return _need_login("转发要登录", aweme_id=aid)

    icon = page.locator('[data-e2e="video-share-icon-container"]').first
    if not await icon.count():
        return _err("没找到分享图标（[data-e2e=video-share-icon-container]）", aweme_id=aid, url=page.url)
    try:
        await icon.hover(force=True)
    except Exception:
        box = await icon.bounding_box()
        if box:
            await page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    # 等面板出现
    opened = False
    for _ in range(12):
        await page.wait_for_timeout(500)
        opened = await page.evaluate("() => (document.body.innerText || '').indexOf('分享给朋友') >= 0")
        if opened:
            break
    if not opened:
        await page.screenshot(path=str(HOME / "thumbs" / "_share.png"))
        return _err("悬停后没弹出「分享给朋友」面板", aweme_id=aid, url=page.url, notes=notes)

    # 找到那个人那一行的「分享」按钮（红色）
    _submitted()
    hit = await page.evaluate(
        r"""(nick) => {
            const v = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
            const norm = s => String(s || '').replace(/\s+/g, '');
            const target = norm(nick);
            const buttons = [];
            for (const row of document.querySelectorAll('div,li')) {
                if (!v(row)) continue;
                const t = row.innerText || '';
                if (!t || t.length > 40) continue;
                let nameHit = false;
                for (const e of row.querySelectorAll('span,a,div')) {
                    const it = (e.innerText || '').trim();
                    if (!it || it.length > 30) continue;
                    if (norm(it) === target) { nameHit = true; break; }
                }
                if (!nameHit) continue;
                for (const b of row.querySelectorAll('div,span,button')) {
                    if ((b.innerText || '').trim() === '分享' && v(b) && !buttons.includes(b)) { buttons.push(b); break; }
                }
            }
            const minimal = buttons.filter(b => !buttons.some(o => o !== b && b.contains(o)));
            if (minimal.length !== 1) return {ok:false, found: minimal.length, rows: buttons.length};
            minimal[0].click(); return {ok:true};
        }""",
        nickname,
    )
    await page.wait_for_timeout(2500)
    if hit.get("ok"):
        # Confirm the outgoing video card in the exact target conversation.
        await _open_conversation(page, ctx, nickname)
        for _ in range(10):
            messages = await _message_snapshot(page)
            for message in reversed(messages):
                if message["direction"] == "outbound" and message.get("awemeId") == aid and message.get("messageId") and message["messageId"] not in before_ids:
                    return _ok(shared_to=nickname, aweme_id=aid, messageId=message["messageId"], verified=True, evidence="outbound-video-card")
            await page.wait_for_timeout(500)
        # 兜底：会话里出站数量增加了 / 分享了新的视频卡片，也认（卡片往往拿不到 awemeId）
        try:
            now_share = await page.evaluate(r"""() => document.querySelectorAll('[class*="MessageItemShareAwemecontainer"]').length""")
            if now_share > before_share:
                return _ok(shared_to=nickname, aweme_id=aid, messageId="share-card-count",
                           verified=True, evidence="share-card-appeared")
        except Exception:
            pass
        try:
            now_msgs = await _message_snapshot(page)
            now_out = sum(1 for m in now_msgs if m.get("direction") == "outbound")
            before_out = sum(1 for m in before_msgs if m.get("direction") == "outbound")
            if now_out > before_out:
                return _ok(shared_to=nickname, aweme_id=aid, messageId="outbound-count",
                           verified=True, evidence="outbound-count-increased")
        except Exception:
            pass
        # 已经点了分享但没拿到卡片回执：仍然算「操作过」，返回 ok 让上层继续补附言
        return _ok(shared_to=nickname, aweme_id=aid, messageId="share-clicked", clicked=True,
                   verified=False, status="unknown", evidence="share-clicked-unconfirmed",
                   note="已点击分享，卡片回执没确认")
    return _err(f"面板里没有「{nickname}」这一行", aweme_id=aid, notes=notes)


async def _open_conversation(page, ctx, nickname, peer_id=""):
    await _goto(page, "https://www.douyin.com/jingxuan", settle=2)
    st = await _login_state(page, ctx)
    if not st["loggedIn"]:
        raise ValueError("needLogin: 私信需要登录")
    icon = await _first_of(page, ['[data-e2e="im-entry"]'], 3000)
    if icon is None:
        # 兜底：有些版本入口没有 data-e2e，就按文字找「消息」那一项
        try:
            icon = await page.evaluate_handle("""() => {
                const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
                const cands = Array.from(document.querySelectorAll('a,button,div,li,span'))
                    .filter(e => visible(e) && (e.innerText || '').trim() === '消息');
                return cands.length === 1 ? cands[0] : null;
            }""")
            icon = icon.as_element()
        except Exception:
            icon = None
    if icon is None:
        raise ValueError("没有找到消息入口")
    # 先把可能挡住点击的浮层清掉（发现页提示条/引导遮罩）
    try:
        await page.evaluate("""() => {
            document.querySelectorAll('.discover-tab-container, [class*="discover-tab"], [class*="guide-mask"], [class*="mask-layer"]').forEach(e => e.remove());
        }""")
    except Exception:
        pass
    opened = False
    for _attempt in range(3):
        try:
            await icon.click(force=True, timeout=4000)
            opened = True
            break
        except Exception:
            try:
                await icon.evaluate("e => e.click()")
                opened = True
                break
            except Exception:
                try:
                    await page.keyboard.press("Escape")
                except Exception:
                    pass
                await page.wait_for_timeout(400)
    if not opened:
        raise ValueError("消息入口点不进去（页面浮层挡住）")
    await page.wait_for_function("""() => Array.from(document.querySelectorAll('input')).some(e =>
        /搜索/.test(e.placeholder||'') && e.getClientRects().length)""", timeout=12000)
    # 等会话列表真正渲染出来（刚点开消息面板时列表是异步加载的）
    try:
        await page.wait_for_selector('[data-e2e="conversation-item"]', state="visible", timeout=8000)
    except Exception:
        pass
    await page.wait_for_timeout(600)
    handle = await page.evaluate_handle(r"""({nick,peer}) => {
        const visible=e=>e.getClientRects().length && getComputedStyle(e).visibility!=='hidden';
        const norm=s=>String(s||'').replace(/\s+/g,'').trim();
        const tgt=norm(nick);
        const hit=[];
        for(const it of Array.from(document.querySelectorAll('[data-e2e="conversation-item"]'))){
            if(!visible(it)) continue;
            const titleEl=it.querySelector('[class*="ConversationItemtitle"]')||it;
            const first=((titleEl.innerText||'').split('\n')[0]||'');
            if(norm(first)!==tgt) continue;
            const pid=it.getAttribute('data-user-id')||it.getAttribute('data-peer-id')||'';
            if(peer&&pid&&peer!==pid) continue;
            if(!hit.includes(it)) hit.push(it);
        }
        if(hit.length===1) return hit[0];
        if(hit.length>1) return null;
        const search=Array.from(document.querySelectorAll('input')).find(e=>/搜索/.test(e.placeholder||'')&&visible(e));
        if(!search) return null;
        let root=search;
        for(let i=0;i<6&&root.parentElement;i++){root=root.parentElement;if(root.querySelector('[data-conversation-id],[role="listitem"]'))break}
        const found=[];
        for(const e of root.querySelectorAll('a,span,div')){
            if(!visible(e)||(e.textContent||'').trim()!==nick)continue;
            let row=e.closest('[data-conversation-id],[role="listitem"],li');
            if(!row){row=e;for(let i=0;i<4&&row.parentElement;i++){const p=row.parentElement,r=p.getBoundingClientRect();if(r.height>160)break;row=p}}
            const id=row.getAttribute('data-user-id')||row.getAttribute('data-peer-id')||'';
            const link=row.querySelector('a[href*="/user/"]');
            const uid=id||(link?((link.href.match(/user\/([^/?]+)/)||[])[1]||''):'');
            if(peer&&uid&&peer!==uid)continue;
            if(!found.includes(row))found.push(row);
        }
        return found.length===1?found[0]:null;
    }""", {"nick": nickname, "peer": peer_id})
    row = handle.as_element()
    if row is None:
        raise ValueError("没有找到唯一的完整昵称会话；不会按前四字猜测")
    await row.click()
    await page.wait_for_function("""() => Array.from(document.querySelectorAll('[contenteditable="true"],textarea[placeholder*="发送"],input[placeholder*="发送"]'))
        .some(e=>e.getClientRects().length && !e.disabled)""", timeout=15000)
    handle = await page.evaluate_handle("""(nick) => {
        const editors=Array.from(document.querySelectorAll('[contenteditable="true"],textarea[placeholder*="发送"],input[placeholder*="发送"]'))
          .filter(e=>e.getClientRects().length&&!e.disabled);
        if(editors.length===1) return editors[0];
        const matches=editors.filter(e=>{
          let box=e;for(let i=0;i<7&&box.parentElement;i++){box=box.parentElement;
          const names=box.querySelectorAll('header,[data-e2e*="chat-title"],[class*="title"],[class*="Title"],[class*="chatHeader"],[class*="chat-header"]');
          const _n=s=>String(s||'').replace(/\\s+/g,'');const _t=_n(nick);
          if(Array.from(names).some(n=>{const x=n.innerText||'';return _n(x)===_t||_n(x.split('\\n')[0])===_t}))return true}
          return false});
        return matches.length===1?matches[0]:null;
    }""", nickname)
    editor = handle.as_element()
    if editor is None:
        raise ValueError("会话已打开但目标标题/消息输入框无法唯一确认")
    return editor


async def _message_snapshot(page):
    return await page.evaluate(r"""() => {
        const v=e=>e.getClientRects().length && getComputedStyle(e).visibility!=='hidden';
        const out=[];
        const seen=new Set();
        const hash=s=>{let h=2166136261;for(const c of s)h=Math.imul(h^c.charCodeAt(0),16777619)>>>0;return h.toString(16)};
        const occurrences=new Map();
        const avatarOf=(e)=>{let p=e;for(let i=0;i<10&&p;i++){if(typeof p.querySelectorAll==='function'){for(const img of Array.from(p.querySelectorAll('img'))){if(typeof img.getBoundingClientRect!=='function')continue;const src=img.currentSrc||img.src||'';const r=img.getBoundingClientRect();if(r.width>=20&&r.width<=90&&/(aweme-avatar|\/img\/|avatar)/i.test(src))return src;}}p=p.parentElement;}return ''};
        const push=(id,direction,text,media,awemeId,kind='text',attachments=[],senderId='',conversationId='',avatar='')=>{
            if(id.startsWith('dom')){
                const value=JSON.stringify([direction,text,media.map(u=>{try{return new URL(u).origin+new URL(u).pathname}catch{return u}}),awemeId]);
                const count=occurrences.get(value)||0;occurrences.set(value,count+1);
                id='dom:'+hash(value)+':'+count;
            }
            const key=id+'|'+(text||'').slice(0,24)+'|'+(awemeId||'');
            if(seen.has(key))return;
            seen.add(key);
            out.push({messageId:id,direction,text:text,image:media,images:media,
                      media:media,awemeId:awemeId||'',kind,attachments,senderId,conversationId,avatar,
                      fromMe: direction === 'outbound',
                      idSource:id.startsWith('dom:')?'dom':'platform'});
        };
        // 1) 首选：带 data-message-id 的节点
        for(const e of Array.from(document.querySelectorAll('[data-message-id],[data-msg-id]'))){
            if(!v(e))continue;
            const id=e.getAttribute('data-message-id')||e.getAttribute('data-msg-id');
            const self=e.getAttribute('data-is-self')||e.getAttribute('data-self');
            const senderId=e.getAttribute('data-sender-id')||e.getAttribute('data-from-user-id')||'';
            const selfId=document.querySelector('[data-current-user-id]')?.getAttribute('data-current-user-id')||'';
            const direction=senderId&&selfId?(senderId===selfId?'outbound':'inbound'):(e.getAttribute('data-direction')||((self==='true'||self==='1')?'outbound':(self==='false'||self==='0')?'inbound':'unknown'));
            const card=e.querySelector('a[href*="/video/"]');
            const imgs=Array.from(e.querySelectorAll('img')).filter(x=>!x.closest('[class*="avatar"],[class*="Avatar"]'));
            const kind=card?'video':e.querySelector('[class*="Emoji"],[class*="emoji"]')?'sticker':imgs.length?'image':'text';
            push(id,direction,(e.innerText||'').trim(),
                 imgs.map(x=>x.currentSrc||x.src),
                 card?((card.href.match(/video\/(\d+)/)||[])[1]||''):'',kind,
                 imgs.map(x=>({url:x.currentSrc||x.src,alt:x.alt||'',kind})),senderId,
                 e.closest('[data-conversation-id]')?.getAttribute('data-conversation-id')||'',
                 avatarOf(e));
        }
        if(out.length) return out;
        // 2) 兜底：按气泡 DOM 识别（抖音私信没有 data-message-id）
        const sels=[
            ['text','[class*="MessageItemTextbubbleContent"]'],
            ['emoji','[class*="MessageItemEmojiemojiBox"]'],
            ['share','[class*="MessageItemShareAwemecontainer"]'],
            ['image','[class*="MessageItemImage"]'],
        ];
        const rows=[];
        for(const [kind,sel] of sels){
            for(const e of Array.from(document.querySelectorAll(sel))){
                if(!v(e))continue;
                const r=e.getBoundingClientRect();
                if(r.height<10||r.height>520)continue;
                rows.push({kind,e,r});
            }
        }
        rows.sort((a,b)=>a.r.top-b.r.top);
        const seenY=new Set();
        let idx=0;
        for(const row of rows){
            const yKey=Math.round(row.r.top/6)+':'+row.kind;
            if(seenY.has(yKey))continue;
            seenY.add(yKey);
            const link=row.e.querySelector('a[href*="/video/"]');
            const awemeId=link?((link.href.match(/video\/(\d+)/)||[])[1]||''):'';
            // 方向：抖音的 class 已经明说了——自己的消息容器带 isFromMe
            let dir='unknown';
            try {
                if (row.e.closest('[class*="isFromMe"]')) dir='outbound';
                else if (row.e.closest('[class*="MessageItemText"], [class*="MessageItemEmoji"], [class*="MessageItemImage"], [class*="MessageItemShare"]')) dir='inbound';
            } catch { dir='unknown'; }
            const imgs=Array.from(row.e.querySelectorAll('img')).map(x=>x.currentSrc||x.src);
            const kind=row.kind==='share'?'video':row.kind==='emoji'?'sticker':row.kind;
            // data-index 是从列表底部数的格子，最新一条永远是 0，不能拿来当消息编号。
            push('dom'+idx+'-'+row.kind,dir,(row.e.innerText||'').trim(),imgs,awemeId,kind,
                 Array.from(row.e.querySelectorAll('img')).map(x=>({url:x.currentSrc||x.src,alt:x.alt||'',kind})),
                 '', '', avatarOf(row.e));
            idx++;
        }
        return out;
    }""")


async def _send_chat_part(page, editor, part):
    before_items = await _message_snapshot(page)
    before = {m["messageId"] for m in before_items}
    try:
        before_emoji = await page.evaluate(r"""() => document.querySelectorAll('[class*="MessageItemEmojiemojiBox"]').length""")
    except Exception:
        before_emoji = 0
    before_out = sum(1 for m in before_items if m.get("direction") == "outbound")
    try:
        before_body = await page.evaluate("() => (document.body.innerText||'').replace(/\\s+/g,'')")
    except Exception:
        before_body = ""
    kind = part.get("kind")
    await editor.click()
    await page.keyboard.press("Control+A")
    await page.keyboard.press("Backspace")
    if kind == "text":
        text = str(part.get("text") or "").strip()
        if not text or len(text) > 1000:
            return _err("私信正文为空或过长", status="failed")
        await page.keyboard.type(text, delay=20)
        _submitted()
        await page.keyboard.press("Enter")
        expected_media = ""
    elif kind == "sticker":
        keyword = str(part.get("keyword") or "大肥鱼")[:40]
        # 抖音私信：没有「输入关键词→联想」这条路，要点输入框旁的笑脸按钮打开表情面板再点一个
        await editor.click()
        await page.keyboard.press("Control+A")
        await page.keyboard.press("Backspace")
        opened = False
        for _ in range(6):
            btn = await _first_of(page, ['.messageMsgInputiconAction', '[class*="messageMsgInputiconAction"]'], 1200)
            if btn is not None:
                try:
                    await btn.click()
                    opened = True
                    break
                except Exception:
                    pass
            await page.wait_for_timeout(400)
        if not opened:
            return _err("没有找到表情按钮，未发送", status="failed")
        try:
            await page.wait_for_selector('.componentsemojiemojiPanel img,[class*="componentsemoji"] img', state="visible", timeout=8000)
        except Exception:
            return _err("没有找到表情面板，未发送", status="failed")
        # ⭐ 表情包优先：先「收藏」tab（17 张大肥鱼），再「表情」tab（214 张通用表情）；都按心情标签挑
        expected_media = ""
        pick_idx = max(0, int(part.get("pick", 0) or 0))
        kw = str(keyword or "").replace(" ", "").replace("大肥鱼", "").replace("表情包", "").replace("表情", "")

        def _norm_key(x):
            s = str(x or "").split("?")[0]
            m = re.search(r"tos-cn-i-[^/]+/([^/]+)$", s)
            if m:
                s = m.group(1)
            s = s.rsplit("/", 1)[-1]
            return re.sub(r"\.(png|jpe?g|webp|gif)$", "", s).lower()

        def _load_meta(name):
            out = {}
            try:
                f = HOME / name
                if f.exists():
                    for it in (json.loads(f.read_text(encoding="utf-8")).get("items") or []):
                        out[_norm_key(it.get("key"))] = it.get("tags") or []
            except Exception:
                pass
            return out

        fav_sel = r'(tos-cn-i-tsj2vxp0zn|im-emoticon|ies\.fe\.effect|im-resource)'

        async def _fav_srcs(tab):
            try:
                await page.evaluate("""(idx) => {
                    const subs = document.querySelectorAll('.emojiEmojisModalTabsubTab');
                    if (subs.length > idx) subs[idx].click();
                }""", tab)
                await page.wait_for_timeout(1400)
            except Exception:
                return []
            return await page.evaluate("""(sel) => {
                const re = new RegExp(sel);
                const panel = document.querySelector('.componentsemojiemojiPanel,[class*="componentsemoji"]');
                if (!panel) return [];
                return Array.from(panel.querySelectorAll('img'))
                    .filter(e => e.getClientRects().length && re.test(e.currentSrc || e.src || ''))
                    .map(e => e.currentSrc || e.src || '');
            }""", fav_sel)

        def _best(srcs, meta):
            best_s, best_i = 0, 0
            for i, src in enumerate(srcs):
                s = 0
                for t in meta.get(_norm_key(src), []):
                    t = str(t or "").replace(" ", "")
                    if t and kw and (t in kw or kw in t):
                        s += 2
                if s > best_s:
                    best_s, best_i = s, i
            return best_s, best_i

        def _last_sticker():
            try:
                f = HOME / "last-sticker.txt"
                return f.read_text(encoding="utf-8").strip() if f.exists() else ""
            except Exception:
                return ""

        def _remember_sticker(src):
            try:
                (HOME / "last-sticker.txt").write_text(str(src or ""), encoding="utf-8")
            except Exception:
                pass

        fav_pick = None
        for tab, meta_file in ((2, "favorites2.json"), (1, "favorites.json")):
            srcs = await _fav_srcs(tab)
            if not srcs:
                continue
            score, bi = _best(srcs, _load_meta(meta_file))
            if score > 0:
                fav_pick = bi
                expected_media = srcs[bi]
                _remember_sticker(expected_media)
                break
        if fav_pick is None:
            srcs = await _fav_srcs(2)
            if srcs:
                last = _last_sticker()
                # 没匹配到标签：别永远发第一张，随机挑一张，并尽量避开上一张
                pool = [i for i in range(len(srcs)) if srcs[i] != last] or list(range(len(srcs)))
                if pick_idx and 0 <= pick_idx < len(srcs):
                    fav_pick = pick_idx
                else:
                    import random
                    fav_pick = random.choice(pool)
                expected_media = srcs[fav_pick]
                _remember_sticker(expected_media)

        if fav_pick is not None:
            await page.evaluate("""(arg) => {
                const re = new RegExp(arg.sel);
                const panel = document.querySelector('.componentsemojiemojiPanel,[class*="componentsemoji"]');
                const imgs = Array.from(panel.querySelectorAll('img'))
                    .filter(e => e.getClientRects().length && re.test(e.currentSrc || e.src || ''));
                const img = imgs[Math.min(arg.idx, imgs.length - 1)];
                if (!img) return false;
                const box = img.closest('[class*="Item"],[class*="item"]') || img.parentElement || img;
                box.click();
                return true;
            }""", {"idx": fav_pick, "sel": fav_sel})
            _submitted()
            await page.wait_for_timeout(300)
            text = ""
            fav = {"ok": True}
        else:
            fav = None
        if not fav:
            # 收藏里没有（或没加载出来）⇒ 回到默认表情，按关键字挑
            try:
                await page.evaluate("""() => {
                    const subs = document.querySelectorAll('.emojiEmojisModalTabsubTab');
                    if (subs.length) subs[0].click();
                }""")
                await page.wait_for_timeout(800)
            except Exception:
                pass
            imgs = page.locator('.componentsemojiemojiPanel img,[class*="componentsemoji"] img')
            total = await imgs.count()
            if not total:
                return _err("表情面板里没有表情", status="failed")
            chosen = None
            if keyword:
                for i in range(total):
                    label = ((await imgs.nth(i).get_attribute('alt')) or '') + ' ' + ((await imgs.nth(i).get_attribute('aria-label')) or '')
                    if label and keyword in label:
                        chosen = imgs.nth(i)
                        break
            if chosen is None:
                chosen = imgs.nth(max(0, min(pick_idx, total - 1)))
            expected_media = await chosen.get_attribute("src") or ""
            _submitted()
            await chosen.click()
            text = ""
    else:
        return _err("未知消息类型", status="failed")
    expected = "".join(text.split()) if kind == "text" else ""
    for _ in range(16):
        await page.wait_for_timeout(500)
        msgs = await _message_snapshot(page)
        for m in msgs:
            mt = "".join((m.get("text") or "").split())
            if m["messageId"] in before or m["direction"] != "outbound":
                continue
            if (kind == "text" and mt == expected) or \
               (kind == "sticker" and expected_media and expected_media in (m.get("media") or [])):
                return _ok(verified=True, messageId=m["messageId"], kind=kind, evidence="new-outbound-message")
        # 兜底 1：整页文本出现刚发的内容（发送前没有）
        if kind == "text" and expected:
            try:
                body = await page.evaluate("() => (document.body.innerText||'').replace(/\\s+/g,'')")
            except Exception:
                body = ""
            if expected in body and expected not in before_body:
                return _ok(verified=True, messageId="body-text", kind=kind, evidence="body-text-appears")
        # 兜底 2：出站气泡数量增加了（表情包/图片这类比文本更难精确比对）
        if kind == "sticker":
            now_out = sum(1 for m in msgs if m.get("direction") == "outbound")
            if now_out > before_out:
                return _ok(verified=True, messageId="outbound-count", kind=kind, evidence="outbound-count-increased")
            # 兜底 3：表情气泡数量增加了（收藏表情最稳的判据）
            try:
                now_emoji = await page.evaluate(r"""() => document.querySelectorAll('[class*="MessageItemEmojiemojiBox"]').length""")
                if now_emoji > before_emoji:
                    return _ok(verified=True, messageId="emoji-count", kind=kind, evidence="emoji-bubble-increased")
            except Exception:
                pass
            # （删掉了「按图片路径匹配」的兜底：它会把表情面板里的预览图当成已发送，误判成功）
    return _err("已操作但没有读取到新出站消息，停止自动重发", status="unknown", kind=kind)


async def _chat_send_core(page, ctx, nickname: str, text: str, peer_id: str = "") -> dict:
    editor = await _open_conversation(page, ctx, nickname, peer_id)
    return await _send_chat_part(page, editor, {"kind": "text", "text": text})


@restricted_tool()
async def douyin_chat_send(nickname: str, text: str, peer_id: str = "") -> str:
    async def impl():
        ctx = await _browser.context()
        return await _chat_send_core(await _browser.page_chat(), ctx, nickname, text, peer_id)
    return j(await _guard(impl, 90))


@restricted_tool()
async def douyin_inbox(limit: int = 12, nickname: str = "") -> str:
    """Only return identified incoming messages; a changing preview/time is not a message."""
    async def impl():
        ctx = await _browser.context()
        # ⭐ 和指定的人聊天用「聊天专用页」；遍历陌生人的老巡检用主页面，两路互不打扰
        page = await (_browser.page_chat() if str(nickname or "").strip() else _browser.page())
        await _goto(page, "https://www.douyin.com/jingxuan", settle=2)
        login = await _login_state(page, ctx)
        if not login["loggedIn"]:
            return _need_login("读私信需要登录")
        # ⭐ 指定了人：只开这一个会话（比遍历全部快得多，也不会超时）
        if str(nickname or "").strip():
            name = str(nickname).strip()
            try:
                await _open_conversation(page, ctx, name)
            except Exception as exc:
                return _err(f"打开和「{name}」的会话失败：{type(exc).__name__}: {exc}", phase="inbox")
            # 滚到最底下再读（新消息在底部）
            try:
                await page.evaluate("""() => {
                    const box = document.querySelector('[class*="MessageList"],[class*="messageList"],[class*="MessageItem"]');
                    let el = box;
                    while (el && !(el.scrollHeight > el.clientHeight + 10)) el = el.parentElement;
                    if (el) el.scrollTop = el.scrollHeight;
                }""")
            except Exception:
                pass
            await page.wait_for_timeout(1200)
            messages = await _message_snapshot(page)
            last = messages[-1] if messages else None
            item = {**last, "name": name, "peerId": "", "preview": (last or {}).get("text", "")} if last else None
            items = [item] if item and item.get("direction") == "inbound" else []
            return _ok(items=items, count=len(items), lastDirection=(item or {}).get("direction", ""),
                      notes=["只读了指定联系人；lastDirection=最后一条是谁发的"])
        icon = await _first_of(page, ['[data-e2e="im-entry"]'], 3000)
        if icon is None:
            return _err("没有找到消息入口")
        await icon.click()
        await page.wait_for_timeout(1000)
        rows = await page.evaluate("""() => Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).filter(e=>e.getClientRects().length).map(e=>{
            const t=(e.innerText||'').trim().split(String.fromCharCode(10))[0];
            return {name:t, peerId:'', conversationId:e.getAttribute('data-conversation-id')||''};
        }).filter(e=>e.name)""")
        if not rows:
            return _err("无法可靠读取会话身份，未根据预览猜测回复", phase="inbox")
        result = []
        started = time.monotonic()
        for row in rows[:max(1, min(int(limit), 12))]:
            if time.monotonic() - started > 65:
                break
            try:
                await _open_conversation(page, ctx, row["name"], row["peerId"])
                messages = await _message_snapshot(page)
                if not messages:
                    continue
                last = messages[-1]
                if last["direction"] == "inbound":
                    result.append({**row, **last, "preview": last["text"]})
            except Exception as exc:
                log(f"读取会话未完成：{type(exc).__name__}")
        return _ok(items=result, count=len(result), notes=["仅返回具有消息 ID 和明确入站方向的消息"])
    return j(await _guard(impl, 90))


@restricted_tool()
async def douyin_chat_batch(nickname: str, messages: str = "") -> str:
    """JSON array of text/sticker items. Each result is confirmed independently."""
    try:
        parts = json.loads(messages)
        if not isinstance(parts, list) or not parts or len(parts) > 4 or any(not isinstance(x, dict) for x in parts):
            raise ValueError()
    except Exception:
        return j(_err("messages 必须为含 1–4 个消息对象的 JSON 数组"))
    async def impl():
        ctx = await _browser.context()
        page = await _browser.page_chat()
        editor = await _open_conversation(page, ctx, nickname)
        outcomes = []
        for part in parts:
            r = await _send_chat_part(page, editor, part)
            outcomes.append({"kind": part.get("kind"), "status": "succeeded" if r.get("verified") else r.get("status", "failed"), **r})
            if not r.get("ok"):
                break
        complete = len(outcomes) == len(parts) and all(r.get("verified") for r in outcomes)
        return {"ok": complete, "verified": complete, "status": "succeeded" if complete else "partial" if any(r.get("verified") for r in outcomes) else outcomes[-1].get("status", "failed"),
                "outcomes": outcomes, "sent": [r.get("kind") for r in outcomes if r.get("verified")], "error": None if complete else "附加消息未全部确认"}
    return j(await _guard(impl, 120))


@restricted_tool()
async def douyin_chat_sticker(nickname: str, keyword: str = "", pick: int = 0, flip: int = 0) -> str:
    async def impl():
        ctx = await _browser.context()
        page = await _browser.page_chat()
        editor = await _open_conversation(page, ctx, nickname)
        return await _send_chat_part(page, editor, {"kind": "sticker", "keyword": keyword, "pick": pick, "flip": flip})
    return j(await _guard(impl, 90))


@restricted_tool()
async def douyin_share_video(aweme_id: str, nickname: str) -> str:
    """把视频转发给某个人：视频页 → 分享 → 面板里点他那行的「分享」。"""
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        return await _share_core(page, ctx, aweme_id, nickname)

    return j(await _guard(_impl, 90))


@restricted_tool()
async def douyin_publish(video_path: str, title: str, tags: str = "", draft: bool = True, ai_declare: bool = True, cover_path: str = "") -> str:
    """投稿视频（需登录）。draft=True（默认）只存草稿；draft=False 才点发布。

    返回 {ok, url, draft, notes?}。
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        return await _publish_core(page, ctx, video_path, title, tags, draft, ai_declare, cover_path)

    return j(await _guard(_impl, 120))


@restricted_tool()
async def douyin_selfcheck() -> str:
    """真跑一次：Chrome 能不能起、登录没、搜索能不能用。

    返回 {ok, chrome, profile, loggedIn, searched, needLogin?, notes[]}。
    """
    return j(await _guard(_selfcheck_core, 55))


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def _print_selftest() -> int:
    async def _run():
        try:
            return await _selftest()
        finally:
            await _browser.close()

    try:
        result = asyncio.run(_run())
    except Exception as exc:  # pragma: no cover
        log(traceback.format_exc())
        result = {"selftest": True, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
    print(j(result), flush=True)
    return 0 if result.get("ok") else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="douyin-mcp (Playwright + system Chrome)")
    parser.add_argument("--transcribe-wav", default="")
    parser.add_argument("--selftest", action="store_true",
                        help="不开 MCP 协议，直接跑登录检查 + 一次搜索，把 JSON 打到 stdout")
    args = parser.parse_args()
    if args.transcribe_wav:
        from contextlib import redirect_stdout
        with redirect_stdout(sys.stderr):
            result = _transcribe_sync(Path(args.transcribe_wav))
        print(json.dumps(result, ensure_ascii=False))
        return 0
    if args.selftest:
        return _print_selftest()
    mcp.run(transport="stdio")
    return 0


if __name__ == "__main__":
    sys.exit(main())
