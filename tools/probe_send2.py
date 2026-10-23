"""探针：找「发送」那个红色圆钮（按背景色/类名），以及 @ 面板的可点候选。"""
from __future__ import annotations

import asyncio
import json
import sys

URL = "https://www.douyin.com/video/{aid}"


async def main() -> None:
    from playwright.async_api import async_playwright

    aid = sys.argv[1] if len(sys.argv) > 1 else "7695306080221498643"
    out = {}
    async with async_playwright() as p:
        br = await p.chromium.connect_over_cdp("http://127.0.0.1:9333", timeout=8000)
        ctx = br.contexts[0]
        page = await ctx.new_page()
        try:
            await page.goto(URL.format(aid=aid), wait_until="domcontentloaded", timeout=45000)
            await page.wait_for_timeout(5000)
            ph = page.get_by_text("留下你的精彩评论", exact=False).first
            if await ph.count():
                await ph.click(timeout=4000)
                await page.wait_for_timeout(1000)
            ed = page.locator("div.public-DraftEditor-content").first
            await ed.click()
            await page.keyboard.type("测试", delay=30)
            await page.wait_for_timeout(800)
            out["red"] = await page.evaluate(
                """() => {
                    const out = [];
                    document.querySelectorAll('*').forEach((e) => {
                        const cs = getComputedStyle(e);
                        const b = e.getBoundingClientRect();
                        if (b.width < 16 || b.width > 120 || b.height < 16 || b.height > 120) return;
                        const bg = cs.backgroundColor || '';
                        const m = bg.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
                        const isRed = m && Number(m[1]) > 180 && Number(m[2]) < 110 && Number(m[3]) < 130;
                        const cls = (e.className || '').toString();
                        if (isRed || /send|publish|submit/i.test(cls)) {
                            out.push({ tag: e.tagName, cls: cls.slice(0, 50), bg, x: b.x | 0, y: b.y | 0, w: b.width | 0, h: b.height | 0, txt: (e.innerText || '').trim().slice(0, 6) });
                        }
                    });
                    return out.slice(0, 10);
                }"""
            )
            # @ 面板：在编辑器里打 @ 再看有没有一个「面板根」把若干头像名字包起来
            await page.keyboard.type("@", delay=60)
            await page.wait_for_timeout(2000)
            out["after_at"] = await page.evaluate(
                """() => {
                    const names = Array.from(document.querySelectorAll('div,span'))
                        .map((e) => ({ t: (e.innerText || '').trim(), r: e.getBoundingClientRect() }))
                        .filter((x) => x.r.width > 24 && x.r.width < 200 && x.r.height > 12 && x.r.height < 60
                                 && x.t.length >= 2 && x.t.length <= 16 && !/[\\s]/.test(x.t));
                    return { count: names.length, sample: names.slice(0, 12).map((x) => x.t) };
                }"""
            )
        finally:
            try:
                await page.close()
            except Exception:
                pass
            await br.close()
    print("DOM " + json.dumps(out, ensure_ascii=False)[:1800])


if __name__ == "__main__":
    asyncio.run(main())
