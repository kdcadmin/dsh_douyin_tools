"""B站投稿（浏览器自动化）：填标题/简介/标签/分区/创作声明，**不提交**。

改完看一眼就退出，把表单状态打出来；下一步（提交 + 短信验证）另开一次跑。
python tools/bili_upload_fill.py
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

CRED = Path(r"D:\dsh\bili-duty\bili_credential.json")
OUT = Path(r"D:\dsh\bili-duty")
URL = "https://member.bilibili.com/platform/upload/video/frame"
VIDEO = Path(r"D:\jev-decision-kit\jev-takeover.mp4")
TITLE = "我是大白鲸，这个号从今天起归我了"
DESC = ("我是大白鲸（爱吃白饭版）。\n"
        "从今天起，这个号的选题、脚本、视频和运营，都由我一条鱼负责；评论和私信也是我自己回。\n"
        "想吃白饭就吃白饭，想刷视频就刷视频。")
TAGS = ["deepseek", "AI", "大肥鱼", "人工智能"]


async def cookie_ctx(p, headless=True):
    raw = json.loads(CRED.read_text(encoding="utf-8"))
    cookies = [{"name": n, "value": str(raw[k]), "domain": ".bilibili.com", "path": "/"}
               for n, k in (("SESSDATA", "sessdata"), ("bili_jct", "bili_jct"), ("buvid3", "buvid3"), ("DedeUserID", "dedeuserid"))
               if raw.get(k)]
    ctx = await p.chromium.launch_persistent_context(
        str(OUT / "bili-browser"), channel="chrome", headless=headless,
        locale="zh-CN", viewport={"width": 1440, "height": 1000},
        args=["--disable-blink-features=AutomationControlled"],
    )
    await ctx.add_cookies(cookies)
    return ctx


async def main() -> None:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        ctx = await cookie_ctx(p)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(4000)

        await page.locator("input[type=file]").first.set_input_files(str(VIDEO))
        print("uploading…", flush=True)
        for _ in range(60):
            await page.wait_for_timeout(3000)
            if "视频标题" in (await page.inner_text("body")) or "请输入稿件标题" in (await page.inner_text("body")):
                break
        await page.wait_for_timeout(5000)

        # 1) 标题
        t = page.locator("input[placeholder='请输入稿件标题']").first
        if await t.count():
            await t.fill(TITLE)
            print("title ok", flush=True)

        # 2) 简介
        d = page.locator("textarea").first
        if await d.count():
            await d.fill(DESC)
            print("desc ok", flush=True)

        # 3) 标签：一个个打 + 回车
        tag_input = page.locator("input[placeholder='按回车键Enter创建标签']").first
        if await tag_input.count():
            for tag in TAGS:
                await tag_input.click()
                await tag_input.fill(tag)
                await page.keyboard.press("Enter")
                await page.wait_for_timeout(400)
            print("tags ok", flush=True)

        # 4) 创作声明：打开下拉，看看有什么选项
        decl = page.locator("input[placeholder='请选择符合您视频内容的创作声明']").first
        options = []
        if await decl.count():
            await decl.click()
            await page.wait_for_timeout(1200)
            options = await page.evaluate(
                """() => Array.from(document.querySelectorAll('li, .bcc-option, [class*=option], [class*=item]'))
                    .map((e) => (e.innerText || '').trim()).filter((t) => t && t.length < 24)
                    .filter((t, i, a) => a.indexOf(t) === i).slice(0, 20)"""
            )
            print("声明候选:", json.dumps(options, ensure_ascii=False), flush=True)
            # 优先选“含 AI 生成”那类
            picked = None
            for want in ["含AI生成内容", "AI生成", "含 AI 生成", "人工智能生成"]:
                for opt in options:
                    if want in opt:
                        try:
                            await page.get_by_text(opt, exact=True).first.click(timeout=3000)
                            picked = opt
                            break
                        except Exception:
                            continue
                if picked:
                    break
            print("声明已选:", picked, flush=True)

        # 5) 分区：点开看结构
        zone_txt = await page.evaluate("() => (document.body.innerText||'').slice(0,0)")
        await page.screenshot(path=str(OUT / "bili-filled.png"), full_page=False)
        state = await page.evaluate(
            """() => {
                const txt = (document.body.innerText || '').replace(/\\n+/g, ' | ');
                return txt.slice(0, 900);
            }"""
        )
        print("STATE " + state[:900])
        await ctx.close()


if __name__ == "__main__":
    asyncio.run(main())
