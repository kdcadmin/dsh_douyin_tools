"""B站投稿页探路：注入 Cookie 打开 member.bilibili.com 的上传页，把关键控件打出来。

python tools/probe_bili_upload.py
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

CRED = Path(r"D:\dsh\bili-duty\bili_credential.json")
OUT = Path(r"D:\dsh\bili-duty")
URL = "https://member.bilibili.com/platform/upload/video/frame"


async def main() -> None:
    from playwright.async_api import async_playwright

    raw = json.loads(CRED.read_text(encoding="utf-8"))
    cookies = []
    for name, key in (("SESSDATA", "sessdata"), ("bili_jct", "bili_jct"), ("buvid3", "buvid3"), ("DedeUserID", "dedeuserid")):
        if raw.get(key):
            cookies.append({"name": name, "value": str(raw[key]), "domain": ".bilibili.com", "path": "/"})

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            str(OUT / "bili-browser"), channel="chrome", headless=True,
            locale="zh-CN", viewport={"width": 1440, "height": 1000},
            args=["--disable-blink-features=AutomationControlled"],
        )
        await ctx.add_cookies(cookies)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(8000)
        info = await page.evaluate(
            """() => {
                const txt = (document.body.innerText || '').replace(/\\n+/g, ' | ').slice(0, 700);
                const btns = Array.from(document.querySelectorAll('button, .bcc-button, [class*=btn]'))
                    .map((e) => (e.innerText || '').trim().slice(0, 18)).filter(Boolean).slice(0, 30);
                const inputs = Array.from(document.querySelectorAll('input, textarea'))
                    .map((e) => ({ t: e.type || e.tagName, ph: e.placeholder || '', cls: (e.className||'').toString().slice(0,40) })).slice(0, 20);
                const files = Array.from(document.querySelectorAll('input[type=file]')).map((e) => e.accept || '');
                return { url: location.href, title: document.title, txt, btns, inputs, files };
            }"""
        )
        print("BILI_UPLOAD " + json.dumps(info, ensure_ascii=False)[:2600])
        await page.screenshot(path=str(OUT / "bili-upload-page.png"), full_page=False)
        await ctx.close()


if __name__ == "__main__":
    asyncio.run(main())
