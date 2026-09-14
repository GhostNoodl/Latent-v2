"""Private SAM worker. JSON lines in/out; no listener, shell tools, or automatic downloads."""
import os
import sys
import json
import hashlib
import threading
import time
import io
import base64
import math
from pathlib import Path

ROOT = Path(sys.argv[1]).resolve()
CODE = Path(sys.argv[2]).resolve()
MODEL = Path(sys.argv[3]).resolve()
MODEL_SHA = sys.argv[4]
OWNER = int(sys.argv[5])
THREADS = int(sys.argv[6])
for item in (CODE, MODEL):
    if not item.is_relative_to(ROOT):
        raise RuntimeError("SAM files must remain in the private studio.")
with MODEL.open("rb") as model_file:
    digest = hashlib.file_digest(model_file, "sha256").hexdigest()
if digest != MODEL_SHA:
    raise RuntimeError("SAM weights do not match their pinned identity.")

def emit(value):
    print(json.dumps(value, allow_nan=False, separators=(",", ":")), flush=True)

def watch_owner():
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x00100000, False, OWNER)
        if not handle:
            os._exit(1)
        kernel.WaitForSingleObject(handle, 0xFFFFFFFF)
        kernel.CloseHandle(handle)
        os._exit(0)
    else:
        while True:
            if os.getppid() != OWNER:
                os._exit(0)
            time.sleep(0.5)

if os.name == "nt":
    import ctypes
    from ctypes import wintypes
    mutex_kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    mutex_kernel.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    mutex_kernel.CreateMutexW.restype = wintypes.HANDLE
    mutex = mutex_kernel.CreateMutexW(None, True, "Global\\LatentV2Segmentation-" + hashlib.sha256(os.path.normcase(str(ROOT)).encode()).hexdigest())
    if not mutex:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:
        emit({"type": "fatal", "error": "Another smart-mask worker already owns this studio."})
        sys.exit(12)
threading.Thread(target=watch_owner, daemon=True).start()

# -I excludes the working directory and inherited Python paths. Only this verified code is added.
sys.path.insert(0, str(CODE))
import torch
import numpy as np
from PIL import Image
from segment_anything import SamPredictor, sam_model_registry

torch.set_num_threads(THREADS)
torch.set_num_interop_threads(1)
torch.set_default_device("cpu")
torch.set_grad_enabled(False)
model = sam_model_registry["vit_b"](checkpoint=None)
# Explicit safe tensor-state loading, without a global pickle exception or CUDA placement.
state = torch.load(str(MODEL), map_location="cpu", weights_only=True)
model.load_state_dict(state, strict=True)
del state
model.eval().requires_grad_(False)
predictor = SamPredictor(model)
cached_hash = None
emit({"type": "ready", "device": str(predictor.device), "modelSha256": MODEL_SHA, "pythonVersion": sys.version.split()[0], "torchVersion": torch.__version__, "threads": THREADS})

def coordinate(value, maximum):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 or value >= maximum:
        raise ValueError("Prompt coordinates are outside the normalized source.")
    return float(value)

for line in sys.stdin:
    request_id = None
    try:
        if len(line) > 65536:
            raise ValueError("Segmentation request exceeds its input bound.")
        message = json.loads(line)
        request_id = message["id"]
        source = Path(message["sourcePath"]).resolve()
        if not source.is_relative_to(ROOT / "inputs") or not source.is_file() or source.stat().st_size > 64 * 1024 * 1024:
            raise ValueError("Invalid private source path.")
        payload = source.read_bytes()
        if hashlib.sha256(payload).hexdigest() != message["sourceSha256"]:
            raise ValueError("The source changed before segmentation.")
        with Image.open(io.BytesIO(payload)) as opened:
            width, height = opened.size
            if width != message["width"] or height != message["height"] or width * height > 4194304 or max(width, height) > 8192 or getattr(opened, "n_frames", 1) != 1:
                raise ValueError("Smart masks require one normalized source frame of at most 4 megapixels.")
            image = np.array(opened.convert("RGB"))
        points = message["points"]
        if not isinstance(points, list) or len(points) > 64 or (not points and not message.get("box")):
            raise ValueError("Add up to 64 points or one rectangle.")
        for point in points:
            coordinate(point["x"], width); coordinate(point["y"], height)
            if point["label"] not in (0, 1):
                raise ValueError("Point labels must be foreground or background.")
        box = message.get("box")
        if box:
            coordinate(box["x"], width); coordinate(box["y"], height)
            if box["width"] < 1 or box["height"] < 1 or box["x"] + box["width"] > width or box["y"] + box["height"] > height:
                raise ValueError("The selection rectangle is outside the source.")
        start = time.perf_counter()
        cache_hit = cached_hash == message["sourceSha256"]
        with torch.inference_mode():
            if not cache_hit:
                predictor.set_image(image)
                cached_hash = message["sourceSha256"]
            embedding_ms = (time.perf_counter() - start) * 1000
            prediction_start = time.perf_counter()
            masks, scores, _ = predictor.predict(
                point_coords=np.asarray([[point["x"], point["y"]] for point in points], dtype=np.float32) if points else None,
                point_labels=np.asarray([point["label"] for point in points], dtype=np.int32) if points else None,
                box=np.asarray([box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]], dtype=np.float32) if box else None,
                multimask_output=len(points) == 1 and not box,
            )
        index = int(np.argmax(scores)); mask = masks[index]
        satisfied = all(bool(mask[min(height - 1, int(point["y"])), min(width - 1, int(point["x"]))]) == bool(point["label"]) for point in points)
        output = io.BytesIO()
        Image.fromarray(mask.astype(np.uint8) * 255).save(output, format="PNG")
        emit({"type": "result", "id": request_id, "png": base64.b64encode(output.getvalue()).decode("ascii"), "width": width, "height": height,
              "predictedQuality": float(scores[index]), "selectedPixels": int(mask.sum()), "pointPromptsSatisfied": satisfied,
              "embeddingCacheHit": cache_hit, "embeddingMs": embedding_ms, "inferenceMs": (time.perf_counter() - prediction_start) * 1000})
    except Exception as error:
        emit({"type": "error", "id": request_id, "error": str(error)[:1000]})
