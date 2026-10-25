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
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

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
SEARCH_URL = "https://www.douyin.com/search/{kw}?type={type}"
CREATOR_UPLOAD = "https://creator.douyin.com/creator-micro/content/upload"

HEADLESS = os.environ.get("DOUYIN_HEADLESS", "1") != "0"
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


def _ok(**kw):
    d = {"ok": True}
    d.update(kw)
    return d


def _err(msg: str, **kw):
    d = {"ok": False, "error": msg}
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
        self.mode = "profile"          # profile | cdp
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
                _ = self._ctx.pages  # 活着就不会抛
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
                self.cdp_note = f"CDP 连不上（{type(exc).__name__}: {exc}）⇒ 退回插件自己的 profile"
                log(self.cdp_note)
                try:
                    await self._pw.stop()
                except Exception:
                    pass
                self._pw = await async_playwright().start()
                self._browser = None
        try:
            self._ctx = await self._pw.chromium.launch_persistent_context(
                str(PROFILE_DIR),
                channel="chrome",
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
        log(f"Chrome 起来了：profile={PROFILE_DIR} headless={HEADLESS}")
        return self._ctx

    async def page(self):
        ctx = await self.context()
        # cdp / shared 模式：浏览器可能是别人的，别去动人家的标签页，自己开一个
        if self.mode in ("cdp", "shared"):
            if self._own_page is not None and not self._own_page.is_closed():
                return self._own_page
            self._own_page = await ctx.new_page()
            return self._own_page
        for p in ctx.pages:
            if p.url and not p.url.startswith("about:"):
                return p
        if ctx.pages:
            return ctx.pages[0]
        return await ctx.new_page()

    async def close(self) -> None:
        # cdp / shared 模式：只关我们开的那一个标签页 + 断开连接，
        # **不许关掉浏览器/上下文**（那可能是别的会话正在用的同一个 Chrome）
        shared = self.mode in ("cdp", "shared")
        try:
            if shared and self._own_page is not None and not self._own_page.is_closed():
                await self._own_page.close()
        except Exception:
            pass
        self._own_page = None
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


async def _guard(factory, timeout: float = DEFAULT_TIMEOUT) -> dict:
    """拿锁 + 超时 + 异常兜底。factory 是一个无参协程函数。"""
    async def _inner():
        async with _browser.lock:
            return await factory()

    try:
        return await asyncio.wait_for(_inner(), timeout=timeout)
    except asyncio.TimeoutError:
        log(f"timeout after {timeout:.0f}s")
        return _err(f"超时：{timeout:.0f}s 内抖音页面没给出结果（可稍后重试）", timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        log(traceback.format_exc())
        return _err(f"{type(exc).__name__}: {exc}")


# ---------------------------------------------------------------------------
# Playwright 小工具
# ---------------------------------------------------------------------------

async def _goto(page, url: str, settle: float = 3.0) -> None:
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=35000)
    except Exception as exc:
        log(f"goto {url} -> {type(exc).__name__}: {exc}")
        raise
    if settle > 0:
        await page.wait_for_timeout(int(settle * 1000))


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
                """() => {
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
        page.on("response", self._on)

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
                self.items.append({"url": url.split("?")[0], "data": data})
        except Exception:
            return

    async def wait_for(self, predicate, timeout: float = 10.0, poll: float = 0.25):
        end = time.time() + timeout
        while time.time() < end:
            for item in list(self.items):
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
        except Exception:
            pass
        for task in list(self._tasks):
            task.cancel()
        self._tasks.clear()


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
    return {
        "cid": str(c.get("cid") or ""),
        "user": user.get("nickname") or "",
        "text": (c.get("text") or "").strip(),
        "digg": _num(c.get("digg_count", 0)),
        "time": _fmt_ts(c.get("create_time")),
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
            """() => {
                const seen = new Set(); const out = [];
                const anchors = Array.from(document.querySelectorAll(
                    '[data-e2e="scroll-list"] a[href*="/video/"], a[href*="/video/"]'
                ));
                for (const a of anchors) {
                    const m = (a.href || '').match(/\\/video\\/(\\d{6,})/);
                    if (!m || seen.has(m[1])) continue;
                    seen.add(m[1]);
                    let card = a.closest('li') || a.closest('[data-e2e="search-result-card"]');
                    if (!card) { let p = a; for (let i = 0; i < 4 && p.parentElement; i++) p = p.parentElement; card = p; }
                    const img = (card || a).querySelector('img');
                    const text = ((card && card.innerText) || a.innerText || '').trim();
                    out.push({
                        aweme_id: m[1],
                        title: ((img && img.alt) || text.split('\\n')[0] || '').slice(0, 120),
                        author: '',
                        digg: 0, comment: 0, share: 0, duration: 0,
                        url: 'https://www.douyin.com/video/' + m[1],
                        cover: (img && img.src) || '',
                        _text: text.slice(0, 300)
                    });
                }
                return out;
            }"""
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
            """() => {
                const info = document.querySelector('[data-e2e="detail-video-info"]');
                const id = (info && info.getAttribute('data-e2e-aweme-id'))
                    || ((location.pathname.match(/\\/video\\/(\\d+)/) || [])[1] || '');
                const title = (info && info.querySelector('h1') && info.querySelector('h1').innerText.trim())
                    || (document.title || '').replace(/\\s*-\\s*抖音$/, '');
                const authorImg = document.querySelector('[data-e2e="user-info"] img[alt]');
                const num = t => {
                    if (!t) return 0;
                    t = String(t).replace(/,/g, '').trim();
                    let m = 1;
                    if (t.endsWith('万')) { m = 10000; t = t.slice(0, -1); }
                    else if (t.endsWith('亿')) { m = 100000000; t = t.slice(0, -1); }
                    const v = parseFloat(t);
                    return isNaN(v) ? 0 : Math.round(v * m);
                };
                const digg = document.querySelector('[data-e2e="video-player-digg"]');
                const cmt = document.querySelector('[data-e2e="feed-comment-icon"]');
                const share = document.querySelector('[data-e2e="video-player-share"]');
                const pub = document.querySelector('[data-e2e="detail-video-publish-time"]');
                return {
                    aweme_id: id, title: title, desc: title,
                    author: (authorImg && authorImg.alt) || '',
                    digg: num(digg && digg.innerText),
                    comment_count: num(cmt && cmt.innerText),
                    share: num(share && share.innerText),
                    publish_time: pub ? pub.innerText.replace('发布时间：', '').trim() : ''
                };
            }"""
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
                    """() => {
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
            """(num) => {
                const out = [];
                const nodes = Array.from(document.querySelectorAll('[data-e2e="comment-item"], [class*="commentItem"], [class*="CommentItem"]'));
                for (const n of nodes) {
                    if (out.length >= num) break;
                    const txt = (n.innerText || '').replace(/\s+/g, ' ').trim();
                    if (!txt || txt.length < 2) continue;
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
                    });
                }
                return out;
            }""",
            max(1, int(num or 30)),
        )
        return [i for i in (items or []) if i.get("text")]
    except Exception:
        return []


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
        got = await net.wait_for(lambda u, d: isinstance(d.get("comments"), list), timeout=10.0)
        # ⭐ 图文（note）/非视频作品：/video/<id> 里没有播放器也不拉评论接口 ⇒ 换 /note/<id> 再试
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
                        """() => {
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
            # ⭐ DOM 兜底：有些作品（尤其图文）不抛 /comment/list/，只能从面板里抠
            dom_items = await _scrape_comments_dom(page, num)
            if dom_items:
                notes.append(f"接口没给，改成从页面里抠到 {len(dom_items)} 条")
                return _ok(aweme_id=aid, count=len(dom_items), items=dom_items, notes=notes, source="dom")
            notes.append("接口和页面都没拿到评论（这条可能关了评论，或评论还没加载出来）")
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
        # 弹层在但停在「验证码登录」tab 时，切回扫码 tab
        if await _first_of(page, QR_SELS, 500) is None:
            try:
                tab = page.get_by_text("扫码登录", exact=False).first
                if await tab.count() and await tab.is_visible(timeout=500):
                    await tab.click(timeout=3000)
                    await page.wait_for_timeout(1500)
            except Exception:
                pass
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
        hint="用抖音APP「扫一扫」扫码（约 180 秒有效）；扫完调 douyin_login_poll",
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


async def _switch_to_sms_tab(page) -> bool:
    """把登录弹层切到「验证码登录」tab。"""
    for label in ("验证码登录", "短信验证登录", "验证码 登录"):
        if await _click_text(page, label, exact=False):
            await page.wait_for_timeout(900)
            return True
    return False


async def _sms_start_core(page, ctx, phone: str) -> dict:
    """填手机号 + 点「获取验证码」，把短信发出去。返回 needCode=True。"""
    digits = re.sub(r"\D", "", str(phone or ""))
    if len(digits) != 11:
        return _err("手机号要给 11 位数字", phone=phone)
    await _goto(page, f"{HOME_URL}?_t={int(time.time() * 1000)}", settle=3.0)
    st = await _login_state(page, ctx)
    if st["loggedIn"]:
        return _ok(loggedIn=True, already=True, hint="已经登录了，不用再发短信")
    await _ensure_login_panel(page)
    if not await _switch_to_sms_tab(page):
        notes = [(await _body_text(page, 300))[:200]]
        return _err("没找到「验证码登录」这个 tab（弹层可能改版）", notes=notes)
    box = await _first_of(page, SMS_PHONE_SELS, 4000)
    if box is None:
        return _err("没找到手机号输入框", notes=[(await _body_text(page, 300))[:200]])
    try:
        await box.click(timeout=3000)
        await box.fill(digits)
    except Exception as exc:
        return _err(f"填手机号失败：{type(exc).__name__}: {exc}")
    await page.wait_for_timeout(300)
    clicked = await _click_text(page, "获取验证码", exact=False)
    if not clicked:
        clicked = await _click_text(page, "发送验证码", exact=False)
    if not clicked:
        clicked = await _click_text(page, "获取短信验证码", exact=False)
    await page.wait_for_timeout(1800)
    body = await _body_text(page, 1200)
    sent = ("秒后" in body) or ("重新获取" in body) or ("已发送" in body)
    hint = ("短信已发出" if sent else "点了「获取验证码」，但没看到倒计时（可能没发出去）") + \
           "：把收到的 6 位验证码给我（调 douyin_login_sms_submit），我填进去点登录"
    log(f"短信验证码：phone={digits[:3]}****{digits[-2:]} sent={sent}")
    return _ok(needCode=True, phone=digits, sent=sent, hint=hint)


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
        return _err("验证码填好了，但找不到「登录」按钮", code=digits)
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
    state = "waiting_scan" if qr_visible else "no_qr"
    if scanned and qr_visible:
        state = "scanned_need_confirm"
    hints = {
        "waiting_scan": "还没扫到：把这张二维码对着抖音「扫一扫」",
        "scanned_need_confirm": "扫到了，但手机上还没点「确认登录」—— 去手机上点一下那一步",
        "no_qr": "二维码已经不在页面上了（过期/刷新）⇒ 重新调 douyin_login_qr 出一张新的",
    }
    return _ok(loggedIn=False, needLogin=True, state=state, qrVisible=qr_visible,
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
            """() => {
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

        note = ""
        if dom["visible"]:
            try:
                await page.locator("[data-e2e='video-player-digg']").first.click(timeout=5000)
                note = "点了页面上的点赞按钮"
            except Exception as exc:  # noqa: BLE001
                note = f"按钮点击失败（{type(exc).__name__}），改 JS 直点"
        else:
            note = "点赞按钮 rect=0×0（互动栏 display:none），改用 JS 直点"

        if not note.startswith("点了页面"):
            # JS 派发 click 不受 display:none 影响：事件照走，抖音照样发请求
            await page.evaluate(
                """() => {
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
                    before=dom["state"], after=final.get("state"), note=note)

    # 页面上压根没有这个节点
    if undo:
        return _err("这条视频页没有可用的点赞按钮（互动栏未渲染），双击只能点赞、无法取消；"
                    "要取消请换一条视频页重试，或到「我 → 喜欢」里手动取消", aweme_id=aid)
    try:
        vid = page.locator("video").first
        if await vid.count() == 0:
            return _err("页面里没有 video 元素，点赞按钮也找不到", aweme_id=aid)
        await vid.scroll_into_view_if_needed(timeout=3000)
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
                    aweme_id=aid, state=after["state"])
    return _err("没有点赞按钮，双击后也读不到状态节点（无法核对，不敢报成功）", aweme_id=aid)


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
                    """() => {
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
            if idx is None:
                return _err(
                    f"找不到 cid={reply_cid} 对应的评论（DOM 不暴露 cid，且它不在已加载的评论里）",
                    aweme_id=aid, notes=notes,
                )
            items = page.locator("[data-e2e='comment-item']")
            if await items.count() <= idx:
                return _err(f"评论序号 {idx} 超出页面已渲染的条数", aweme_id=aid)
            target = items.nth(idx)
            try:
                await target.scroll_into_view_if_needed(timeout=2000)
                await target.hover(timeout=2000)
                reply_btn = target.get_by_text("回复", exact=True).first
                await reply_btn.click(timeout=4000)
                await page.wait_for_timeout(600)
            except Exception as exc:
                notes.append(f"点「回复」失败：{type(exc).__name__}: {exc}（改为发顶层评论）")

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
                    """(nick) => {
                        const els = Array.from(document.querySelectorAll('div,li,span'));
                        const out = [];
                        els.forEach((e) => {
                            const t = (e.innerText || '').trim();
                            const r = e.getBoundingClientRect();
                            if (!t || t.indexOf(nick) < 0) return;
                            if (r.width < 150 || r.width > 280 || r.height < 40 || r.height > 110) return;
                            out.push({ t, x: r.x | 0, y: r.y | 0, w: r.width | 0, h: r.height | 0 });
                        });
                        return out.slice(0, 5);
                    }""",
                    mention,
                )
                if rows:
                    await page.mouse.click(rows[0]["x"] + 10, rows[0]["y"] + rows[0]["h"] / 2)
                    await page.wait_for_timeout(800)
                    notes.append(f"点了 @ 联想面板里的「{rows[0]['t']}」")
                else:
                    notes.append("打了 @ 但没等到联想面板（只能按纯文本发）")
            except Exception as exc:
                notes.append(f"@ 联想失败：{type(exc).__name__}: {exc}")

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
        # 打完之后核对一下，编辑器里到底有没有字（2026-10-23：不核对就会出现"看起来打了、其实空的"）
        try:
            got = (await box.inner_text())[:60]
        except Exception:
            got = ""
        notes.append(f"编辑器里的字：{got!r}")

        # @ 提醒：打出来的 @昵称 是纯文本，抖音不会自动成 mention；这里先如实记一笔
        if "@" in text:
            notes.append("正文里的 @ 是纯文本（抖音桌面端不自动转成 @提醒）")

        await page.wait_for_timeout(400)
        sent = False
        # ⭐ 2026-10-25：抖音桌面端**没有发送按钮**，打完字按回车就发（实测编辑器会清空）
        try:
            await page.keyboard.press("Enter")
            await page.wait_for_timeout(2200)
            left = await box.inner_text() if hasattr(box, "inner_text") else ""
            if not str(left or "").strip():
                sent = True
                notes.append("回车提交，编辑器已清空")
        except Exception as exc:
            notes.append(f"回车提交失败：{type(exc).__name__}")
        # ① 点「工具条最右边那个 36px 图标」——实测这就是发送钮（无文字、红色圆/箭头）
        try:
            btn = await page.evaluate(
                """() => {
                    const ed = document.querySelector('div.public-DraftEditor-content');
                    if (!ed) return null;
                    let box = ed;
                    for (let i = 0; i < 7 && box.parentElement; i++) box = box.parentElement;
                    const nodes = Array.from(box.querySelectorAll('span,button,div'))
                        .map((e) => ({ r: e.getBoundingClientRect() }))
                        .filter((x) => x.r.width >= 24 && x.r.width <= 48 && x.r.height >= 24 && x.r.height <= 48);
                    if (!nodes.length) return null;
                    nodes.sort((a, b) => b.r.x - a.r.x);
                    const t = nodes[0].r;
                    return { x: t.x | 0, y: t.y | 0, w: t.width | 0, h: t.height | 0 };
                }"""
            )
            if btn:
                await page.mouse.click(btn["x"] + btn["w"] / 2, btn["y"] + btn["h"] / 2)
                await page.wait_for_timeout(2800)
                if net.items:
                    sent = True
                    notes.append(f"点了工具条最右边的图标（{btn['x']},{btn['y']}）并拿到 /comment/publish/ 回执")
        except Exception as exc:
            notes.append(f"点工具条图标失败：{type(exc).__name__}: {exc}")
        # ① 先用 JS 找「发送」（有的版本它是 div/span，不是 button，也不是 data-e2e）
        try:
            clicked_js = await page.evaluate(
                """() => {
                    const nodes = Array.from(document.querySelectorAll('button,div,span'));
                    const cand = nodes.filter((e) => {
                        const t = (e.textContent || '').trim();
                        if (t !== '发送' && t !== '发布') return false;
                        const r = e.getBoundingClientRect();
                        return r.width > 4 && r.height > 4;
                    });
                    if (!cand.length) return false;
                    cand[cand.length - 1].click();
                    return true;
                }"""
            )
            if clicked_js:
                await page.wait_for_timeout(2500)
                if net.items:
                    sent = True
                    notes.append("JS 点到「发送」并拿到 /comment/publish/ 回执")
        except Exception as exc:
            notes.append(f"JS 点发送失败：{type(exc).__name__}: {exc}")

        # ② 键盘提交（Draft.js 编辑器没有发送按钮时靠这个）
        if not sent:
            try:
                await box.click(timeout=2000)
            except Exception:
                pass
            for keys, label in (("Control+Enter", "Ctrl+Enter"), ("Enter", "Enter")):
                try:
                    await page.keyboard.press(keys)
                    await page.wait_for_timeout(2500)
                except Exception as exc:
                    notes.append(f"{label} 失败：{type(exc).__name__}: {exc}")
                    continue
                if net.items:
                    sent = True
                    notes.append(f"{label} 提交成功（/comment/publish/ 有回执）")
                    break
        if not sent:
            for sel in ["[data-e2e='comment-publish']", "[data-e2e='comment-send']"]:
                try:
                    btn = page.locator(sel).first
                    if await btn.count() and await btn.is_visible(timeout=600):
                        await btn.click(timeout=4000)
                        sent = True
                        break
                except Exception:
                    continue
        if not sent:
            btn = await _visible_text(page, "发送", exact=True)
            if btn is not None:
                try:
                    await btn.click(timeout=4000)
                    sent = True
                except Exception as exc:
                    notes.append(f"点发送失败：{type(exc).__name__}: {exc}")
        if not sent:
            # ⭐ 2026-10-23 实测：桌面端评论框**没有「发送」按钮**（编辑器是 Draft.js），
            #    提交靠键盘：Ctrl+Enter 生效（实测真的发出去了，/comment/publish/ 有回执）。
            for keys, label in (("Control+Enter", "Ctrl+Enter"), ("Enter", "Enter")):
                try:
                    await page.keyboard.press(keys)
                    await page.wait_for_timeout(2000)
                except Exception as exc:
                    notes.append(f"{label} 失败：{type(exc).__name__}: {exc}")
                    continue
                if net.items:
                    sent = True
                    notes.append(f"{label} 提交成功（/comment/publish/ 有回执）")
                    break
        if not sent:
            return _err("没找到「发送」按钮，Ctrl+Enter / Enter 也没触发提交", aweme_id=aid, notes=notes)

        hit = await net.wait_for(lambda u, d: True, timeout=10.0)

        async def _confirmed(tail: str, tries: int = 8) -> bool:
            """回读确认：页面文本或评论列表里真出现这句才算发出去。"""
            for _ in range(tries):
                await page.wait_for_timeout(1200)
                try:
                    body = await page.inner_text("body")
                except Exception:
                    body = ""
                if tail and tail in body:
                    return True
                try:
                    for item in list(cmt_net.items):
                        for c in item["data"].get("comments") or []:
                            if tail and tail in str(c.get("text") or ""):
                                return True
                except Exception:
                    pass
                try:
                    await page.evaluate(
                        "() => { const b=document.querySelector('[data-e2e=\"comment-list\"]'); if(b&&b.parentElement) b.parentElement.scrollTop=0; }"
                    )
                except Exception:
                    pass
            return False

        tail_txt = (text or "").strip()[-10:]

        if hit:
            data = hit["data"]
            comment = data.get("comment") or {}
            cid = str(comment.get("cid") or data.get("cid") or "")
            posted = comment.get("text") or data.get("text") or text
            if await _confirmed(tail_txt):
                out = _ok(aweme_id=aid, cid=cid, text=posted, url=VIDEO_URL.format(aweme_id=aid),
                          reply_cid=str(reply_cid or ""), verified=True)
                if notes:
                    out["notes"] = notes
                return out
            notes.append("有发布回执，但评论区里查不到这句 ⇒ 可能被限流/秒删；重试一次")
            # 重试一次：重新点开编辑器 → 输入 → 回车
            try:
                box2, notes = await _open_comment_box(page, notes)
                await box2.click()
                await page.keyboard.type(text, delay=40)
                await page.wait_for_timeout(500)
                await page.keyboard.press("Enter")
                await page.wait_for_timeout(2500)
            except Exception as exc:
                notes.append(f"重试输入失败：{type(exc).__name__}")
            if await _confirmed(tail_txt, tries=10):
                out = _ok(aweme_id=aid, cid=cid, text=posted, url=VIDEO_URL.format(aweme_id=aid),
                          reply_cid=str(reply_cid or ""), verified=True, retried=True)
                if notes:
                    out["notes"] = notes
                return out
            return _err("评论没真正发出去（有回执但评论区长不出来）", aweme_id=aid, text=text, notes=notes)

        # 没有 XHR 回执时，看评论列表里是否出现这段文本
        await page.wait_for_timeout(1500)
        try:
            seen = await page.locator(f"text={text[:24]}").count() > 0
        except Exception:
            seen = False
        if seen:
            notes.append("没抓到 /comment/publish/ 回执，但页面上已经出现评论文本")
            return _ok(aweme_id=aid, cid="", text=text, url=VIDEO_URL.format(aweme_id=aid),
                       reply_cid=str(reply_cid or ""), verified=True, notes=notes)
        return _err("点了发送但 10s 内没等到发布回执，也没在页面上看到评论",
                    aweme_id=aid, notes=notes)
    finally:
        net.close()
        cmt_net.close()


async def _publish_core(page, ctx, video_path: str, title: str, tags: str, draft: bool, ai_declare: bool = True, cover_path: str = "") -> dict:
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
    except Exception as exc:
        notes.append(f"填标题失败：{type(exc).__name__}: {exc}")

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
                    """() => {
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
                    notes.append("已勾选自主声明：内容由AI生成")
                else:
                    notes.append("⚠️ 打开声明面板但没找到「内容由AI生成」")
            else:
                notes.append("⚠️ 没找到「自主声明」入口")
        except Exception as exc:
            notes.append(f"勾声明失败：{type(exc).__name__}: {exc}")

    if draft:
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
    try:
        loc = page.locator("button:has-text('发布')")
        n = await loc.count()
        for i in range(n):
            item = loc.nth(i)
            if await item.is_visible(timeout=300):
                txt = ((await item.inner_text()) or "").strip()
                if txt in ("发布", "发布作品"):
                    await item.click(timeout=5000)
                    clicked = True
                    break
    except Exception as exc:
        notes.append(f"点发布失败：{type(exc).__name__}: {exc}")
    if not clicked:
        clicked = await _click_text(page, "发布", exact=True)
    if not clicked:
        return _err("没找到可点的「发布」按钮", url=page.url, notes=notes)
    await page.wait_for_timeout(4000)
    return _ok(url=page.url, draft=False, notes=notes)


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
            net = Net(page, lambda u, d: "hot/search/list" in u and isinstance(d.get("data"), dict))
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


@mcp.tool()
async def douyin_hot(limit: int = 30) -> str:
    """抖音热榜（**不用登录**就能拿）。

    返回 {ok, items:[{word, sentence_id, hot_value, discuss_video_count}], count, notes?}。
    sentence_id 可以喂给 douyin_hot_videos 去看这条热点的视频。
    """
    async def _impl():
        page = await _browser.page()
        return await _hot_core(page, limit)

    return j(await _guard(_impl, 45))


@mcp.tool()
async def douyin_hot_videos(sentence_id: str = "", word: str = "", num: int = 10) -> str:
    """看某条热点的视频列表（**不用登录**）。给 sentence_id（推荐）或 word。

    返回 {ok, sentence_id, word, items:[{aweme_id,url,title}], count, notes?}。
    """
    async def _impl():
        page = await _browser.page()
        return await _hot_videos_core(page, sentence_id, word, num)

    return j(await _guard(_impl, 60))


@mcp.tool()
async def douyin_login_sms(phone: str) -> str:
    """短信验证码登录第一步：切到「验证码登录」、填手机号、点「获取验证码」。

    返回 {ok, needCode, phone, sent, hint}；拿到短信后调 douyin_login_sms_submit(code)。
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        return await _sms_start_core(page, ctx, phone)

    return j(await _guard(_impl, 60))


@mcp.tool()
async def douyin_login_sms_submit(code: str) -> str:
    """短信验证码登录第二步：填 6 位验证码并点登录，最多等 15 秒确认登录态。

    返回 {ok, loggedIn, nickname?, uid?, hint}。
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        return await _sms_submit_core(page, ctx, code)

    return j(await _guard(_impl, 60))


@mcp.tool()
async def douyin_thumb(aweme_id: str) -> str:
    """给一条视频截缩略图（没封面 URL 时用）。存 <家>/thumbs/<id>.jpg，返回 {ok, path}。"""
    async def _impl():
        page = await _browser.page()
        return await _thumb_core(page, aweme_id)

    return j(await _guard(_impl, 60))


@mcp.tool()
async def douyin_check_credential() -> str:
    """检查抖音登录态（cookie sessionid + 页面头像两种证据）。

    返回 {ok, loggedIn, nickname?, uid?, evidence?, hint?}。
    """
    return j(await _guard(_check_credential_core, 45))


@mcp.tool()
async def douyin_login_qr() -> str:
    """打开抖音首页，唤出扫码登录弹层，把二维码截图存到 <家>/login-qr.png。

    返回 {ok, png, hint, loggedIn, needLogin?, bytes?, notes?}。
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        return await _login_qr_core(page, ctx)

    return j(await _guard(_impl, 60))


@mcp.tool()
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

async def _feed_core(page, ctx, num: int, scrolls: int) -> dict:
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
                             "duration": a.get("duration") or 0,
                             "author": ((a.get("author") or {}).get("nickname") or "")[:20],
                             "digg": (a.get("statistics") or {}).get("digg_count") or 0}
        except Exception:
            return

    page.on("response", _on_resp)
    try:
        await _goto(page, "https://www.douyin.com/jingxuan", settle=4.0)
        # 精选页默认不拉推荐流 ⇒ 点一下「推荐」
        try:
            await page.evaluate("""() => {
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
    items, dropped = _drop_live(items)
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


async def _watch_core(page, aweme_id: str, seconds: int = 300) -> dict:
    """把视频真看一遍：下载媒体 → 抽音轨 → faster-whisper 转写。

    seconds: 最多转写前多少秒（默认 300s；跳着看时用这个截断）
    """
    aid = _extract_aweme_id(str(aweme_id)) or str(aweme_id)
    media_dir = HOME / "media"
    media_dir.mkdir(parents=True, exist_ok=True)
    notes: list[str] = []
    url_hit: dict = {}

    # ⭐ 用一张**新标签页**跑：主标签常被别的操作占着，goto 会超时
    try:
        page = await page.context.new_page()
        notes.append("新开标签页")
    except Exception:
        pass

    # ① 转写结果的缓存：同一条视频只下一次、只转一次
    cache = media_dir / f"{aid}.{int(seconds)}.json"
    if cache.exists():
        try:
            data = json.loads(cache.read_text(encoding="utf-8"))
            data["cached"] = True
            return data
        except Exception:
            pass

    def on_resp(r):
        u = r.url or ""
        if not url_hit and ("/video/tos/" in u or "mime_type=video" in u) and ".mp4" not in u[:20]:
            url_hit.setdefault("url", u)

    try:
        await _goto(page, VIDEO_URL.format(aweme_id=aid), settle=3.0)
        await page.wait_for_timeout(1500)
        # 让 <video> 起播，currentSrc 才有值
        try:
            await page.evaluate("() => { const v = document.querySelector('video'); if (v) { v.muted = true; v.play && v.play(); } }")
        except Exception:
            pass
        url = ""
        for _ in range(12):
            cands = await page.evaluate(
                """() => {
                    const v = document.querySelector('video');
                    if (!v) return [];
                    const out = [];
                    if (v.currentSrc) out.push(v.currentSrc);
                    if (v.src) out.push(v.src);
                    v.querySelectorAll('source').forEach((s) => { if (s.src) out.push(s.src); });
                    return out;
                }"""
            )
            # ⭐ 只认 CDN 直链（douyinvod / .mp4）；/aweme/v1/play/ 是接口，ffmpeg 读不了
            for c in cands or []:
                if ("douyinvod.com" in c) or c.split("?")[0].endswith(".mp4"):
                    url = c
                    break
            if url:
                break
            await page.wait_for_timeout(400)
        dur = 0
        try:
            dur = float(await page.evaluate("() => { const v = document.querySelector('video'); return v ? v.duration : 0; }") or 0)
        except Exception:
            pass
    finally:
        try:
            page.remove_listener("response", on_resp)
        except Exception:
            pass

    if not url:
        return _err("没拿到视频流地址（未登录或被风控）", aweme_id=aid, duration=dur, notes=notes or None)

    # ⭐ 2026-10-25：**从不整条下载**。按取样片段用 ffmpeg 带 Range 直接取那几十秒。
    #   · ≤90 秒的视频：取开头
    #   · 长视频：取「开头 + 中间 + 结尾」各 30 秒（跳着看）
    segs_plan: list[tuple[float, int]] = []
    total = float(dur or 0)
    if total and total > 150:
        mid = max(0.0, total / 2 - 15)
        end = max(0.0, total - 45)
        segs_plan = [(0.0, 30), (mid, 30), (end, 30)]
    else:
        segs_plan = [(0.0, max(15, min(int(seconds), 120)))]

    # 拿浏览器 cookie，ffmpeg 才能读 play 接口
    cookie_hdr = ""
    try:
        cks = await page.context.cookies()
        parts = [f"{c.get('name')}={c.get('value')}" for c in cks if c.get("name") and c.get("value")]
        if parts:
            cookie_hdr = "Cookie: " + "; ".join(parts) + "\r\n"
    except Exception:
        pass

    # play 接口读不了 ⇒ 先在页面里 fetch 一次（只取前 1KB），把 302 之后的 CDN 直链拿出来
    try:
        final_url = await page.evaluate(
            """async (u) => {
                try {
                    const r = await fetch(u, { method: 'GET', headers: { Range: 'bytes=0-1024' }, credentials: 'include' });
                    return r.url || '';
                } catch (e) { return ''; }
            }""",
            url,
        )
        if final_url and "douyinvod.com" in final_url:
            notes.append("已解析到 CDN 直链")
            url = final_url
    except Exception:
        pass

    ff = _ffmpeg_path()
    ua = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36")
    hdr = "Referer: https://www.douyin.com/\r\n" + cookie_hdr

    wav_parts: list[Path] = []
    import subprocess
    for i, (start_at, dur_s) in enumerate(segs_plan):
        part = media_dir / f"{aid}.{int(seconds)}.{i}.wav"
        cmd = [ff, "-y", "-user_agent", ua, "-headers", hdr,
               "-ss", f"{start_at:.1f}", "-t", str(dur_s), "-i", url,
               "-vn", "-ac", "1", "-ar", "16000", str(part)]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=180)
            if r.returncode == 0 and part.exists() and part.stat().st_size > 1000:
                wav_parts.append(part)
            else:
                notes.append(f"片段 {i} 取失败：" + (r.stderr or b"")[-120:].decode("utf-8", "replace"))
        except Exception as exc:
            notes.append(f"片段 {i} 出错：{type(exc).__name__}")
    if not wav_parts:
        # 短一点的视频（≤5 分钟）可以整条下下来兜底；长视频绝不整条下，直接放弃看片
        if (dur or 0) <= 300:
            try:
                import subprocess
                out_mp4 = media_dir / f"{aid}.mp4"
                resp = await page.request.get(url, timeout=120000)
                if resp.status == 200:
                    out_mp4.write_bytes(await resp.body())
                    wav = media_dir / f"{aid}.{int(seconds)}.wav"
                    r = subprocess.run([ff, "-y", "-i", str(out_mp4), "-t", str(max(15, int(seconds))),
                                        "-vn", "-ac", "1", "-ar", "16000", str(wav)],
                                       capture_output=True, timeout=300)
                    if r.returncode == 0 and wav.exists():
                        notes.append(f"兜底：整条下载 {out_mp4.stat().st_size // 1024} KB 后抽音轨")
                        wav_parts = [wav]
                        try:
                            if os.environ.get("DOUYIN_KEEP_MEDIA") != "1":
                                out_mp4.unlink(missing_ok=True)
                        except Exception:
                            pass
            except Exception as exc:
                notes.append(f"兜底下载失败：{type(exc).__name__}")
        if not wav_parts:
            return _err(
                "拿不到可读的音轨（长视频不整条下载，直接放弃看片）" if (dur or 0) > 300 else "取音轨全失败（可能未登录/风控）",
                aweme_id=aid, duration=dur, notes=notes or None,
            )
    notes.append(f"取样 {len(wav_parts)} 段 / 计划 {len(segs_plan)} 段（不整条下载）")

    # 合成一个 wav（numpy 拼接，别用 ffmpeg concat，省事）
    wav = media_dir / f"{aid}.{int(seconds)}.wav"
    try:
        import wave as _w
        import numpy as _np
        frames = []
        sr = 16000
        for part in wav_parts:
            with _w.open(str(part), "rb") as w:
                sr = w.getframerate()
                frames.append(_np.frombuffer(w.readframes(w.getnframes()), dtype=_np.int16))
        merged = _np.concatenate(frames) if frames else _np.zeros(0, dtype=_np.int16)
        with _w.open(str(wav), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
            w.writeframes(merged.tobytes())
        for part in wav_parts:
            try: part.unlink(missing_ok=True)
            except Exception: pass
    except Exception as exc:
        return _err(f"音轨拼接失败：{type(exc).__name__}", aweme_id=aid, notes=notes)

    text = ""
    try:
        import wave
        import numpy as np
        model_name = os.environ.get("DOUYIN_WHISPER_MODEL", "base")
        model = _whisper_model(model_name)
        # ⭐ 不用 av 解码（这台机器上 av ↔ faster-whisper 的 metadata_errors 参数不兼容），
        #   自己把 16k 单声道 wav 读成 numpy 再喂给模型。
        with wave.open(str(wav), "rb") as w:
            sr = w.getframerate()
            raw = w.readframes(w.getnframes())
        audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        if sr != 16000:
            notes.append(f"注意：采样率 {sr}（ffmpeg 已按 16k 输出，正常不该出现）")
        segs, info = model.transcribe(audio, language="zh", vad_filter=True, beam_size=1)
        parts = [s.text.strip() for s in segs if s.text and s.text.strip()]
        text = " ".join(parts)[:2000]
        notes.append(f"whisper={model_name} 语言={info.language} 片段={len(parts)} 时长={round(len(audio)/max(1,sr),1)}s")
    except Exception as exc:
        return _err(f"转写出错：{type(exc).__name__}: {exc}", aweme_id=aid, notes=notes, downloaded=str(out_mp4))

    result = _ok(aweme_id=aid, duration=round(dur, 1), transcript=text,
                 chars=len(text), notes=notes)
    try:
        cache.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass
    # 用完即弃（想留着素材就设 DOUYIN_KEEP_MEDIA=1）
    try:
        await page.close()
    except Exception:
        pass
    if os.environ.get("DOUYIN_KEEP_MEDIA") != "1":
        try:
            wav.unlink(missing_ok=True)
            notes.append("音轨已删（DOUYIN_KEEP_MEDIA=1 可保留）")
        except Exception:
            pass
    return result


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


@mcp.tool()
async def douyin_watch(aweme_id: str, seconds: int = 300) -> str:
    """真·看视频：下载这条视频 → 抽音轨 → 本地转写成文字（faster-whisper）。

    用途：评论/转发之前先「看完」，别只看标题。
    seconds: 最多转写前多少秒（长视频跳着看就用它截断）
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        return await _watch_core(page, aweme_id, seconds)

    return j(await _guard(_impl, 600))


@mcp.tool()
async def douyin_feed(num: int = 10, scrolls: int = 6) -> str:
    """刷抖音推荐流（**不搜索**）：打开首页推荐，往下滚几屏，把露出的视频收下来。

    Args:
        num: 想要几条（默认 10）
        scrolls: 最多滚几屏（默认 6）

    返回 {ok, items:[{aweme_id,title,url}], count, notes?}
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        return await _feed_core(page, ctx, max(1, min(int(num or 10), 50)), max(1, min(int(scrolls or 6), 30)))

    return j(await _guard(_impl, 120))


@mcp.tool()
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


@mcp.tool()
async def douyin_video(aweme_id: str) -> str:
    """获取单条抖音视频信息（接受数字 id 或整条 /video/<id> 链接）。

    返回 {ok, aweme_id,title,desc,author,digg,comment_count,share,url,publish_time}。
    """
    async def _impl():
        page = await _browser.page()
        return await _video_core(page, aweme_id)

    return j(await _guard(_impl, 45))


@mcp.tool()
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
            items = [{"cid": str(x.get("cid")), "user": x.get("user", ""), "text": str(x.get("text", ""))[:30]} for x in items]
        res["items"] = items
        res["count"] = len(items)
        return res

    return j(await _guard(_impl, 60))


@mcp.tool()
async def douyin_like(aweme_id: str, undo: bool = False) -> str:
    """点赞 / 取消点赞（需登录）。undo=True 取消。

    返回 {ok, liked, changed, note?}。
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        return await _like_core(page, ctx, aweme_id, undo)

    return j(await _guard(_impl, 45))


@mcp.tool()
async def douyin_my_posts(days: int = 1) -> str:
    """我自己的作品列表（按发布时间过滤，默认只要今天的）。

    用于「自动回评论」：只回**当日发布**的视频，过了当天就不再回。
    走站内接口 /aweme/v1/web/aweme/post/（登录态在浏览器里，带 Cookie 同源请求）。
    返回 {ok, items:[{aweme_id,title,create_time,day}], count, days}
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        await _goto(page, "https://www.douyin.com/user/self", settle=4.0)
        sec = ""
        try:
            sec = await page.evaluate("() => (location.pathname.match(/user\\/([^/?]+)/) || [])[1] || ''")
        except Exception:
            sec = ""
        if not sec:
            # 从页面上找自己的链接
            try:
                sec = await page.evaluate(
                    """() => {
                        const a = Array.from(document.querySelectorAll("a[href*='/user/']"))
                            .map((e) => (e.getAttribute('href') || '').match(/user\\/([^/?]+)/))
                            .filter(Boolean).map((m) => m[1]);
                        return a.length ? a[0] : '';
                    }"""
                )
            except Exception:
                sec = ""
        if not sec:
            return _err("没拿到自己的 sec_user_id（/user/self 可能跳转了）", needLogin=False)
        data = await page.evaluate(
            """async (uid) => {
                const r = await fetch('/aweme/v1/web/aweme/post/?device_platform=webapp&aid=6383&channel=channel_pc_web&sec_user_id='
                    + encodeURIComponent(uid) + '&max_cursor=0&count=20&locate_query=false&show_live_replay_strategy=1', { credentials: 'include' });
                const j = await r.json();
                return (j.aweme_list || []).map((a) => ({
                    aweme_id: a.aweme_id,
                    title: (a.desc || '').slice(0, 60),
                    create_time: a.create_time || 0,
                }));
            }""",
            sec,
        )
        import time as _t
        today = _t.strftime("%Y-%m-%d")
        cutoff = _t.mktime(_t.strptime(today, "%Y-%m-%d"))
        items = []
        for a in (data or []):
            ct = int(a.get("create_time") or 0)
            day = _t.strftime("%Y-%m-%d", _t.localtime(ct)) if ct else ""
            if days <= 1 and ct and ct < cutoff:
                continue
            items.append({"aweme_id": str(a["aweme_id"]), "title": a.get("title", ""), "create_time": ct, "day": day})
        return _ok(items=items, count=len(items), days=days, sec_user_id=sec)

    return j(await _guard(_impl, 70))


@mcp.tool()
async def douyin_comment(aweme_id: str, text: str, reply_cid: str = "", mention: str = "", reply_index: int = -1) -> str:
    """发评论或回复某条评论（需登录）。reply_cid 非空时回复该评论；
    mention 非空时走**真人 @ 提醒**（打 @昵称 → 点联想面板那一行），不是纯文本 @。

    返回 {ok, cid, text, url, reply_cid?, notes?}。
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        return await _comment_core(page, ctx, aweme_id, text, reply_cid, mention, reply_index)

    return j(await _guard(_impl, 70))


async def _share_core(page, ctx, aweme_id: str, nickname: str) -> dict:
    """转发：视频页 → **鼠标悬停**分享图标 → 面板「分享给朋友」→ 点那个人右边的「分享」。

    2026-10-25 实测：这个面板是 **hover 打开**的（click 不弹）。面板里每行是「头像+昵称 … [分享]」。
    """
    notes = []
    (HOME / "thumbs").mkdir(parents=True, exist_ok=True)
    aid = _extract_aweme_id(str(aweme_id)) or str(aweme_id)
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
    hit = await page.evaluate(
        """(nick) => {
            const rows = Array.from(document.querySelectorAll('div,li'));
            for (const row of rows) {
                const t = (row.innerText || '');
                if (!t || t.indexOf(nick) < 0) continue;
                if (t.replace(/\s+/g, '').length > 60) continue;   // 太长的不是一行
                const btns = Array.from(row.querySelectorAll('div,span,button'))
                    .filter((b) => (b.innerText || '').trim() === '分享');
                for (const b of btns) { b.click(); return { ok: true, row: t.replace(/\s+/g, ' ').slice(0, 40) }; }
            }
            return { ok: false };
        }""",
        nickname,
    )
    await page.wait_for_timeout(2500)
    if hit.get("ok"):
        return _ok(shared_to=nickname, aweme_id=aid, matched=hit.get("row"), how="hover-panel", notes=notes or None)
    return _err(f"面板里没有「{nickname}」这一行", aweme_id=aid, notes=notes)


async def _chat_send_core(page, ctx, nickname: str, text: str) -> dict:
    """私信：首页点右上「消息」图标（data-e2e=im-entry）→ 右侧抽屉 → 点那个人 → 「发送消息」框 → 回车。

    2026-10-25 使用者截图 + 实测：抽屉里的会话列表直接有好友；输入框 placeholder 是「发送消息」。
    之前失败的原因是把昵称打进了页面顶部那个大搜索框。
    """
    notes = []
    (HOME / "thumbs").mkdir(parents=True, exist_ok=True)
    await _goto(page, "https://www.douyin.com/jingxuan", settle=4.0)
    st = await _login_state(page, ctx)
    if not st["loggedIn"]:
        return _need_login("私信要登录", nickname=nickname)

    # 1) 打开消息抽屉 —— 必须真实鼠标点击（JS .click() 不触发，2026-10-25 实测）
    icon = page.locator('[data-e2e="im-entry"]').first
    if not await icon.count():
        return _err("没找到「消息」图标（data-e2e=im-entry）", url=page.url, notes=notes)
    box = await icon.bounding_box()
    if not box:
        return _err("「消息」图标没有尺寸", url=page.url, notes=notes)
    await page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    await page.wait_for_timeout(400)
    await page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    opened = False
    for _ in range(12):
        await page.wait_for_timeout(500)
        body = await page.inner_text("body")
        if "陌生人消息" in body or "分享[视频]" in body or "发送消息" in body:
            opened = True
            break
    notes.append("抽屉已打开" if opened else "抽屉没打开")
    if not opened:
        return _err("点「消息」后抽屉没打开", url=page.url, notes=notes)

    nickKey = "".join(ch for ch in str(nickname) if ch.strip())[:4]
    openedInfo = await page.evaluate(
        "() => { const t = document.body.innerText || ''; return { drawer: t.indexOf('陌生人消息') >= 0 || t.indexOf('分享[视频]') >= 0, tail: t.slice(-60) }; }"
    )
    notes.append("抽屉状态：" + str(openedInfo.get("drawer")))
    hit = 0
    notes.append(f"抽屉搜索框 {hit} 个")
    await page.wait_for_timeout(2500)

    rowBox = await page.evaluate(
        """(nick) => {
            const W = window.innerWidth;
            const key = nick.replace(/\s+/g, '').slice(0, 4);
            const rows = Array.from(document.querySelectorAll('div,li')).filter((e) => {
                const r = e.getBoundingClientRect();
                const t = (e.innerText || '').replace(/\s+/g, ' ').trim();
                return r.x > W * 0.5 && r.width > 120 && r.height >= 30 && r.height <= 120 && t.replace(/\s+/g, '').indexOf(key) >= 0;
            });
            if (!rows.length) return null;
            rows.sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);
            const r = rows[0].getBoundingClientRect();
            return { x: r.x + 30, y: r.y + r.height / 2, t: (rows[0].innerText || '').replace(/\s+/g, ' ').slice(0, 30) };
        }""",
        nickname,
    )
    clicked = (rowBox or {}).get("t")
    if rowBox:
        await page.mouse.click(rowBox["x"], rowBox["y"])
        await page.wait_for_timeout(2000)
        # 有「发消息」按钮就再点一次它（真实鼠标）
        btnBox = await page.evaluate(
            """() => {
                const W = window.innerWidth;
                const b = Array.from(document.querySelectorAll('div,span,button')).find((e) => {
                    const r = e.getBoundingClientRect();
                    return (e.innerText || '').trim() === '发消息' && r.x > W * 0.5 && r.width > 20;
                });
                if (!b) return null;
                const r = b.getBoundingClientRect();
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }"""
        )
        if btnBox:
            await page.mouse.click(btnBox["x"], btnBox["y"])
            await page.wait_for_timeout(2000)
            notes.append("点了「发消息」")
    # 3) 等输入框（placeholder=发送消息）
    ed = None
    for _ in range(20):
        await page.wait_for_timeout(600)
        # 实测：聊天输入框是 **contenteditable 的 DIV**（属性可能是空值），且在抽屉区域（x > 屏宽 50%）
        ed = await page.evaluate_handle(
            """() => {
                const W = window.innerWidth, H = window.innerHeight;
                const list = Array.from(document.querySelectorAll('div[contenteditable], textarea, input'));
                const hit = list.find((e) => {
                    const r = e.getBoundingClientRect();
                    const ph = e.placeholder || '';
                    const isSend = ph.indexOf('发送消息') >= 0;
                    return (isSend || e.getAttribute('contenteditable') !== null) &&
                           r.width > 100 && r.height > 16 && r.x > W * 0.4 && r.y > H * 0.45;
                });
                return hit || null;
            }"""
        )
        ed = ed.as_element() if ed else None
        if ed is not None:
            break
    if ed is None:
        cands = await page.evaluate(
            """() => Array.from(document.querySelectorAll('input,textarea,div[contenteditable]')).map((e) => ({
                   tag: e.tagName, ce: e.getAttribute('contenteditable'), ph: e.placeholder || '',
                   w: e.getBoundingClientRect().width | 0, h: e.getBoundingClientRect().height | 0 })).slice(0, 10)"""
        )
        notes.append("候选输入框：" + str(cands)[:300])
        await page.screenshot(path=str(HOME / "thumbs" / "_chat.png"))
        return _err("没等到「发送消息」输入框", url=page.url, notes=notes)

    try:
        await ed.click()
        await page.keyboard.type(text, delay=30)
        await page.wait_for_timeout(500)
        await page.keyboard.press("Enter")
        await page.wait_for_timeout(1500)
        return _ok(to=nickname, sent=text, notes=notes)
    except Exception as exc:
        return _err(f"发送失败：{type(exc).__name__}: {exc}", notes=notes)


@mcp.tool()
async def douyin_chat_send(nickname: str, text: str) -> str:
    """给好友发一条私信（首页右上「消息」→ 搜索昵称 → 输入 → 回车）。

    一个原语干三件事：转发（正文放视频链接）、续火花（随便一句）、发表情包（写 [憨笑] 这类文本码）。
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        return await _chat_send_core(page, ctx, nickname, text)

    return j(await _guard(_impl, 90))


@mcp.tool()
async def douyin_inbox(limit: int = 12) -> str:
    """读消息抽屉里的会话列表（谁发来的、最后一句是什么、什么时候）。

    返回 {ok, items:[{name, preview, time}], count}
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        (HOME / "thumbs").mkdir(parents=True, exist_ok=True)
        await _goto(page, "https://www.douyin.com/jingxuan", settle=4.0)
        st = await _login_state(page, ctx)
        if not st["loggedIn"]:
            return _need_login("读私信要登录")
        icon = page.locator('[data-e2e="im-entry"]').first
        if not await icon.count():
            return _err("没找到「消息」图标")
        box = await icon.bounding_box()
        await page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        # 抽屉是否打开：看右侧有没有那个「搜索」框（x 靠右），比数文案可靠
        opened = False
        for _ in range(14):
            await page.wait_for_timeout(500)
            opened = await page.evaluate(
                """() => {
                    const W = innerWidth;
                    return Array.from(document.querySelectorAll('input'))
                        .some((e) => (e.placeholder || '').indexOf('搜索') >= 0 && e.getBoundingClientRect().x > W * 0.55);
                }"""
            )
            if opened:
                break
        if not opened:
            await page.screenshot(path=str(HOME / "thumbs" / "_inbox.png"))
            return _err("消息抽屉没打开")
        items = await page.evaluate(
            """(limit) => {
                const W = innerWidth;
                const rows = Array.from(document.querySelectorAll('div,li')).filter((e) => {
                    const r = e.getBoundingClientRect();
                    const t = (e.innerText || '').replace(/\s+/g, ' ').trim();
                    return r.x > W * 0.5 && r.width > 140 && r.height >= 40 && r.height <= 110 && t.length > 1 && t.length < 80;
                });
                const out = [];
                for (const e of rows) {
                    const t = (e.innerText || '').replace(/\s+/g, ' ').trim();
                    if (t.indexOf('消息') === 0 && t.length < 4) continue;
                    if (out.some((o) => o.text === t)) continue;
                    out.push({ text: t });
                }
                return out.slice(0, limit);
            }""",
            max(1, min(int(limit or 12), 30)),
        )
        return _ok(items=items, count=len(items))

    return j(await _guard(_impl, 90))


@mcp.tool()
async def douyin_chat_batch(nickname: str, messages: str = "") -> str:
    """一次会话里把话和表情包都发完（不再反复打开抽屉/重复搜索）。

    messages: 用 `|` 分隔的片段，`sticker:关键词` 表示发表情包，其它按文字发。
    例：`这个视频好好笑[笑哭]|sticker:大肥鱼`
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        (HOME / "thumbs").mkdir(parents=True, exist_ok=True)
        notes = []
        await _goto(page, "https://www.douyin.com/jingxuan", settle=4.0)
        st = await _login_state(page, ctx)
        if not st["loggedIn"]:
            return _need_login("发私信要登录", nickname=nickname)

        icon = page.locator('[data-e2e="im-entry"]').first
        if not await icon.count():
            return _err("没找到「消息」图标")
        box = await icon.bounding_box()
        await page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        opened = False
        for _ in range(12):
            await page.wait_for_timeout(500)
            opened = await page.evaluate(
                """() => { const W = innerWidth;
                    return Array.from(document.querySelectorAll('input')).some((e) =>
                        (e.placeholder || '').indexOf('搜索') >= 0 && e.getBoundingClientRect().x > W * 0.55); }"""
            )
            if opened:
                break
        if not opened:
            return _err("消息抽屉没打开", notes=notes)

        key = "".join(ch for ch in str(nickname) if ch.strip())[:4]
        rowBox = await page.evaluate(
            """(key) => {
                const W = innerWidth;
                const rows = Array.from(document.querySelectorAll('div,li')).filter((e) => {
                    const r = e.getBoundingClientRect();
                    const t = (e.innerText || '').replace(/\s+/g, '');
                    return r.x > W * 0.5 && r.width > 120 && r.height >= 30 && r.height <= 120 && t.indexOf(key) >= 0;
                });
                if (!rows.length) return null;
                rows.sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);
                const r = rows[0].getBoundingClientRect();
                return { x: r.x + 30, y: r.y + r.height / 2 };
            }""",
            key,
        )
        if not rowBox:
            return _err(f"抽屉里没有「{nickname}」", notes=notes)
        await page.mouse.click(rowBox["x"], rowBox["y"])
        await page.wait_for_timeout(3500)

        sent = []
        parts = [x.strip() for x in str(messages or "").split("|") if x.strip()]
        for part in parts:
            ed = await page.evaluate_handle(
                """() => { const W = innerWidth, H = innerHeight;
                    return Array.from(document.querySelectorAll('div[contenteditable], textarea, input'))
                        .find((e) => { const r = e.getBoundingClientRect();
                            const ph = e.placeholder || '';
                            return (ph.indexOf('发送消息') >= 0 || e.getAttribute('contenteditable') !== null) &&
                                   r.width > 100 && r.height > 16 && r.x > W * 0.4 && r.y > H * 0.45; }) || null; }"""
            )
            el = ed.as_element()
            if el is None:
                return _err("没找到输入框", sent=sent, notes=notes)
            if part.startswith("sticker:"):
                kw = part.split(":", 1)[1].strip() or "大肥鱼"
                await el.click()
                await page.keyboard.type(kw, delay=50)
                await page.wait_for_timeout(2600)
                sticks = await page.evaluate(
                    """() => { const W = innerWidth, H = innerHeight;
                        return Array.from(document.querySelectorAll('img')).map((e) => {
                            const r = e.getBoundingClientRect();
                            return { x: r.x | 0, y: r.y | 0, w: r.width | 0, h: r.height | 0 };
                        }).filter((o) => o.w >= 40 && o.w <= 140 && o.h >= 40 && o.h <= 140 && o.y > H * 0.6 && o.x > W * 0.65); }"""
                )
                if sticks:
                    s = sticks[0]
                    await page.mouse.click(s["x"] + s["w"] / 2, s["y"] + s["h"] / 2)
                    await page.wait_for_timeout(1800)
                    sent.append("sticker:" + kw)
                else:
                    sent.append("sticker-miss:" + kw)
                for _ in range(len(kw) + 2):
                    await page.keyboard.press("Backspace")
            else:
                await el.click()
                await page.keyboard.type(part, delay=30)
                await page.keyboard.press("Enter")
                await page.wait_for_timeout(1200)
                sent.append(part)
        return _ok(to=nickname, sent=sent, notes=notes)

    return j(await _guard(_impl, 150))


@mcp.tool()
async def douyin_chat_sticker(nickname: str, keyword: str = "大肥鱼", pick: int = 0) -> str:
    """在私信里发表情包：打开抽屉 → 点那个人 → 输入关键词（默认「大肥鱼」）→ 联想表情面板 → 点其中一个发出去。

    2026-10-25 实测：输入「大肥鱼」会在输入框上方弹出一排表情包，点一下就发。
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        (HOME / "thumbs").mkdir(parents=True, exist_ok=True)
        notes = []
        await _goto(page, "https://www.douyin.com/jingxuan", settle=4.0)
        st = await _login_state(page, ctx)
        if not st["loggedIn"]:
            return _need_login("发表情要登录", nickname=nickname)

        icon = page.locator('[data-e2e="im-entry"]').first
        if not await icon.count():
            return _err("没找到「消息」图标")
        box = await icon.bounding_box()
        await page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        await page.wait_for_timeout(3000)

        key = "".join(ch for ch in str(nickname) if ch.strip())[:4]
        rowBox = await page.evaluate(
            """(key) => {
                const W = innerWidth;
                const rows = Array.from(document.querySelectorAll('div,li')).filter((e) => {
                    const r = e.getBoundingClientRect();
                    const t = (e.innerText || '').replace(/\s+/g, '');
                    return r.x > W * 0.5 && r.width > 120 && r.height >= 30 && r.height <= 120 && t.indexOf(key) >= 0;
                });
                if (!rows.length) return null;
                rows.sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);
                const r = rows[0].getBoundingClientRect();
                return { x: r.x + 30, y: r.y + r.height / 2 };
            }""",
            key,
        )
        if not rowBox:
            return _err(f"抽屉里没有「{nickname}」", notes=notes)
        await page.mouse.click(rowBox["x"], rowBox["y"])
        await page.wait_for_timeout(3500)

        ed = await page.evaluate_handle(
            """() => {
                const W = innerWidth, H = innerHeight;
                return Array.from(document.querySelectorAll('div[contenteditable], textarea, input'))
                    .find((e) => { const r = e.getBoundingClientRect();
                        return r.width > 100 && r.y > H * 0.45 && r.x > W * 0.4; }) || null;
            }"""
        )
        el = ed.as_element()
        if el is None:
            return _err("没找到输入框", notes=notes)
        await el.click()
        await page.keyboard.type(keyword, delay=60)
        await page.wait_for_timeout(3000)

        sticks = await page.evaluate(
            """() => {
                const W = innerWidth, H = innerHeight;
                return Array.from(document.querySelectorAll('img')).map((e) => {
                    const r = e.getBoundingClientRect();
                    return { x: r.x | 0, y: r.y | 0, w: r.width | 0, h: r.height | 0 };
                }).filter((o) => o.w >= 40 && o.w <= 140 && o.h >= 40 && o.h <= 140 && o.y > H * 0.6 && o.x > W * 0.65);
            }"""
        )
        if not sticks:
            await page.screenshot(path=str(HOME / "thumbs" / "_sticker.png"))
            return _err("没等到表情面板", notes=notes)
        idx = max(0, min(int(pick or 0), len(sticks) - 1))
        s = sticks[idx]
        await page.mouse.click(s["x"] + s["w"] / 2, s["y"] + s["h"] / 2)
        await page.wait_for_timeout(2500)
        # 清掉输入框里剩下的关键词，避免跟着发出去
        try:
            for _ in range(len(keyword) + 2):
                await page.keyboard.press("Backspace")
        except Exception:
            pass
        return _ok(to=nickname, sticker_index=idx, candidates=len(sticks), keyword=keyword, notes=notes)

    return j(await _guard(_impl, 120))


@mcp.tool()
async def douyin_share_video(aweme_id: str, nickname: str) -> str:
    """把视频转发给某个人：视频页 → 分享 → 面板里点他那行的「分享」。"""
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        return await _share_core(page, ctx, aweme_id, nickname)

    return j(await _guard(_impl, 90))


@mcp.tool()
async def douyin_publish(video_path: str, title: str, tags: str = "", draft: bool = True, ai_declare: bool = True, cover_path: str = "") -> str:
    """投稿视频（需登录）。draft=True（默认）只存草稿；draft=False 才点发布。

    返回 {ok, url, draft, notes?}。
    """
    async def _impl():
        ctx = await _browser.context()
        page = await _browser.page()
        return await _publish_core(page, ctx, video_path, title, tags, draft, ai_declare, cover_path)

    return j(await _guard(_impl, 120))


@mcp.tool()
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
    parser.add_argument("--selftest", action="store_true",
                        help="不开 MCP 协议，直接跑登录检查 + 一次搜索，把 JSON 打到 stdout")
    args = parser.parse_args()
    if args.selftest:
        return _print_selftest()
    mcp.run(transport="stdio")
    return 0


if __name__ == "__main__":
    sys.exit(main())
