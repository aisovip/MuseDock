"""Loopback FireRed AED transcription + same-checkpoint CTC word alignment."""
import argparse
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import sys
import threading
import socket

import numpy as np
import sherpa_onnx
import soundfile as sf
from alignment import CTCAligner, AlignmentError

MODEL_ID = "fireredasr2-aed"
TIMING_SOURCE = "firered_aed_ctc_forced_alignment"
MANIFEST = json.loads(Path(__file__).with_name("models.json").read_text(encoding="utf-8"))
MAX_BYTES = 25 * 1024 * 1024


class Engine:
    def __init__(self, cache, threads):
        aed, ctc = cache / MANIFEST["aed"], cache / MANIFEST["ctc"]
        self.recognizer = sherpa_onnx.OfflineRecognizer.from_fire_red_asr(
            encoder=str(aed / "encoder.int8.onnx"), decoder=str(aed / "decoder.int8.onnx"),
            tokens=str(aed / "tokens.txt"), num_threads=threads, provider="cpu", debug=False)
        self.aligner = CTCAligner(ctc, aed / "tokens.txt", threads)
        self.vad_path = cache / "silero_vad.onnx"
        self.lock = threading.Lock()

    def ranges(self, audio):
        config = sherpa_onnx.VadModelConfig()
        config.silero_vad.model = str(self.vad_path)
        config.silero_vad.min_silence_duration = 0.35
        config.silero_vad.min_speech_duration = 0.20
        config.silero_vad.max_speech_duration = 30
        config.sample_rate = 16000
        config.num_threads = 1
        vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=120)
        detected = []
        def drain():
            while not vad.empty():
                segment = vad.front
                detected.append((int(segment.start), int(segment.start + len(segment.samples))))
                vad.pop()
        window = config.silero_vad.window_size
        for offset in range(0, len(audio), window):
            vad.accept_waveform(np.pad(audio[offset:offset + window], (0, max(0, window - len(audio[offset:offset + window])))))
            drain()
        vad.flush()
        drain()
        padded = []
        for start, end in detected:
            start, end = max(0, start - 2400), min(len(audio), end + 2400)
            if end <= start:
                continue
            if padded and start - padded[-1][1] <= 16000 and end - padded[-1][0] <= 480000:
                padded[-1][1] = max(end, padded[-1][1])
            else:
                if padded and start < padded[-1][1]:
                    midpoint = (start + padded[-1][1]) // 2
                    padded[-1][1], start = midpoint, midpoint
                padded.append([start, end])
        return padded

    def transcribe(self, data):
        audio, rate = sf.read(io.BytesIO(data), dtype="float32")
        if rate != 16000 or audio.ndim != 1 or not len(audio) or not np.all(np.isfinite(audio)):
            raise ValueError("请上传有效的 16kHz 单声道 WAV 音频")
        duration = len(audio) / rate
        sentences, words = [], []
        for start, end in self.ranges(audio):
            stream = self.recognizer.create_stream()
            stream.accept_waveform(rate, audio[start:end])
            self.recognizer.decode_stream(stream)
            text, tokens = stream.result.text.strip(), list(stream.result.tokens)
            if not text:
                raise AlignmentError("检测到人声片段但识别为空，不能交付不完整转写")
            aligned = self.aligner.align(audio[start:end], tokens, start / rate, duration)
            if "".join(item["text"] for item in aligned).replace(" ", "") != text.replace(" ", ""):
                raise AlignmentError("字词时间戳与 AED 识别文本不一致")
            if words and aligned[0]["start"] < words[-1]["end"]:
                raise AlignmentError("相邻音频片段的字词时间戳重叠")
            sentences.append({"text": text, "start": round(aligned[0]["start"] * 1000),
                              "end": round(aligned[-1]["end"] * 1000), "words": aligned})
            words.extend(aligned)
        return {"model": MODEL_ID, "status": "done" if sentences else "no_speech_detected",
                "text": "\n".join(item["text"] for item in sentences), "duration": duration,
                "timing_source": TIMING_SOURCE, "sentence_info": sentences, "words": words,
                "word_timestamp_unit": "seconds", "alignment_frame_ms": 40,
                "low_confidence_word_count": sum(item["confidence"] < 0.1 for item in words)}


def handler_for(engine):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def respond(self, status, payload):
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                self.respond(200, {"status": "ready", "model": MODEL_ID, "timing_source": TIMING_SOURCE,
                                   "word_timestamps": True, "runtime_version": MANIFEST["version"]})
            elif self.path == "/v1/models":
                self.respond(200, {"data": [{"id": MODEL_ID, "object": "model"}]})
            else:
                self.respond(404, {"error": "接口不存在"})

        def do_POST(self):
            if self.path != "/v1/audio/transcriptions":
                self.respond(404, {"error": "接口不存在"})
                return
            if not engine.lock.acquire(blocking=False):
                self.respond(429, {"error": "正在处理另一个转写，请稍后重试"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_BYTES:
                    self.respond(413, {"error": "音频上传大小无效或超过 25 MiB"})
                    return
                content_type = self.headers.get("Content-Type", "")
                if not content_type.startswith("multipart/form-data") or "\r" in content_type or "\n" in content_type:
                    raise ValueError("需要 multipart/form-data 音频请求")
                self.connection.settimeout(60)
                body = self.rfile.read(length)
                if len(body) != length:
                    raise ValueError("音频上传不完整")
                parts = BytesParser(policy=policy.default).parsebytes(
                    ("Content-Type: " + content_type + "\r\nMIME-Version: 1.0\r\n\r\n").encode() + body)
                fields = {part.get_param("name", header="content-disposition"): part.get_payload(decode=True)
                          for part in parts.iter_parts()}
                if fields.get("model", b"").decode() != MODEL_ID or not fields.get("file"):
                    raise ValueError("模型名称或音频文件无效")
                self.respond(200, engine.transcribe(fields["file"]))
            except AlignmentError:
                self.respond(422, {"code": "ASR_ALIGNMENT_FAILED", "error": "声学对齐失败，无法提供可靠的字词时间证据，请保留音频并检查识别结果"})
            except (ValueError, RuntimeError, sf.LibsndfileError):
                self.respond(400, {"error": "音频或识别输入无效，请检查 16kHz 单声道 WAV 文件"})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                self.respond(500, {"error": "本地识别失败，请检查模型环境和内存"})
            finally:
                engine.lock.release()
    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1", choices=("127.0.0.1", "localhost", "::1"))
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--model-cache", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=min(6, os.cpu_count() or 2))
    parser.add_argument("--parent-stdin", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.threads <= 32:
        raise ValueError("线程数需要在 1 到 32 之间")
    if args.parent_stdin:
        threading.Thread(target=lambda: (sys.stdin.buffer.read(), os._exit(0)), daemon=True).start()
    engine = Engine(args.model_cache, args.threads)
    class LocalServer(ThreadingHTTPServer):
        address_family = socket.AF_INET6 if args.host == "::1" else socket.AF_INET
    LocalServer((args.host, args.port), handler_for(engine)).serve_forever()


if __name__ == "__main__":
    main()
