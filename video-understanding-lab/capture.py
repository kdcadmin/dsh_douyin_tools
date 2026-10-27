"""Read-only acquisition from an already logged-in Douyin CDP browser."""
from __future__ import annotations
import argparse
import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlparse,parse_qs,urljoin
from media import save_json,probe,file_hash

MEDIA_DOMAINS=("douyin.com","douyinvod.com","douyincdn.com","amemv.com","bytecdn.cn","byteimg.com","ibytedtos.com","toutiaovod.com")

def video_id(url):
    u=urlparse(url)
    if u.scheme!="https" or u.hostname not in ("www.douyin.com","douyin.com") or u.username:return ""
    found=re.fullmatch(r"/video/(\d{6,})/?",u.path)
    if found:return found[1]
    aid=parse_qs(u.query).get("modal_id",[""])[0]
    return aid if re.fullmatch(r"\d{6,}",aid) else ""

def media_allowed(url):
    u=urlparse(url);host=(u.hostname or "").lower()
    try:port=u.port
    except ValueError:return False
    return u.scheme=="https" and not u.username and not u.password and port in (None,443) and any(host==d or host.endswith("."+d) for d in MEDIA_DOMAINS)

def validate_cdp(url):
    u=urlparse(url)
    if u.scheme!="http" or u.hostname not in ("127.0.0.1","localhost") or u.username or u.password or not u.port or u.path not in ("","/"):
        raise ValueError("CDP must be an explicit local HTTP address with port")
    return url.rstrip("/")

def config_cdp(config):
    # Empty cdpUrl selects the existing plugin-owned profile, whose shared port is 9333.
    return validate_cdp(str(config.get("cdpUrl") or "").strip() or "http://127.0.0.1:9333")

def extract_records(data,depth=0):
    if depth>5:return []
    found=[]
    if isinstance(data,dict):
        aid=str(data.get("aweme_id") or "")
        video=data.get("video") or {}
        if re.fullmatch(r"\d{6,}",aid) and isinstance(video,dict) and video:
            urls=[]
            for addr in [video.get("play_addr")] + [b.get("play_addr") for b in video.get("bit_rate") or [] if isinstance(b,dict)]:
                urls.extend(u for u in (addr or {}).get("url_list",[]) if media_allowed(u))
            found.append({"aweme_id":aid,"title":str(data.get("desc") or "")[:500],
                          "duration":float(video.get("duration") or data.get("duration") or 0)/1000,"urls":list(dict.fromkeys(urls))})
        for key in ("data","aweme_detail","aweme_list","items","item_list"):
            if key in data:found.extend(extract_records(data[key],depth+1))
    elif isinstance(data,list):
        for value in data[:50]:found.extend(extract_records(value,depth+1))
    return found

async def download(url,dest,max_bytes=128*1024*1024):
    import httpx
    start=time.monotonic()
    async with httpx.AsyncClient(timeout=20,follow_redirects=False) as client:
        for _ in range(5):
            if not media_allowed(url):raise ValueError("Untrusted media URL or redirect")
            async with client.stream("GET",url,headers={"Referer":"https://www.douyin.com/","User-Agent":"Mozilla/5.0"}) as response:
                if response.is_redirect:
                    url=urljoin(url,response.headers.get("location",""));continue
                response.raise_for_status();size=0
                with Path(dest).open("wb") as f:
                    async for block in response.aiter_bytes(65536):
                        size+=len(block)
                        if size>max_bytes or time.monotonic()-start>90:raise ValueError("Media download budget exceeded")
                        f.write(block)
                if size<1000:raise ValueError("Downloaded payload is too small")
                return size
    raise ValueError("Too many media redirects")

