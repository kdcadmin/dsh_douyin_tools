"""删掉重复作品：在作品管理里按标题找到**除最新一条之外**的同标题作品，点删除并确认。

python tools/dedupe_works.py <标题关键字> [要保留几条，默认 1]
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

HOME = Path(os.environ.get("DSH_DOUYIN_HOME") or (Path.home() / ".dsh" / "douyin-duty"))
PROFILE = HOME / "browser"
URL = "https://creator.douyin.com/creator-micro/content/manage"


async def main() -> None:
    from playwright.async_api import async_playwright

    key = sys.argv[1]
    keep = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            str(PROFILE), channel="chrome", headless=True, locale="zh-CN",
            viewport={"width": 1440, "height": 1000},
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(8000)

        # 定位所有「删除作品」按钮，按出现顺序（最新在前）
        btns = page.locator("text=删除作品")
        n = await btns.count()
        print(f"找到 {n} 个删除按钮；保留最新 {keep} 条含「{key}」的作品")
        targets = []
        for i in range(n):
            row = btns.nth(i).locator("xpath=ancestor::div[.//text()[contains(., '" + key + "')]][1]")
            try:
                txt = (await row.inner_text())[:80].replace("\n", " ")
            except Exception:
                continue
            if key in txt:
                targets.append((i, txt))
        print("匹配到", len(targets), "条")
        for i, txt in targets:
            print("  -", txt)
        drop = targets[keep:]
        if not drop:
            print("没有重复，不用删")
            await ctx.close()
            return
        # 从后往前删，避免索引跳动
        for i, txt in reversed(drop):
            btns = page.locator("text=删除作品")
            await btns.nth(i).click(timeout=8000)
            await page.wait_for_timeout(1500)
            for sel in ["button:has-text('确定')", "button:has-text('确认')", "button:has-text('删除')"]:
                b = page.locator(sel).first
                if await b.count():
                    try:
                        await b.click(timeout=4000, force=True)
                        break
                    except Exception:
                        continue
            await page.wait_for_timeout(3000)
            print("已删：", txt[:40])
        await page.reload(wait_until="domcontentloaded")
        await page.wait_for_timeout(6000)
        left = await page.locator("text=删除作品").count()
        body = await page.inner_text("body")
        print(json.dumps({"ok": True, "remaining_works": left, "has_title": key in body}, ensure_ascii=False))
        await ctx.close()


if __name__ == "__main__":
    asyncio.run(main())
