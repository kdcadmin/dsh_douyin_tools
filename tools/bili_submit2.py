"""B站投稿（带封面，最多两次尝试）：上传 → 封面弹层 → 确认 → 声明 → 投稿 → 报结论。"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

CRED = Path(r"D:\dsh\bili-duty\bili_credential.json")
OUT = Path(r"D:\dsh\bili-duty")
URL = "https://member.bilibili.com/platform/upload/video/frame"
VIDEO = Path(r"E:\视频素材\dsh\视频\jev-plugin-intro.mp4")
COVER = Path(r"E:\视频素材\dsh\视频\封面\cover-4x3.png")  # 直接给 4:3，省掉一次裁剪
TITLE = "这是能让我自己刷抖音的软件"
DESC = ("我是大白鲸（爱吃白饭版）。\n"
        "这是能让我自己刷抖音的软件：挑片、读评论、写日报，好看的视频我会 @ 主人。\n"
        "已经传到 dsh 插件市场了，过几天应该就能看到。\n"
        "工作流：github.com/kdcadmin/dsh_douyin_tools")
TAGS = ["deepseek", "AI", "大肥鱼", "人工智能", "dsh"]


async def main() -> None:
    from playwright.async_api import async_playwright

    raw = json.loads(CRED.read_text(encoding="utf-8"))
    cookies = [{"name": n, "value": str(raw[k]), "domain": ".bilibili.com", "path": "/"}
               for n, k in (("SESSDATA", "sessdata"), ("bili_jct", "bili_jct"), ("buvid3", "buvid3"), ("DedeUserID", "dedeuserid"))
               if raw.get(k)]

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            str(OUT / "bili-browser"), channel="chrome", headless=True, locale="zh-CN",
            viewport={"width": 1440, "height": 1000}, args=["--disable-blink-features=AutomationControlled"])
        await ctx.add_cookies(cookies)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(4000)
        await page.locator("input[type=file]").first.set_input_files(str(VIDEO))
        print("uploading…", flush=True)
        for _ in range(60):
            await page.wait_for_timeout(3000)
            if "请输入稿件标题" in (await page.inner_text("body")):
                break
        await page.wait_for_timeout(4000)

        t = page.locator("input[placeholder='请输入稿件标题']").first
        if await t.count():
            await t.fill(TITLE)
        d = page.locator("textarea").first
        if await d.count():
            await d.fill(DESC)
        tag_in = page.locator("input[placeholder='按回车键Enter创建标签']").first
        if await tag_in.count():
            for tag in TAGS:
                await tag_in.click()
                await tag_in.fill(tag)
                await page.keyboard.press("Enter")
                await page.wait_for_timeout(300)
        print("form filled", flush=True)

        # ── 封面 ──
        try:
            for sel in ["text=添加封面", "text=更换封面"]:
                loc = page.locator(sel).first
                if await loc.count():
                    await loc.click(timeout=5000, force=True)
                    break
            await page.wait_for_timeout(2500)
            imgs = page.locator("input[type=file][accept*='image']")
            n = await imgs.count()
            if n:
                await imgs.nth(n - 1).set_input_files(str(COVER))
                await page.wait_for_timeout(4000)
                dump = await page.evaluate(
                    """() => {
                        const portal = document.querySelector('.bcc-dialog, .bili-dialog, [class*=modal], [class*=dialog]');
                        const btns = Array.from((portal || document).querySelectorAll('button, [class*=btn]'))
                            .map((e) => ({ t: (e.innerText || '').trim().slice(0, 10), c: (e.className || '').toString().slice(0, 40) }))
                            .filter((x) => x.t);
                        const tabs = Array.from((portal || document).querySelectorAll('[class*=tab], li'))
                            .map((e) => (e.innerText || '').trim().slice(0, 12)).filter(Boolean).slice(0, 8);
                        const imgs = Array.from(document.querySelectorAll('img')).length;
                        return { btns: btns.slice(0, 14), tabs, imgs };
                    }"""
                )
                print("COVER_DIALOG " + json.dumps(dump, ensure_ascii=False)[:700], flush=True)
                # B站 封面是两步：裁剪(确定) → 比例确认(再一个确定/确认)。循环点 3 轮。
                for round_i in range(3):
                    clicked = None
                    for tname in ("确定", "确认", "完成", "保存"):
                        hit = await page.evaluate(
                            """(t) => {
                                const bs = Array.from(document.querySelectorAll('button, [class*=btn], .bcc-button'));
                                const b = bs.find((x) => (x.innerText || '').trim() === t && x.getClientRects().length > 0);
                                if (b) { b.click(); return true; }
                                return false;
                            }""", tname)
                        if hit:
                            clicked = tname
                            break
                    print("cover round", round_i, "clicked", clicked, flush=True)
                    if not clicked:
                        break
                    await page.wait_for_timeout(3500)
                    dlg = await page.evaluate(
                        """() => {
                            const vis = Array.from(document.querySelectorAll('button, [class*=btn]'))
                                .filter((e) => e.getClientRects().length > 0)
                                .map((e) => (e.innerText || '').trim()).filter(Boolean);
                            return vis.slice(0, 12);
                        }"""
                    )
                    print("   buttons now:", json.dumps(dlg, ensure_ascii=False)[:200], flush=True)
                await page.screenshot(path=str(OUT / "bili-cover-1.png"))
        except Exception as exc:
            print("COVER fail", type(exc).__name__, str(exc)[:100], flush=True)

        # ── 声明 ──
        decl = await page.evaluate(
            """() => {
                const want = '含AI生成内容';
                const els = Array.from(document.querySelectorAll('label, li, div'))
                    .filter((e) => (e.innerText || '').trim() === want);
                for (const el of els) {
                    const cb = el.querySelector('input[type=checkbox]');
                    (cb || el).click();
                    if (cb) return cb.checked ? 'checked' : 'clicked-unchecked';
                    return 'clicked';
                }
                return 'notfound';
            }"""
        )
        await page.wait_for_timeout(1000)
        print("DECL", decl, flush=True)

        # ── 投稿 ──
        for label in ("立即投稿", "投稿"):
            b = page.get_by_text(label, exact=True).first
            if await b.count():
                await b.click(timeout=8000, force=True)
                print("clicked", label, flush=True)
                break
        await page.wait_for_timeout(12000)
        body = await page.inner_text("body")
        errs = [ln for ln in body.split("\n") if any(k in ln for k in ("请确认", "请填写", "请选择", "必填", "失败", "错误"))][:8]
        ok_mark = any(k in body for k in ("投稿成功", "已提交", "审核", "稿件管理"))
        print("AFTER url=" + page.url)
        print("ERRS " + json.dumps(errs, ensure_ascii=False)[:600])
        print("OK_MARK", ok_mark, flush=True)
        await page.screenshot(path=str(OUT / "bili-after3.png"))
        await ctx.close()


if __name__ == "__main__":
    asyncio.run(main())
