// Real local GSAP/Chrome/FFmpeg evidence, with visually distinct source images.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const tools = require('../server/services/creative/whiteboard/mediaTools');
const { openingRecipe } = require('../server/services/creative/shared/videoOpeningRenderer');
const { resolveFfmpegPath, resolveFfprobePath } = require('../server/services/tts/ttsTimeline');

(async () => {
  const parent = path.resolve(__dirname, '../.codex-runtime');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'image-opening-render-test-'));
  const runtime = { ffmpeg: await resolveFfmpegPath(), ffprobe: await resolveFfprobePath(), encoderThreads: 2 };
  const colors = [[210, 40, 30], [30, 170, 60], [35, 65, 210], [200, 150, 20]];
  const images = colors.map((_, i) => path.join(root, `source-${i}.png`));
  await tools.execute(tools.pythonPath(), ['-c',
    'from PIL import Image;import json,sys;[(Image.new("RGB",(400,300),tuple(c)).save(p)) for c,p in zip(json.loads(sys.argv[1]),json.loads(sys.argv[2]))]',
    JSON.stringify(colors), JSON.stringify(images)]);
  const recipe = await openingRecipe(tools.hashFile, 'image-montage');
  assert.equal(recipe.style, 'image-montage-v1');
  assert.notDeepEqual(recipe, await openingRecipe(tools.hashFile, 'question'));
  for (const [width, height] of [[640, 360], [360, 640], [480, 360]]) {
    runtime.recipe = { width, height };
    const output = path.join(root, `opening-${width}.mp4`);
    const progress = [];
    const result = await tools.renderOpening({ images, mode: 'image-montage', output, endMs: 3000 }, runtime,
      { onProgress: value => progress.push(value) });
    assert.equal(result.frameCount, 180);
    assert.equal(result.addedText, false);
    assert.deepEqual(result.visibleImages, [0, 1, 2, 3]);
    assert.equal(progress.at(-1).writtenFrames, 180);
    assert.equal(result.validation.decoded, true);
    const frame = path.join(root, `wall-${width}.png`);
    await tools.extractFrame(output, frame, 2800, runtime);
    await tools.execute(tools.pythonPath(), ['-c',
      'from PIL import Image;import numpy as np,json,sys;a=np.array(Image.open(sys.argv[1]).convert("RGB")).astype(int);counts=[int(np.all(np.abs(a-np.array(c))<20,axis=2).sum()) for c in json.loads(sys.argv[2])];assert min(counts)>500,counts;print(counts)',
      frame, JSON.stringify(colors)]);
    console.log(`PASS ${width}×${height}：真实画面含全部 4 张不同图片，180 帧、无新增文字/音轨、完整解码`);
  }
  // One image and a larger count exercise layouts and compressed montage scheduling.
  for (const count of [1, 128]) {
    runtime.recipe = { width: 480, height: 360 };
    const result = await tools.renderOpening({ images: Array.from({ length: count }, (_, i) => images[i % 4]),
      mode: 'image-montage', output: path.join(root, `count-${count}.mp4`), endMs: 3000 }, runtime);
    assert.equal(result.visibleImages.length, count);
    assert.equal(result.frameCount, 180);
    console.log(`PASS ${count} 张图片动态布局与精确帧数`);
  }
  const controller = new AbortController();
  const output = path.join(root, 'cancelled.mp4');
  await assert.rejects(tools.renderOpening({ images, mode: 'image-montage', output, endMs: 3000 }, runtime,
    { signal: controller.signal, onProgress: () => controller.abort() }), error => error.code === 'MEDIA_CANCELLED');
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('.image-opening-')), false);
  assert.equal(await fs.access(output).then(() => true, () => false), false);
  console.log(`PASS 取消制作及临时帧清理；真实 provider 调用 0。产物：${root}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
