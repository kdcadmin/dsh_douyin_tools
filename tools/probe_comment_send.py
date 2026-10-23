"""探针 4：在评论编辑器里打完字之后，尝试用键盘提交（Ctrl+Enter / Enter），
看 /comment/publish/ 有没有回执、评论区里有没有出现这段文字。

用法：python tools/probe_comment_send.py <aweme_id> "<text>"
⚠️ 这会**真的发出去**一条评论（就是这个用途）。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

HOME = Path(os.environ.get("DSH_DOUYIN_HOME") or (Path.home() / ".dsh" / "douyin-duty"))


async def main() -> None:
    from playwright.async_api import async_playwright

    aid = sys.argv[1]
    text = sys.argv[2]
    out = {"published_xhr": False, "text_seen": False}
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            str(HOME / "browser"), channel="chrome", headless=True,
            locale="zh-CN", viewport={"width": 1440, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()

        async def on_resp(resp):
            if "comment/publish" in resp.url:
                out["published_xhr"] = True
                try:
                    out["payload"] = (await resp.text())[:300]
                except Exception:
                    pass

        page.on("response", on_resp)
        try:
            await page.goto(f"https://www.douyin.com/video/{aid}", wait_until="domcontentloaded", timeout=45000)
            await page.wait_for_timeout(6000)
            ph = page.get_by_text("留下你的精彩评论", exact=False).first
            if await ph.count():
                await ph.click(timeout=4000)
                await page.wait_for_timeout(1200)
            ed = page.locator("div.public-DraftEditor-content").first
            out["editor"] = await ed.count()
            if out["editor"]:
                await ed.click()
                await page.keyboard.type(text, delay=25)
                await page.wait_for_timeout(600)
                out["typed"] = (await ed.inner_text())[:60]
                # 先试 Ctrl+Enter
                await page.keyboard.press("Control+Enter")
                await page.wait_for_timeout(4000)
                if not out["published_xhr"]:
                    await page.keyboard.press("Enter")
                    await page.wait_for_timeout(4000)
            body = await page.inner_text("body")
            out["text_seen"] = text[:16] in body
            out["editor_after"] = (await page.locator("div.public-DraftEditor-content").first.inner_text())[:40] if out["editor"] else ""
        finally:
            await ctx.close()
    print("SEND " + json.dumps(out, ensure_ascii=False)[:900])


if __name__ == "__main__":
    asyncio.run(main())
