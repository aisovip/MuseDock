import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../frontend-react/src/api/client.js', import.meta.url), 'utf8');
const { api } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const original = globalThis.fetch;
const calls = [];
try {
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ id: 'bundle-1' }) }; };
  await api.previewTaskBundle('task/id', true);
  assert.ok(calls.at(-1).url.includes('task%2Fid/diagnostic-bundles/preview?include_files=1'));
  await api.createTaskBundle('task/id', true);
  assert.equal(calls.at(-1).options.method, 'POST');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { includeFiles: true });
  await api.getTaskBundle('task/id', 'bundle/id');
  assert.ok(calls.at(-1).url.includes('task%2Fid/diagnostic-bundles/bundle%2Fid'));
  assert.ok(api.getTaskBundleFileUrl('task/id', 'bundle/id').endsWith('bundle%2Fid/file'));
  globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ message: '资料正在清理' }) });
  await assert.rejects(api.createTaskBundle('1'), error => error.status === 409 && error.message === '资料正在清理');
  globalThis.fetch = async () => { throw new Error('network'); };
  await assert.rejects(api.getTaskBundle('1', '2'), /无法连接服务/);
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, headers: new Headers({ 'Content-Type': 'application/zip' }) }; };
  await api.verifyTaskBundleDownload('1', '2');
  assert.equal(calls.at(-1).options.method, 'HEAD');
  globalThis.fetch = async () => ({ ok: false, status: 404, headers: new Headers() });
  await assert.rejects(api.verifyTaskBundleDownload('1', '2'), error => error.status === 404 && /重新打包/.test(error.message));
  for (const file of ['CreativeTaskSummary.jsx', 'whiteboard/WhiteboardTaskDetail.jsx', 'illustrated/IllustratedTaskDetail.jsx']) {
    const component = await fs.readFile(new URL(`../frontend-react/src/components/creative/${file}`, import.meta.url), 'utf8');
    assert.match(component, /<TaskBundleButton\s+workflowId=/);
  }
  console.log('任务诊断 API 客户端参数、中文错误、下载地址及三模式静态接线通过');
} finally { globalThis.fetch = original; }
