const path = require('path');
const fsp = require('fs/promises');
const crypto = require('crypto');
const DATA_ROOT = require('../../dataRoot');
const workflowStore = require('../creative/workflowStore');
const { buildBundle, collectPlan, bundleError } = require('./taskDiagnosticBundle');
const { getApiCallStore } = require('./apiCallStore');
const { beginExport } = require('./taskDiagnosticLocks');

const TTL_MS = 30 * 60 * 1000;
function createBundleJobs(options = {}) {
  const rootDir = options.rootDir || workflowStore.DEFAULT_ROOT;
  const directory = path.resolve(options.directory || path.join(DATA_ROOT, 'data', 'task-diagnostic-bundles'));
  const jobs = new Map();
  const starting = new Map();
  let active = 0;
  let previewing = 0;
  const view = job => ({ id: job.id, workflow_id: job.workflowId, include_files: job.includeFiles,
    status: job.status, message: job.message, phase: job.phase, estimated_bytes: job.estimatedBytes || 0,
    completed_files: job.completedFiles || 0, total_files: job.totalFiles || 0,
    ...(job.result || {}), expires_at: job.expiresAt ? new Date(job.expiresAt).toISOString() : '',
    download_url: job.status === 'ready' ? `/api/creative-workflows/${job.workflowId}/diagnostic-bundles/${job.id}/file` : '' });

  // 仅删除服务拥有的 UUID.zip；重启后的过期文件也按 mtime 回收。
  async function prune() {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (job.expiresAt && job.expiresAt <= now) {
        jobs.delete(id);
        await fsp.rm(job.path, { force: true }).catch(() => {});
      }
    }
    let entries;
    try { entries = await fsp.readdir(directory); } catch { return; }
    for (const name of entries) {
      if (!/^[a-f0-9-]{36}\.zip$/.test(name) || jobs.has(name.slice(0, -4))) continue;
      const file = path.join(directory, name);
      const stat = await fsp.lstat(file).catch(() => null);
      if (stat?.isFile() && !stat.isSymbolicLink() && now - stat.mtimeMs > TTL_MS) await fsp.rm(file, { force: true }).catch(() => {});
    }
  }
  const timer = setInterval(() => { prune().catch(() => {}); }, 60 * 1000);
  timer.unref();

  async function preview(workflowId, payload) {
    validate(payload);
    if (active + previewing >= 2) throw bundleError('BUSY', '正在准备其他诊断包，请稍后再试。', 429);
    const release = beginExport(rootDir, workflowId);
    if (!release) throw bundleError('DATA_BUSY', '任务资料正在删除或清理，请稍后重试。', 409);
    previewing += 1;
    try {
      const plan = await collectPlan(workflowId, { ...options, includeFiles: payload.includeFiles });
      return { estimated_bytes: plan.estimatedBytes, total_files: plan.files.length, skipped_count: plan.skipped.length,
        message: '大小为关联文件的原始体积；API 返回和诊断摘要会另外加入，最终 ZIP 大小以打包结果为准。' };
    } finally { previewing -= 1; release(); }
  }

  function validate(payload = {}) {
    if (payload.includeFiles !== undefined && typeof payload.includeFiles !== 'boolean') throw bundleError('INVALID_OPTIONS', '打包选项无效。');
  }

  async function start(workflowId, payload = {}) {
    validate(payload);
    const pending = starting.get(workflowId);
    if (pending) {
      if (pending.includeFiles !== (payload.includeFiles === true)) throw bundleError('BUSY', '本任务正在打包，请等待完成后切换导出方式。', 409);
      return pending.promise;
    }
    const promise = startUnreserved(workflowId, payload);
    starting.set(workflowId, { promise, includeFiles: payload.includeFiles === true });
    promise.finally(() => { if (starting.get(workflowId)?.promise === promise) starting.delete(workflowId); }).catch(() => {});
    return promise;
  }

  async function startUnreserved(workflowId, payload = {}) {
    validate(payload);
    workflowStore.getWorkflowPath(workflowId, rootDir);
    const existing = [...jobs.values()].find(job => job.workflowId === workflowId && ['collecting', 'packing'].includes(job.status));
    if (existing) {
      if (existing.includeFiles !== (payload.includeFiles === true)) throw bundleError('BUSY', '本任务正在打包，请等待完成后切换导出方式。', 409);
      return view(existing);
    }
    if (active + previewing >= 2 || jobs.size >= 20) throw bundleError('BUSY', '正在准备其他诊断包或临时包过多，请稍后再试。', 429);
    const release = beginExport(rootDir, workflowId);
    if (!release) throw bundleError('DATA_BUSY', '任务资料正在删除或清理，请稍后重试。', 409);
    active += 1;
    try {
      // 不调用带状态同步副作用的任务详情 API。
      const file = workflowStore.getWorkflowPath(workflowId, rootDir);
      const stat = await fsp.lstat(file).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) throw bundleError('NOT_FOUND', '创作任务不存在或已删除。', 404);
      await fsp.mkdir(directory, { recursive: true });
      const id = crypto.randomUUID();
      const job = { id, workflowId, includeFiles: payload.includeFiles === true, path: path.join(directory, `${id}.zip`),
        status: 'collecting', phase: 'collecting', message: '正在收集任务信息…' };
      jobs.set(id, job);
      setImmediate(async () => {
        try {
          let apiCallStore = null;
          try {
            apiCallStore = Object.prototype.hasOwnProperty.call(options, 'apiCallStore')
              ? options.apiCallStore : getApiCallStore(options.apiCallLogDirectory);
          } catch { /* API 数据库损坏也应允许导出其它任务诊断。 */ }
          job.result = await (options.buildBundle || buildBundle)(workflowId, job.path,
            { ...options, apiCallStore, includeFiles: job.includeFiles }, progress => {
              Object.assign(job, progress);
              if (progress.phase) job.status = progress.phase;
            });
          job.status = 'ready'; job.message = '压缩包已准备好，可以下载并发送给开发者。';
        } catch (error) {
          job.status = 'failed';
          job.message = error.code === 'ENOSPC' ? '磁盘空间不足，无法生成压缩包，请清理空间后重试。'
            : ['EACCES', 'EPERM'].includes(error.code) ? '没有文件读写权限，请检查任务目录和临时目录权限。'
            : ['NOT_FOUND', 'TASK_UNREADABLE', 'TASK_MISMATCH', 'READ_FAILED'].includes(error.code) ? error.message
            : '任务打包失败，请检查文件、磁盘空间和本地服务后重试。';
          await fsp.rm(job.path, { force: true }).catch(() => {});
        } finally { job.expiresAt = Date.now() + TTL_MS; active -= 1; release(); }
      });
      return view(job);
    } catch (error) { active -= 1; release(); throw error; }
  }

  function getJob(workflowId, id) {
    const job = jobs.get(id);
    if (!job || job.workflowId !== workflowId || job.expiresAt && job.expiresAt <= Date.now()) {
      throw bundleError('BUNDLE_NOT_FOUND', '诊断包不存在或已过期，请重新打包。', 404);
    }
    return job;
  }
  return { preview, start, get: (workflowId, id) => view(getJob(workflowId, id)),
    file(workflowId, id) {
      const job = getJob(workflowId, id);
      if (job.status !== 'ready') throw bundleError('BUNDLE_NOT_READY', '压缩包尚未准备好，请等待打包完成。', 409);
      return { path: job.path, filename: `MuseDock-${workflowId}-${job.includeFiles ? 'files' : 'diagnostics'}.zip` };
    },
    async close() { clearInterval(timer); }, prune };
}

let defaults;
function defaultBundleJobs() { return defaults ||= createBundleJobs(); }
module.exports = { createBundleJobs, defaultBundleJobs, TTL_MS };
