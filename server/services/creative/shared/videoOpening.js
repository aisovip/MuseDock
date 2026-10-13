// Creation-mode-independent contract. Adapters supply text, images and timing.
const OPENING_STYLE = 'card-stack-v1';
const OPENING_CUE_ID = '__opening_question';
const MAX_QUESTION_LENGTH = 160;

class OpeningError extends Error {
  constructor(message) { super(message); this.code = 'INVALID_OPENING'; this.statusCode = 400; }
}

function validateQuestion(value, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new OpeningError('开场问题必须是文本。');
  const question = value.trim();
  if ((!allowEmpty && !question) || question.length > MAX_QUESTION_LENGTH
    || (question && !/[\p{L}\p{N}]/u.test(question))) {
    throw new OpeningError(`请填写可朗读的开场问题，最多 ${MAX_QUESTION_LENGTH} 个字符。`);
  }
  return question;
}

function normalizeOpening(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['mode', 'question'].includes(key))) throw new OpeningError('开场设置格式无效。');
  if (value.mode === 'disabled') return null;
  if (value.mode !== 'question') throw new OpeningError('请选择直接开始或提问模式。');
  return { mode: 'question', question: validateQuestion(value.question ?? '', { allowEmpty: true }) };
}

function openingDurationMs(question, language = 'zh-CN') {
  const units = language === 'zh-CN' ? Array.from(question).length : question.trim().split(/\s+/u).length;
  return Math.max(3000, Math.ceil(units * 1000 / (language === 'zh-CN' ? 4 : 2.5)) + 300);
}

function freezeOpening(question, language) {
  return { mode: 'question', style: OPENING_STYLE, question: validateQuestion(question),
    estimatedDurationMs: openingDurationMs(question, language) };
}

function narrationCues(artifact) {
  return artifact.opening ? [{ id: OPENING_CUE_ID, text: artifact.opening.question }, ...artifact.cues] : artifact.cues;
}

function narrationScenes(artifact) {
  const cueMap = new Map(artifact.cues.map(cue => [cue.id, cue.text]));
  const offset = artifact.opening?.estimatedDurationMs || 0;
  const body = artifact.scenes.map(scene => ({ ...scene, startMs: scene.startMs + offset,
    endMs: scene.endMs + offset, text: scene.cueIds.map(id => cueMap.get(id)).join('\n') }));
  return artifact.opening ? [{ id: OPENING_CUE_ID, cueIds: [OPENING_CUE_ID],
    text: artifact.opening.question, startMs: 0, endMs: offset }, ...body] : body;
}

module.exports = { OPENING_STYLE, OPENING_CUE_ID, MAX_QUESTION_LENGTH, normalizeOpening, validateQuestion,
  openingDurationMs, freezeOpening, narrationCues, narrationScenes };
