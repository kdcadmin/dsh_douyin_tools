"""抓抖音创作页的按钮/输入框，找「存草稿」「发布」到底叫什么。"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

HOME = Path(os.environ.get("DSH_DOUYIN_HOME") or (Path.home() / ".dsh" / "douyin-duty"))
PROFILE = HOME / "browser"
URL = "https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page"


async def main() -> None:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            str(PROFILE), channel="chrome", headless=True,
            locale="zh-CN", viewport={"width": 1440, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(7000)
        info = await page.evaluate(
            """() => {
                const btns = Array.from(document.querySelectorAll('button, [role=button], .semi-button, [class*=btn]'))
                    .map((e) => ({ t: (e.innerText || '').trim().slice(0, 24), c: (e.className || '').toString().slice(0, 60) }))
                    .filter((x) => x.t);
                const files = Array.from(document.querySelectorAll('input[type=file]'))
                    .map((e) => ({ accept: e.getAttribute('accept') || '', name: e.getAttribute('name') || '' }));
                return { url: location.href, title: document.title, btns: btns.slice(0, 40), files };
            }"""
        )
        print("PAGE " + json.dumps(info, ensure_ascii=False)[:2500])
        await page.screenshot(path=str(HOME / "creator-page.png"))
        await ctx.close()


if __name__ == "__main__":
    asyncio.run(main())
