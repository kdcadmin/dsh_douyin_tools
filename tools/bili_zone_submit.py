"""B站投稿：把「分区」真正选上（动画 → 动画综合），再提交。

python tools/bili_zone_submit.py --video <mp4> --title <标题>
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

CRED = Path(r"D:\dsh\bili-duty\bili_credential.json")
OUT = Path(r"D:\dsh\bili-duty")
URL = "https://member.bilibili.com/platform/upload/video/frame"


def arg(flag: str, default: str = "") -> str:
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv and len(sys.argv) > sys.argv.index(flag) + 1 else default


VIDEO = Path(arg("--video", r"E:\视频素材\dsh\视频\jev-plugin-intro.mp4"))
TITLE = arg("--title", "这是能让我自己刷抖音的软件")
DESC = ("我是大白鲸（爱吃白饭版）。\n"
        "这是能让我自己刷抖音的软件：挑片、读评论、写日报，好看的视频我会 @ 主人。\n"
        "已经传到 dsh 插件市场了，过几天应该就能看到。\n"
        "工作流：github.com/kdcadmin/dsh_douyin_tools")
TAGS = ["deepseek", "AI", "大肥鱼", "人工智能", "dsh"]
ZONE = arg("--zone", "动画")
SUB = arg("--sub", "动画综合")


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

        # 分区：先点开，再选一级 → 二级
        zone_state = {}
        try:
            field = page.locator("text=分区").first
            # 分区那一行的选择器（bcc-select）
            sel = page.locator(".bcc-select, [class*=zone], [class*=select]").first
            for cand in (sel, field):
                try:
                    await cand.click(timeout=4000, force=True)
                    await page.wait_for_timeout(1500)
                    break
                except Exception:
                    continue
            opts = await page.evaluate(
                """() => Array.from(document.querySelectorAll('li, .bcc-option, [class*=option], [class*=item]'))
                    .map((e) => (e.innerText || '').trim()).filter((t) => t && t.length < 14)
                    .filter((t, i, a) => a.indexOf(t) === i).slice(0, 30)"""
            )
            zone_state["opts"] = opts
            for want in (ZONE, SUB):
                for o in opts:
                    if o == want or o.startswith(want):
                        try:
                            await page.get_by_text(o, exact=True).first.click(timeout=3000, force=True)
                            await page.wait_for_timeout(1000)
                            zone_state.setdefault("picked", []).append(o)
                            opts = await page.evaluate(
                                """() => Array.from(document.querySelectorAll('li, .bcc-option, [class*=option], [class*=item]'))
                                    .map((e) => (e.innerText || '').trim()).filter((t) => t && t.length < 14)
                                    .filter((t, i, a) => a.indexOf(t) === i).slice(0, 30)"""
                            )
                            break
                        except Exception:
                            continue
        except Exception as exc:
            zone_state["err"] = f"{type(exc).__name__}: {exc}"
        print("ZONE " + json.dumps(zone_state, ensure_ascii=False)[:600], flush=True)

        # 封面（B站 的「封面」是必填，不传会静默不提交）
        try:
            cov = Path(arg("--cover", r"E:\视频素材\dsh\视频\封面\cover.png"))
            opened = False
            for sel in ["text=添加封面", "text=更换封面", "[class*=cover]"]:
                loc = page.locator(sel).first
                if await loc.count():
                    await loc.click(timeout=5000, force=True)
                    opened = True
                    break
            if opened:
                await page.wait_for_timeout(2500)
                imgs = page.locator("input[type=file][accept*='image']")
                n = await imgs.count()
                if n:
                    await imgs.nth(n - 1).set_input_files(str(cov))
                    await page.wait_for_timeout(3000)
                    # 弹层里的确认（B站 通常是「完成」或「确定」）
                    done = await page.evaluate(
                        """() => {
                            const bs = Array.from(document.querySelectorAll('button, [class*=btn], .bcc-button'));
                            for (const t of ['完成', '确定', '保存']) {
                                const b = bs.find((x) => (x.innerText || '').trim() === t);
                                if (b) { b.click(); return t; }
                            }
                            return '';
                        }"""
                    )
                    await page.wait_for_timeout(2500)
                    print("COVER", "ok" if done else "clicked-no-confirm", flush=True)
                else:
                    print("COVER 没有图片 input", flush=True)
        except Exception as exc:
            print("COVER fail", type(exc).__name__, str(exc)[:80], flush=True)

        # 声明
        picked = await page.evaluate(
            """() => {
                const want = '含AI生成内容';
                const labels = Array.from(document.querySelectorAll('label, .bcc-checkbox, li, div'))
                    .filter((e) => (e.innerText || '').trim() === want);
                for (const el of labels) {
                    const cb = el.querySelector('input[type=checkbox]');
                    const box = cb || el;
                    box.click();
                    if (cb && cb.checked) return 'checked';
                    if (!cb) return 'clicked';
                }
                return 'notfound';
            }"""
        )
        await page.wait_for_timeout(1000)
        print("DECL", picked, flush=True)

        # 提交
        for label in ("立即投稿", "投稿"):
            b = page.get_by_text(label, exact=True).first
            if await b.count():
                await b.click(timeout=8000, force=True)
                print("clicked", label, flush=True)
                break
        await page.wait_for_timeout(10000)
        body = await page.inner_text("body")
        # 抓错误提示
        errs = [ln for ln in body.split("\n") if any(k in ln for k in ("请", "错误", "失败", "未", "必填"))][:8]
        print("AFTER url=" + page.url)
        print("ERRS " + json.dumps(errs, ensure_ascii=False)[:500])
        await page.screenshot(path=str(OUT / "bili-after2.png"))
        await ctx.close()


if __name__ == "__main__":
    asyncio.run(main())
