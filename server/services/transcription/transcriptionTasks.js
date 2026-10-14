const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const mediaPipeline = require('../mediaPipeline');
const aiModelConfig = require('../ai/aiModelConfig');
const { readAudioDuration } = require('../tts/ttsTimeline');
const { normalizeCreativeInputWithDouyinShortLink } = require('../creative/creativeContext');
const { TranscriptionError, transcriptionEndpoint } = require('./funasr');
const { ensureFunasrService } = require('./funasrRuntime');
const { ensureLocalAsrService, transcribeLocalAsrAudio } = require('./localAsr');
const { toSrt, proofreadTranscript } = require('./corrections');
const { extractVideoFrames, MAX_FRAME_COUNT } = require('./videoFrames');
const { DOUYIN_VIDEO_PAGE_MESSAGES } = require('../../scraper/douyinVideoPage');

const DEFAULT_ROOT = path.join(require('../../dataRoot'), 'data/transcriptions');
const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ACTIVE_STATUSES = new Set(['queued', 'running']);
const FILE_KINDS = new Set(['rawText', 'rawSrt', 'rawJson', 'correctedText', 'correctedSrt', 'corrections', 'metadata', 'audio', 'framesManifest']);

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function textConfigured(config) {
  return config?.enabled === true && !!config.apiKey && !!config.baseUrl && !!config.modelId;
}

function safeError(error) {
  return error instanceof TranscriptionError
    ? { code: error.code, message: error.message }
    : { code: 'TRANSCRIPTION_FAILED', message: '转写任务失败，请检查本地媒体环境和服务配置后重试。' };
}

async function resolveSource(source) {
  const normalized = await normalizeCreativeInputWithDouyinShortLink({ input: source }, {
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password
        || (parsed.port && !['80', '443'].includes(parsed.port))
        || !/(^|\.)(douyin|iesdouyin)\.com$/i.test(parsed.hostname)) {
        throw new TranscriptionError('INVALID_SOURCE', '抖音短链跳转到了不支持的地址，请使用完整视频链接。');
      }
      const response = await fetch(url, options);
      await response.body?.cancel();
      return response;
    },
  });
  if (!normalized.success || normalized.data?.mode !== 'douyin') {
    throw new TranscriptionError('INVALID_SOURCE', normalized.success
      ? '请输入单条抖音视频链接、分享文案或视频 ID。' : normalized.message);
  }
  return normalized.data;
}

