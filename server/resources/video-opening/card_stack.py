"""Portable card-stack opening. JSON in, silent H.264 + a receipt out. No provider calls."""
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import time

from PIL import Image, ImageDraw, ImageFont, ImageOps


def ease(value):
    return 1 - (1 - max(0, min(1, value))) ** 3


def question_layer(question, width, height, region, font_path):
    panel = Image.new("RGB", (width, height - region), "white")
    draw = ImageDraw.Draw(panel)
    size = round(width * .043)
    while True:
        font = ImageFont.truetype(font_path, size)
        lines, line = [], ""
        for char in question.replace("\n", " "):
            if line and draw.textlength(line + char, font=font) > width * .88:
                lines.append(line.strip())
                line = ""
            line += char
        if line.strip():
            lines.append(line.strip())
        line_height = math.ceil(size * 1.45)
        if len(lines) * line_height <= panel.height * .84 or size <= 16:
            break
        size -= 2
    y = (panel.height - line_height * len(lines)) / 2
    for line in lines:
        draw.text((width / 2, y), line, anchor="mt", font=font, fill="#111827")
        y += line_height
    return panel


def main(spec):
    width, height = spec["canvas"]["width"], spec["canvas"]["height"]
    fps, count = spec["fps"], spec["frameCount"]
    paths = [Path(file) for file in spec["images"]]
    if any(not file.is_file() for file in paths):
        raise ValueError("开场图片缺失")
    region = round(height * .80)
    card_width, card_height = round(width * .76), round(region * .88)
    panel = question_layer(spec["question"], width, height, region, spec["font"])
    background = Image.new("RGB", (width, height), "#f6f7f9")
    background.paste(panel, (0, region))
    output = Path(spec["output"])
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [spec["ffmpeg"], "-v", "error", "-n", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}",
               "-r", str(fps), "-i", "pipe:0", "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "18",
               "-threads", str(spec.get("encoderThreads", 2)), "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output)]
    started = time.monotonic()
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=errors,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        active, card, center = -1, None, None
        appearances = []
        try:
            for frame_number in range(count):
                index = min(len(paths) - 1, frame_number * len(paths) // count)
                if index != active:
                    if card is not None:
                        background.paste(card, center, card)
                        background.paste(panel, (0, region))
                    active = index
                    with Image.open(paths[index]) as source:
                        content = ImageOps.contain(source.convert("RGB"), (card_width - 24, card_height - 24), Image.Resampling.LANCZOS)
                    card = Image.new("RGBA", (card_width, card_height), "white")
                    card.paste(content, ((card_width - content.width) // 2, (card_height - content.height) // 2))
                    ImageDraw.Draw(card).rectangle((0, 0, card_width - 1, card_height - 1), outline="#e7e9ee", width=2)
                    card = card.rotate([3.5, -3, 2, -1.5][index % 4], Image.Resampling.BICUBIC, expand=True)
                    center = ((width - card.width) // 2, (region - card.height) // 2)
                    appearances.append({"index": index, "startFrame": frame_number})
                first_frame = math.ceil(index * count / len(paths))
                slot_frames = math.ceil((index + 1) * count / len(paths)) - first_frame
                # Leave at least half of every shot fully visible, even with many images.
                enter_frames = max(1, min(round(fps * .34), slot_frames // 2))
                progress = 1 if index == 0 else ease((frame_number - first_frame + 1) / enter_frames)
                x = round(center[0] + (1 - progress) * width * .8 * (1 if index % 2 else -1))
                frame = background.copy()
                frame.paste(card, (x, center[1]), card)
                frame.paste(panel, (0, region))
                process.stdin.write(frame.tobytes())
                if frame_number % fps == 0 or frame_number == count - 1:
                    print(json.dumps({"type": "render_progress", "phase": "encoding", "writtenFrames": frame_number + 1,
                                      "totalFrames": count, "elapsedMs": round((time.monotonic() - started) * 1000)}), flush=True)
            process.stdin.close()
            if process.wait() != 0:
                raise RuntimeError("encoder failed")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
    return {"success": True, "style": "card-stack-v1", "frameCount": count, "imageCount": len(paths), "appearances": appearances}


if __name__ == "__main__":
    try:
        print(json.dumps(main(json.load(sys.stdin)), ensure_ascii=False), flush=True)
    except Exception:
        print(json.dumps({"success": False, "errorCode": "OPENING_RENDER_FAILED", "message": "提问开场渲染失败，请检查图片、字体和本地媒体环境后重试。"}, ensure_ascii=False), flush=True)
        sys.exit(1)
