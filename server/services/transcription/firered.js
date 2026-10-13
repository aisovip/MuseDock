const { TranscriptionError, transcribeFunasrAudio } = require('./funasr');
const TIMING_SOURCE = 'firered_aed_ctc_forced_alignment';
const canonical = value => String(value || '').replace(/\s/gu, '');

function normalizeFireRed(payload, durationMs, offsetMs = 0) {
  const invalid = message => { throw new TranscriptionError('ASR_TIMESTAMPS_INVALID', message); };
  if (payload?.model !== 'fireredasr2-aed' || payload?.timing_source !== TIMING_SOURCE
    || payload?.word_timestamp_unit !== 'seconds' || !Array.isArray(payload?.sentence_info) || !Array.isArray(payload?.words)) {
    throw new TranscriptionError('ASR_TIMESTAMPS_MISSING', 'FireRed 未返回 AED 文字及 CTC 字词声学对齐证据，请使用项目附带的 FireRed 服务。');
  }
  if (payload.status === 'no_speech_detected' && payload.text === '' && !payload.words.length && !payload.sentence_info.length) return [];
  if (payload.status !== 'done') invalid('FireRed 返回状态与转写证据不一致。');
  if (!payload.sentence_info.length || !payload.words.length || canonical(payload.text) !== canonical(payload.sentence_info.map(cue => cue.text).join(''))) {
    invalid('FireRed 转写文字与句级证据不一致，已保留原始响应。');
  }
  let previousEnd = 0;
  const sentences = payload.sentence_info.map((cue, index) => {
    if (typeof cue.text !== 'string' || !cue.text.trim() || !Array.isArray(cue.words) || !cue.words.length) invalid('FireRed 缺少与字幕文字绑定的字词时间戳。');
    const words = cue.words.map(word => {
      const startMs = Math.round(word.start * 1000), endMs = Math.round(word.end * 1000);
      if (typeof word.start !== 'number' || typeof word.end !== 'number' || typeof word.text !== 'string' || !word.text.trim()
        || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < previousEnd || endMs <= startMs || endMs > durationMs
        || typeof word.confidence !== 'number' || !Number.isFinite(word.confidence) || word.confidence < 0 || word.confidence > 1) {
        invalid('FireRed 字词时间戳无效、重叠或超出音频边界，不能使用估算时间代替。');
      }
      previousEnd = endMs;
      return { text: word.text, startMs: startMs + offsetMs, endMs: endMs + offsetMs, confidence: word.confidence };
    });
    if (canonical(cue.text) !== canonical(words.map(word => word.text).join(''))
      || cue.start !== words[0].startMs - offsetMs || cue.end !== words.at(-1).endMs - offsetMs) invalid('FireRed 句级与字词时间证据不一致。');
    return { index: index + 1, text: cue.text.trim(), startMs: words[0].startMs, endMs: words.at(-1).endMs, words };
  });
  const flattened = payload.sentence_info.flatMap(cue => cue.words);
  const evidenceValues = items => items.map(word => [word.text, word.start, word.end, word.confidence]);
  if (JSON.stringify(evidenceValues(flattened)) !== JSON.stringify(evidenceValues(payload.words))) invalid('FireRed 顶层字词证据与字幕不一致。');
  return sentences;
}

function splitAlignedSentences(sentences) {
  const result = [];
  for (const sentence of sentences) {
    const characters = Array.from(sentence.text);
    const ends = [];
    let cursor = 0;
    for (const word of sentence.words) {
      let remaining = Array.from(canonical(word.text)).length;
      while (remaining > 0 && cursor < characters.length) {
        if (!/\s/u.test(characters[cursor])) remaining -= 1;
        cursor += 1;
      }
      if (remaining) throw new TranscriptionError('ASR_TIMESTAMPS_INVALID', '字幕文字无法映射到已有字词时间证据。');
      ends.push(cursor);
    }
    let first = 0, length = 0;
    const append = last => {
      const words = sentence.words.slice(first, last + 1);
      const text = characters.slice(first ? ends[first - 1] : 0, ends[last]).join('').trim();
      result.push({ index: result.length + 1, sourceSegmentIndex: sentence.index, text, words,
        startMs: words[0].startMs, endMs: words.at(-1).endMs });
    };
    for (let index = 0; index < sentence.words.length; index += 1) {
      const word = sentence.words[index], count = Array.from(canonical(word.text)).length;
      if (index > first && (length + count > 24 || word.endMs - sentence.words[first].startMs > 6500
        || word.startMs - sentence.words[index - 1].endMs >= 450 || /[。！？!?；;]$/u.test(sentence.words[index - 1].text))) {
        append(index - 1); first = index; length = 0;
      }
      length += count;
    }
    append(sentence.words.length - 1);
  }
  return result;
}

async function transcribeFireRedAudio(audioPath, config, options = {}) {
  let result;
  try {
    result = await transcribeFunasrAudio(audioPath, config, { ...options,
      requestTimeoutMs: options.requestTimeoutMs || 1200000,
      serviceLabel: 'FireRed', provider: 'firered', normalizePayload: normalizeFireRed });
  } catch (error) {
    if (error instanceof TranscriptionError) error.message = error.message.replaceAll('FunASR', 'FireRed');
    throw error;
  }
  const sentences = splitAlignedSentences(result.sentences);
  const words = sentences.flatMap(cue => cue.words);
  return { ...result, sentences, words, timingSource: TIMING_SOURCE,
    alignmentFrameMs: 40, lowConfidenceWordCount: words.filter(word => word.confidence < 0.1).length };
}
module.exports = { TIMING_SOURCE, normalizeFireRed, splitAlignedSentences, transcribeFireRedAudio };
