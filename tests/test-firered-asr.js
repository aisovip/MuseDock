const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const configService = require('../server/services/ai/aiModelConfig');
const pipeline = require('../server/services/mediaPipeline');
const { normalizeFireRed, splitAlignedSentences, transcribeFireRedAudio, TIMING_SOURCE } = require('../server/services/transcription/firered');
const { createFunasrRuntime } = require('../server/services/transcription/funasrRuntime');
const timing = require('../server/services/creative/illustrated/timing');
const models = require('../server/services/creative/illustrated/models');

const words = [{ text: '你好', start: .12, end: .4, confidence: .9 }, { text: '世界', start: .7, end: 1.1, confidence: .8 }];
const payload = () => ({ model: 'fireredasr2-aed', status: 'done', timing_source: TIMING_SOURCE, word_timestamp_unit: 'seconds',
  text: '你好世界', sentence_info: [{ text: '你好世界', start: 120, end: 1100, words: structuredClone(words) }], words: structuredClone(words) });
const ready = { status: 'ready', model: 'fireredasr2-aed', timing_source: TIMING_SOURCE, word_timestamps: true, runtime_version: 'firered-aed-ctc-int8-v1' };
class Child extends EventEmitter {
  constructor() { super(); this.stdin = new PassThrough(); this.stderr = new PassThrough(); }
  unref() {}
  kill() { this.emit('close', 0); }
}