function createTranscriptionService(options = {}) {
  const rootDir = path.resolve(options.rootDir || DEFAULT_ROOT);
  const pipeline = options.mediaPipeline || mediaPipeline;
  const jobs = new Map();
  const running = new Map();
  const loading = new Map();
  const deleting = new Set();
  const editing = new Set();
  const deleted = new Set();
  let creating = false;

  function directory(id) {
    if (!ID_PATTERN.test(String(id || ''))) throw new TranscriptionError('TASK_NOT_FOUND', '转写任务不存在。', 404);
    return path.join(rootDir, id);
  }

  function assertAvailable(id) {
    directory(id);
    if (deleted.has(id)) throw new TranscriptionError('TASK_NOT_FOUND', '转写记录已删除。', 404);
    if (deleting.has(id)) throw new TranscriptionError('TASK_DELETING', '这条转写正在删除，请稍后刷新。', 409);
  }

  async function save(job) {
    assertAvailable(job.id);
    job.updatedAt = new Date(Math.max(Date.now(), (Date.parse(job.updatedAt) || 0) + 1)).toISOString();
    const file = path.join(directory(job.id), 'task.json');
    await fsp.writeFile(`${file}.tmp`, JSON.stringify(job, null, 2), 'utf8');
    await fsp.rename(`${file}.tmp`, file);
  }

  function present(job) {
    const files = Object.fromEntries(Object.entries(job.files || {}).map(([kind, file]) => [kind, {
      name: file.name, bytes: file.bytes, sha256: file.sha256,
      url: `/api/transcriptions/${job.id}/files/${kind}`,
    }]));
    return {
      id: job.id, status: job.status, stage: job.stage, progress: job.progress, message: job.message,
      title: jobTitle(job),
      source: job.source || null, autoCorrect: job.autoCorrect, correctionCount: job.correctionCount,
      extractFrames: job.extractFrames === true, frameCount: job.frameCount ?? null,
      frames: (job.frames || []).map(frame => ({ ...frame, ...files[frame.kind] })),
      frameSampling: job.frameSampling || null,
      createdAt: job.createdAt, updatedAt: job.updatedAt, error: job.error || null,
      result: job.result || null, canCorrect: canStartCorrection(job),
      canRetryCorrection: job.status === 'partial' && job.stage === 'correcting',
      files,
    };
  }

  function canStartCorrection(job) {
    return job.status === 'succeeded' && !!job.result?.sentences?.length
      && !!job.files?.rawJson && !!job.files?.rawText && !!job.files?.rawSrt
      && !job.result.correctedText && !job.files.correctedText;
  }

  function jobTitle(job) {
    return String(job.source?.title || job.source?.url || job.input || '抖音转写').replace(/\s+/g, ' ').slice(0, 160);
  }

  function summarize(job) {
    return {
      id: job.id, title: jobTitle(job), status: job.status, stage: job.stage,
      createdAt: job.createdAt || null, updatedAt: job.updatedAt || null,
      source: job.source ? { title: job.source.title, url: job.source.url, awemeId: job.source.awemeId } : null,
      autoCorrect: job.autoCorrect === true,
      durationMs: job.result?.durationMs ?? job.source?.durationMs ?? null,
      sentenceCount: job.result?.sentenceCount ?? null,
      hasResult: !!job.result, hasCorrectedText: !!job.result?.correctedText,
    };
  }

  async function list() {
    let entries;
    try { entries = await fsp.readdir(rootDir, { withFileTypes: true }); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new TranscriptionError('HISTORY_UNAVAILABLE', '无法读取转写历史，请检查数据目录权限后重试。', 500);
      entries = [];
    }
    const ids = [...new Set([
      ...entries.filter(entry => entry.isDirectory() && ID_PATTERN.test(entry.name)).map(entry => entry.name),
      ...jobs.keys(),
    ])];
    const items = [];
    let skippedCount = 0;
    // 兼容已有任务目录；按批读取，避免大量历史同时打开文件。
    for (let offset = 0; offset < ids.length; offset += 20) {
      const batch = await Promise.all(ids.slice(offset, offset + 20).map(async id => {
        try { return summarize(await load(id)); }
        catch (error) {
          if (deleted.has(id) || deleting.has(id)) return null;
          if (error instanceof TranscriptionError && ['TASK_NOT_FOUND', 'TASK_INVALID'].includes(error.code)) {
            skippedCount += 1;
            return null;
          }
          throw error;
        }
      }));
      items.push(...batch.filter(Boolean));
    }
    items.sort((left, right) => (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0)
      || right.id.localeCompare(left.id));
    return { items: items.filter(item => !deleted.has(item.id) && !deleting.has(item.id)), skippedCount };
  }

  async function load(id) {
    assertAvailable(id);
    if (loading.has(id)) return loading.get(id);
    if (jobs.has(id)) return jobs.get(id);
    // 合并冷读和中断恢复，删除必须等待恢复写盘结束。
    const pending = (async () => {
      let job;
      try { job = JSON.parse(await fsp.readFile(path.join(directory(id), 'task.json'), 'utf8')); }
      catch { throw new TranscriptionError('TASK_NOT_FOUND', '转写任务不存在或已被清理。', 404); }
      assertAvailable(id);
      if (!job || typeof job !== 'object' || Array.isArray(job) || job.id !== id) throw new TranscriptionError('TASK_INVALID', '转写任务数据无效。');
      jobs.set(id, job);
      if (ACTIVE_STATUSES.has(job.status) && !running.has(id)) {
        job.status = job.files?.rawJson ? 'partial' : 'interrupted';
        if (job.files?.rawJson && job.autoCorrect && job.stage !== 'extracting_frames') job.stage = 'correcting';
        job.message = job.files?.rawJson ? '服务重启中断了任务，原始转写已保留。' : '服务重启中断了任务，请重新开始转写。';
        await save(job);
      }
      assertAvailable(id);
      return job;
    })();
    loading.set(id, pending);
    try { return await pending; }
    finally { loading.delete(id); }
  }

  async function deletionDirectory(id) {
    const target = directory(id);
    try {
      const stat = await fsp.lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new TranscriptionError('DELETE_PATH_INVALID', '转写目录位置异常，已停止删除。', 409);
      }
      const [realRoot, realTarget] = await Promise.all([fsp.realpath(rootDir), fsp.realpath(target)]);
      if (path.relative(realRoot, realTarget) !== id) {
        throw new TranscriptionError('DELETE_PATH_INVALID', '转写目录位置异常，已停止删除。', 409);
      }
      return realTarget;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof TranscriptionError) throw error;
      throw new TranscriptionError('DELETE_FAILED', '无法访问转写目录，请检查目录权限后重试。', 500);
    }
  }

  async function remove(id) {
    directory(id);
    if (creating || running.has(id) || deleting.has(id) || editing.has(id)) {
      throw new TranscriptionError('TASK_BUSY', '转写、校订或保存修改正在进行，请等待完成后再删除。', 409);
    }
    if (deleted.has(id) || !await deletionDirectory(id)) {
      jobs.delete(id); deleted.add(id);
      return { id, deleted: true };
    }
    const job = await load(id);
    if (creating || running.has(id) || deleting.has(id) || editing.has(id) || ACTIVE_STATUSES.has(job.status)) {
      throw new TranscriptionError('TASK_BUSY', '转写、校订或保存修改正在进行，请等待完成后再删除。', 409);
    }
    deleting.add(id);
    try {
      // 只删除已解析到转写根目录正下方的任务目录，不跟随记录中的文件路径。
      const target = await deletionDirectory(id);
      if (target) {
        try {
          await (options.removeDirectory || fsp.rm)(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
          const message = '删除未完成，部分文件可能被占用，请关闭相关文件或检查目录权限后重试删除。';
          Object.assign(job, { status: 'partial', stage: 'deleting', message, error: { code: 'DELETE_FAILED', message }, updatedAt: new Date().toISOString() });
          // 部分删除失败时保留可重试的历史记录；不重建目录，也不写入异常路径。
          try {
            const remaining = await deletionDirectory(id);
            if (remaining) await fsp.writeFile(path.join(remaining, 'task.json'), JSON.stringify(job, null, 2), 'utf8');
          } catch {}
          throw new TranscriptionError('DELETE_FAILED', message, 500);
        }
      }
      jobs.delete(id); deleted.add(id);
      return { id, deleted: true };
    } finally { deleting.delete(id); }
  }

  async function configs(autoCorrect) {
    const asr = await (options.resolveAsrRuntime || mediaPipeline.resolveAsrRuntime)(options);
    if (!asr.configured || !['funasr', 'firered'].includes(asr.provider)) {
      throw new TranscriptionError('ASR_NOT_CONFIGURED', '请在设置的“全局模型选择 → ASR 转写”中选择“FireRed（本地，默认）”，无需 API Key；也可选择已部署的 FunASR。');
    }
    transcriptionEndpoint(asr.baseUrl);
    const text = autoCorrect ? await (options.getTextConfig || aiModelConfig.getRuntimeConfig)('text', options) : null;
    if (autoCorrect && !textConfigured(text)) {
      throw new TranscriptionError('TEXT_NOT_CONFIGURED', '已选择自动校订，请先在设置中配置并选择分析模型，或关闭自动校订。');
    }
    return { asr, text };
  }

  async function setStage(job, stage, progress, message) {
    Object.assign(job, { status: 'running', stage, progress, message, error: null });
    await save(job);
  }

  async function recordFile(job, kind, relativePath) {
    const fullPath = path.join(directory(job.id), relativePath);
    const stat = await fsp.stat(fullPath);
    if (!stat.isFile() || !stat.size) throw new TranscriptionError('ARTIFACT_EMPTY', '转写产物为空，无法交付。');
    job.files[kind] = { path: relativePath, name: path.basename(relativePath), bytes: stat.size, sha256: await hashFile(fullPath) };
  }

  async function writeArtifact(job, kind, relativePath, content) {
    const fullPath = path.join(directory(job.id), relativePath);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await fsp.writeFile(fullPath, content, { encoding: 'utf8', flag: 'wx' });
    await recordFile(job, kind, relativePath);
  }

  async function verifiedFile(job, kind) {
    const isFrame = /^frame-\d{4}$/.test(kind) && job.frames?.some(frame => frame.kind === kind);
    if ((!FILE_KINDS.has(kind) && !isFrame) || !job.files?.[kind]) throw new TranscriptionError('FILE_NOT_FOUND', '该转写文件尚未生成。', 404);
    const artifact = job.files[kind];
    const fullPath = path.resolve(directory(job.id), artifact.path);
    const relative = path.relative(directory(job.id), fullPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new TranscriptionError('FILE_INVALID', '转写文件路径无效。');
    let digest;
    try { digest = await hashFile(fullPath); } catch { throw new TranscriptionError('FILE_NOT_FOUND', '转写文件不存在或已被清理。', 404); }
    if (digest !== artifact.sha256) throw new TranscriptionError('ARTIFACT_CHANGED', '转写文件已被修改，校验未通过，请保留原始产物。', 409);
    return { path: fullPath, name: artifact.name, ...(isFrame ? { contentType: 'image/jpeg' } : {}) };
  }

  async function correct(job, textConfig) {
    await setStage(job, 'correcting', 80, '正在调用分析模型校订...');
    const rawJson = await verifiedFile(job, 'rawJson');
    await verifiedFile(job, 'rawText');
    await verifiedFile(job, 'rawSrt');
    const raw = JSON.parse(await fsp.readFile(rawJson.path, 'utf8'));
    const attemptDir = `corrections/${randomUUID()}`;
    const corrected = await proofreadTranscript(raw.sentences, {
      title: job.source.title, textConfig, configPath: options.configPath,
      callModel: options.callTextModel,
      onModelResponse: async response => {
        const responseDir = path.join(directory(job.id), attemptDir);
        await fsp.mkdir(responseDir, { recursive: true });
        await fsp.writeFile(path.join(responseDir, `response-${response.batchNumber}.json`), JSON.stringify({
          rawJsonSha256: job.files.rawJson.sha256, receivedAt: new Date().toISOString(), ...response,
        }, null, 2), { encoding: 'utf8', flag: 'wx' });
      },
      onProgress: ({ progress, message }) => {
        job.progress = 80 + Math.floor(progress * (job.extractFrames ? 0.12 : 0.18)); job.message = message;
      },
    });
    const text = corrected.sentences.map(cue => cue.text).join('\n');
    await writeArtifact(job, 'correctedText', `${attemptDir}/transcript.corrected.txt`, `${text}\n`);
    await writeArtifact(job, 'correctedSrt', `${attemptDir}/transcript.corrected.srt`, toSrt(corrected.sentences));
    await writeArtifact(job, 'corrections', `${attemptDir}/transcript.corrections.json`, JSON.stringify({
      method: 'analysis-model-proofreading', model: corrected.model, source: job.source,
      rawTextSha256: job.files.rawText.sha256, rawSrtSha256: job.files.rawSrt.sha256,
      correctedTextSha256: job.files.correctedText.sha256, correctedSrtSha256: job.files.correctedSrt.sha256,
      indicesAndTimingPreserved: true, changes: corrected.changes,
    }, null, 2));
    job.correctionCount = corrected.changes.length;
    job.result.correctedText = text;
    job.result.correctedSentences = corrected.sentences;
    job.result.rawModifiedAfterCorrection = false;
  }

  async function updateText(id, payload = {}) {
    const job = await load(id);
    assertAvailable(id);
    if (creating || running.has(id) || editing.has(id) || ACTIVE_STATUSES.has(job.status) || job.stage === 'deleting') {
      throw new TranscriptionError('TASK_BUSY', '转写、校订或保存修改正在进行，请稍后再保存。', 409);
    }
    if (!payload || !['raw', 'corrected'].includes(payload.version)
      || Object.keys(payload).some(key => !['version', 'texts', 'updatedAt'].includes(key))) {
      throw new TranscriptionError('INVALID_EDIT', '请选择原始转写或校订版，并提交有效的字幕文字。');
    }
    if (typeof payload.updatedAt !== 'string' || payload.updatedAt !== job.updatedAt) {
      throw new TranscriptionError('EDIT_CONFLICT', '这条转写已更新，请重新加载后再修改；当前修改尚未保存。', 409);
    }
    const raw = payload.version === 'raw';
    const sentenceKey = raw ? 'sentences' : 'correctedSentences';
    const textKey = raw ? 'rawText' : 'correctedText';
    const srtKey = raw ? 'rawSrt' : 'correctedSrt';
    const previousSentences = job.result?.[sentenceKey];
    if (!previousSentences?.length || !job.files?.[textKey] || !job.files?.[srtKey]) {
      throw new TranscriptionError('TEXT_NOT_EDITABLE', '该版本尚未生成可修改的文字和字幕。', 409);
    }
    if (!Array.isArray(payload.texts) || payload.texts.length !== previousSentences.length
      || payload.texts.some(text => typeof text !== 'string' || !text.trim() || /[\r\n\u0000]/.test(text) || text.length > 10000)
      || payload.texts.reduce((length, text) => length + text.length, 0) > 500000) {
      throw new TranscriptionError('INVALID_EDIT', `请保留 ${previousSentences.length} 行字幕，每行不能为空，且不能增删字幕行。`);
    }
    editing.add(id);
    try {
      await verifiedFile(job, textKey);
      await verifiedFile(job, srtKey);
      const texts = payload.texts.map(text => text.trim());
      if (texts.every((text, index) => text === previousSentences[index].text)) return present(job);
      // 在独立版本目录准备完整产物；task.json 原子替换成功后才发布到内存。
      const next = structuredClone(job);
      const editedAt = new Date().toISOString();
      const editDir = `edits/${randomUUID()}`;
      const changes = [];
      const sentences = previousSentences.map((cue, index) => {
        if (cue.text === texts[index]) return { ...cue };
        const { words, ...sentence } = cue;
        changes.push({ index: cue.index, before: cue.text, after: texts[index], startMs: cue.startMs, endMs: cue.endMs });
        return { ...sentence, text: texts[index] };
      });
      const text = texts.join('\n');
      next.result[textKey] = text;
      next.result[sentenceKey] = sentences;
      next.result[raw ? 'rawEditedAt' : 'correctedEditedAt'] = editedAt;
      await writeArtifact(next, textKey, `${editDir}/transcript.${payload.version}.txt`, `${text}\n`);
      await writeArtifact(next, srtKey, `${editDir}/transcript.${payload.version}.srt`, toSrt(sentences));
      if (raw) {
        const rawJson = await verifiedFile(job, 'rawJson');
        const original = JSON.parse(await fsp.readFile(rawJson.path, 'utf8'));
        // 人工改字没有重新听音对齐，原字词证据继续保留在上一版 JSON 中。
        next.result.words = [];
        next.result.rawModifiedAfterCorrection = !!next.result.correctedText;
        await writeArtifact(next, 'rawJson', `${editDir}/transcript.raw.json`, JSON.stringify({
          ...original, text, sentences, words: [], manuallyEdited: true, editedAt,
          wordAlignmentValid: false, previousRawJson: job.files.rawJson,
        }, null, 2));
      } else {
        next.correctionCount = sentences.filter((cue, index) => cue.text !== next.result.sentences[index].text).length;
        await verifiedFile(job, 'corrections');
        await writeArtifact(next, 'corrections', `${editDir}/transcript.corrections.json`, JSON.stringify({
          method: 'manual-edit', editedAt, source: job.source, previousRecord: job.files.corrections,
          rawTextSha256: job.files.rawText.sha256, rawSrtSha256: job.files.rawSrt.sha256,
          correctedTextSha256: next.files.correctedText.sha256, correctedSrtSha256: next.files.correctedSrt.sha256,
          rawModifiedAfterCorrection: next.result.rawModifiedAfterCorrection === true,
          indicesAndTimingPreserved: true, changes,
        }, null, 2));
      }
      await fsp.writeFile(path.join(directory(id), editDir, 'edit.json'), JSON.stringify({
        method: 'manual-edit', version: payload.version, editedAt, indicesAndTimingPreserved: true,
        previousFiles: job.files, changes,
      }, null, 2), { encoding: 'utf8', flag: 'wx' });
      await save(next);
      jobs.set(id, next);
      return present(next);
    } catch (error) {
      if (error instanceof TranscriptionError) throw error;
      throw new TranscriptionError('SAVE_FAILED', '修改未保存，请检查磁盘空间与目录权限后重试；已保存版本仍保留。', 500);
    } finally { editing.delete(id); }
  }

  async function finish(job) {
    if (job.extractFrames && job.frames.length !== job.frameCount) {
      await setStage(job, 'extracting_frames', 94, `正在读取视频时长并抽取 ${job.frameCount} 张截图...`);
      const media = pipeline.getMediaPaths(job.source.awemeId, path.join(directory(job.id), 'media'));
      try {
        const sampled = await (options.extractVideoFrames || extractVideoFrames)(media.video, media.framesDir, {
          frameCount: job.frameCount, ffmpegPath: options.ffmpegPath, ffprobePath: options.ffprobePath,
          mediaTimeoutMs: 180000,
          onFrame: async frame => {
            const kind = `frame-${String(frame.index).padStart(4, '0')}`;
            await recordFile(job, kind, path.relative(directory(job.id), frame.path));
            job.frames.push({ kind, index: frame.index, timestampMs: frame.timestampMs });
            job.progress = 94 + Math.floor(job.frames.length / job.frameCount * 5);
            job.message = `正在抽帧，已保存 ${job.frames.length}/${job.frameCount} 张截图...`;
            await save(job);
          },
        });
        if (sampled.frames.length !== job.frameCount || job.frames.length !== job.frameCount) {
          throw new TranscriptionError('FRAME_EXTRACTION_FAILED', '截图数量与设置不一致，请重新开始转写。');
        }
        job.frameSampling = { method: 'uniform_from_zero', durationMs: sampled.durationMs, intervalMs: sampled.intervalMs };
        await writeArtifact(job, 'framesManifest', path.relative(directory(job.id), path.join(media.framesDir, 'frames.json')),
          JSON.stringify({ source: job.source, frameCount: job.frameCount, ...job.frameSampling,
            frames: job.frames.map(frame => ({ ...frame, ...job.files[frame.kind] })),
          }, null, 2));
      } catch (error) {
        const known = error instanceof TranscriptionError;
        throw new TranscriptionError(known ? error.code : 'FRAME_EXTRACTION_FAILED',
          `转写结果已保存，抽帧未完成：${known ? error.message : '请检查视频文件、ffmpeg 配置与磁盘空间。'}`);
      }
    }
    const message = job.result?.status === 'no_speech_detected' ? '未检测到可转写的人声，已保留音频与检测结果。'
      : job.result?.correctedText ? `转写和校订完成，共校订 ${job.correctionCount} 条字幕。` : '转写完成，原始文本和字幕已保存。';
    Object.assign(job, { status: 'succeeded', stage: 'done', progress: 100,
      message: `${message}${job.extractFrames ? ` 已保存 ${job.frames.length} 张截图。` : ''}` });
    await save(job);
  }

  async function run(job, runtime) {
    await setStage(job, 'starting_asr', 2, '正在检查本地 ASR 转写服务...');
    await (options.ensureLocalAsrService || (runtime.asr.provider === 'funasr' ? options.ensureFunasrService || ensureFunasrService : ensureLocalAsrService))(runtime.asr, {
      onProgress: ({ message }) => { job.message = message; },
    });
    await setStage(job, 'resolving', 5, '正在解析抖音链接...');
    const source = await (options.resolveSource || resolveSource)(job.input);
    const id = source.aweme_id;
    await setStage(job, 'downloading', 10, '正在读取抖音视频信息...');
    const detail = await (options.getVideoDetail || require('../../scraper/douyin').getVideoDetail)(id);
    if (detail.needVerify) throw new TranscriptionError('DOUYIN_NEEDS_VERIFY', '抖音需要验证，请点击“登录抖音”，在浏览器完成验证后重试。');
    if (detail.needLogin) throw new TranscriptionError('DOUYIN_NEEDS_LOGIN', '请先点击“登录抖音”并完成登录，再开始转写。');
    if (!detail.success) {
      const message = Object.hasOwn(DOUYIN_VIDEO_PAGE_MESSAGES, detail.code) ? DOUYIN_VIDEO_PAGE_MESSAGES[detail.code] : '';
      throw new TranscriptionError(message ? detail.code : 'DOUYIN_SOURCE_FAILED',
        message || '读取抖音视频信息失败，请检查浏览器和网络后重试。');
    }
    if (!detail.data?.video_download_url) {
      throw new TranscriptionError('DOUYIN_VIDEO_URL_MISSING', '抖音已返回作品信息，但没有可用的视频播放地址，请确认链接为可播放的视频。');
    }
    if (String(detail.data.aweme_id) !== id) throw new TranscriptionError('SOURCE_MISMATCH', '解析结果与输入的视频 ID 不一致，已停止转写。');
    job.source = { awemeId: id, url: `https://www.douyin.com/video/${id}`, title: detail.data.title || '' };
    const mediaRoot = path.join(directory(job.id), 'media');
    const prepared = await pipeline.prepareDouyinMedia(id, { ...detail.data, raw: undefined }, {
      rootDir: mediaRoot, extractFrames: false,
      downloadTimeoutMs: 180000, mediaTimeoutMs: 180000, maxDownloadBytes: 512 * 1024 * 1024,
      onProgress: ({ step, progress }) => {
        job.progress = 10 + Math.floor(progress * 0.35);
        job.message = step === 'audio' ? '正在抽取完整音频...' : '正在准备视频和音频...';
      },
    });
    if (!['done', 'exists'].includes(prepared.steps?.audio?.status)) {
      throw new TranscriptionError('MEDIA_PREPARE_FAILED', prepared.steps?.ffmpeg?.status === 'unavailable'
        ? 'ffmpeg 不可用，请安装或在环境变量中配置 FFMPEG_PATH。'
        : '视频下载或音频提取失败，请检查网络、抖音登录状态与 ffmpeg。');
    }
    const media = pipeline.getMediaPaths(id, mediaRoot);
    const duration = await (options.readAudioDuration || readAudioDuration)(media.audio, options);
    if (!duration.success || !Number.isFinite(duration.duration) || duration.duration <= 0) {
      throw new TranscriptionError('AUDIO_DURATION_INVALID', '无法读取音频时长，请检查 ffprobe 配置与媒体文件。');
    }
    if (duration.duration > 7200) throw new TranscriptionError('AUDIO_TOO_LONG', '小工具暂时支持 2 小时以内的视频，请使用较短的视频。');
    const durationMs = Math.round(duration.duration * 1000);
    job.source.durationMs = durationMs;
    job.source.videoSha256 = await hashFile(media.video);
    await recordFile(job, 'audio', path.relative(directory(job.id), media.audio));
    job.source.audioSha256 = job.files.audio.sha256;
    await setStage(job, 'transcribing', 45, '正在请求本地 ASR 转写与时间对齐...');
    const result = await (options.transcribeAudio || transcribeLocalAsrAudio)(media.audio, runtime.asr, {
      ...options, durationMs, workDir: path.join(directory(job.id), 'asr'),
      onProgress: ({ progress, message }) => { job.progress = 45 + Math.floor(progress * 0.3); job.message = message; },
    });
    if (result.status === 'no_speech_detected') {
      if (!result.success || result.text || result.sentences?.length || result.words?.length || result.missingRanges?.length) {
        throw new TranscriptionError('ASR_INCOMPLETE', 'ASR 空人声状态与转写结果不一致，已停止交付。');
      }
      await writeArtifact(job, 'rawJson', 'transcript.raw.json', JSON.stringify(result, null, 2));
      Object.assign(job, { result: { status: 'no_speech_detected', rawText: '', sentences: [], words: [], durationMs,
          sentenceCount: 0, timingSource: result.timingSource, requestCount: result.requestCount } });
      await save(job);
      await finish(job);
      return;
    }
    if (!result.success || !result.sentences?.length || result.missingRanges?.length) {
      throw new TranscriptionError('ASR_INCOMPLETE', 'ASR 转写不完整，已保留媒体与各段响应，请检查服务。');
    }
    await setStage(job, 'saving', 76, '正在保存原始转写和字幕...');
    await writeArtifact(job, 'rawText', 'transcript.raw.txt', `${result.text}\n`);
    await writeArtifact(job, 'rawSrt', 'transcript.raw.srt', toSrt(result.sentences));
    await writeArtifact(job, 'rawJson', 'transcript.raw.json', JSON.stringify(result, null, 2));
    await writeArtifact(job, 'metadata', 'metadata.json', JSON.stringify({
      source: job.source, model: { provider: result.provider, modelId: runtime.asr.modelId },
      extractFrames: job.extractFrames, frameCount: job.frameCount,
      durationMs, timingSource: result.timingSource, sentenceCount: result.sentences.length,
      requestCount: result.requestCount, missingRanges: result.missingRanges, files: job.files,
    }, null, 2));
    job.result = { rawText: result.text, sentences: result.sentences, words: result.words || [], durationMs,
      sentenceCount: result.sentences.length, timingSource: result.timingSource, requestCount: result.requestCount };
    await save(job);
    if (job.autoCorrect) await correct(job, runtime.text);
    await finish(job);
  }

  function launch(job, operation) {
    const promise = Promise.resolve().then(operation).catch(async error => {
      const failure = safeError(error);
      Object.assign(job, { status: job.result ? 'partial' : 'failed', error: failure, message: failure.message });
      await save(job);
    }).finally(() => running.delete(job.id));
    running.set(job.id, promise);
    // 磁盘写入失败仍在内存中保留终态，避免未处理的拒绝或永久 loading。
    promise.catch(() => {
      Object.assign(job, { status: 'failed', message: '转写结果保存失败，请检查磁盘空间与目录权限。', error: { code: 'SAVE_FAILED' } });
    });
  }

  async function beginCorrection(id, retry) {
    const job = await load(id);
    assertAvailable(id);
    const eligible = retry ? job.status === 'partial' && job.stage === 'correcting' : canStartCorrection(job);
    if (creating || running.size || editing.has(id) || !eligible) {
      throw new TranscriptionError(retry ? 'CORRECTION_NOT_RETRYABLE' : 'CORRECTION_NOT_AVAILABLE',
        retry ? '该任务当前不能重试校订，请等待运行结束。' : '该任务当前不能发起校订，请等待原始转写完成；已有校订版可直接修改。', 409);
    }
    creating = true;
    try {
      const text = await (options.getTextConfig || aiModelConfig.getRuntimeConfig)('text', options);
      if (!textConfigured(text)) throw new TranscriptionError('TEXT_NOT_CONFIGURED', '请先在设置中配置并选择分析模型。');
      await verifiedFile(job, 'rawJson');
      await verifiedFile(job, 'rawText');
      await verifiedFile(job, 'rawSrt');
      await setStage(job, 'correcting', 80, retry ? '正在重新校订已保存的原始转写...' : '正在校订已保存的原始转写...');
      launch(job, async () => {
        await correct(job, text);
        await finish(job);
      });
      return present(job);
    } finally { creating = false; }
  }

  return {
    list,
    remove,
    updateText,
    async capabilities() {
      const asr = await (options.resolveAsrRuntime || mediaPipeline.resolveAsrRuntime)(options);
      const text = await (options.getTextConfig || aiModelConfig.getRuntimeConfig)('text', options);
      let asrReady = asr.configured && ['funasr', 'firered'].includes(asr.provider);
      try { if (asrReady) transcriptionEndpoint(asr.baseUrl); } catch { asrReady = false; }
      return { asrReady, asrProvider: asrReady ? asr.provider : '', asrModel: asrReady ? asr.modelId : '', textReady: textConfigured(text), textModel: textConfigured(text) ? text.modelId : '' };
    },
    async create({ source, autoCorrect = false, extractFrames = false, frameCount } = {}) {
      if (typeof source !== 'string' || !source.trim() || source.length > 4096 || typeof autoCorrect !== 'boolean') {
        throw new TranscriptionError('INVALID_INPUT', '请输入有效的抖音链接或分享文案（不超过 4096 字符）。');
      }
      if (typeof extractFrames !== 'boolean') throw new TranscriptionError('INVALID_INPUT', '请选择是否抽帧。');
      if (extractFrames && (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > MAX_FRAME_COUNT)) {
        throw new TranscriptionError('INVALID_FRAME_COUNT', `抽帧数量必须是 1 到 ${MAX_FRAME_COUNT} 之间的整数。`);
      }
      const requestedFrameCount = extractFrames ? frameCount : null;
      const input = source.trim();
      const existing = [...jobs.values()].find(job => running.has(job.id) && job.input === input && job.autoCorrect === autoCorrect
        && job.extractFrames === extractFrames && job.frameCount === requestedFrameCount);
      if (existing) return present(existing);
      if (creating || running.size) throw new TranscriptionError('TASK_BUSY', '已有转写任务正在执行，请等待完成后再开始。', 409);
      creating = true;
      try {
        const runtime = await configs(autoCorrect);
        const job = { id: randomUUID(), input, autoCorrect, extractFrames, frameCount: requestedFrameCount, frames: [],
          status: 'queued', stage: 'queued', progress: 0,
          message: '正在准备转写任务...', files: {}, createdAt: new Date().toISOString() };
        await fsp.mkdir(directory(job.id), { recursive: true });
        await save(job);
        jobs.set(job.id, job);
        launch(job, () => run(job, runtime));
        return present(job);
      } finally { creating = false; }
    },
    async get(id) { return present(await load(id)); },
    async file(id, kind) { return verifiedFile(await load(id), kind); },
    async startCorrection(id) { return beginCorrection(id, false); },
    async retryCorrection(id) { return beginCorrection(id, true); },
    async waitForIdle() { await Promise.allSettled([...running.values()]); },
  };
}

module.exports = { createTranscriptionService, DEFAULT_ROOT, resolveSource };
