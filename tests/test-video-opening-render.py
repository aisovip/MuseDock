"""Real local FFmpeg verification; distinct pictures prove all cards actually appear."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

import cv2
from PIL import Image

root = Path(__file__).resolve().parent.parent
module_spec = importlib.util.spec_from_file_location("card_stack", root / "server/resources/video-opening/card_stack.py")
renderer = importlib.util.module_from_spec(module_spec)
sys.dont_write_bytecode = True
module_spec.loader.exec_module(renderer)
colors = [(210, 40, 30), (30, 170, 60), (35, 65, 210), (200, 150, 20)]
font = os.environ.get("MUSEDOCK_WHITEBOARD_FONT") or ("C:/Windows/Fonts/msyh.ttc" if os.name == "nt" else "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")
with tempfile.TemporaryDirectory(prefix="musedock-opening-render-") as folder:
    directory = Path(folder)
    images = []
    for index, color in enumerate(colors):
        file = directory / f"image-{index}.png"
        Image.new("RGB", (400, 300), color).save(file)
        images.append(str(file))
    for width, height in [(640, 360), (360, 640), (480, 360)]:
        output = directory / f"opening-{width}.mp4"
        receipt = renderer.main({"canvas": {"width": width, "height": height}, "fps": 30, "frameCount": 60,
                                 "images": images, "question": "同样是数据库，到底应该怎么选？", "font": font,
                                 "ffmpeg": shutil.which("ffmpeg"), "output": str(output), "encoderThreads": 2})
        assert receipt["imageCount"] == 4
        info = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(output)]))
        assert len(info["streams"]) == 1
        assert info["streams"][0]["nb_frames"] == "60"
        cap = cv2.VideoCapture(str(output))
        for index, color in enumerate(colors):
            cap.set(cv2.CAP_PROP_POS_FRAMES, index * 15 + 10)
            success, frame = cap.read()
            assert success
            rgb = frame[round(height * .4), width // 2, ::-1]
            assert max(abs(int(rgb[i]) - color[i]) for i in range(3)) < 15, (index, rgb, color)
        cap.release()
        subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-i", str(output), "-f", "null", "-"], check=True)
        print(f"PASS {width}x{height}: all 4 distinct pictures, exact 60 frames, silent H.264, full decode")
