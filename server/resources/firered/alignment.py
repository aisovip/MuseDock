"""CTC Viterbi alignment of FireRed AED tokens to acoustic emissions.

Algorithm: FireRedASR2S models/module/ctc.py and torchaudio forced_align.
Uses the official CTC-only ONNX export of the same FireRedASR2-AED checkpoint.
Never substitutes greedy CTC text, VAD bounds, or proportional word timing.
"""
from pathlib import Path

import numpy as np


class AlignmentError(ValueError):
    pass


def token_table(path):
    result = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        token, number = line.rsplit(" ", 1)
        result[token] = int(number)
    return result


def viterbi_spans(log_probs, target, blank=0):
    """Return target-token frame spans, with start inclusive/end exclusive."""
    probs = np.asarray(log_probs, dtype=np.float64)
    target = np.asarray(target, dtype=np.int64)
    if probs.ndim != 2 or target.ndim != 1 or not len(target):
        raise AlignmentError("CTC 对齐输入为空或维度无效")
    frames, vocabulary = probs.shape
    repeats = int(np.sum(target[1:] == target[:-1]))
    if frames < len(target) + repeats or np.any(target == blank) or np.any(target < 0) or np.any(target >= vocabulary):
        raise AlignmentError("识别 token 无法在有效声学帧中对齐")
    if np.any(np.isnan(probs)) or np.any(np.isposinf(probs)):
        raise AlignmentError("CTC 声学概率无效")
    labels = np.full(2 * len(target) + 1, blank, dtype=np.int64)
    labels[1::2] = target
    states = len(labels)
    skip_allowed = np.zeros(states, dtype=bool)
    skip_allowed[2:] = (labels[2:] != blank) & (labels[2:] != labels[:-2])
    scores = np.full(states, -np.inf)
    scores[:2] = probs[0, labels[:2]]
    back = np.zeros((frames, states), dtype=np.uint8)
    for frame in range(1, frames):
        step_one = np.r_[-np.inf, scores[:-1]]
        step_two = np.r_[-np.inf, -np.inf, scores[:-2]]
        step_two[~skip_allowed] = -np.inf
        candidates = np.stack((scores, step_one, step_two))
        choice = np.argmax(candidates, axis=0)
        scores = np.max(candidates, axis=0) + probs[frame, labels]
        back[frame] = choice
    state = states - 1 if scores[-1] > scores[-2] else states - 2
    if not np.isfinite(scores[state]):
        raise AlignmentError("CTC 没有找到可达的完整对齐路径")
    state_path = np.empty(frames, dtype=np.int32)
    for frame in range(frames - 1, -1, -1):
        state_path[frame] = state
        if frame:
            state -= int(back[frame, state])
    if state_path[0] not in (0, 1):
        raise AlignmentError("CTC 回溯路径无效")
    spans = []
    for index, token in enumerate(target):
        positions = np.flatnonzero(state_path == 2 * index + 1)
        if not len(positions):
            raise AlignmentError("CTC 对齐缺少目标 token")
        confidence = float(np.exp(np.mean(probs[positions, token])))
        spans.append((int(positions[0]), int(positions[-1] + 1), min(1.0, confidence)))
    return spans


def is_cjk(text):
    return any("\u3400" <= char <= "\u9fff" for char in text)


def words_from_tokens(tokens, spans, frame_seconds, offset, duration):
    if len(tokens) != len(spans) or not np.isfinite(frame_seconds) or frame_seconds <= 0 or offset < 0 or not np.isfinite(duration):
        raise AlignmentError("字词对齐数量或音频范围无效")
    words = []
    for token, (first, last, confidence) in zip(tokens, spans):
        # FireRed native convention places the first emission at +1 frame.
        start = offset + (first + 1) * frame_seconds
        end = min(duration, offset + (last + 1) * frame_seconds)
        if not np.isfinite(start) or end <= start:
            raise AlignmentError("字词对齐时间超出音频边界")
        text = token.replace("▁", "")
        if not text:
            continue
        if is_cjk(text) or token.startswith("▁") or not words or is_cjk(words[-1]["text"]):
            words.append({"text": text, "start": round(start, 3), "end": round(end, 3),
                          "confidence": round(confidence, 6)})
        else:
            words[-1]["text"] += text
            words[-1]["end"] = round(end, 3)
            words[-1]["confidence"] = min(words[-1]["confidence"], round(confidence, 6))
    if not words:
        raise AlignmentError("未生成有效的字词对齐证据")
    return words


