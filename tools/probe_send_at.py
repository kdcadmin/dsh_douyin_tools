"""探针：在**共享的 detached Chrome**（端口 9333）里打开评论框，
把「发送按钮」（图标按钮、没有文字）和「@ 联想面板」的 DOM 结构摸清楚。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

URL = "https://www.douyin.com/video/{aid}"


async def main() -> None:
    from playwright.async_api import async_playwright

    aid = sys.argv[1] if len(sys.argv) > 1 else "7695306080221498643"
    nick = sys.argv[2] if len(sys.argv) > 2 else "月亮硬糖"
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
                await page.wait_for_timeout(1200)
            ed = page.locator("div.public-DraftEditor-content").first
            out["editor"] = await ed.count()
            if not out["editor"]:
                print("DOM " + json.dumps(out, ensure_ascii=False))
                return
            await ed.click()
            await page.keyboard.type("@", delay=40)
            await page.wait_for_timeout(1800)
            # @ 面板：找带名字的候选
            out["picker"] = await page.evaluate(
                """(nick) => {
                    const all = Array.from(document.querySelectorAll('div,li,span'));
                    const hits = all.filter((e) => (e.innerText || '').trim() === nick);
                    const pickerRoot = hits.length ? hits[0].closest('div[class]') : null;
                    return {
                        hits: hits.length,
                        pickerClass: pickerRoot ? (pickerRoot.className || '').slice(0, 80) : '',
                        visibleCandidates: all.filter((e) => {
                            const r = e.getBoundingClientRect();
                            return r.width > 30 && r.height > 30 && r.width < 400 && /^[\\u4e00-\\u9fa5A-Za-z0-9_\\-]{2,16}$/.test((e.innerText||'').trim());
                        }).length,
                    };
                }""",
                nick,
            )
            # 发送按钮：编辑器所在工具条里、最右边、圆形/红色
            out["sendCand"] = await page.evaluate(
                """() => {
                    const ed = document.querySelector('div.public-DraftEditor-content');
                    if (!ed) return [];
                    let box = ed;
                    for (let i = 0; i < 6 && box.parentElement; i++) box = box.parentElement;
                    const r = box.getBoundingClientRect();
                    const nodes = Array.from(box.querySelectorAll('*'));
                    return nodes.map((e) => {
                        const b = e.getBoundingClientRect();
                        const cs = getComputedStyle(e);
                        if (b.width < 18 || b.width > 90 || b.height < 18 || b.height > 90) return null;
                        if (b.left < r.right - 120) return null;
                        return {
                            tag: e.tagName, cls: (e.className || '').toString().slice(0, 50),
                            w: b.width | 0, h: b.height | 0, x: b.x | 0, y: b.y | 0,
                            bg: cs.backgroundColor, radius: cs.borderRadius,
                            txt: (e.innerText || '').trim().slice(0, 8),
                        };
                    }).filter(Boolean).slice(0, 12);
                }"""
            )
        finally:
            try:
                await page.close()
            except Exception:
                pass
            await br.close()
    print("DOM " + json.dumps(out, ensure_ascii=False)[:2200])


if __name__ == "__main__":
    asyncio.run(main())