async function run() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'musedock-firered-'));
  try {
    const configPath = path.join(root, 'config.json');
    await configService.saveConfig({ providers: {}, active: { asr: 'builtin/funasr' },
      localAsr: { baseUrl: 'http://localhost:9876/v1', pythonPath: 'old-python', modelCache: 'old-cache' } }, { configPath });
    const current = await configService.getRuntimeConfig('asr', { configPath });
    assert.equal(current.provider, 'firered');
    assert.equal(current.baseUrl, 'http://127.0.0.1:8001/v1');
    assert.equal(current.pythonPath, '');
    assert.equal(current.modelCache, '');
    const resolved = await pipeline.resolveAsrRuntime({ asrConfig: current,
      env: { FUNASR_BASE_URL: 'http://old.invalid/v1', FUNASR_PYTHON: 'old-python', MODELSCOPE_CACHE: 'old-cache', ASR_API_KEY: 'unrelated' } });
    assert.equal(resolved.provider, 'firered');
    assert.equal(resolved.apiKey, '');
    assert.equal(resolved.pythonPath, '');
    assert.equal(resolved.baseUrl, current.baseUrl);
    const explicitFireRed = await pipeline.resolveAsrRuntime({ asrConfig: current,
      env: { ASR_PROVIDER: 'firered', FIRERED_BASE_URL: 'https://example.invalid/v1', FIRERED_API_KEY: 'fixture-key' } });
    assert.equal(explicitFireRed.builtin, false);
    assert.equal(explicitFireRed.apiKey, 'fixture-key');
    const explicit = configService.normalizeStoredConfig({ providers: { custom: { models: { asr: { enabled: true, backend: 'funasr', modelId: 'paraformer' } } } }, active: { asr: 'custom/asr' } });
    assert.equal(explicit.active.asr, 'custom/asr');
    assert.equal(explicit.providers.custom.models.asr.backend, 'funasr');
    assert.equal((await pipeline.resolveAsrRuntime({ asrConfig: current, env: { ASR_PROVIDER: 'funasr', FUNASR_BASE_URL: 'http://localhost:8000/v1' } })).provider, 'funasr');
    assert.equal(models.snapshot(current, 'asr').configured, true);

    const cues = normalizeFireRed(payload(), 1600, 2000);
    assert.deepEqual(cues[0].words.map(word => [word.startMs, word.endMs]), [[2120,2400],[2700,3100]]);
    const split = splitAlignedSentences(cues);
    assert.deepEqual(split[0].words, cues[0].words);
    const paused = splitAlignedSentences([{ ...cues[0], text: 'HELLO WORLD', words: [
      { text: 'HELLO', startMs: 120, endMs: 400 }, { text: 'WORLD', startMs: 900, endMs: 1200 },
    ] }]);
    assert.deepEqual(paused.map(cue => [cue.text, cue.startMs, cue.endMs]), [['HELLO', 120, 400], ['WORLD', 900, 1200]]);
    for (const mutate of [
      item => { item.timing_source = 'vad_segment_bounds'; },
      item => { item.words = []; },
      item => { item.text = '别的文字'; },
      item => { item.sentence_info[0].words[0].start = NaN; },
      item => { item.sentence_info[0].words[1].start = .3; },
      item => { item.sentence_info[0].words[1].end = 2; },
      item => { item.sentence_info[0].end = 1200; },
    ]) { const item = payload(); mutate(item); assert.throws(() => normalizeFireRed(item, 1600)); }
    const silence = { ...payload(), status: 'no_speech_detected', text: '', words: [], sentence_info: [] };
    assert.deepEqual(normalizeFireRed(silence, 1000), []);

    const audio = path.join(root, 'source.wav');
    await fsp.writeFile(audio, Buffer.alloc(100));
    const result = await transcribeFireRedAudio(audio, current, { durationMs: 1600, workDir: root,
      execute: async (_file, args) => fsp.writeFile(args.at(-1), Buffer.alloc(100)), fetchImpl: async (_url, request) => {
        assert.equal(request.body.get('model'), 'fireredasr2-aed');
        assert.ok(request.body.getAll('timestamp_granularities[]').includes('word'));
        return new Response(JSON.stringify(payload()));
      } });
    assert.equal(result.provider, 'firered');
    assert.equal(result.words.length, 2);
    assert.equal(result.timingSource, TIMING_SOURCE);
    assert.ok((await fsp.readFile(path.join(root, 'response-1.json'), 'utf8')).includes(TIMING_SOURCE));
    const noSpeech = await transcribeFireRedAudio(audio, current, { durationMs: 1600, workDir: path.join(root, 'silence'),
      execute: async (_file, args) => fsp.writeFile(args.at(-1), Buffer.alloc(100)), fetchImpl: async () => new Response(JSON.stringify(silence)) });
    assert.equal(noSpeech.status, 'no_speech_detected');
    assert.equal(noSpeech.text, '');
    assert.deepEqual(noSpeech.words, []);

    const settings = { narrationLanguage: 'zh-CN', aspectRatio: '16:9' };
    const chunk = { id: 'part1', sceneId: 'scene_1', text: '你好世界' };
    const aligned = timing.asrSegmentTiming(chunk, { ...result, kind: 'asr_words' }, 1600, settings);
    assert.equal(aligned.timingKind, 'asr_words');
    assert.equal(aligned.captions[0].startMs, 120);
    assert.equal(aligned.captions.at(-1).endMs, 1100);
    const assembled = timing.assembleTiming({ scenes: [{ id: 'scene_1' }] }, [{ ...chunk, durationMs: 1600, timing: aligned }]);
    assert.equal(assembled.timingKind, 'asr_words');
    assert.deepEqual(await timing.displayCaptions({ narration: { timing: assembled, segments: [{ ...chunk, durationMs: 1600 }] }, settings }, async () => result), aligned.captions);

    let launched = false, launches = 0;
    const runtime = createFunasrRuntime({ backend: 'firered', env: {}, modelsReady: () => true, startTimeoutMs: 300,
      pollIntervalMs: 2, execute: async () => {}, fetchImpl: async () => {
        if (!launched) throw new TypeError('refused', { cause: { code: 'ECONNREFUSED' } });
        return new Response(JSON.stringify(ready));
      }, spawnImpl: (_python, args) => {
        launches += 1; launched = true;
        assert.ok(args.some(arg => arg.endsWith('firered\\server.py') || arg.endsWith('firered/server.py')));
        assert.ok(args.includes('--model-cache'));
        assert.ok(!args.includes('--device'));
        return new Child();
      } });
    try { await Promise.all([runtime.ensure({ ...current, pythonPath: 'fixture-python' }), runtime.ensure({ ...current, pythonPath: 'fixture-python' })]); assert.equal(launches, 1); }
    finally { runtime.close(); }
    for (const fake of [{ ...ready, word_timestamps: false }, { ...ready, model: 'paraformer' }, { data: [{ id: current.modelId }] }]) {
      const invalid = createFunasrRuntime({ backend: 'firered', env: {}, fetchImpl: async () => new Response(JSON.stringify(fake)) });
      await assert.rejects(invalid.ensure(current), error => error.code === 'ASR_PORT_IN_USE');
      invalid.close();
    }
    console.log('FireRed 默认迁移、供应商兼容、文字/字词绑定、时间边界、静音、字幕消费及启动锁测试通过。');
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
