// 手动本地验收：node tests/test-firered-live.js 音频路径 [证据输出目录]
// 只运行本机 FireRed；无云端/分析模型/TTS 调用。先执行 npm run setup:asr。
const assert = require('assert/strict');
const fsp = require('fs/promises');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { createFunasrRuntime } = require('../server/services/transcription/funasrRuntime');
const { transcribeFireRedAudio } = require('../server/services/transcription/firered');
const { toSrt } = require('../server/services/transcription/corrections');
async function run() {
  if (!process.argv[2]) {
    if (process.env.RUN_FIRERED_LIVE_TEST === '1') throw new Error('请显式传入用于本地验收的音频文件路径。');
    console.log('跳过 FireRed 真实音频验收：请先安装 ASR 环境，再显式传入音频路径；普通测试不会下载或加载模型。');
    return;
  }
  const audio = path.resolve(process.argv[2]);
  const output = process.argv[3] ? path.resolve(process.argv[3]) : await fsp.mkdtemp(path.join(os.tmpdir(), 'firered-live-'));
  await fsp.mkdir(output, { recursive: true });
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const config = { builtin: true, provider: 'firered', modelId: 'fireredasr2-aed', baseUrl: `http://127.0.0.1:${port}/v1` };
  const runtime = createFunasrRuntime({ backend: 'firered', env: process.env });
  const started = Date.now();
  try {
    await runtime.ensure(config, { onProgress: ({ message }) => console.log(message) });
    const result = await transcribeFireRedAudio(audio, config, { workDir: path.join(output, 'asr'), onProgress: ({ message }) => console.log(message) });
    assert.equal(result.success, true);
    assert.ok(result.words.length);
    assert.equal(result.words.map(word => word.text).join('').replace(/\s/gu,''), result.text.replace(/\s/gu,''));
    await fsp.writeFile(path.join(output, 'transcript.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
    await fsp.writeFile(path.join(output, 'transcript.srt'), toSrt(result.sentences), { flag: 'wx' });
    const hash = createHash('sha256');
    for await (const buffer of fs.createReadStream(audio)) hash.update(buffer);
    const evidence = { inputSha256: hash.digest('hex'), durationMs: result.durationMs, wordCount: result.words.length,
      sentenceCount: result.sentences.length, lowConfidenceWordCount: result.lowConfidenceWordCount,
      elapsedSeconds: (Date.now() - started) / 1000, timingSource: result.timingSource };
    // Generate valid PCM16 silence; do not reuse arbitrary personal fixtures.
    const wav = Buffer.alloc(44 + 32000);
    wav.write('RIFF',0); wav.writeUInt32LE(wav.length - 8,4); wav.write('WAVEfmt ',8);
    wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22);
    wav.writeUInt32LE(16000,24); wav.writeUInt32LE(32000,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34);
    wav.write('data',36); wav.writeUInt32LE(32000,40);
    const silentFile = path.join(output, 'silence.wav'); await fsp.writeFile(silentFile,wav);
    const silence = await transcribeFireRedAudio(silentFile, config, { durationMs:1000, workDir:path.join(output,'silence-asr') });
    assert.equal(silence.status, 'no_speech_detected'); assert.equal(silence.text, ''); assert.deepEqual(silence.words, []);
    evidence.silenceStatus = silence.status;
    await fsp.writeFile(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2), {flag:'wx'});
    console.log(JSON.stringify(evidence));
  } finally { runtime.close(); }
}
run().catch(error => { console.error(error.code || '', error.message); process.exitCode = 1; });
