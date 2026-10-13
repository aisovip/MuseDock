const assert = require('node:assert/strict');
const express = require('express');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readZip } = require('./helpers/diagnostic-zip.cjs');
const { createBundleJobs } = require('../server/services/diagnostics/taskDiagnosticBundleJobs');
const locks = require('../server/services/diagnostics/taskDiagnosticLocks');
const workflows = require('../server/services/creative/creativeWorkflows');
const maintenance = require('../server/services/systemMaintenance');
const ID = '202610130000000011', OTHER = '202610130000000012';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'musedock-bundle-route-'));
  const rootDir = path.join(base, 'data', 'creative-workflows'), mediaRoot = path.join(base, 'data', 'media', 'douyin');
  const directory = path.join(base, 'bundles');
  await fsp.mkdir(rootDir, { recursive: true });
  await fsp.writeFile(path.join(rootDir, `${ID}.json`), JSON.stringify({ workflow_id: ID, status: 'failed', error: { message: '离线失败' } }));
  const jobs = createBundleJobs({ rootDir, mediaRoot, directory, apiCallStore: null });
  const app = express(); app.use(express.json()); app.locals.taskDiagnosticBundles = jobs;
  app.use('/api/creative-workflows/:workflow_id/diagnostic-bundles', require('../server/routes/taskDiagnosticBundles'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  const prefix = `http://127.0.0.1:${server.address().port}/api/creative-workflows/${ID}/diagnostic-bundles`;
  try {
    const preview = await fetch(`${prefix}/preview?include_files=0`);
    assert.equal(preview.status, 200);
    assert.ok(Number.isFinite((await preview.json()).estimated_bytes));
    const invalid = await fetch(prefix, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"includeFiles":"yes"}' });
    assert.equal(invalid.status, 400);
    const missing = await fetch(prefix.replace(ID, OTHER), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(missing.status, 404);

    const response = await fetch(prefix, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 202);
    let job = await response.json();
    const firstId = job.id;
    const wrongTask = await fetch(`${prefix.replace(ID, OTHER)}/${job.id}`);
    assert.equal(wrongTask.status, 404, '不能下载其他任务的压缩包');
    for (let attempt = 0; attempt < 200 && job.status !== 'ready'; attempt++) {
      await pause(10);
      job = await (await fetch(`${prefix}/${job.id}`)).json();
      assert.notEqual(job.status, 'failed', job.message);
    }
    assert.equal(job.status, 'ready');
    assert.equal(job.id, firstId);
    const downloaded = await fetch(`${prefix}/${job.id}/file`);
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get('content-type'), /application\/zip/);
    assert.match(downloaded.headers.get('content-disposition'), /attachment/);
    assert.equal(downloaded.headers.get('cache-control'), 'no-store');
    const zip = readZip(Buffer.from(await downloaded.arrayBuffer()));
    assert.ok(zip.has('task/workflow.json'));
    assert.ok(zip.has('诊断摘要.md'));

    // 非检查后上锁：实际导出锁持有期间，删除和系统清理均不得动资料。
    const release = locks.beginExport(rootDir, ID);
    const deleted = await workflows.deleteCreativeWorkflow(ID, { rootDir, mediaRoot });
    assert.equal(deleted.statusCode, 409);
    const cleanup = await maintenance.cleanupTargets({ targets: ['creative-workflows'], rootDir: base,
      hasRunningCreativeTasks: async () => false });
    assert.equal(cleanup.success, false);
    assert.match(cleanup.message, /打包/);
    await fsp.access(path.join(rootDir, `${ID}.json`));
    release();
    const cleaning = locks.beginCleanup();
    await assert.rejects(jobs.start(ID), error => error.statusCode === 409);
    cleaning();

    // 对并发 POST 复用同一任务，并在失败后释放锁。
    let releaseBuild;
    const blocking = createBundleJobs({ rootDir, directory: path.join(base, 'blocking'), apiCallStore: null,
      buildBundle: async () => { await new Promise(resolve => { releaseBuild = resolve; }); throw new Error('SIMULATED'); } });
    try {
      const [first, duplicate] = await Promise.all([blocking.start(ID), blocking.start(ID)]);
      assert.equal(first.id, duplicate.id);
      await assert.rejects(blocking.start(ID, { includeFiles: true }), error => error.statusCode === 409);
      for (let i = 0; !releaseBuild && i < 100; i++) await pause(5);
      assert.ok(releaseBuild);
      releaseBuild();
      for (let i = 0; blocking.get(ID, first.id).status !== 'failed' && i < 100; i++) await pause(5);
      assert.equal(blocking.get(ID, first.id).status, 'failed');
      const deleting = locks.beginDelete(rootDir, ID);
      assert.ok(deleting, '失败后必须释放导出锁'); deleting();
    } finally { await blocking.close(); }
    // 过期文件回收；只操作服务拥有的 ZIP 文件。
    const stale = path.join(directory, '11111111-1111-4111-8111-111111111111.zip');
    await fsp.writeFile(stale, 'old');
    await fsp.utimes(stale, new Date(0), new Date(0));
    await jobs.prune();
    await assert.rejects(fsp.access(stale));
    console.log('任务诊断下载接口、异步状态、任务隔离、重复提交、删除清理互斥、失败释放及过期清理通过');
  } finally {
    await jobs.close();
    await new Promise(resolve => server.close(resolve));
    await fsp.rm(base, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
