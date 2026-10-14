export function validateOpening(value, { allowEmpty = true } = {}) {
  if (!value || value.mode === 'disabled') return '';
  if (value.mode === 'image-montage') return '';
  if (value.mode !== 'question') return '请选择直接开始、提问模式或图片汇总。';
  const question = value.question?.trim() || '';
  if (!allowEmpty && !question) return '请填写开场问题后保存。';
  if (question.length > 160 || (question && !/[\p{L}\p{N}]/u.test(question))) return '请填写可朗读的开场问题，最多 160 个字符。';
  return '';
}

export function openingFormValue(artifact) {
  return artifact?.opening ? { mode: artifact.opening.mode, question: artifact.opening.question || '' } : { mode: 'disabled', question: '' };
}

export function openingLabel(opening) {
  return opening?.mode === 'image-montage' ? '图片汇总 · 无新增文字'
    : opening?.mode === 'question' ? '提问模式 · 卡片叠放全部成品图' : '直接开始正文';
}
