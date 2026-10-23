"""看创作中心的「作品管理」页：最近几条作品的状态（发布成功没）。"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

HOME = Path(os.environ.get("DSH_DOUYIN_HOME") or (Path.home() / ".dsh" / "douyin-duty"))
PROFILE = HOME / "browser"
URL = "https://creator.douyin.com/creator-micro/content/manage"


async def main() -> None:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            str(PROFILE), channel="chrome", headless=True, locale="zh-CN",
            viewport={"width": 1440, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(7000)
        data = await page.evaluate(
            """() => {
                const txt = document.body.innerText || '';
                const rows = Array.from(document.querySelectorAll('[class*=video-item], [class*=work-item], [class*=card]'))
                    .map((e) => (e.innerText || '').trim().split('\\n').slice(0, 4).join(' | '))
                    .filter((t) => t && t.length > 6);
                return { url: location.href, snippet: txt.slice(0, 900), rows: rows.slice(0, 8) };
            }"""
        )
        print("MANAGE " + json.dumps(data, ensure_ascii=False)[:2200])
        await page.screenshot(path=str(HOME / "creator-manage.png"), full_page=False)
        await ctx.close()


if __name__ == "__main__":
    asyncio.run(main())
