"""B站投稿：上传文件 → 等表单 → 打印表单控件（第一轮先看结构，再填）。

python tools/bili_upload_probe2.py <视频路径>
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

CRED = Path(r"D:\dsh\bili-duty\bili_credential.json")
OUT = Path(r"D:\dsh\bili-duty")
URL = "https://member.bilibili.com/platform/upload/video/frame"
VIDEO = Path(r"D:\jev-decision-kit\jev-takeover.mp4")


async def main() -> None:
    from playwright.async_api import async_playwright

    raw = json.loads(CRED.read_text(encoding="utf-8"))
    cookies = [{"name": n, "value": str(raw[k]), "domain": ".bilibili.com", "path": "/"}
               for n, k in (("SESSDATA", "sessdata"), ("bili_jct", "bili_jct"), ("buvid3", "buvid3"), ("DedeUserID", "dedeuserid"))
               if raw.get(k)]

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            str(OUT / "bili-browser"), channel="chrome", headless=True,
            locale="zh-CN", viewport={"width": 1440, "height": 1000},
            args=["--disable-blink-features=AutomationControlled"],
        )
        await ctx.add_cookies(cookies)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(5000)

        vin = page.locator("input[type=file]").first
        await vin.set_input_files(str(VIDEO))
        print("uploading…", flush=True)
        for i in range(60):
            await page.wait_for_timeout(3000)
            txt = await page.inner_text("body")
            if "视频标题" in txt or "标题" in txt and "简介" in txt:
                break
        await page.wait_for_timeout(5000)
        info = await page.evaluate(
            """() => {
                const txt = (document.body.innerText || '').replace(/\\n+/g, ' | ').slice(0, 1200);
                const inputs = Array.from(document.querySelectorAll('input, textarea'))
                    .map((e) => ({ tag: e.tagName, type: e.type, ph: e.placeholder || '', cls: (e.className||'').toString().slice(0,50), val: (e.value||'').slice(0,30) }))
                    .slice(0, 25);
                const btns = Array.from(document.querySelectorAll('button, [class*=btn], span[class*=btn]'))
                    .map((e) => (e.innerText||'').trim().slice(0, 16)).filter(Boolean).slice(0, 40);
                const marks = Array.from(document.querySelectorAll('div,span,label'))
                    .filter((e) => /AI|声明|分区|自制|转载|更多设置/.test((e.innerText||'')) )
                    .map((e) => ({ t: (e.innerText||'').trim().slice(0, 26), c: (e.className||'').toString().slice(0,44) }))
                    .filter((x) => x.t.length < 26).slice(0, 30);
                return { url: location.href, txt, inputs, btns, marks };
            }"""
        )
        print("FORM " + json.dumps(info, ensure_ascii=False)[:3200])
        await page.screenshot(path=str(OUT / "bili-form.png"), full_page=False)
        await ctx.close()


if __name__ == "__main__":
    asyncio.run(main())
