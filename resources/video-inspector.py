"""Latent-owned bounded CPU MP4 inspection. No models, subprocesses, network, or writes."""
import json
import math
import os
import sys
from pathlib import Path

MAX_BYTES = 512 * 1024 * 1024
MAX_FRAMES = 400
MAX_SECONDS = 17
MAX_PIXELS = 768 * 1344


def inspect(filename):
    import av
    candidate = Path(filename)
    if not candidate.is_absolute() or candidate.suffix.lower() != ".mp4" or not candidate.is_file():
        raise ValueError("A verified absolute local MP4 is required.")
    if candidate.stat().st_size < 1 or candidate.stat().st_size > MAX_BYTES:
        raise ValueError("The MP4 exceeds the 512 MiB inspection bound.")
    with av.open(str(candidate), mode="r", format="mp4", options={"protocol_whitelist": "file", "enable_drefs": "0", "use_absolute_path": "0"}) as container:
        videos = list(container.streams.video)
        audio_streams = list(container.streams.audio)
        if len(videos) != 1 or len(audio_streams) > 1 or len(container.streams) != len(videos) + len(audio_streams):
            raise ValueError("Inspect one video stream and at most one audio stream, without extra tracks.")
        stream = videos[0]
        stream.codec_context.thread_count = 2
        width, height = stream.codec_context.width, stream.codec_context.height
        if min(width, height) < 1 or max(width, height) > 2048 or width * height > MAX_PIXELS:
            raise ValueError("The video canvas exceeds the reviewed candidate bound.")
        if stream.codec_context.name != "h264":
            raise ValueError("The initial local video route requires H.264 in MP4.")
        fps = stream.average_rate
        if fps is None or not 1 <= float(fps) <= 60:
            raise ValueError("The video frame rate is missing or exceeds the inspection bound.")
        frames = 0
        previous_time = None
        first_time = None
        for frame in container.decode(stream):
            frames += 1
            if frames > MAX_FRAMES or frame.width != width or frame.height != height:
                raise ValueError("The decoded video exceeds frame bounds or changes canvas.")
            current_time = float(frame.pts * frame.time_base) if frame.pts is not None else None
            if current_time is None or not math.isfinite(current_time):
                raise ValueError("Every video frame needs a finite timestamp.")
            if previous_time is not None and abs(current_time - previous_time - 1 / float(fps)) > max(0.0001, float(stream.time_base) * 2):
                raise ValueError("The initial route requires a constant frame-rate video.")
            if first_time is None:
                first_time = current_time
            previous_time = current_time
        duration = frames / float(fps)
        if frames < 1 or duration > MAX_SECONDS:
            raise ValueError("The decoded video duration is outside the inspection bound.")
        declared = float(stream.duration * stream.time_base) if stream.duration is not None else None
        if declared is not None and abs(declared - duration) > 1 / float(fps) + 0.02:
            raise ValueError("The declared video duration differs from decoded frames.")
        video_codec = stream.codec_context.name
        pixel_format = stream.codec_context.format.name
    audio = []
    # A fresh container avoids seek/decoder state ambiguities after counting video frames.
    with av.open(str(candidate), mode="r", format="mp4", options={"protocol_whitelist": "file", "enable_drefs": "0", "use_absolute_path": "0"}) as container:
        for stream in container.streams.audio:
            stream.codec_context.thread_count = 2
            channels = stream.codec_context.channels
            rate = stream.codec_context.sample_rate
            if stream.codec_context.name != "aac" or channels not in (1, 2) or not 8000 <= rate <= 96000:
                raise ValueError("The initial MP4 route supports bounded mono/stereo AAC audio only.")
            samples = 0
            packets = 0
            for frame in container.decode(stream):
                packets += 1
                samples += frame.samples
                if packets > 2000 or samples / rate > MAX_SECONDS + 0.25:
                    raise ValueError("Audio decode exceeded its duration bound.")
            if samples == 0:
                raise ValueError("The declared audio stream contains no decoded samples.")
            declared = float(stream.duration * stream.time_base) if stream.duration is not None else samples / rate
            if not math.isfinite(declared) or declared < 0 or abs(declared - duration) > 0.25:
                raise ValueError("Audio and video durations do not match the initial local profile.")
            audio.append({"codec": "aac", "channels": channels, "sampleRate": rate, "durationSeconds": declared})
    return {"schema": 1, "mimeType": "video/mp4", "width": width, "height": height, "frames": frames,
            "fps": {"numerator": fps.numerator, "denominator": fps.denominator}, "durationSeconds": duration,
            "videoCodec": video_codec, "pixelFormat": pixel_format, "audio": audio,
            "inspection": {"tool": "PyAV", "version": av.__version__, "decodedFrames": frames, "complete": True}}


if __name__ == "__main__":
    try:
        request = sys.stdin.buffer.readline(4097)
        if not request or len(request) > 4096 or sys.stdin.buffer.read(1):
            raise ValueError("One bounded inspection request is required.")
        data = json.loads(request)
        if not isinstance(data, dict) or set(data) != {"filename"} or not isinstance(data["filename"], str):
            raise ValueError("Invalid inspection request.")
        print(json.dumps({"ok": True, "media": inspect(data["filename"])}), flush=True)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)[:1000]}), flush=True)
        sys.exit(1)
