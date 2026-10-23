"""看 B站 创作中心的稿件管理页：最新投稿是什么状态。"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

CRED = Path(r"D:\dsh\bili-duty\bili_credential.json")
OUT = Path(r"D:\dsh\bili-duty")
URLS = [
    "https://member.bilibili.com/platform/upload-manager/article",
    "https://member.bilibili.com/platform/upload-manager/archive",
]


async def main() -> None:
    from playwright.async_api import async_playwright

    raw = json.loads(CRED.read_text(encoding="utf-8"))
    cookies = [{"name": n, "value": str(raw[k]), "domain": ".bilibili.com", "path": "/"}
               for n, k in (("SESSDATA", "sessdata"), ("bili_jct", "bili_jct"), ("buvid3", "buvid3"), ("DedeUserID", "dedeuserid"))
               if raw.get(k)]
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            str(OUT / "bili-browser"), channel="chrome", headless=True, locale="zh-CN",
            viewport={"width": 1440, "height": 1000}, args=["--disable-blink-features=AutomationControlled"])
        await ctx.add_cookies(cookies)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        for u in URLS:
            try:
                await page.goto(u, wait_until="domcontentloaded", timeout=45000)
                await page.wait_for_timeout(6000)
                txt = await page.inner_text("body")
                print("URL", u, "->", page.url)
                print(txt.replace("\n", " | ")[:1100])
                await page.screenshot(path=str(OUT / f"bili-manager-{u.rsplit('/', 1)[-1]}.png"))
                break
            except Exception as exc:
                print("fail", u, type(exc).__name__)
        await ctx.close()


if __name__ == "__main__":
    asyncio.run(main())
