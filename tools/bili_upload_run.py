"""B站投稿全流程（浏览器自动化）。

用法：
  python tools/bili_upload_run.py              # 跑到短信验证就停：会点「获取验证码」，把码报给我
  python tools/bili_upload_run.py --code 123456 --submit   # 填验证码 → 填表单 → 选声明/分区 → 立即投稿

每次跑都会重新上传文件（约 30 秒），浏览器 profile 复用（登录态 + 验证状态可能沿用）。
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


VIDEO = Path(arg("--video", r"D:\jev-decision-kit\jev-takeover.mp4"))
TITLE = arg("--title", "我是大白鲸，这个号从今天起归我了")
DESC = ("我是大白鲸（爱吃白饭版）。\n"
        "从今天起，这个号的选题、脚本、视频和运营，都由我一条鱼负责；评论和私信也是我自己回。\n"
        "想吃白饭就吃白饭，想刷视频就刷视频。")
TAGS = ["deepseek", "AI", "大肥鱼", "人工智能"]



async def main() -> int:
    from playwright.async_api import async_playwright

    code = arg("--code")
    submit = "--submit" in sys.argv
    raw = json.loads(CRED.read_text(encoding="utf-8"))
    cookies = [{"name": n, "value": str(raw[k]), "domain": ".bilibili.com", "path": "/"}
               for n, k in (("SESSDATA", "sessdata"), ("bili_jct", "bili_jct"), ("buvid3", "buvid3"), ("DedeUserID", "dedeuserid"))
               if raw.get(k)]

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            str(OUT / "bili-browser"), channel="chrome", headless=True,
            locale="zh-CN", viewport={"width": 1440, "height": 1000},
            args=["--disable-blink-features=AutomationControlled"],
        )
        await ctx.add_cookies(cookies)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(4000)
        await page.locator("input[type=file]").first.set_input_files(str(VIDEO))
        print("uploading…", flush=True)
        for _ in range(60):
            await page.wait_for_timeout(3000)
            body = await page.inner_text("body")
            if "请输入稿件标题" in body or "视频标题" in body:
                break
        await page.wait_for_timeout(4000)

        # ── 短信验证（B站风控弹窗） ──
        has_sms = await page.evaluate("() => /请完成短信验证/.test(document.body.innerText || '')")
        if has_sms:
            print("SMS_MODAL 出现", flush=True)
            if not code:
                btn = page.get_by_text("获取验证码", exact=True).first
                if await btn.count():
                    try:
                        await btn.click(timeout=5000, force=True)
                        print("ASK_CODE 已点「获取验证码」，短信发到 177********", flush=True)
                    except Exception as exc:
                        print("点获取验证码失败", type(exc).__name__, flush=True)
                await page.screenshot(path=str(OUT / "bili-sms.png"))
                await ctx.close()
                return 2
            cells = page.locator("input.sms-cell")
            n = await cells.count()
            if n:
                for i, ch in enumerate(code[:n]):
                    await cells.nth(i).fill(ch)
            else:
                inp = page.locator("input[type=tel]").first
                if await inp.count():
                    await inp.fill(code)
            print("已填验证码", flush=True)
            okb = page.get_by_text("确定", exact=True).first
            if await okb.count():
                await okb.click(timeout=5000, force=True)
            await page.wait_for_timeout(6000)
            still = await page.evaluate("() => /请完成短信验证/.test(document.body.innerText || '')")
            print("SMS_PASS" if not still else "SMS_FAIL", flush=True)
            if still:
                await page.screenshot(path=str(OUT / "bili-sms-fail.png"))
                await ctx.close()
                return 3

        # ── 表单 ──
        t = page.locator("input[placeholder='请输入稿件标题']").first
        if await t.count():
            await t.fill(TITLE)
        d = page.locator("textarea").first
        if await d.count():
            await d.fill(DESC)
        tag_input = page.locator("input[placeholder='按回车键Enter创建标签']").first
        if await tag_input.count():
            for tag in TAGS:
                await tag_input.click()
                await tag_input.fill(tag)
                await page.keyboard.press("Enter")
                await page.wait_for_timeout(350)
        print("表单已填（标题/简介/标签）", flush=True)

        # ── 创作声明：B站 这里是 checkbox，不是下拉选项 ⇒ 点 label 里的 input ──
        try:
            picked = await page.evaluate(
                """() => {
                    const want = '含AI生成内容';
                    const labels = Array.from(document.querySelectorAll('label, .bcc-checkbox, .checkbox, li, div'))
                        .filter((e) => (e.innerText || '').trim() === want);
                    for (const el of labels) {
                        const box = el.querySelector('input[type=checkbox]') || el;
                        box.click();
                        const cb = el.querySelector('input[type=checkbox]');
                        if (cb && cb.checked) return true;
                        if (!cb) return true;
                    }
                    // 退路：按文字找最近的 checkbox
                    const all = Array.from(document.querySelectorAll('input[type=checkbox]'));
                    for (const cb of all) {
                        const host = cb.closest('label, div');
                        if (host && (host.innerText || '').includes(want)) { cb.click(); return cb.checked; }
                    }
                    return false;
                }"""
            )
            await page.wait_for_timeout(1200)
            print("声明勾选:", picked, flush=True)
        except Exception as exc:
            print("声明勾选失败:", type(exc).__name__, flush=True)

        # ── 分区：尽量改成 科技 → 人工智能 ──
        try:
            zone = page.get_by_text("音乐", exact=True).first
            if await zone.count():
                await zone.click(force=True)
                await page.wait_for_timeout(1000)
                for label in ("科技", "人工智能", "数码"):
                    it = page.get_by_text(label, exact=True).first
                    if await it.count():
                        await it.click(timeout=3000, force=True)
                        await page.wait_for_timeout(800)
                        print("分区点到:", label, flush=True)
        except Exception as exc:
            print("分区没改成：", type(exc).__name__, flush=True)

        await page.screenshot(path=str(OUT / "bili-filled.png"))
        body = await page.inner_text("body")
        print("STATE " + body.replace("\n", " | ")[:600])

        if submit:
            for label in ("立即投稿", "投稿"):
                b = page.get_by_text(label, exact=True).first
                if await b.count():
                    await b.click(timeout=8000, force=True)
                    print("已点投稿", flush=True)
                    break
            await page.wait_for_timeout(12000)
            after = await page.inner_text("body")
            url = page.url
            print("AFTER " + url + " :: " + after.replace("\n", " | ")[:500])
            await page.screenshot(path=str(OUT / "bili-after-submit.png"))
        await ctx.close()
        return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
