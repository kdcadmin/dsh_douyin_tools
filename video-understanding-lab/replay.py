"""Create denser local evidence for an explicit range of an existing source."""
import json
import math
from pathlib import Path
from media import file_hash, prepare, run, save_json, plan_frames

def validate_range(start,end,duration):
    if not all(math.isfinite(t) for t in (start,end,duration)) or start<0 or end<=start or end>duration:
        raise ValueError('Clip must satisfy 0 <= start < end <= source duration')

def clip(case,start,end,out,step=.25):
    case=Path(case).resolve();out=Path(out).resolve()
    packet=json.loads((case/'packet.json').read_text(encoding='utf-8'))
    validate_range(start,end,packet['duration'])
    plan_frames(end-start,step)
    if out.exists():raise FileExistsError('Replay output already exists; choose a new directory')
    if file_hash(packet['source'])!=packet['sourceSha256']:raise ValueError('Source changed since evidence preparation')
    out.mkdir(parents=True)
    video=out/'source.mp4'
    run(['ffmpeg','-v','error','-y','-ss',f'{start:.6f}','-i',packet['source'],'-t',f'{end-start:.6f}',
         '-map','0:v:0','-map','0:a:0?','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',video],timeout=180)
    result=prepare(video,out,step=step)
    parent_offset=packet.get('rootOffsetSeconds',0)+start
    result.update(sourceRange={'start':start,'end':end},parentPacket=str(case/'packet.json'),
                  parentSourceSha256=packet['sourceSha256'],rootOffsetSeconds=parent_offset)
    for frame in result['frames']:
        frame['parentTime']=round(start+frame['time'],4)
        frame['rootTime']=round(parent_offset+frame['time'],4)
    save_json(out/'packet.json',result)
    return result