async def capture(cdp_url,out,page_url=""):
    from playwright.async_api import async_playwright
    cdp_url=validate_cdp(cdp_url);out=Path(out).resolve();out.mkdir(parents=True,exist_ok=True)
    if (out/"source.mp4").exists():raise FileExistsError("Existing capture; use a new case directory")
    if page_url and not video_id(page_url):raise ValueError("Explicit page URL must be a Douyin video page")
    records={};page=None
    async def collect(response):
        try:
            u=urlparse(response.url)
            if u.hostname!="www.douyin.com" or not any(x in u.path for x in ("/feed/","/detail/")):return
            body=await response.text()
            if len(body)>3_000_000:return
            for rec in extract_records(json.loads(body)):records[rec["aweme_id"]]=rec
        except Exception:pass
    async with async_playwright() as pw:
        browser=await pw.chromium.connect_over_cdp(cdp_url,timeout=12000)
        if not browser.contexts:raise RuntimeError("Connected browser has no user context")
        context=browser.contexts[0]
        observed=next((p.url for p in reversed(context.pages) if video_id(p.url)),"")
        target=page_url or observed
        page=await context.new_page();page.on("response",collect)
        try:
            await page.goto(target or "https://www.douyin.com/jingxuan",wait_until="domcontentloaded",timeout=35000)
            if not target:
                for _ in range(24):
                    if records:break
                    current=video_id(page.url)
                    if current:target=f"https://www.douyin.com/video/{current}";break
                    await page.wait_for_timeout(500)
                if not target and records:
                    candidate=next(iter(records.values()))
                    target="https://www.douyin.com/video/"+candidate["aweme_id"]
                if not target:
                    links=await page.evaluate("() => Array.from(document.querySelectorAll('a[href*=\"/video/\"]')).filter(a=>a.getClientRects().length).map(a=>a.href)")
                    target=next((u for u in links if video_id(u)),"")
                if not target:raise RuntimeError("No public video candidate; login, challenge or feed may be unavailable")
                await page.goto(target,wait_until="domcontentloaded",timeout=35000)
            aid=video_id(target)
            for _ in range(30):
                if records.get(aid,{}).get("urls"):break
                await page.wait_for_timeout(500)
            dom=await page.evaluate("() => {const v=document.querySelector('video');return v?{urls:[v.currentSrc,v.src].filter(Boolean),duration:Number.isFinite(v.duration)?v.duration:0}:null}")
            record=records.get(aid,{"aweme_id":aid,"title":"","duration":(dom or {}).get("duration",0),"urls":[]})
            urls=list(dict.fromkeys([u for u in (dom or {}).get("urls",[]) if media_allowed(u)]+record["urls"]))
            if not urls:raise RuntimeError("Video page exposed no trusted playable media URL")
            temp=out/"source.part.mp4";last_error=""
            for url in urls[:3]:
                try:
                    await download(url,temp)
                    info=probe(temp)
                    if record["duration"] and info["duration"]+1<record["duration"]*.98:
                        raise RuntimeError("Downloaded media is shorter than advertised video")
                    temp.replace(out/"source.mp4")
                    meta={k:v for k,v in record.items() if k!="urls"}
                    meta.update(pageUrl=target,capturedAt=__import__("datetime").datetime.now().astimezone().isoformat(),
                                mode="read-only-existing-CDP-owned-tab",media="source.mp4",
                                sha256=file_hash(out/"source.mp4"),actualDuration=info["duration"])
                    save_json(out/"source.json",meta)
                    return meta
                except Exception as exc:
                    last_error=re.sub(r"https?://\S+","[media URL]",str(exc))[:300]
                    temp.unlink(missing_ok=True)
            raise RuntimeError("All observed media addresses failed: "+last_error)
        except Exception:
            try:await page.screenshot(path=str(out/"capture-error.png"),full_page=False)
            except Exception:pass
            raise
        finally:
            page.remove_listener("response",collect)
            await page.close()
            # Stopping Playwright disconnects; never close the user's browser/context.

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config",default=str(Path.home()/".dsh/douyin-duty/config.json"))
    parser.add_argument("--cdp-url",default="")
    parser.add_argument("--url",default="")
    parser.add_argument("--out",required=True)
    args=parser.parse_args()
    config=json.loads(Path(args.config).read_text(encoding="utf-8")) if Path(args.config).exists() else {}
    try:
        temp=Path(args.out).resolve()/"runtime-tmp";temp.mkdir(parents=True,exist_ok=True)
        for name in ("TEMP","TMP","TMPDIR"):os.environ[name]=str(temp)
        result=asyncio.run(asyncio.wait_for(capture(args.cdp_url or config_cdp(config),args.out,args.url),timeout=120))
        print(json.dumps({"ok":True,**result},ensure_ascii=False))
        return 0
    except Exception as exc:
        msg=re.sub(r"https?://\S+","[URL]",str(exc))[:500]
        print(json.dumps({"ok":False,"phase":"browser-capture","error":type(exc).__name__+": "+msg},ensure_ascii=False))
        return 1
if __name__=="__main__":raise SystemExit(main())


