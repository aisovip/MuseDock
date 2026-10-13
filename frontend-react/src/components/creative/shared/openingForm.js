export function validateOpening(value, { allowEmpty = true } = {}) {
  if (!value || value.mode === 'disabled') return '';
  if (value.mode !== 'question') return '请选择直接开始或提问模式。';
  const question = value.question?.trim() || '';
  if (!allowEmpty && !question) return '请填写开场问题后保存。';
  if (question.length > 160 || (question && !/[\p{L}\p{N}]/u.test(question))) return '请填写可朗读的开场问题，最多 160 个字符。';
  return '';
}

export function openingFormValue(artifact) {
  return artifact?.opening ? { mode: 'question', question: artifact.opening.question } : { mode: 'disabled', question: '' };
}
