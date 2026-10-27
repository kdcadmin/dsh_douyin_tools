"""Timestamped transcript from the full PCM track; not a substitute for hearing sound effects."""
import argparse
import json
import math
import os
import wave
from pathlib import Path
from media import save_json

def segment_result(segments,duration,language):
    if not math.isfinite(duration) or duration<=0:raise ValueError('Invalid audio duration')
    out=[]
    for s in segments:
        start=float(s.start);end=float(s.end)
        if not math.isfinite(start) or not math.isfinite(end) or start<0 or end<start or end>duration+1:raise ValueError("ASR timestamp outside audio")
        text=str(s.text).strip()
        if text:out.append({"id":f"A{len(out):04}","start":round(start,3),"end":round(end,3),"text":text,
                            "avgLogprob":float(s.avg_logprob),"noSpeechProb":float(s.no_speech_prob)})
    return {"schemaVersion":1,"language":language,"audioDuration":duration,"segments":out,
            "text":" ".join(s["text"] for s in out),"rawAudioSemanticsVerified":False,
            "limitations":["Speech transcription may contain recognition errors.",
                           "Music, sound effects and intonation are not established by this transcript."]}

def transcribe(audio,out,model="base",cache=None):
    from faster_whisper import WhisperModel
    import numpy as np
    # 首次允许在线下载模型（走 HF 镜像）；要完全离线再设 DOUYIN_WHISPER_OFFLINE=1
    offline=os.environ.get("DOUYIN_WHISPER_OFFLINE")=="1"
    if offline:os.environ["HF_HUB_OFFLINE"]="1"
    else:os.environ.pop("HF_HUB_OFFLINE",None)
    os.environ.setdefault("HF_ENDPOINT","https://hf-mirror.com")
    if cache:os.environ["HUGGINGFACE_HUB_CACHE"]=str(Path(cache).resolve())
    with wave.open(str(audio),"rb") as wav:
        if (wav.getnchannels(),wav.getframerate(),wav.getsampwidth())!=(1,16000,2):raise ValueError("Expected mono 16kHz PCM16")
        duration=wav.getnframes()/wav.getframerate()
        samples=np.frombuffer(wav.readframes(wav.getnframes()),dtype=np.int16).astype(np.float32)/32768.0
    engine=WhisperModel(model,device="cpu",compute_type="int8",local_files_only=offline,
                        download_root=str(Path(cache).resolve()) if cache else None)
    parts,info=engine.transcribe(samples,language="zh",vad_filter=True,beam_size=5)
    result=segment_result(parts,duration,info.language)
    result["model"]=model
    save_json(out,result)
    packet=Path(out).parent/"packet.json"
    if packet.exists():
        p=json.loads(packet.read_text(encoding="utf-8"));p["transcript"]=Path(out).name
        save_json(packet,p)
    return result

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio");parser.add_argument("--out",required=True)
    parser.add_argument("--model",default="base")
    parser.add_argument("--cache",default=str(Path.home()/".dsh/douyin-duty/models/hub"))
    a=parser.parse_args()
    r=transcribe(a.audio,a.out,a.model,a.cache)
    print(json.dumps({"ok":True,"duration":r["audioDuration"],"segments":len(r["segments"]),
                      "output":a.out,"model":r["model"]},ensure_ascii=False))
if __name__=="__main__":main()

