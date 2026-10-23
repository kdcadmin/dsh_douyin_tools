"""探针 3：打开编辑器、打字之后，发送按钮在哪、文本进没进编辑器。"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

HOME = Path(os.environ.get("DSH_DOUYIN_HOME") or (Path.home() / ".dsh" / "douyin-duty"))


async def main() -> None:
    from playwright.async_api import async_playwright

    aid = sys.argv[1] if len(sys.argv) > 1 else "7695306080221498643"
    out = {}
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            str(HOME / "browser"), channel="chrome", headless=True,
            locale="zh-CN", viewport={"width": 1440, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        try:
            await page.goto(f"https://www.douyin.com/video/{aid}", wait_until="domcontentloaded", timeout=45000)
            await page.wait_for_timeout(6000)
            ph = page.get_by_text("留下你的精彩评论", exact=False).first
            if await ph.count():
                await ph.click(timeout=4000)
                await page.wait_for_timeout(1200)
            ed = page.locator("div.public-DraftEditor-content").first
            out["editor_found"] = await ed.count()
            if out["editor_found"]:
                await ed.click()
                await page.keyboard.type("@月亮硬糖🌇 测试一下别当真", delay=25)
                await page.wait_for_timeout(800)
                out["editor_text"] = (await ed.inner_text())[:80]
            # 所有可见按钮的文案
            out["buttons"] = await page.eval_on_selector_all(
                "button, [role='button'], div[class*='send'], div[class*='btn']",
                "els => els.map(e => ({t: (e.innerText||'').trim().slice(0,12), c: (e.className||'').slice(0,40), d: !!e.disabled, w: e.getBoundingClientRect().width|0}))"
                ".filter(x => x.t && x.w > 0).slice(0, 25)")
            out["send_like"] = await page.eval_on_selector_all(
                "*", "els => els.filter(e => /发送|发布/.test((e.innerText||'').trim()) && (e.innerText||'').trim().length <= 4 && e.getBoundingClientRect().width > 0).map(e => ({tag: e.tagName, t: (e.innerText||'').trim(), c: (e.className||'').slice(0,50)})).slice(0,10)")
        finally:
            await ctx.close()
    print("DOM3 " + json.dumps(out, ensure_ascii=False)[:3000])


if __name__ == "__main__":
    asyncio.run(main())
