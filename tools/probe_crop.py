"""探「封面裁剪」弹层：上传后把弹层里的按钮/文字/class 全打出来，找「完成」到底在哪。"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

HOME = Path(os.environ.get("DSH_DOUYIN_HOME") or (Path.home() / ".dsh" / "douyin-duty"))
PROFILE = HOME / "browser"
URL = "https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page"
VIDEO = Path(r"E:\视频素材\dsh\视频\jev-plugin-intro.mp4")
COVER = Path(r"E:\视频素材\dsh\视频\封面\cover-3x4.png")


async def main() -> None:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            str(PROFILE), channel="chrome", headless=True, locale="zh-CN",
            viewport={"width": 1440, "height": 1000},
            args=["--disable-blink-features=AutomationControlled"])
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(4000)
        await page.locator("input[type=file]").first.set_input_files(str(VIDEO))
        for _ in range(40):
            await page.wait_for_timeout(3000)
            if "作品描述" in (await page.inner_text("body")):
                break
        await page.wait_for_timeout(3000)
        for sel in ["text=设置封面", "text=选择封面"]:
            loc = page.locator(sel).first
            if await loc.count():
                await loc.click(timeout=5000, force=True)
                break
        await page.wait_for_timeout(2500)
        await page.locator("input[type=file][accept*='image']").last.set_input_files(str(COVER))
        await page.wait_for_timeout(6000)
        info = await page.evaluate(
            """() => {
                const portals = Array.from(document.querySelectorAll('.semi-portal, [role=dialog], .semi-modal-wrap'));
                const out = [];
                for (const portal of portals) {
                    const els = Array.from(portal.querySelectorAll('button, .semi-button, span, div'))
                        .map((e) => ({ tag: e.tagName, cls: (e.className || '').toString().slice(0, 46),
                                       t: (e.innerText || '').trim().slice(0, 12) }))
                        .filter((x) => x.t && x.t.length <= 8);
                    if (els.length) out.push(els.slice(0, 26));
                }
                return out;
            }"""
        )
        print("PORTALS " + json.dumps(info, ensure_ascii=False)[:3000])
        await page.screenshot(path=str(HOME / "crop-dialog.png"))
        await ctx.close()


if __name__ == "__main__":
    asyncio.run(main())
