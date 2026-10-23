"""探针 2：点开评论框之后，编辑器和发送按钮长什么样。"""
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
            out["before_ce"] = await page.eval_on_selector_all("[contenteditable]", "e => e.length")

            # 找「留下你的精彩评论」这类占位入口并点开
            clicked = []
            for label in ("留下你的精彩评论", "写评论", "善语结善缘", "说点什么"):
                try:
                    loc = page.get_by_text(label, exact=False).first
                    if await loc.count() and await loc.is_visible(timeout=800):
                        await loc.click(timeout=4000)
                        clicked.append(label)
                        await page.wait_for_timeout(1200)
                        break
                except Exception:
                    continue
            out["clicked"] = clicked
            out["after_ce"] = await page.eval_on_selector_all(
                "[contenteditable]", "els => els.map(e => (e.className||'').slice(0,50))")
            out["after_textarea"] = await page.eval_on_selector_all(
                "textarea", "els => els.map(e => (e.getAttribute('placeholder')||'') + '|' + (e.className||'').slice(0,30))")
            out["send_btns"] = await page.eval_on_selector_all(
                "button,div[role='button'],[data-e2e]",
                "els => els.map(e => (e.innerText||'').trim()).filter(t => t === '发送' || t === '发布' || t === '评论').slice(0,6)")
            out["e2e_after"] = await page.eval_on_selector_all(
                "[data-e2e]", "els => Array.from(new Set(els.map(e => e.getAttribute('data-e2e')))).filter(n => /comment|send|input|editor/i.test(n))")
            out["body_tail"] = (await page.inner_text("body"))[-400:]
        finally:
            await ctx.close()
    print("DOM2 " + json.dumps(out, ensure_ascii=False)[:2500])


if __name__ == "__main__":
    asyncio.run(main())
