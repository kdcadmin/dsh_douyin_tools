"""Validate model evidence references without pretending to score semantic truth."""
from pathlib import Path
import json
import math
from media import save_json,file_hash

def validate_review(packet,review,transcript=None):
    if not isinstance(review.get("model"),str) or not review["model"].strip():raise ValueError("Model identity required")
    if not isinstance(review.get("summary"),str) or not review["summary"].strip():raise ValueError("Summary required")
    if set(review.get("inspectedContactSheets",[]))!=set(packet["contactSheets"]):raise ValueError("Every full-timeline contact sheet must be inspected")
    frames={f["id"] for f in packet["frames"]}
    audio={s["id"] for s in (transcript or {}).get("segments",[])}
    if not review.get("timeline") or not review.get("questions"):raise ValueError("Timeline and grounded question answers required")
    for item in [*review["timeline"],*review["questions"]]:
        fids=item.get("frameIds",[]);aids=item.get("audioIds",[])
        if not fids and not aids:raise ValueError("Each observation/answer needs evidence references")
        if not set(fids)<=frames:raise ValueError("Unknown frame reference")
        if not set(aids)<=audio:raise ValueError("Unknown transcript reference")
        if "start" in item or "end" in item:
            start=float(item.get("start",0));end=float(item.get("end",start))
            if not math.isfinite(start) or not math.isfinite(end) or start<0 or end<start or end>packet["duration"]:
                raise ValueError("Claim time outside video")
    if not isinstance(review.get("rawAudioListened"),bool):raise ValueError("Raw audio listening status required")
    if not isinstance(review.get("uncertainties"),list):raise ValueError("Uncertainty list required")
    return {**review,"evidenceReferencesValid":True,"completeUnderstandingGuaranteed":False,
            "reviewMode":"current-conversation-review","videoDuration":packet["duration"]}

def record_review(case,review):
    case=Path(case).resolve();packet=json.loads((case/"packet.json").read_text(encoding="utf-8"))
    if file_hash(packet["source"])!=packet["sourceSha256"]:raise ValueError("Source video changed after evidence generation")
    for f in packet["frames"]:
        if not (case/f["path"]).is_file():raise ValueError("Missing evidence image")
    transcript=None
    if packet.get("transcript"):transcript=json.loads((case/packet["transcript"]).read_text(encoding="utf-8"))
    result=validate_review(packet,review,transcript)
    save_json(case/"review.json",result)
    packet["reviewStatus"]="model-reviewed"
    packet["reviewFile"]="review.json"
    # A self-report is not a human ground-truth acceptance test.
    packet["understandingVerified"]=False
    save_json(case/"packet.json",packet)
    return result

