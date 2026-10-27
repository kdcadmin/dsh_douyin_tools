"""Standalone evidence CLI. The model review is performed by the current conversation."""
import argparse
import asyncio
import importlib.util
import json
import os
import shutil
from pathlib import Path
from media import prepare

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest='command',required=True)
    commands.add_parser('doctor',help='Show dependency availability; no model or browser requests')
    p=commands.add_parser('capture',help='Read a public video through the existing CDP browser')
    p.add_argument('--out',required=True);p.add_argument('--url',default='');p.add_argument('--cdp-url',default='')
    p.add_argument('--config',default=str(Path.home()/'.dsh/douyin-duty/config.json'))
    p=commands.add_parser('prepare');p.add_argument('video');p.add_argument('--out',required=True)
    p.add_argument('--step',type=float,default=1);p.add_argument('--max-duration',type=float,default=600)
    p.add_argument('--limit-seconds',type=float,default=0,help='Only analyze the first N seconds (0=full)')
    p=commands.add_parser('asr');p.add_argument('case');p.add_argument('--model',default='base')
    p.add_argument('--cache',default=str(Path.home()/'.dsh/douyin-duty/models/hub'))
    p=commands.add_parser('clip');p.add_argument('case');p.add_argument('--out',required=True)
    p.add_argument('--start',type=float,required=True);p.add_argument('--end',type=float,required=True)
    p.add_argument('--step',type=float,default=.25)
    p=commands.add_parser('record');p.add_argument('case');p.add_argument('review')
    a=parser.parse_args()
    try:
        if a.command=='doctor':
            result={'ffmpeg':shutil.which('ffmpeg'),'ffprobe':shutil.which('ffprobe'),
                    'modules':{name:importlib.util.find_spec(name) is not None for name in ('PIL','playwright','httpx','numpy','faster_whisper')},
                    'modelMode':'current-conversation-review','automaticModelBackend':False}
        elif a.command=='capture':
            from capture import capture,config_cdp
            cfg=Path(a.config);config=json.loads(cfg.read_text(encoding='utf-8')) if cfg.exists() else {}
            temp=Path(a.out).resolve()/'runtime-tmp';temp.mkdir(parents=True,exist_ok=True)
            for name in ('TEMP','TMP','TMPDIR'):os.environ[name]=str(temp)
            result=asyncio.run(asyncio.wait_for(capture(a.cdp_url or config_cdp(config),a.out,a.url),timeout=120))
        elif a.command=='prepare':
            packet=prepare(a.video,a.out,step=a.step,max_duration=a.max_duration,limit=a.limit_seconds)
            result={'duration':packet['duration'],'analysisDuration':packet.get('analysisDuration',packet['duration']),
                    'partial':packet.get('partial',False),'frames':len(packet['frames']),'sheets':len(packet['contactSheets']),
                    'audio':packet['audio'],'packet':str(Path(a.out).resolve()/'packet.json')}
        elif a.command=='asr':
            from asr import transcribe
            case=Path(a.case).resolve();packet=json.loads((case/'packet.json').read_text(encoding='utf-8'))
            if not packet['audio']['available']:raise ValueError('No audio track in this source')
            r=transcribe(case/packet['audio']['path'],case/'transcript.json',a.model,a.cache)
            result={'duration':r['audioDuration'],'segments':len(r['segments']),'output':str(case/'transcript.json')}
        elif a.command=='clip':
            from replay import clip
            r=clip(a.case,a.start,a.end,a.out,step=a.step)
            result={'duration':r['duration'],'frames':len(r['frames']),'range':r['sourceRange'],'packet':str(Path(a.out).resolve()/'packet.json')}
        else:
            from evidence import record_review
            r=record_review(a.case,json.loads(Path(a.review).read_text(encoding='utf-8')))
            result={'reviewStatus':'model-reviewed','evidenceReferencesValid':r['evidenceReferencesValid'],
                    'completeUnderstandingGuaranteed':False,'output':str(Path(a.case).resolve()/'review.json')}
        print(json.dumps({'ok':True,**result},ensure_ascii=False));return 0
    except Exception as exc:
        print(json.dumps({'ok':False,'phase':a.command,'error':type(exc).__name__+': '+str(exc)[:500]},ensure_ascii=False));return 1

if __name__=='__main__':raise SystemExit(main())
