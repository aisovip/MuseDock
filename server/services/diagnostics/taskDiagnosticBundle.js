const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Transform, Readable } = require('stream');
const { pipeline, finished } = require('stream/promises');
const { ZipFile } = require('yazl');
const workflowStore = require('../creative/workflowStore');
const { requestSecrets, redactBody, redactValue } = require('./apiCallRedaction');
const { scrubText, environmentSnapshot } = require('./taskDiagnosticRecords');

const LIMITS = Object.freeze({ files: 4000, totalBytes: 2 * 1024 ** 3, textBytes: 16 * 1024 ** 2,
  apiBytes: 128 * 1024 ** 2, apiRecords: 2000 });
const TEXT = /\.(?:json|jsonl|txt|log|srt|ass|vtt|html|css|js|mjs|yaml|yml|md|csv|svg)$/i;
const MEDIA = /\.(?:png|jpe?g|webp|gif|mp3|wav|aac|m4a|ogg|flac|mp4|webm|mov|ttf|woff2?)$/i;
const FORBIDDEN = /(?:^|\/)(?:node_modules|\.git|__pycache__|runtime|chrome-user-data|\.env[^/]*|[^/]*(?:cookie|credential|secret|ai-models|app-settings)[^/]*)(?:\/|$)/i;

function bundleError(code, message, statusCode = 400) { return Object.assign(new Error(message), { code, statusCode }); }
function within(file, root) { const relative = path.relative(root, file); return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative)); }

async function checkedFile(file, root) {
  const absoluteRoot = path.resolve(root), absolute = path.resolve(file);
  if (!within(absolute, absoluteRoot)) throw new Error('BOUNDARY');
  // 检查每级目录，拒绝 symlink / Windows junction，而不只检查叶子文件。
  let current = absoluteRoot;
  for (const segment of ['', ...path.relative(absoluteRoot, absolute).split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    const stat = await fsp.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('SYMLINK');
  }
  const realRoot = await fsp.realpath(absoluteRoot), real = await fsp.realpath(absolute);
  if (!within(real, realRoot)) throw new Error('BOUNDARY');
  return { stat: await fsp.stat(absolute), real };
}

async function openChecked(file, root, expected) {
  const { stat } = await checkedFile(file, root);
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size
      || expected && (opened.ino !== expected.ino || opened.dev !== expected.dev
        || opened.size !== expected.size || opened.mtimeMs !== expected.mtimeMs)) throw new Error('CHANGED');
    await checkedFile(file, root);
    return { handle, stat: opened };
  } catch (error) { await handle.close().catch(() => {}); throw error; }
}

async function readLimitedText(handle, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (!result.bytesRead) throw new Error('CHANGED');
    offset += result.bytesRead;
  }
  return bytes.toString('utf8');
}

function clean(value, secrets = []) {
  if (typeof value === 'string') return scrubText(redactBody(value, '', secrets));
  if (Array.isArray(value)) return value.map(item => clean(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(redactValue(value, secrets))
    .map(([key, item]) => [key, clean(item, secrets)]));
  return value;
}

function omitLargeBinary(value) {
  if (typeof value === 'string' && (/^data:(?:image|audio|video)\//i.test(value)
    || (value.length > 8192 && /^[A-Za-z0-9+/=\r\n]+$/.test(value)))) {
    return `[媒体 Base64 已从文本省略，原字段 ${Buffer.byteLength(value)} 字节；请检查任务媒体或 API 记录附件]`;
  }
  if (Array.isArray(value)) return value.map(omitLargeBinary);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, omitLargeBinary(item)]));
  return value;
}

function mediaExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF') {
    if (bytes.subarray(8, 12).toString() === 'WAVE') return 'wav';
    if (bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  }
  if (bytes.subarray(0, 3).toString() === 'ID3' || bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0) return 'mp3';
  if (bytes.subarray(0, 4).toString() === 'OggS') return 'ogg';
  if (bytes.subarray(0, 4).toString() === 'fLaC') return 'flac';
  if (bytes.subarray(4, 8).toString() === 'ftyp') return 'mp4';
  return '';
}

