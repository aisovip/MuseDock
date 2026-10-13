import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import express from 'express';

const require = createRequire(import.meta.url);
const { createBundleJobs } = require('../server/services/diagnostics/taskDiagnosticBundleJobs');
const { readZip } = require('./helpers/diagnostic-zip.cjs');
const ID = '202610130000000031';
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'musedock-bundle-ui-'));
let vite, server, browser, jobs;
try {
  const rootDir = path.join(base, 'workflows');
  await fs.mkdir(rootDir, { recursive: true });
  await fs.writeFile(path.join(rootDir, `${ID}.json`), JSON.stringify({ workflow_id: ID, status: 'failed', error: { message: '离线界面验证' } }));
  jobs = createBundleJobs({ rootDir, mediaRoot: path.join(base, 'media'), directory: path.join(base, 'bundles'), apiCallStore: null });
  const virtual = 'virtual:task-bundle-ui.jsx';
  vite = await createServer({ configFile: fileURLToPath(new URL('../frontend-react/vite.config.js', import.meta.url)),
    server: { middlewareMode: true, hmr: false, proxy: {} }, appType: 'custom',
    plugins: [{ name: 'task-bundle-fixture', resolveId(id) { if (id === virtual) return '\0' + virtual; },
      load(id) { if (id === '\0' + virtual) return `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {TaskBundleButton} from '/src/components/diagnostics/TaskBundleButton.jsx';
        import '/src/styles.css';
        createRoot(document.getElementById('root')).render(React.createElement('div',{style:{padding:24}},React.createElement(TaskBundleButton,{workflowId:'${ID}'})));`; },
    }] });
  const app = express(); app.use(express.json()); app.locals.taskDiagnosticBundles = jobs;
  app.use('/api/creative-workflows/:workflow_id/diagnostic-bundles', require('../server/routes/taskDiagnosticBundles'));
  app.get('/__bundle-ui', async (req, res) => res.type('html').send(await vite.transformIndexHtml(req.path,
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import '${virtual}';</script></body></html>`)));
  app.use(vite.middlewares);
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(`${origin}/__bundle-ui`);
  await page.getByRole('button', { name: '打包任务详情', exact: true }).click();
  await page.getByRole('button', { name: '开始打包', exact: true }).waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === '开始打包')?.disabled);

  // POST 错误不能被后续成功的 preview 清掉。
  const createPath = `**/api/creative-workflows/${ID}/diagnostic-bundles`;
  await page.route(createPath, route => route.request().method() === 'POST'
    ? route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ message: '离线测试：打包队列繁忙' }) }) : route.continue());
  await page.getByRole('button', { name: '开始打包', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '打包队列繁忙' }).waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === '开始打包')?.disabled);
  assert.ok(await page.getByRole('alert').filter({ hasText: '打包队列繁忙' }).isVisible());
  await page.unroute(createPath);

  await page.getByRole('button', { name: '开始打包', exact: true }).click();
  await page.getByRole('button', { name: '下载 ZIP', exact: true }).waitFor();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 ZIP', exact: true }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  assert.ok(readZip(await fs.readFile(downloadPath)).has('诊断摘要.md'));
  await page.getByText('已请求下载，请检查浏览器下载列表；完成后可将 ZIP 发给开发者。').waitFor();
  await page.getByRole('button', { name: '关闭', exact: true }).last().click();

  // 重启/过期的 ready 状态，重开弹窗需回到可重新打包状态。
  await page.route(`**/api/creative-workflows/${ID}/diagnostic-bundles/*`, route => {
    if (!route.request().url().endsWith('/preview') && route.request().method() === 'GET') return route.fulfill({ status: 404,
      contentType: 'application/json', body: JSON.stringify({ message: '诊断包已过期，请重新打包。' }) });
    return route.continue();
  });
  await page.getByRole('button', { name: '打包任务详情', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '已过期' }).waitFor();
  await page.getByRole('button', { name: '开始打包', exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭', exact: true }).last().click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打包任务详情', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.ok(bounds.height <= 844);
  await page.getByRole('combobox', { name: '打包内容' }).click();
  await page.getByRole('option', { name: '诊断包＋素材与工程文件', exact: true }).click();
  await page.getByText('包含诊断资料及本任务关联的图片、音频、字幕、工程和中间产物。大型视频可能使压缩包很大。').waitFor();
  assert.deepEqual(errors, []);
  console.log('诊断弹窗桌面/390px、提交失败保持、真实 ZIP 下载、关闭重开过期恢复、导出模式切换通过（隔离 Chrome，无外部请求）');
} finally {
  await browser?.close();
  await vite?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await jobs?.close();
  await fs.rm(base, { recursive: true, force: true });
}
