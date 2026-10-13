const path = require('path');
const { OPENING_STYLE, validateQuestion } = require('./videoOpening');

const SCRIPT = path.join(__dirname, '../../../resources/video-opening/card_stack.py');

async function openingRecipe(hashFile) {
  return { contract: 'video-opening-v1', style: OPENING_STYLE,
    sources: await Promise.all([__filename, require.resolve('./videoOpening'), SCRIPT].map(hashFile)) };
}

// The caller supplies its local runtime; no whiteboard/task/store dependency here.
async function renderVideoOpening({ images, question, output, canvas, fps, frameCount }, runtime, options = {}) {
  validateQuestion(question);
  if (!Array.isArray(images) || !images.length || images.length > 128
    || !Number.isInteger(frameCount) || frameCount < images.length
    || !Number.isInteger(fps) || fps < 1 || fps > 120
    || ![canvas?.width, canvas?.height].every(n => Number.isInteger(n) && n >= 64 && n <= 4096 && n % 2 === 0)) {
    const error = new Error('提问开场的图片、画幅或时长无效，请增加提问时长或减少图片数量。');
    error.code = 'OPENING_INVALID'; throw error;
  }
  const result = await runtime.execute(runtime.pythonPath, [SCRIPT], { ...options, input: {
    images, question, output, canvas, fps, frameCount, font: runtime.font,
    ffmpeg: runtime.ffmpeg, encoderThreads: runtime.encoderThreads || 2,
  } });
  try {
    const receipt = JSON.parse(result.stdout.trim().split('\n').at(-1));
    if (!receipt.success || receipt.frameCount !== frameCount || receipt.imageCount !== images.length) throw new Error();
    return receipt;
  } catch {
    const error = new Error('提问开场渲染未返回完整结果，请重试本地合成。');
    error.code = 'OPENING_RENDER_FAILED'; throw error;
  }
}

module.exports = { openingRecipe, renderVideoOpening };
