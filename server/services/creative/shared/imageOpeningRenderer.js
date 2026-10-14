const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright-core');
const { imageOpeningComposition } = require('./imageOpeningComposition');

function renderError(code, message) { return Object.assign(new Error(message), { code }); }

async function launchOpeningBrowser(options = {}) {
  return chromium.launch({ headless: true, channel: 'chrome', timeout: 30000,
    ...(options.browserExecutablePath ? { executablePath: options.browserExecutablePath, channel: undefined } : {}) });
}

async function renderImageOpening({ images, output, canvas, fps, frameCount }, runtime, options = {}) {
  if (frameCount !== fps * 3) throw renderError('OPENING_INVALID', '图片汇总开头必须为 3 秒。');
  const signal = options.signal;
  const controller = new AbortController();
  let stopped = null;
  let browser;
  let timer;
  let directory;
  const stop = error => { stopped ||= error; controller.abort(); if (browser) void browser.close().catch(() => {}); };
  const abort = () => stop(renderError('MEDIA_CANCELLED', '图片汇总开头制作已取消。'));
  const check = () => { if (stopped) throw stopped; };
  if (signal?.aborted) { abort(); check(); }
  signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => stop(renderError('MEDIA_TIMEOUT', '图片汇总开头制作超时，请检查本地浏览器与磁盘后重试。')), options.timeoutMs || 300000);
  try {
    directory = await fs.mkdtemp(path.join(path.dirname(output), '.image-opening-'));
    browser = await launchOpeningBrowser(options);
    check();
    const page = await browser.newPage({ viewport: canvas, deviceScaleFactor: 1 });
    const requests = new Set();
    // Only allow this composition's explicitly supplied local assets; no network traffic.
    await page.route('**/*', async route => {
      const match = /^https:\/\/opening\.invalid\/image\/(\d+)$/.exec(route.request().url());
      const index = match ? Number(match[1]) : -1;
      if (index < 0 || index >= images.length) return route.abort();
      requests.add(index);
      await route.fulfill({ body: await fs.readFile(images[index]), contentType: 'image/png' });
    });
    const composition = imageOpeningComposition({ count: images.length, canvas, fps });
    await page.setContent(composition.html, { waitUntil: 'load', timeout: 30000 });
    await page.addScriptTag({ path: require.resolve('gsap/dist/gsap.min.js') });
    await page.addScriptTag({ content: composition.script });
    await page.evaluate(async () => { await Promise.all([...document.images].map(image => image.decode())); });
    const text = await page.evaluate(() => document.body.innerText.trim());
    if (text || requests.size !== images.length) throw renderError('OPENING_RENDER_FAILED', '图片汇总开头存在额外文字或缺失图片。');
    const started = Date.now();
    for (let frame = 0; frame < frameCount; frame += 1) {
      check();
      await page.evaluate(t => { window.__mpSetTimelineTime(t); }, frame / fps);
      await page.screenshot({ path: path.join(directory, `frame-${String(frame).padStart(4, '0')}.png`), timeout: 15000 });
      if (frame % fps === 0 || frame === frameCount - 1) await options.onProgress?.({ type: 'render_progress', phase: 'rendering',
        writtenFrames: frame + 1, totalFrames: frameCount, elapsedMs: Date.now() - started });
    }
    await page.evaluate(() => { window.__mpSetTimelineTime(2.8); });
    const visibleImages = await page.evaluate(() => [...document.querySelectorAll('.tile')].filter(tile => {
      const rect = tile.getBoundingClientRect();
      return Number(getComputedStyle(tile).opacity) === 1 && rect.width > 0 && rect.height > 0;
    }).map(tile => Number(tile.dataset.imageIndex)));
    if (visibleImages.length !== images.length) throw renderError('OPENING_RENDER_FAILED', '图片墙没有完整展示全部成品图。');
    check();
    await runtime.execute(runtime.ffmpeg, ['-v', 'error', '-n', '-framerate', String(fps), '-i', path.join(directory, 'frame-%04d.png'),
      '-frames:v', String(frameCount), '-an', '-c:v', 'libx264', '-preset', 'fast', '-threads', String(runtime.encoderThreads || 2),
      '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], { ...options, signal: controller.signal });
    check();
    return { success: true, frameCount, fps, imageCount: images.length, durationMs: 3000, addedText: false,
      columns: composition.columns, rows: composition.rows, rapidShotCount: composition.shotCount, visibleImages };
  } catch (error) {
    if (stopped) throw stopped;
    if (error.code) throw error;
    throw renderError('OPENING_RENDER_FAILED', '图片汇总开头制作失败，请检查本地 Chrome、成品图片和磁盘空间后重试。');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (browser) await browser.close().catch(() => {});
    // mkdtemp is the sole creator of this exact temporary directory.
    if (directory && path.dirname(path.resolve(directory)) === path.resolve(path.dirname(output))
      && path.basename(directory).startsWith('.image-opening-')) await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { renderImageOpening, launchOpeningBrowser };
