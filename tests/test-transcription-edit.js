const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const express = require('express');
const { createTranscriptionService } = require('../server/services/transcription/transcriptionTasks');
const { createTranscriptionRouter } = require('../server/routes/transcriptions');
const mediaPipeline = require('../server/services/mediaPipeline');

async function run() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'musedock-transcription-edit-'));
  const words = [{ text: '月光', startMs: 100, endMs: 800 }];
  const sentences = [{ index: 1, startMs: 100, endMs: 800, text: '家向的月光。', words },
    { index: 2, startMs: 950, endMs: 1500, text: '照着小路。' }];
  let asrCalls = 0;
  let downloads = 0;
  let modelCalls = 0;
  let failCorrection = false;
  let noSpeech = false;
  let modelInput;
  const options = {
    rootDir,
    resolveAsrRuntime: async () => ({ configured: true, provider: 'funasr', baseUrl: 'http://localhost:8000/v1', modelId: 'fixture' }),
    ensureFunasrService: async () => {},
    getTextConfig: async () => ({ enabled: true, apiKey: 'fixture-only', baseUrl: 'https://example.invalid/v1', modelId: 'fixture' }),
    resolveSource: async () => ({ aweme_id: '1234567890' }),
    getVideoDetail: async () => ({ success: true, data: { aweme_id: '1234567890', title: '编辑测试', video_download_url: 'https://example.invalid/video' } }),
    mediaPipeline: { getMediaPaths: mediaPipeline.getMediaPaths, prepareDouyinMedia: async (id, _detail, config) => {
      downloads++;
      const media = mediaPipeline.getMediaPaths(id, config.rootDir);
      await fs.mkdir(media.dir, { recursive: true });
      await fs.writeFile(media.video, 'fixture-video');
      await fs.writeFile(media.audio, 'fixture-audio');
      return { steps: { audio: { status: 'done' } } };
    } },
    readAudioDuration: async () => ({ success: true, duration: 1.6 }),
    transcribeAudio: async () => {
      asrCalls++;
      return { success: true, status: noSpeech ? 'no_speech_detected' : 'done',
        text: noSpeech ? '' : '家向的月光。照着小路。', sentences: noSpeech ? [] : sentences,
        words: noSpeech ? [] : words, requestCount: 1, missingRanges: [], timingSource: 'fixture' };
    },
    callTextModel: async config => {
      modelCalls++;
      modelInput = JSON.parse(config.messages[1].content);
      return failCorrection ? { success: false, configured: true } : {
        success: true, text: JSON.stringify({ changes: [{ index: 1, type: 'homophone', text: '家乡的月光。', reason: '测试纠错' }] }),
      };
    },
  };
  const service = createTranscriptionService(options);
  const app = express();
  app.use(express.json());
  app.use('/api/transcriptions', createTranscriptionRouter({ service }));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}/api/transcriptions`;
  const put = (id, payload, headers = {}) => fetch(`${base}/${id}/text`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload),
  });
  const read = async (id, kind) => fs.readFile((await service.file(id, kind)).path, 'utf8');
  const edit = (job, version, texts) => ({ version, texts, updatedAt: job.updatedAt });
  const timing = cues => cues.map(cue => [cue.index, cue.startMs, cue.endMs]);
  async function create(autoCorrect = true) {
    const job = await service.create({ source: 'https://www.douyin.com/video/1234567890', autoCorrect });
    await service.waitForIdle();
    return service.get(job.id);
  }
  try {
    const initial = await create();
    const originalJson = await read(initial.id, 'rawJson');
    const originalSrtFile = (await service.file(initial.id, 'rawSrt')).path;
    const previousCounts = [asrCalls, downloads, modelCalls];
    const body = edit(initial, 'raw', ['故乡的月光。', '照着小路。']);
    assert.equal((await put(initial.id, body, { Origin: 'https://example.invalid' })).status, 403);
    for (const invalid of [{ ...body, version: 'other' }, { ...body, texts: ['少一行'] },
      { ...body, texts: ['', '文字'] }, { ...body, texts: ['文字\n换行', '文字'] },
      { ...body, sentences: [] }, { ...body, texts: ['a'.repeat(10001), '文字'] }]) {
      assert.equal((await put(initial.id, invalid)).status, 400);
    }
    assert.equal((await put(initial.id, { ...body, updatedAt: 'old' })).status, 409);
    const response = await put(initial.id, body);
    assert.equal(response.status, 200);
    const rawEdited = (await response.json()).data;
    assert.equal(rawEdited.result.rawText, '故乡的月光。\n照着小路。');
    assert.equal(rawEdited.result.correctedText, initial.result.correctedText, '两版分别保存');
    assert.equal(rawEdited.files.correctedSrt.sha256, initial.files.correctedSrt.sha256);
    assert.equal(rawEdited.result.rawModifiedAfterCorrection, true);
    assert.notEqual(rawEdited.updatedAt, initial.updatedAt);
    assert.deepEqual(timing(rawEdited.result.sentences), timing(sentences));
    assert.deepEqual(rawEdited.result.words, []);
    assert.equal('words' in rawEdited.result.sentences[0], false, '改字不能继续绑定原字词时间点');
    assert.equal(await read(initial.id, 'rawText'), `${rawEdited.result.rawText}\n`);
    assert.match(await read(initial.id, 'rawSrt'), /00:00:00,100 --> 00:00:00,800\n故乡的月光。/);
    const rawJson = JSON.parse(await read(initial.id, 'rawJson'));
    assert.deepEqual(rawJson.sentences, rawEdited.result.sentences);
    assert.deepEqual(rawJson.words, []);
    assert.equal(rawJson.wordAlignmentValid, false);
    assert.equal(await fs.readFile(path.join(rootDir, initial.id, rawJson.previousRawJson.path), 'utf8'), originalJson);
    assert.match(await fs.readFile(originalSrtFile, 'utf8'), /家向的月光。/, '最初产物保留');
    assert.deepEqual([asrCalls, downloads, modelCalls], previousCounts, '人工保存不调用模型、ASR 或下载');
    assert.equal((await put(initial.id, body)).status, 409, '旧详情不能覆盖新版本');

    const correctedResponse = await put(initial.id, edit(rawEdited, 'corrected', ['家乡的月色。', '照着小路。']));
    assert.equal(correctedResponse.status, 200);
    const corrected = (await correctedResponse.json()).data;
    assert.equal(corrected.result.rawText, rawEdited.result.rawText);
    assert.equal(corrected.files.rawSrt.sha256, rawEdited.files.rawSrt.sha256);
    assert.equal(await read(initial.id, 'correctedText'), '家乡的月色。\n照着小路。\n');
    assert.match(await read(initial.id, 'correctedSrt'), /00:00:00,100 --> 00:00:00,800\n家乡的月色。/);
    assert.deepEqual(timing(corrected.result.correctedSentences), timing(sentences));
    const corrections = JSON.parse(await read(initial.id, 'corrections'));
    assert.equal(corrections.method, 'manual-edit');
    assert.equal(corrections.changes[0].before, initial.result.correctedSentences[0].text);
    assert.equal(corrections.correctedTextSha256, corrected.files.correctedText.sha256);
    assert.equal(corrections.rawTextSha256, rawEdited.files.rawText.sha256);
    assert.deepEqual((await createTranscriptionService(options).get(initial.id)).result, corrected.result, '重启能恢复两版修改');
    assert.deepEqual([asrCalls, downloads, modelCalls], previousCounts);

    const saveRename = fs.rename;
    fs.rename = async (from, to) => {
      if (to === path.join(rootDir, initial.id, 'task.json')) throw new Error('fixture disk failure');
      return saveRename(from, to);
    };
    try {
      await assert.rejects(service.updateText(initial.id, edit(corrected, 'raw', ['不能发布的文字。', '照着小路。'])), error => error.code === 'SAVE_FAILED');
      assert.deepEqual(await service.get(initial.id), corrected, '保存失败不发布内存半成品');
      assert.deepEqual(await createTranscriptionService(options).get(initial.id), corrected, '保存失败不覆盖磁盘版本');
    } finally { fs.rename = saveRename; }

    const write = fs.writeFile;
    let release;
    let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    fs.writeFile = async (file, ...args) => {
      if (String(file).endsWith(`${path.sep}edit.json`)) { entered(); await gate; }
      return write(file, ...args);
    };
    const pending = service.updateText(initial.id, edit(corrected, 'raw', ['故乡的月色。', '照着小路。']));
    await started;
    try {
      await assert.rejects(service.updateText(initial.id, edit(corrected, 'corrected', ['重叠修改。', '照着小路。'])), error => error.code === 'TASK_BUSY');
      await assert.rejects(service.remove(initial.id), error => error.code === 'TASK_BUSY');
      assert.deepEqual(await service.get(initial.id), corrected, '保存中读取仍返回完整的上一版');
    } finally { release(); fs.writeFile = write; }
    await pending;

    const noCorrection = await create(false);
    assert.equal(noCorrection.canCorrect, true, '仅转写完成后允许按需校订');
    await assert.rejects(service.updateText(noCorrection.id, edit(noCorrection, 'corrected', ['文字', '文字'])), error => error.code === 'TEXT_NOT_EDITABLE');
    const tamperedFile = (await service.file(noCorrection.id, 'rawText')).path;
    await fs.writeFile(tamperedFile, '外部篡改');
    await assert.rejects(service.updateText(noCorrection.id, edit(noCorrection, 'raw', ['测试修改', '照着小路。'])), error => error.code === 'ARTIFACT_CHANGED');
    await assert.rejects(service.startCorrection(noCorrection.id), error => error.code === 'ARTIFACT_CHANGED');

    const onDemand = await create(false);
    const onDemandEdited = await service.updateText(onDemand.id, edit(onDemand, 'raw', ['按需校订使用的原文。', '照着小路。']));
    assert.equal((await createTranscriptionService(options).get(onDemand.id)).canCorrect, true, '历史仅转写任务同样可校订');
    const missingText = createTranscriptionService({ ...options, getTextConfig: async () => ({ enabled: false }) });
    await assert.rejects(missingText.startCorrection(onDemand.id), error => error.code === 'TEXT_NOT_CONFIGURED');
    assert.equal((await missingText.get(onDemand.id)).status, 'succeeded', '缺配置不能改变原任务状态');
    assert.equal((await fetch(`${base}/${onDemand.id}/corrections`, { method: 'POST', headers: { Origin: 'https://example.invalid' } })).status, 403);
    failCorrection = true;
    const countsBeforeCorrection = [asrCalls, downloads];
    const firstCorrection = await fetch(`${base}/${onDemand.id}/corrections`, { method: 'POST' });
    assert.equal(firstCorrection.status, 202);
    await service.waitForIdle();
    const onDemandPartial = await service.get(onDemand.id);
    assert.equal(onDemandPartial.status, 'partial');
    assert.equal(onDemandPartial.canRetryCorrection, true);
    assert.equal(onDemandPartial.canCorrect, false);
    assert.equal(onDemandPartial.result.rawText, onDemandEdited.result.rawText);
    assert.equal(modelInput.sentences[0].text, '按需校订使用的原文。');
    failCorrection = false;
    const retryOnDemand = await service.retryCorrection(onDemand.id);
    assert.equal(retryOnDemand.status, 'running');
    await assert.rejects(service.startCorrection(onDemand.id), error => error.status === 409);
    await service.waitForIdle();
    const onDemandDone = await service.get(onDemand.id);
    assert.equal(onDemandDone.status, 'succeeded');
    assert.equal(onDemandDone.autoCorrect, false, '保留新建时的选择');
    assert.equal(onDemandDone.canCorrect, false);
    assert.match(onDemandDone.message, /转写和校订完成/);
    assert.equal(onDemandDone.files.rawJson.sha256, onDemandEdited.files.rawJson.sha256);
    assert.equal(onDemandDone.files.rawSrt.sha256, onDemandEdited.files.rawSrt.sha256);
    assert.deepEqual(timing(onDemandDone.result.correctedSentences), timing(sentences));
    assert.deepEqual([asrCalls, downloads], countsBeforeCorrection, '按需校订和重试均不重新 ASR 或下载');
    await assert.rejects(service.startCorrection(onDemand.id), error => error.code === 'CORRECTION_NOT_AVAILABLE');

    failCorrection = true;
    const partial = await create();
    assert.equal(partial.status, 'partial');
    const partialEdited = await service.updateText(partial.id, edit(partial, 'raw', ['重试要使用的原文。', '照着小路。']));
    failCorrection = false;
    const beforeRetry = [asrCalls, downloads];
    await service.retryCorrection(partial.id);
    await assert.rejects(service.updateText(partial.id, edit(partialEdited, 'raw', ['运行中不能改', '文字'])), error => error.code === 'TASK_BUSY');
    await service.waitForIdle();
    assert.equal(modelInput.sentences[0].text, '重试要使用的原文。', '校订重试读取人工保存后的 rawJson');
    assert.deepEqual([asrCalls, downloads], beforeRetry);
    assert.equal((await service.get(partial.id)).result.rawModifiedAfterCorrection, false);

    noSpeech = true;
    const silent = await create(false);
    assert.equal(silent.canCorrect, false, '没有人声不显示校订入口');
    await assert.rejects(service.startCorrection(silent.id), error => error.code === 'CORRECTION_NOT_AVAILABLE');
    await assert.rejects(service.updateText(silent.id, edit(silent, 'raw', ['不能补造人声'])), error => error.code === 'TEXT_NOT_EDITABLE');
    await service.remove(initial.id);
    await assert.rejects(service.updateText(initial.id, body), error => error.code === 'TASK_NOT_FOUND');
  } finally {
    await new Promise(resolve => server.close(resolve));
    const relative = path.relative(os.tmpdir(), path.resolve(rootDir));
    assert.ok(relative.startsWith('musedock-transcription-edit-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

run().then(() => console.log('转写编辑测试通过：两版持久化、TXT/SRT 一致、时间轴、版本保留、保存失败、冲突与并发保护、校订重试。'))
  .catch(error => { console.error(error); process.exitCode = 1; });
