"""One-shot private CPU face detection. No networking, downloads, or image writes."""
import os
import sys
import json
import hashlib
import threading
import time
import math
from pathlib import Path

ROOT = Path(sys.argv[1]).resolve()
VENDOR = Path(sys.argv[2]).resolve()
MODEL = Path(sys.argv[3]).resolve()
MODEL_SHA = sys.argv[4]
OWNER = int(sys.argv[5])


def checked_path(filename):
    given = Path(filename)
    if not given.is_absolute() or ".." in given.parts:
        raise RuntimeError("Face detector paths must be absolute private paths.")
    cursor = given
    while cursor != cursor.parent:
        if cursor.is_symlink() or cursor.is_junction():
            raise RuntimeError("Face detector paths cannot contain links or junctions.")
        cursor = cursor.parent
    resolved = given.resolve(strict=True)
    if not resolved.is_relative_to(ROOT):
        raise RuntimeError("Face detector files must stay in this studio.")
    return resolved


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


def main():
    threading.Thread(target=watch_owner, daemon=True).start()
    checked_path(VENDOR)
    checked_path(MODEL)
    with MODEL.open("rb") as model_file:
        if hashlib.file_digest(model_file, "sha256").hexdigest() != MODEL_SHA:
            raise RuntimeError("The detector model differs from its pinned identity.")
    # Isolated mode ignores inherited PYTHONPATH. Only the verified vendor is added.
    sys.path.insert(0, str(VENDOR))
    import cv2 as cv
    import numpy as np
    if cv.__version__ != "4.13.0" or not Path(cv.__file__).resolve().is_relative_to(VENDOR):
        raise RuntimeError("The private detector imported an unexpected OpenCV build.")
    cv.setNumThreads(2)
    cv.ocl.setUseOpenCL(False)
    request_bytes = sys.stdin.buffer.readline(16385)
    if len(request_bytes) > 16384:
        raise RuntimeError("The detector request exceeds its limit.")
    request = json.loads(request_bytes)
    source = checked_path(request["filename"])
    if not source.is_relative_to(ROOT / "inputs") or source.stat().st_size > 64 * 1024 * 1024:
        raise RuntimeError("The source must be a bounded private input image.")
    content = source.read_bytes()
    if hashlib.sha256(content).hexdigest() != request["sha256"]:
        raise RuntimeError("The source changed before face detection.")
    width, height = request["width"], request["height"]
    if not isinstance(width, int) or not isinstance(height, int) or min(width, height) < 1 or max(width, height) > 8192 or width * height > 4194304:
        raise RuntimeError("The source exceeds the initial 4 megapixel face profile.")
    image = cv.imdecode(np.frombuffer(content, dtype=np.uint8), cv.IMREAD_COLOR)
    if image is None or image.shape[:2] != (height, width):
        raise RuntimeError("The source dimensions do not match the saved image.")
    profile = request["profile"]
    if profile not in ("anime", "photographic"):
        raise RuntimeError("Unknown face detector profile.")
    confidence = request["confidence"]
    if not isinstance(confidence, (float, int)) or not math.isfinite(confidence) or not 0.1 <= confidence <= 0.99:
        raise RuntimeError("Invalid face detection threshold.")
    frames = []
    for side in ([640] if profile == "anime" else [320, 640]):
        scale = min(1, side / max(width, height))
        frame = {"width": max(1, math.floor(width * scale + 0.5)), "height": max(1, math.floor(height * scale + 0.5))}
        if frame not in frames:
            frames.append(frame)
    started = time.monotonic()
    candidates = []
    if profile == "anime":
        detector = cv.CascadeClassifier(str(MODEL))
        if detector.empty():
            raise RuntimeError("The anime cascade could not be loaded.")
    else:
        detector = cv.FaceDetectorYN.create(str(MODEL), "", (320, 320), float(confidence), 0.3, 5000, cv.dnn.DNN_BACKEND_OPENCV, cv.dnn.DNN_TARGET_CPU)
    for frame_index, frame in enumerate(frames):
        size = (frame["width"], frame["height"])
        resized = image if size == (width, height) else cv.resize(image, size, interpolation=cv.INTER_AREA)
        if profile == "anime":
            gray = cv.equalizeHist(cv.cvtColor(resized, cv.COLOR_BGR2GRAY))
            boxes = detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(24, 24))
            for x, y, w, h in boxes:
                candidates.append({"frame": frame_index, "box": {"x": int(x), "y": int(y), "width": int(w), "height": int(h)}})
        else:
            detector.setInputSize(size)
            _, faces = detector.detect(resized)
            for face in ([] if faces is None else faces):
                values = list(map(float, face))
                if len(values) != 15 or not all(map(math.isfinite, values)):
                    raise RuntimeError("YuNet returned invalid coordinates.")
                x, y, w, h = values[:4]
                candidates.append({"frame": frame_index, "box": {"x": x, "y": y, "width": w, "height": h}, "score": values[14], "landmarks": [{"x": values[i], "y": values[i + 1]} for i in range(4, 14, 2)]})
    candidates.sort(key=lambda face: (-face.get("score", 0), -(face["box"]["width"] * face["box"]["height"] / (frames[face["frame"]]["width"] * frames[face["frame"]]["height"])), face["box"]["y"], face["box"]["x"]))
    result = {"opencv": cv.__version__, "width": width, "height": height, "frames": frames, "candidates": candidates[:128], "candidateCount": len(candidates), "durationMs": (time.monotonic() - started) * 1000}
    print(json.dumps(result, allow_nan=False, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        sys.exit(1)
