"""探抖音创作页的「封面」上传入口：上传视频 → 点封面 → 看弹层里有什么控件。"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

HOME = Path(os.environ.get("DSH_DOUYIN_HOME") or (Path.home() / ".dsh" / "douyin-duty"))
PROFILE = HOME / "browser"
URL = "https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page"
VIDEO = Path(r"E:\视频素材\dsh\视频\jev-plugin-intro.mp4")


async def main() -> None:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            str(PROFILE), channel="chrome", headless=True, locale="zh-CN",
            viewport={"width": 1440, "height": 1000},
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(4000)
        await page.locator("input[type=file]").first.set_input_files(str(VIDEO))
        print("uploading…", flush=True)
        for _ in range(40):
            await page.wait_for_timeout(3000)
            if "请输入作品标题" in (await page.inner_text("body")) or "作品标题" in (await page.inner_text("body")):
                break
        await page.wait_for_timeout(4000)

        # 找封面区域并点开
        clicked = None
        for sel in ["text=编辑封面", "text=更换封面", "text=添加封面", "[class*=cover]"]:
            loc = page.locator(sel).first
            if await loc.count():
                try:
                    await loc.click(timeout=4000, force=True)
                    clicked = sel
                    break
                except Exception:
                    continue
        print("clicked:", clicked, flush=True)
        await page.wait_for_timeout(2500)
        info = await page.evaluate(
            """() => {
                const txt = (document.body.innerText || '').replace(/\\n+/g, ' | ');
                const files = Array.from(document.querySelectorAll('input[type=file]'))
                    .map((e) => e.accept || '');
                const btns = Array.from(document.querySelectorAll('button, [class*=btn]'))
                    .map((e) => (e.innerText || '').trim().slice(0, 14)).filter(Boolean).slice(0, 30);
                const tabs = Array.from(document.querySelectorAll('[class*=tab], [role=tab]'))
                    .map((e) => (e.innerText || '').trim().slice(0, 14)).filter(Boolean).slice(0, 12);
                return { txt: txt.slice(0, 900), files, btns, tabs };
            }"""
        )
        print("COVER_UI " + json.dumps(info, ensure_ascii=False)[:2200])
        await page.screenshot(path=str(HOME / "cover-dialog.png"))
        await ctx.close()


if __name__ == "__main__":
    asyncio.run(main())
