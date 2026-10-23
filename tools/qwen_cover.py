"""qwen-image 2.1 出封面图（试 ModelSamplingAuraFlow + QwenImage21Cache 组合）。

用法：python tools/qwen_cover.py "<prompt>" out.png [组号]
  组：1=AuraFlow(shift3.1)+euler30  2=Cache+euler20  3=AuraFlow+res_multistep8
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

API = "http://127.0.0.1:8188"
OUT_DIR = Path(r"E:\Comfy-Desktop\ComfyUI-Shared\output")
UNET = "qwen_image_2.1_int8_convrot.safetensors"
CLIP = "qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors"
VAE = "qwen_image_2.1_vae_bf16.safetensors"


def build(prompt: str, neg: str, group: int, seed: int) -> dict:
    wf = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": CLIP, "type": "qwen_image"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "4": {"class_type": "TextEncodeQwenImage21", "inputs": {"clip": ["2", 0], "prompt": prompt,
                                                               "negative_prompt": neg, "resolution": 1024}},
        "6": {"class_type": "EmptySD3LatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "cover/q"}},
    }
    if group == 1:
        wf["10"] = {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": 3.1}}
        wf["7"] = {"class_type": "KSampler", "inputs": {"model": ["10", 0], "seed": seed, "steps": 30, "cfg": 3.5,
                                                        "sampler_name": "euler", "scheduler": "simple",
                                                        "positive": ["4", 0], "negative": ["4", 1],
                                                        "latent_image": ["6", 0], "denoise": 1.0}}
    elif group == 2:
        wf["10"] = {"class_type": "QwenImage21Cache", "inputs": {"model": ["1", 0], "device": "cuda", "dtype": "bf16"}}
        wf["7"] = {"class_type": "KSampler", "inputs": {"model": ["10", 0], "seed": seed, "steps": 20, "cfg": 3.0,
                                                        "sampler_name": "euler", "scheduler": "simple",
                                                        "positive": ["4", 0], "negative": ["4", 1],
                                                        "latent_image": ["6", 0], "denoise": 1.0}}
    else:
        wf["10"] = {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": 3.1}}
        wf["7"] = {"class_type": "KSampler", "inputs": {"model": ["10", 0], "seed": seed, "steps": 8, "cfg": 1.0,
                                                        "sampler_name": "res_multistep", "scheduler": "simple",
                                                        "positive": ["4", 0], "negative": ["4", 1],
                                                        "latent_image": ["6", 0], "denoise": 1.0}}
    return wf


def run(wf: dict) -> str:
    req = urllib.request.Request(API + "/prompt", data=json.dumps({"prompt": wf, "client_id": "cover"}).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        pid = json.load(urllib.request.urlopen(req, timeout=30))["prompt_id"]
    except urllib.error.HTTPError as e:
        raise SystemExit("HTTP " + str(e.code) + " " + e.read().decode("utf-8", "ignore")[:400])
    for _ in range(120):
        time.sleep(3)
        h = json.load(urllib.request.urlopen(f"{API}/history/{pid}", timeout=30)).get(pid)
        if not h:
            continue
        st = h.get("status", {})
        if st.get("status_str") == "error":
            raise SystemExit("ERR " + json.dumps(st.get("messages", []), ensure_ascii=False)[:400])
        imgs = (h.get("outputs", {}).get("9", {}) or {}).get("images", [])
        if imgs:
            return imgs[0]["filename"]
    raise SystemExit("timeout")


def main() -> int:
    prompt = sys.argv[1]
    dest = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("cover.png")
    group = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    neg = "noise, abstract, texture, low quality, blurry, watermark, text, deformed hands"
    name = run(build(prompt, neg, group, 20261024))
    src = OUT_DIR / "cover" / name
    if not src.exists():
        src = OUT_DIR / name
    dest.write_bytes(src.read_bytes())
    print("COVER", dest, dest.stat().st_size)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
