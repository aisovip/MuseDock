import assert from 'node:assert/strict';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

const server = await createServer({ configFile: 'frontend-react/vite.config.js',
  server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const { WhiteboardTaskDetail } = await server.ssrLoadModule('/src/components/creative/whiteboard/WhiteboardTaskDetail.jsx');
  const workflow = { workflow_id: '00000000000000001', title: '测试任务', status: 'failed', stages: [],
    whiteboard: { messages: [], allowedActions: [{ id: 'save_lineart_prompt' }], attempts: [],
      current: { identity: 'fixture', artifact: { title: '测试任务', aspectRatio: '16:9',
        productionPlan: { narrationMode: 'disabled' }, visualStyle: { displayName: '测试模板', description: '' }, scenes: [], cues: [] } } } };
  function render() {
    return renderToStaticMarkup(React.createElement(MemoryRouter, null,
      React.createElement(WhiteboardTaskDetail, { workflow, onAction: () => {}, onStopAndDelete: () => {} })));
  }
  for (const status of ['failed', 'unknown_external_outcome', 'waiting_approval']) {
    workflow.status = status;
    const html = render();
    const input = html.match(/<textarea\b[^>]*id="whiteboard-revision"[^>]*>/)?.[0];
    assert.ok(input, `${status} 必须显示自由输入框`);
    assert.ok(!/\sdisabled(?:=|\s|>)/.test(input), `${status} 可输入消息`);
  }
  workflow.status = 'running';
  assert.match(render().match(/<textarea\b[^>]*id="whiteboard-revision"[^>]*>/)[0], /\sdisabled(?:=|\s|>)/);
  workflow.status = 'failed';
  workflow.whiteboard.current.stale = true;
  assert.ok(!render().includes('id="whiteboard-revision"'), '旧方案不提供修改入口');
  console.log('PASS 白板 Agent 失败/未知/待确认可输入，运行中禁用，旧方案隐藏；真实接口请求 0。');
} finally { await server.close(); }
