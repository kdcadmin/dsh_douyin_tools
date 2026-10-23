"""看抖音创作页上传之后的「声明」区域：按钮叫什么、AI 生成在哪。

跑完会把所有含"声明/AI"的元素打出来，并截一张图。
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

HOME = Path(os.environ.get("DSH_DOUYIN_HOME") or (Path.home() / ".dsh" / "douyin-duty"))
PROFILE = HOME / "browser"
URL = "https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page"
VIDEO = Path(r"D:\jev-decision-kit\jev-takeover.mp4")


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
        await page.wait_for_timeout(5000)
        inp = page.locator("input[type=file]").last
        await inp.set_input_files(str(VIDEO))
        print("uploading…", flush=True)
        # 等上传完成（封面出现 / 出现「发布」可点）
        for i in range(40):
            await page.wait_for_timeout(3000)
            txt = await page.inner_text("body")
            if "作品简介" in txt or "标题" in txt:
                break
        await page.wait_for_timeout(4000)
        info = await page.evaluate(
            """() => {
                const pick = (sel) => Array.from(document.querySelectorAll(sel)).map((e) => ({
                    t: (e.innerText || '').trim().slice(0, 30),
                    c: (e.className || '').toString().slice(0, 70),
                    tag: e.tagName,
                })).filter((x) => x.t);
                const hits = Array.from(document.querySelectorAll('div,span,button,label'))
                    .filter((e) => /声明|AI生成|内容由/.test((e.innerText || '')))
                    .map((e) => ({ t: (e.innerText || '').trim().slice(0, 40), c: (e.className || '').toString().slice(0, 70) }))
                    .filter((x) => x.t.length < 40);
                return { url: location.href, hits: hits.slice(0, 25), buttons: pick('button').slice(0, 25) };
            }"""
        )
        print("DECL " + json.dumps(info, ensure_ascii=False)[:3000])
        await page.screenshot(path=str(HOME / "creator-declare.png"), full_page=False)
        # 试着点「声明」，看弹出什么
        try:
            clicked = False
            for sel in ["text=作品声明", "text=声明", "text=添加声明"]:
                loc = page.locator(sel).first
                if await loc.count():
                    await loc.click(timeout=4000)
                    clicked = True
                    break
            if clicked:
                await page.wait_for_timeout(2500)
                after = await page.evaluate(
                    """() => Array.from(document.querySelectorAll('div,span,button,label'))
                        .filter((e) => /声明|AI|虚构|转载/.test((e.innerText || '')))
                        .map((e) => ({ t: (e.innerText || '').trim().slice(0, 30), c: (e.className||'').toString().slice(0,60) }))
                        .filter((x) => x.t && x.t.length < 30).slice(0, 30)"""
                )
                print("AFTER_CLICK " + json.dumps(after, ensure_ascii=False)[:2000])
                await page.screenshot(path=str(HOME / "creator-declare2.png"))
        except Exception as exc:  # noqa: BLE001
            print("click 声明失败", type(exc).__name__, str(exc)[:120])
        await ctx.close()


if __name__ == "__main__":
    asyncio.run(main())