function omitBinaryText(text) {
  // 只替换 JSON 字符串，保留长整数、错误候选的格式和其它原文。
  return text.replace(/"(?:\\.|[^"\\])*"/g, token => {
    if (token.length < 8192 && !/^"data:(?:image|audio|video)\//i.test(token)) return token;
    try {
      const original = JSON.parse(token), replacement = omitLargeBinary(original);
      return replacement === original ? token : JSON.stringify(replacement);
    } catch { return token; }
  });
}

async function collectPlan(workflowId, options = {}) {
  const rootDir = path.resolve(options.rootDir || workflowStore.DEFAULT_ROOT);
  const mediaRoot = path.resolve(options.mediaRoot || workflowStore.DEFAULT_MEDIA_ROOT);
  const file = workflowStore.getWorkflowPath(workflowId, rootDir);
  let record;
  try {
    const { handle, stat } = await openChecked(file, rootDir);
    try {
      if (stat.size > LIMITS.textBytes) throw new Error('INVALID');
      record = JSON.parse(await readLimitedText(handle, stat.size));
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('CHANGED');
    } finally { await handle.close(); }
  } catch (error) {
    if (error.code === 'ENOENT') throw bundleError('NOT_FOUND', '创作任务不存在或已删除。', 404);
    throw bundleError('TASK_UNREADABLE', '无法读取任务记录，请检查文件和本地权限。', 409);
  }
  if (String(record.workflow_id) !== String(workflowId)) throw bundleError('TASK_MISMATCH', '任务记录与任务 ID 不一致。', 409);
  const plan = { record, rootDir, mediaRoot, includeFiles: options.includeFiles === true,
    startedAt: new Date().toISOString(), files: [], skipped: [], estimatedBytes: 0 };
  const seen = new Set();
  let inspected = 0;
  const skip = (name, reason) => { if (plan.skipped.length < LIMITS.files) plan.skipped.push({ path: name, reason }); };

  async function add(filePath, allowedRoot, archiveName, expected = {}) {
    archiveName = archiveName.replace(/\\/g, '/');
    if (FORBIDDEN.test(archiveName) || !TEXT.test(archiveName) && !MEDIA.test(archiveName)) {
      skip(archiveName, '不属于允许导出的文件类型，或可能包含配置与凭据。'); return;
    }
    if (!plan.includeFiles && !TEXT.test(archiveName)) { skip(archiveName, '诊断包不包含媒体文件。'); return; }
    if (seen.has(path.resolve(filePath))) return;
    try {
      const { stat } = await checkedFile(filePath, allowedRoot);
      if (!stat.isFile()) throw new Error('TYPE');
      if (TEXT.test(archiveName) && stat.size > LIMITS.textBytes) { skip(archiveName, '文本超过 16 MiB 上限。'); return; }
      if (plan.files.length >= LIMITS.files || plan.estimatedBytes + stat.size > LIMITS.totalBytes) {
        skip(archiveName, '超过 4000 文件或 2 GiB 原文件总量上限。'); return;
      }
      seen.add(path.resolve(filePath));
      plan.files.push({ path: filePath, root: allowedRoot, name: archiveName, size: stat.size,
        mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino, expected });
      plan.estimatedBytes += stat.size;
    } catch (error) { skip(archiveName, error.code === 'ENOENT' ? '文件缺失。' : '文件不可读、类型无效或路径不可信。'); }
  }

  async function walk(directory, allowedRoot, prefix, depth = 0) {
    if (depth > 12 || plan.files.length >= LIMITS.files) { skip(prefix, '目录深度或文件数达到上限。'); return; }
    let entries;
    try {
      const { stat } = await checkedFile(directory, allowedRoot);
      if (!stat.isDirectory()) throw new Error('TYPE');
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (error) { skip(prefix, error.code === 'ENOENT' ? '该目录尚未创建或已缺失。' : '目录不可读或路径不可信。'); return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++inspected > 20000) { skip(prefix, '目录扫描超过 20000 项上限。'); return; }
      const name = `${prefix}/${entry.name}`, next = path.join(directory, entry.name);
      if (FORBIDDEN.test(name) || entry.isSymbolicLink()) { skip(name, '排除配置、缓存或符号链接。'); continue; }
      if (entry.isDirectory()) {
        if (!plan.includeFiles && /(?:^|\/)(?:work|\.whiteboard-work|frames|exports)\//.test(`${name}/`)) {
          skip(name, '中间文件和渲染输出仅在包含素材与工程时导出。'); continue;
        }
        await walk(next, allowedRoot, name, depth + 1);
      } else if (entry.isFile()) await add(next, allowedRoot, name);
    }
  }

  await walk(path.join(rootDir, '.task-diagnostics', workflowId), rootDir, 'diagnostics');
  if (record.creationModeId === 'whiteboard-stream-v1') {
    await walk(path.join(rootDir, 'whiteboard-artifacts', workflowId), rootDir, 'files/whiteboard-artifacts');
    if (plan.includeFiles) await walk(path.join(rootDir, '.whiteboard-work', workflowId), rootDir, 'files/whiteboard-work');
  } else if (record.creationModeId === 'illustrated-narration-v1') {
    await walk(path.join(rootDir, '.illustrated-media', workflowId), rootDir, 'files/illustrated-media');
  } else {
    await walk(path.join(mediaRoot, workflowId), mediaRoot, 'files/hyperframes');
  }

  // 来源目录可为多个任务共用，只读取当前 record 明确引用的文件，绝不递归整包。
  const sourceId = String(record.aweme_id || workflowId);
  if (workflowStore.WORKFLOW_ID_PATTERN.test(sourceId)) {
    const sourceRoot = path.join(mediaRoot, sourceId);
    const visit = async (value, depth = 0) => {
      if (depth > 15 || !value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string' && /^(?:local_path|audio_path|srt_path|output_path|transcript_path|path)$/.test(key)) {
          const candidate = path.isAbsolute(item) ? item : path.resolve(sourceRoot, item);
          if (within(candidate, sourceRoot) && !/(?:^|[\\/])agent_runs[\\/]/.test(path.relative(sourceRoot, candidate))) {
            await add(candidate, mediaRoot, `files/source/${path.relative(sourceRoot, candidate)}`);
          }
        } else if (item && typeof item === 'object') await visit(item, depth + 1);
      }
    };
    await visit(record);
  }
  // 记录已登记而磁盘上缺失的产物；缺失同样是有用的诊断信息。
  const artifacts = record.creationModeId === 'illustrated-narration-v1'
    ? Object.values(record.illustrated?.artifacts || {}).map(a => ({ ...a, prefix: 'files/illustrated-media' }))
    : [record.whiteboard?.media, ...(record.whiteboard?.mediaHistory || [])].filter(Boolean)
      .flatMap(media => (media.artifacts || []).map(a => ({ ...a, prefix: `files/whiteboard-artifacts/${a.attemptId}` })));
  for (const artifact of artifacts) {
    const entry = plan.files.find(item => item.name === `${artifact.prefix}/${artifact.fileName}`);
    if (entry) entry.expected = { bytes: artifact.bytes, sha256: artifact.sha256 };
    else if (plan.includeFiles && !plan.skipped.some(item => item.path === `${artifact.prefix}/${artifact.fileName}`)) {
      skip(`${artifact.prefix}/${artifact.fileName}`, '任务已登记的产物缺失。');
    }
  }
  return plan;
}