class CTCAligner:
    def __init__(self, model_dir, aed_token_path, threads=4):
        import onnxruntime as ort
        import kaldi_native_fbank as knf
        self.knf = knf
        model_dir = Path(model_dir)
        self.tokens = token_table(model_dir / "tokens.txt")
        if self.tokens != token_table(aed_token_path) or self.tokens.get("<blank>") != 0:
            raise AlignmentError("AED 和 CTC 模型的 token 表不一致")
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(model_dir / "model.int8.onnx"), sess_options=options,
                                            providers=["CPUExecutionProvider"])
        meta = self.session.get_modelmeta().custom_metadata_map
        if meta.get("model_type") != "fire-red-asr-2-ctc":
            raise AlignmentError("对齐模型类型不符合 FireRed CTC 合同")
        self.mean = np.fromstring(meta["cmvn_mean"], sep=",", dtype=np.float32)
        self.inv_std = np.fromstring(meta["cmvn_inv_stddev"], sep=",", dtype=np.float32)
        if len(self.mean) != 80 or len(self.inv_std) != 80 or not np.all(np.isfinite(self.mean)) or not np.all(np.isfinite(self.inv_std)) or not np.all(self.inv_std > 0):
            raise AlignmentError("CTC 模型的特征归一化参数无效")
        self.frame_seconds = 0.010 * int(meta.get("subsampling_factor", "4"))
        inputs = self.session.get_inputs()
        if len(inputs) != 2 or inputs[0].type != "tensor(float)" or inputs[1].type != "tensor(int64)":
            raise AlignmentError("CTC ONNX 输入合同不兼容")
        self.input_names = [item.name for item in inputs]

    def align(self, audio, tokens, offset=0, duration=None):
        audio = np.asarray(audio, dtype=np.float32)
        if audio.ndim != 1 or len(audio) < 400 or not np.all(np.isfinite(audio)):
            raise AlignmentError("对齐音频无效或过短")
        if not tokens or any(token not in self.tokens or token in ("<blank>", "<unk>", "<pad>", "<sos>", "<eos>") for token in tokens):
            raise AlignmentError("识别结果包含无法声学对齐的 token")
        opts = self.knf.FbankOptions()
        opts.frame_opts.dither = 0
        opts.frame_opts.snip_edges = True
        opts.mel_opts.num_bins = 80
        opts.mel_opts.high_freq = 0
        opts.mel_opts.low_freq = 20
        fbank = self.knf.OnlineFbank(opts)
        fbank.accept_waveform(16000, (audio * 32768).tolist())
        features = np.asarray([fbank.get_frame(i) for i in range(fbank.num_frames_ready)], dtype=np.float32)
        features = (features - self.mean) * self.inv_std
        outputs = self.session.run(None, {self.input_names[0]: features[None],
                                         self.input_names[1]: np.array([len(features)], dtype=np.int64)})
        valid_frames = int(outputs[1][0])
        if valid_frames < 1 or valid_frames > outputs[0].shape[1]:
            raise AlignmentError("CTC 模型返回了无效的声学帧长度")
        probs = outputs[0][0, :valid_frames]
        # Normalize defensively: equivalent for log probabilities, safe for logits.
        probs = probs - np.max(probs, axis=1, keepdims=True)
        probs = probs - np.log(np.sum(np.exp(probs), axis=1, keepdims=True))
        target = [self.tokens[token] for token in tokens]
        spans = viterbi_spans(probs, target)
        local_end = offset + len(audio) / 16000
        return words_from_tokens(tokens, spans, self.frame_seconds, offset,
                                 min(duration, local_end) if duration is not None else local_end)
