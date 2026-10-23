"""探针：登录后视频页里，评论输入框到底长什么样。"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

HOME = Path(os.environ.get("DSH_DOUYIN_HOME") or (Path.home() / ".dsh" / "douyin-duty"))

URL = "https://www.douyin.com/video/{aid}"


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
            await page.goto(URL.format(aid=aid), wait_until="domcontentloaded", timeout=45000)
            await page.wait_for_timeout(6000)
            await page.mouse.wheel(0, 400)
            await page.wait_for_timeout(1500)
            out["url"] = page.url
            out["e2e"] = await page.eval_on_selector_all(
                "[data-e2e]", "els => Array.from(new Set(els.map(e => e.getAttribute('data-e2e')))).slice(0,60)")
            out["contenteditable"] = await page.eval_on_selector_all(
                "[contenteditable]", "els => els.map(e => (e.getAttribute('class')||'').slice(0,60) + ' | ' + (e.getAttribute('placeholder')||''))")
            out["textareas"] = await page.eval_on_selector_all(
                "textarea", "els => els.map(e => (e.getAttribute('placeholder')||'') + ' | ' + (e.className||'').slice(0,40))")
            out["inputs"] = await page.eval_on_selector_all(
                "input", "els => els.map(e => (e.getAttribute('placeholder')||'') + '|' + (e.type||''))")
            body = await page.inner_text("body")
            out["has_comment_hint"] = any(k in body for k in ("留下你的精彩评论", "写评论", "善语结善缘"))
            out["hint_snippet"] = next((line for line in body.splitlines() if "评论" in line), "")[:80]
        finally:
            await ctx.close()
    print("DOM " + json.dumps(out, ensure_ascii=False)[:2500])


if __name__ == "__main__":
    asyncio.run(main())