async function buildBundle(workflowId, destination, options = {}, onProgress = () => {}) {
  const plan = await collectPlan(workflowId, options);
  const manifest = { schema_version: 1, workflow_id: workflowId, collected_at: plan.startedAt,
    include_files: plan.includeFiles, running: ['queued', 'running', 'processing'].includes(plan.record.status)
      || plan.record.task_status === 'running', estimated_file_bytes: plan.estimatedBytes,
    limits: LIMITS, files: [], skipped: plan.skipped, api_records: 0, warnings: [
      '此包是采集期间的资料快照；制作中的文件和记录可能变化。',
      '历史版本未保存的事件、堆栈、请求和被截断内容无法补回。',
      '诊断保留创作内容；分享前请检查。导出不会重新请求模型。',
    ] };
  const secrets = requestSecrets('', { body: JSON.stringify(plan.record) });
  const zip = new ZipFile();
  const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  // 从开始就监听错误，管道使用背压，媒体不会整体读入内存。
  zip.on('error', error => zip.outputStream.destroy(error));
  const completion = pipeline(zip.outputStream, output);
  let outputError;
  completion.catch(error => { outputError = error; });
  let bytesAdded = 0;
  const addBuffer = async (name, buffer, compress = true) => {
    if (outputError) throw outputError;
    if (bytesAdded + buffer.length > LIMITS.totalBytes) { manifest.skipped.push({ path: name, reason: '达到导出总量上限。' }); return false; }
    bytesAdded += buffer.length;
    let sourceBuffer = buffer;
    const input = new Readable({ read() { this.push(sourceBuffer); sourceBuffer = null; this.push(null); } });
    const consumed = finished(input);
    consumed.catch(() => {});
    zip.addReadStreamLazy(name, { size: buffer.length, compress }, callback => callback(null, input));
    await Promise.race([consumed, completion]);
    manifest.files.push({ path: name, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') });
    return true;
  };
  const addJson = (name, value) => addBuffer(name, Buffer.from(JSON.stringify(clean(omitLargeBinary(value), secrets), null, 2)));
  try {
    await addJson('task/workflow.json', plan.record);
    await addJson('diagnostics/export-environment.json', environmentSnapshot());
    onProgress({ phase: 'packing', message: '正在打包任务资料…', estimatedBytes: plan.estimatedBytes,
      totalFiles: plan.files.length, completedFiles: 0 });

    // 上界固定在第一次列表读取时，避免运行中不断新增记录导致导出不结束。
    const apiStore = options.apiCallStore;
    let before = 0, apiBytes = 0, apiCount = 0;
    if (!apiStore) manifest.warnings.push('API 记录存储不可用，本包未包含 API 请求与返回。');
    try {
    while (apiStore && apiCount < LIMITS.apiRecords) {
      const page = apiStore.list({ workflowId, before, limit: 100 });
      for (const summary of page.records) {
        if (apiCount >= LIMITS.apiRecords) break;
        const detail = apiStore.get(summary.id);
        if (!detail || String(detail.workflow_id) !== String(workflowId)) continue;
        let body = detail.body_text || '', request = detail.request_body_text || '';
        const binary = detail.body_encoding === 'base64';
        if (binary) body = `[二进制响应未放入 API 文本；已保存 ${detail.response_bytes} 字节，编码 Base64。请检查对应任务媒体。]`;
        else body = omitBinaryText(body);
        request = omitBinaryText(request);
        const bodyBuffer = Buffer.from(scrubText(redactBody(body, detail.content_type, secrets)));
        const requestBuffer = Buffer.from(scrubText(redactBody(request, '', secrets)));
        const prefix = `api-calls/${summary.sequence}-${summary.id}`;
        const exported = { ...detail, body_text: undefined, request_body_text: undefined,
          response_file: `${prefix}/response.txt`, request_file: `${prefix}/request.txt`, binary_omitted: binary };
        if (plan.includeFiles) {
          const mediaFiles = [];
          const attachment = async value => {
            if (typeof value !== 'string') return;
            const raw = value.replace(/^data:(?:image|audio|video)\/[^;]+;base64,/i, '');
            if (raw.length < 16 || raw.length > 90 * 1024 ** 2 || !/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) return;
            const header = Buffer.from(raw.slice(0, 64), 'base64'), extension = mediaExtension(header);
            if (!extension) return;
            const bytes = Buffer.from(raw, 'base64');
            const name = `${prefix}/media-${mediaFiles.length + 1}.${extension}`;
            if (apiBytes + bytes.length > LIMITS.apiBytes) {
              manifest.skipped.push({ path: name, reason: 'API 媒体达到合计 128 MiB 导出上限。' }); return;
            }
            if (await addBuffer(name, bytes, false)) { apiBytes += bytes.length; mediaFiles.push(name); }
          };
          if (binary) await attachment(detail.body_text);
          else {
            // 按 JSON 字符串扫描，避免重新解析长整数和重写失败返回。
            for (const token of (detail.body_text || '').matchAll(/"(?:\\.|[^"\\])*"/g)) {
              if (token[0].length > 8192 || /^"data:(?:image|audio|video)\//i.test(token[0])) {
                try { await attachment(JSON.parse(token[0])); } catch { /* 非媒体字符串不作为附件 */ }
              }
            }
          }
          exported.media_files = mediaFiles;
        }
        for (const [kind, buffer] of [['response', bodyBuffer], ['request', requestBuffer]]) {
          if (buffer.length > LIMITS.textBytes || apiBytes + buffer.length > LIMITS.apiBytes) {
            manifest.skipped.push({ path: `${prefix}/${kind}.txt`, reason: 'API 正文超过单条 16 MiB 或合计 128 MiB 导出上限。' });
            exported[`${kind}_export_omitted`] = true;
          } else { await addBuffer(`${prefix}/${kind}.txt`, buffer); apiBytes += buffer.length; }
        }
        await addJson(`${prefix}/record.json`, exported);
        if (detail.body_truncated || detail.request_body_truncated || detail.transport_status === 'incomplete'
          || ['unavailable', 'omitted'].includes(detail.request_body_status)) {
          manifest.warnings.push(`API ${summary.sequence} 存在未保存、截断或未完成的内容，详见 record.json。`);
        }
        apiCount += 1;
      }
      manifest.api_records = apiCount;
      onProgress({ message: `正在打包 API 请求与返回…已收集 ${apiCount} 条。` });
      if (!page.nextCursor) break;
      if (apiCount >= LIMITS.apiRecords) { manifest.warnings.push('API 记录超过 2000 条，较早记录未导出。'); break; }
      before = page.nextCursor;
      await new Promise(resolve => setImmediate(resolve));
    }
    } catch (error) {
      if (outputError) throw outputError;
      manifest.warnings.push('API 记录读取失败，已导出可读取的部分，其余记录未包含。');
    }

    onProgress({ message: '正在打包任务文件…' });

    for (const [index, entry] of plan.files.entries()) {
      try {
        const { stat } = await checkedFile(entry.path, entry.root);
        if (!stat.isFile() || stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs || stat.ino !== entry.ino || stat.dev !== entry.dev) throw new Error('CHANGED');
        if (TEXT.test(entry.name)) {
          const { handle } = await openChecked(entry.path, entry.root, entry);
          let text;
          try {
            text = await readLimitedText(handle, entry.size);
            const after = await handle.stat();
            if (after.mtimeMs !== entry.mtimeMs || after.size !== entry.size) throw new Error('CHANGED');
          } finally { await handle.close(); }
          if (entry.expected.sha256 && entry.expected.sha256 !== crypto.createHash('sha256').update(text).digest('hex')
            || entry.expected.bytes != null && entry.expected.bytes !== entry.size) {
            manifest.warnings.push(`${entry.name} 与任务登记的大小或哈希不一致。`);
          }
          text = scrubText(redactBody(text, '', secrets));
          text = omitBinaryText(text);
          await addBuffer(entry.name, Buffer.from(text));
        } else {
          if (bytesAdded + entry.size > LIMITS.totalBytes) throw new Error('LIMIT');
          // 打开后再次核对 inode/大小，并限制读取范围，不跟随文件在打包期间的增长。
          const { handle } = await openChecked(entry.path, entry.root, entry);
          let handedOff = false;
          try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.ino !== entry.ino || opened.dev !== entry.dev || opened.size !== entry.size) throw new Error('CHANGED');
            const hash = crypto.createHash('sha256');
            const input = entry.size ? handle.createReadStream({ start: 0, end: entry.size - 1, autoClose: false }) : Readable.from([]);
            const hashing = new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); } });
            // await 每个源文件读完后再增加下一个，限制打开文件数和 ZIP 排队内存。
            zip.addReadStream(hashing, entry.name, { size: entry.size, compress: false });
            handedOff = true;
            const reading = pipeline(input, hashing);
            reading.catch(() => {});
            await Promise.race([reading, completion]);
            const sha256 = hash.digest('hex'), after = await handle.stat();
            bytesAdded += entry.size;
            manifest.files.push({ path: entry.name, bytes: entry.size, sha256 });
            if (after.size !== entry.size || after.mtimeMs !== entry.mtimeMs) manifest.warnings.push(`${entry.name} 在打包期间变化。`);
            if ((entry.expected.sha256 && entry.expected.sha256 !== sha256)
              || (entry.expected.bytes != null && entry.expected.bytes !== entry.size)) manifest.warnings.push(`${entry.name} 与任务登记的大小或哈希不一致。`);
          } catch (error) {
            // 已开始写 ZIP 的流出错时必须整体失败，不能生成看似完整的损坏 ZIP。
            if (handedOff) throw bundleError('READ_FAILED', '读取素材时失败，请等待文件写入结束后重新打包。', 409);
            throw error;
          } finally { await handle.close().catch(() => {}); }
        }
      } catch (error) {
        if (error.code === 'READ_FAILED') throw error;
        manifest.skipped.push({ path: entry.name, reason: error.code === 'ENOENT' ? '打包时文件已缺失。' : '文件变化、无法读取或达到大小上限，已跳过。' });
      }
      onProgress({ completedFiles: index + 1 });
    }
    try {
      const { handle, stat } = await openChecked(workflowStore.getWorkflowPath(workflowId, plan.rootDir), plan.rootDir);
      try {
        if (stat.size > LIMITS.textBytes) throw new Error('LIMIT');
        const current = JSON.parse(await readLimitedText(handle, stat.size));
        if (JSON.stringify(current) !== JSON.stringify(plan.record)) manifest.warnings.push('任务记录在打包期间更新，本包使用开始采集时的任务记录。');
      } finally { await handle.close(); }
    } catch { manifest.warnings.push('打包完成时无法再次读取任务记录。'); }
    manifest.completed_at = new Date().toISOString();
    manifest.original_file_bytes_added = bytesAdded;
    const error = plan.record.error || plan.record.last_failure || plan.record.illustrated?.lastError;
    const summary = ['# MuseDock 任务诊断', '', `任务 ID：${workflowId}`,
      `创作模式：${plan.record.creationModeDisplayNameSnapshot || plan.record.creationModeId || 'HyperFrames'}`,
      `任务状态：${plan.record.status || '未知'}；采集时运行中：${manifest.running ? '是' : '否'}`,
      `当前阶段：${plan.record.current_stage || plan.record.last_failure?.stage || '见任务记录'}`,
      `采集开始：${manifest.collected_at}`, `采集结束：${manifest.completed_at}`, '',
      '## 错误详情', '', JSON.stringify(clean(error || { message: plan.record.message || '没有已保存错误。' }, secrets), null, 2), '',
      '## 包含资料', '', `文件 ${manifest.files.length} 个；API 记录 ${manifest.api_records} 条；跳过项 ${manifest.skipped.length} 个。`,
      'task/workflow.json 为任务快照；diagnostics 为已保存事件、失败与环境；api-calls 为本任务请求和返回；files 为相关产物。', '',
      '## 完整性说明', '', ...manifest.warnings.map(item => `- ${item}`), '',
      '缺失、排除或达到大小限制的文件见 manifest.json 的 skipped；关联文件最多 4000 个，API 附件单独计数。本包用于诊断，不是可直接恢复的备份。',
      '只记录导出时当前环境和已保存的启动环境；未记录的历史运行环境无法补回。',
      '建议先阅读本摘要，再检查 diagnostics 和失败阶段的 API 返回。'].join('\n');
    await addBuffer('诊断摘要.md', Buffer.from(scrubText(summary)));
    zip.addBuffer(Buffer.from(JSON.stringify(clean(manifest, secrets), null, 2)), 'manifest.json');
    zip.end();
    await completion;
    return { bytes: (await fsp.stat(destination)).size, fileCount: manifest.files.length,
      apiRecords: manifest.api_records, skippedCount: manifest.skipped.length, warningCount: manifest.warnings.length };
  } catch (error) {
    zip.outputStream.destroy(error);
    await completion.catch(() => {});
    await fsp.rm(destination, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { LIMITS, clean, omitBinaryText, checkedFile, collectPlan, buildBundle, bundleError };
