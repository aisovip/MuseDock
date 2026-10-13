const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { readZip } = require('./helpers/diagnostic-zip.cjs');
const { buildBundle, collectPlan } = require('../server/services/diagnostics/taskDiagnosticBundle');
const { createApiCallStore } = require('../server/services/diagnostics/apiCallStore');
const diagnostics = require('../server/services/diagnostics/taskDiagnosticRecords');
const ID = '202610130000000001', OTHER = '202610130000000002';
const ATTEMPT = '11111111-1111-4111-8111-111111111111';

async function write(file, value) { await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, value); }
function json(files, name) { return JSON.parse(files.get(name).toString()); }

(async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'musedock-bundle-'));
  const rootDir = path.join(base, 'workflows'), mediaRoot = path.join(base, 'media');
  let apiStore;
  try {
    apiStore = createApiCallStore({ directory: path.join(base, 'api') });
    const apiImage = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const apiAudio = Buffer.from('RIFF0000WAVEoffline-audio');
    for (let index = 0; index < 155; index++) {
      const id = apiStore.start({ workflow_id: ID, category: 'text', request_body_text: '{"input":"正文","apiKey":"test-secret"}', request_body_status: 'captured' });
      apiStore.update(id, { transport_status: 'complete', http_status: index === 0 ? 500 : 200,
        body_text: index === 0 ? '{"error":"test-secret","number":9223372036854775807}' : index === 1 ? apiImage.toString('base64')
          : index === 2 ? JSON.stringify({ audio: `data:audio/wav;base64,${apiAudio.toString('base64')}` })
          : '{"answer":"正常","smallImage":"data:image/png;base64,AAAA","image":"' + 'A'.repeat(9000) + '"}',
        body_encoding: index === 1 ? 'base64' : 'utf8',
        body_truncated: index === 0 ? 1 : 0 });
    }
    const otherId = apiStore.start({ workflow_id: OTHER });
    apiStore.update(otherId, { body_text: 'OTHER-TASK-CONTENT', transport_status: 'complete' });
    for (const mode of ['hyperframes-v1', 'whiteboard-stream-v1', 'illustrated-narration-v1']) {
      const record = { workflow_id: ID, creationModeId: mode, status: 'failed', title: '离线任务',
        error: { message: '本地失败', code: 'MEDIA_FAILED' }, apiKey: 'test-secret',
        input: { text: '正文', url: 'https://example.invalid/source?signature=download-secret' } };
      const directory = mode === 'whiteboard-stream-v1' ? path.join(rootDir, 'whiteboard-artifacts', ID, ATTEMPT)
        : mode === 'illustrated-narration-v1' ? path.join(rootDir, '.illustrated-media', ID)
        : path.join(mediaRoot, ID, 'agent_runs', 'current-html-video');
      await write(path.join(directory, 'plan.json'), '{"title":"诊断","apiKey":"test-secret","number":9223372036854775807}');
      await write(path.join(directory, 'image.png'), Buffer.from('OFFLINE-IMAGE'));
      await write(path.join(directory, 'ai-models.json'), '{"apiKey":"DO-NOT-EXPORT"}');
      await write(path.join(rootDir, `${ID}.json`), JSON.stringify(record));
      await diagnostics.recordRun(ID, { mode }, rootDir);
      await diagnostics.recordFailure(ID, Object.assign(new Error('Authorization: Bearer test-secret'), {
        cause: new Error('password=hidden-password'), processDiagnostic: { exitCode: 3, stderrTail: 'apiKey=test-secret' },
      }), { stage: 'render' }, rootDir);
      await diagnostics.recordEvent(ID, { type: 'stage_failed', data: { cookie: 'session-secret' } }, rootDir);

      const lightPath = path.join(base, `${mode}-light.zip`);
      const light = await buildBundle(ID, lightPath, { rootDir, mediaRoot, apiCallStore: apiStore });
      assert.equal(light.apiRecords, 155, '必须导出全部分页与成功返回');
      const files = readZip(await fsp.readFile(lightPath));
      assert.ok(files.has('诊断摘要.md'));
      assert.ok(files.has('diagnostics/diagnostics.json'));
      assert.ok([...files.keys()].some(name => name.endsWith('/plan.json')));
      assert.ok(![...files.keys()].some(name => name.endsWith('.png')));
      const texts = [...files.values()].map(buffer => buffer.toString()).join('\n');
      for (const forbidden of ['test-secret', 'hidden-password', 'session-secret', 'download-secret', 'OTHER-TASK-CONTENT', 'DO-NOT-EXPORT']) assert.ok(!texts.includes(forbidden), forbidden);
      assert.ok(texts.includes('9223372036854775807'), 'API 与候选长整数必须保留原文');
      assert.ok(!texts.includes('A'.repeat(9000)), '默认包不含大段媒体 Base64');
      assert.ok(!texts.includes('data:image/png;base64,AAAA'), '默认包不含短媒体 Data URL');
      const exportedRecord = json(files, 'task/workflow.json');
      assert.equal(exportedRecord.input.text, '正文');
      assert.equal(exportedRecord.apiKey, '[已隐藏]');
      const manifest = json(files, 'manifest.json');
      assert.ok(manifest.warnings.some(value => value.includes('截断')));
      for (const item of manifest.files) {
        assert.equal(crypto.createHash('sha256').update(files.get(item.path)).digest('hex'), item.sha256);
      }
      const fullPath = path.join(base, `${mode}-full.zip`);
      await buildBundle(ID, fullPath, { rootDir, mediaRoot, apiCallStore: apiStore, includeFiles: true });
      const full = readZip(await fsp.readFile(fullPath));
      assert.ok([...full.keys()].some(name => name.endsWith('/image.png')));
      assert.ok([...full.values()].some(bytes => bytes.equals(Buffer.from('OFFLINE-IMAGE'))));
      assert.ok([...full.keys()].some(name => name.startsWith('api-calls/') && name.endsWith('.png')));
      assert.ok([...full.keys()].some(name => name.startsWith('api-calls/') && name.endsWith('.wav')));
      assert.ok([...full.values()].some(bytes => bytes.equals(apiAudio)));
    }

    // 共享来源仅打包任务明确引用的文件，不混入其他 task 的工程。
    const shared = '202610130000000099';
    await write(path.join(mediaRoot, shared, 'needed.txt'), 'REFERENCED');
    await write(path.join(mediaRoot, shared, 'unrelated.txt'), 'SHARED-UNRELATED');
    await write(path.join(mediaRoot, shared, 'agent_runs', 'other', 'project.json'), 'OTHER-RUN');
    await write(path.join(rootDir, `${ID}.json`), JSON.stringify({ workflow_id: ID, aweme_id: shared,
      status: 'running', asset_context: { assets: [{ local_path: path.join(mediaRoot, shared, 'needed.txt') }] } }));
    const target = path.join(base, 'shared.zip');
    await buildBundle(ID, target, { rootDir, mediaRoot, apiCallStore: null, includeFiles: true }, progress => {
      if (progress.phase === 'packing') require('node:fs').writeFileSync(path.join(rootDir, `${ID}.json`), JSON.stringify({ workflow_id: ID, status: 'done' }));
    });
    const sharedFiles = readZip(await fsp.readFile(target));
    assert.ok(sharedFiles.has('files/source/needed.txt'));
    assert.ok(![...sharedFiles.keys()].some(name => name.includes('unrelated') || name.includes('other/project')));
    assert.ok(json(sharedFiles, 'manifest.json').warnings.some(value => value.includes('任务记录在打包期间更新')));
    const brokenPath = path.join(base, 'broken-api.zip');
    await buildBundle(ID, brokenPath, { rootDir, mediaRoot, apiCallStore: { list() { throw new Error('broken database'); } } });
    assert.ok(json(readZip(await fsp.readFile(brokenPath)), 'manifest.json').warnings.some(value => value.includes('API 记录读取失败')));

    // 文件链接和目录 junction 均拒绝；Windows 无符号链接权限时 junction 仍可核验。
    const outside = path.join(base, 'outside');
    await write(path.join(outside, 'escape.txt'), 'OUTSIDE-PRIVATE');
    const own = path.join(mediaRoot, ID);
    await fsp.mkdir(own, { recursive: true });
    await fsp.symlink(outside, path.join(own, 'escape'), 'junction');
    const plan = await collectPlan(ID, { rootDir, mediaRoot, includeFiles: true });
    assert.ok(!plan.files.some(file => file.name.includes('escape')));
    assert.ok(plan.skipped.some(file => file.path.includes('escape')));
    await assert.rejects(collectPlan('../bad', { rootDir }), /任务 ID/);
    await assert.rejects(collectPlan(OTHER, { rootDir }), error => error.statusCode === 404);
    console.log('任务诊断包：三模式、ZIP 解压、分页隔离、脱敏、长整数、Base64、哈希、共享来源及路径边界通过');
  } finally {
    apiStore?.close();
    await fsp.rm(base, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
