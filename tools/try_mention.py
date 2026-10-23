"""试一次「@ + 发送」：开评论框 → 打 @ → 等联想面板 → 点人 → 打字 → 点工具条最右边那个图标。

会把结果（有没有面板、点了哪个、有没有 /comment/publish/ 回执）打成 JSON。
用法：python tools/try_mention.py <aweme_id> <昵称前缀> "<正文>"
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

HOME = Path(os.environ.get("DSH_DOUYIN_HOME") or (Path.home() / ".dsh" / "douyin-duty"))
PROFILE = HOME / "browser"


async def main() -> None:
    from playwright.async_api import async_playwright

    aid = sys.argv[1]
    nick = sys.argv[2] if len(sys.argv) > 2 else "月亮"
    body = sys.argv[3] if len(sys.argv) > 3 else "这条评论区比正片有用"
    out = {"picker": None, "picked": None, "sent_xhr": False, "text_seen": False}

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            str(PROFILE), channel="chrome", headless=True,
            locale="zh-CN", viewport={"width": 1440, "height": 900},
            args=["--disable-blink-features=AutomationControlled", f"--remote-debugging-port=9333", "--remote-allow-origins=*"],
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()

        async def on_resp(resp):
            if "comment/publish" in resp.url:
                out["sent_xhr"] = True
                try:
                    out["payload"] = (await resp.text())[:200]
                except Exception:
                    pass

        page.on("response", on_resp)
        try:
            await page.goto(f"https://www.douyin.com/video/{aid}", wait_until="domcontentloaded", timeout=45000)
            await page.wait_for_timeout(6000)
            ph = page.get_by_text("留下你的精彩评论", exact=False).first
            if await ph.count():
                await ph.click(timeout=4000)
                await page.wait_for_timeout(2500)
            ed = page.locator("div.public-DraftEditor-content").first
            out["editor"] = await ed.count()
            if not out["editor"]:
                print("TRY " + json.dumps(out, ensure_ascii=False))
                return
            await ed.click()
            await page.keyboard.type("@" + nick, delay=60)
            await page.wait_for_timeout(2500)

            # 联想面板：找「头像 + 名字」的候选
            out["picker"] = await page.evaluate(
                """(nick) => {
                    const els = Array.from(document.querySelectorAll('div,li,span'));
                    const hits = els.filter((e) => {
                        const t = (e.innerText || '').trim();
                        const r = e.getBoundingClientRect();
                        return t && t.length <= 12 && t.indexOf(nick) >= 0 && r.width > 10 && r.width < 220 && r.height > 10 && r.height < 90;
                    }).map((e) => {
                        const r = e.getBoundingClientRect();
                        return { t: (e.innerText||'').trim(), x: r.x|0, y: r.y|0, w: r.width|0, h: r.height|0 };
                    });
                    return { count: hits.length, items: hits.slice(0, 8) };
                }""",
                nick,
            )
            # 点第一个候选（整行点，不能只点名字）
            picked = None
            rows = [c for c in (out["picker"].get("items") or []) if c["w"] > 150 and c["h"] > 40]
            for cand in rows:
                try:
                    await page.mouse.click(cand["x"] + 8, cand["y"] + cand["h"] / 2)
                    picked = cand["t"]
                    await page.wait_for_timeout(900)
                    break
                except Exception:
                    continue
            out["picked"] = picked
            if not picked:
                # 面板没出来：把 @ 退格掉，按纯文本发
                for _ in range(len(nick) + 1):
                    await page.keyboard.press("Backspace")
                await page.wait_for_timeout(300)

            await page.keyboard.type(body, delay=25)
            await page.wait_for_timeout(600)
            out["typed"] = (await ed.inner_text())[:80]

            # 工具条：取编辑器所在容器里 24~48px 的图标，点**最右边**那个
            btn = await page.evaluate(
                """() => {
                    const ed = document.querySelector('div.public-DraftEditor-content');
                    if (!ed) return null;
                    let box = ed;
                    for (let i = 0; i < 7 && box.parentElement; i++) box = box.parentElement;
                    const nodes = Array.from(box.querySelectorAll('span,button,div'))
                        .map((e) => ({ e, r: e.getBoundingClientRect() }))
                        .filter((x) => x.r.width >= 24 && x.r.width <= 48 && x.r.height >= 24 && x.r.height <= 48);
                    if (!nodes.length) return null;
                    nodes.sort((a, b) => b.r.x - a.r.x);
                    const top = nodes[0].r;
                    return { x: top.x | 0, y: top.y | 0, w: top.width | 0, h: top.height | 0 };
                }"""
            )
            out["btn"] = btn
            if btn:
                await page.mouse.click(btn["x"] + btn["w"] / 2, btn["y"] + btn["h"] / 2)
                await page.wait_for_timeout(3000)
            if not out["sent_xhr"]:
                await page.keyboard.press("Control+Enter")
                await page.wait_for_timeout(2500)
            body_text = await page.inner_text("body")
            out["text_seen"] = ("这条评论区" in body_text) or (nick in body_text)
            out["editor_after"] = (await ed.inner_text())[:60]
        finally:
            await ctx.close()
    print("TRY " + json.dumps(out, ensure_ascii=False)[:1400])


if __name__ == "__main__":
    asyncio.run(main())
