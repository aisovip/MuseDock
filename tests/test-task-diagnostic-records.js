const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execute } = require('../server/services/creative/whiteboard/mediaTools');
const records = require('../server/services/diagnostics/taskDiagnosticRecords');
const tasks = require('../server/services/creative/creativeWorkflowTasks');
const workflows = require('../server/services/creative/creativeWorkflows');
const { createCreativeTaskRegistry } = require('../server/services/creative/creativeTaskRegistry');
const ID = '202610130000000021';

(async () => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'musedock-diagnostic-records-'));
  try {
    await fsp.writeFile(path.join(rootDir, `${ID}.json`), JSON.stringify({ workflow_id: ID, status: 'running' }));
    await records.recordRun(ID, { task_id: 'run-1' }, rootDir);
    await Promise.all(Array.from({ length: 410 }, (_, seq) => records.recordEvent(ID, {
      seq, type: 'stage_progress', data: { apiKey: 'do-not-store', nested: 'X'.repeat(20000) },
    }, rootDir)));
    let stored = JSON.parse(await fsp.readFile(records.diagnosticPath(ID, rootDir), 'utf8'));
    assert.equal(stored.events.length, 400);
    assert.equal(stored.dropped_events, 10);
    assert.ok(!JSON.stringify(stored).includes('do-not-store'));
    assert.equal(stored.runs[0].environment.node, process.version);

    const error = await execute(process.execPath, ['-e', 'process.stderr.write("apiKey=process-secret\\n"+"x".repeat(7000)+"\\nFINAL-process failed");process.exit(7)'])
      .then(() => assert.fail('必须失败'), failure => failure);
    assert.equal(error.processDiagnostic.exitCode, 7);
    assert.match(error.processDiagnostic.stderrTail, /process failed/);
    assert.ok(error.processDiagnostic.stderrTail.endsWith('FINAL-process failed'));
    assert.ok(!JSON.stringify(error.processDiagnostic).includes('process-secret'));
    await records.recordFailure(ID, error, { stage: 'render' }, rootDir);
    stored = JSON.parse(await fsp.readFile(records.diagnosticPath(ID, rootDir), 'utf8'));
    assert.equal(stored.failures.at(-1).process.exitCode, 7);

    // 覆盖真实后台任务 start / 事件 / catch / 终态接线，无模型调用。
    const registry = createCreativeTaskRegistry();
    const started = await tasks.startCreativeWorkflowTask(ID, { rootDir, registry,
      services: { creativeWorkflows: {
        patchCreativeWorkflowTaskSummary: workflows.patchCreativeWorkflowTaskSummary,
        runCreativeWorkflow: async (id, options) => {
          await options.taskContext.emit({ type: 'stage_started', stage: 'render', message: '正在离线渲染' });
          throw new Error('offline failure password=offline-secret');
        },
      } } });
    for (let index = 0; registry.getTask(started.task_id).status === 'running' && index < 200; index++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(registry.getTask(started.task_id).status, 'failed');
    stored = JSON.parse(await fsp.readFile(records.diagnosticPath(ID, rootDir), 'utf8'));
    assert.ok(stored.events.some(event => event.type === 'task_started'));
    assert.ok(stored.events.some(event => event.type === 'stage_started'));
    assert.ok(stored.events.some(event => event.type === 'task_failed'));
    assert.ok(stored.failures.some(failure => failure.stack.includes('offline failure')));
    assert.ok(!JSON.stringify(stored).includes('offline-secret'));

    await fsp.unlink(path.join(rootDir, `${ID}.json`));
    const before = await fsp.readFile(records.diagnosticPath(ID, rootDir), 'utf8');
    await records.recordFailure(ID, new Error('after deletion'), {}, rootDir);
    assert.equal(await fsp.readFile(records.diagnosticPath(ID, rootDir), 'utf8'), before);
    console.log('诊断事件有界持久化、脱敏、执行环境、子进程退出信息、后台失败接线和删除后不重建通过');
  } finally { await fsp.rm(rootDir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
