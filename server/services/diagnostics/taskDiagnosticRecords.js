const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const fsp = require('fs/promises');
const { redactValue, redactText } = require('./apiCallRedaction');
const store = require('../creative/workflowStore');

const MAX_EVENTS = 400;
const MAX_FAILURES = 20;
const MAX_RUNS = 20;
const SOURCE_FILES = ['creative/workflowStore.js', 'creative/creativeWorkflowTasks.js',
  'creative/whiteboard/mediaTools.js', 'creative/whiteboard/productionWorkflows.js', 'creative/illustrated/runner.js'];
const sourceIdentity = (() => {
  const hash = crypto.createHash('sha256');
  try {
    for (const file of SOURCE_FILES) { hash.update(file); hash.update(fs.readFileSync(path.join(__dirname, '..', file))); }
    return { files: SOURCE_FILES, sha256: hash.digest('hex'), captured_at_module_load: new Date().toISOString() };
  } catch { return { available: false, reason: '当前安装包无法读取源码指纹。' }; }
})();

function scrubText(value) {
  return redactText(value).replace(/\b[A-Za-z]:[\\/][^\r\n"<>|]*|\/(?:Users|home|tmp|var|opt|private)\/[^\s"<>]+/g, '[本地路径]');
}

function boundedValue(value, depth = 0) {
  if (typeof value === 'string') return scrubText(value).slice(0, 2048);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 4) return '[嵌套内容已省略]';
  if (Array.isArray(value)) return value.slice(0, 20).map(item => boundedValue(item, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(redactValue(value)).slice(0, 30)
    .map(([key, item]) => [key, boundedValue(item, depth + 1)]));
  return undefined;
}

function failureDetails(error) {
  const processDetails = boundedValue(error?.processDiagnostic || {});
  if (typeof error?.processDiagnostic?.stderrTail === 'string') processDetails.stderrTail = scrubText(error.processDiagnostic.stderrTail).slice(-8000);
  if (typeof error?.processDiagnostic?.stdoutTail === 'string') processDetails.stdoutTail = scrubText(error.processDiagnostic.stdoutTail).slice(-2000);
  return {
    name: scrubText(error?.name || 'Error').slice(0, 100),
    code: scrubText(error?.code || '').slice(0, 100),
    message: scrubText(error?.message || '').slice(0, 4096),
    stack: scrubText(error?.stack || '').slice(-12000),
    cause: error?.cause ? boundedValue({ name: error.cause.name, code: error.cause.code, message: error.cause.message }) : null,
    process: processDetails,
    detail: scrubText(error?.detail || error?.stderr || '').slice(-8000),
  };
}

function environmentSnapshot() {
  let appVersion = '未知';
  try { appVersion = require('../../../package.json').version; } catch { /* 打包版本可能无 package.json */ }
  return { captured_at: new Date().toISOString(), app_version: appVersion, node: process.version,
    electron: process.versions.electron || '', platform: process.platform, architecture: process.arch,
    os_release: os.release(), free_memory_bytes: os.freemem(), total_memory_bytes: os.totalmem(),
    source_identity_at_module_load: sourceIdentity };
}

function diagnosticPath(workflowId, rootDir = store.DEFAULT_ROOT) {
  store.getWorkflowPath(workflowId, rootDir);
  return path.join(rootDir, '.task-diagnostics', String(workflowId), 'diagnostics.json');
}

async function update(workflowId, rootDir, callback) {
  const file = diagnosticPath(workflowId, rootDir);
  // 诊断是辅助证据，不应让制作失败，也不能在删除后重建任务资料。
  return store.withWorkflowFileQueue(store.getWorkflowPath(workflowId, rootDir), async () => {
    if (!await store.workflowFileExists(workflowId, rootDir)) return;
    let record = { schema_version: 1, workflow_id: String(workflowId), events: [], failures: [], runs: [], dropped_events: 0 };
    try { record = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { /* 首次记录 */ }
    callback(record);
    record.updated_at = new Date().toISOString();
    await store.writeJson(file, record);
  }).catch(() => {});
}

function recordEvent(workflowId, event, rootDir) {
  const safe = boundedValue({ seq: event.seq, type: event.type, task_id: event.task_id,
    operation_id: event.operation_id, stage: event.stage, progress: event.progress,
    message: event.message, time: event.time || new Date().toISOString(), data: event.data });
  // 单个事件独立上限；保留定位字段，不把大对象截成不可解析 JSON。
  if (Buffer.byteLength(JSON.stringify(safe)) > 8192) safe.data = '[事件详情超过 8 KiB，已省略]';
  return update(workflowId, rootDir, record => {
    record.events.push(safe);
    if (record.events.length > MAX_EVENTS) record.dropped_events += record.events.length - MAX_EVENTS;
    record.events = record.events.slice(-MAX_EVENTS);
  });
}

function recordRun(workflowId, context, rootDir) {
  return update(workflowId, rootDir, record => {
    record.runs = [...record.runs, { ...boundedValue(context), environment: environmentSnapshot() }].slice(-MAX_RUNS);
  });
}

function recordFailure(workflowId, error, context, rootDir) {
  return update(workflowId, rootDir, record => {
    record.failures = [...record.failures, { ...boundedValue(context), ...failureDetails(error),
      time: new Date().toISOString() }].slice(-MAX_FAILURES);
  });
}

module.exports = { scrubText, boundedValue, failureDetails, environmentSnapshot, diagnosticPath,
  recordEvent, recordRun, recordFailure, MAX_EVENTS };
