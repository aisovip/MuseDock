const assert = require('node:assert/strict');
const { callTextModel } = require('../server/services/ai/aiTextModel');
const { runWithApiCallContext } = require('../server/services/diagnostics/apiCallRecorder');

const schema = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } };
const protocols = ['openai-responses', 'openai-chat-completions', 'anthropic-messages'];
const config = protocol => ({ enabled: true, apiKey: 'fixture-key', baseUrl: 'https://example.invalid/v1',
  modelId: 'fixture-model', protocol });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const reply = protocol => protocol === 'anthropic-messages'
  ? { content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' }
  : protocol === 'openai-chat-completions' ? { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }
    : { output_text: '{"ok":true}', status: 'completed' };
const call = (protocol, options) => runWithApiCallContext({ store: { start: () => null } }, () => callTextModel({
  textConfig: config(protocol), messages: [{ role: 'user', content: '返回 JSON 对象' }],
  maxRetries: 0, retryDelayMs: 1, ...options,
}));
function checkFormat(body, protocol, outputFormat) {
  if (protocol === 'anthropic-messages') {
    assert.equal(body.response_format, undefined);
    assert.equal(body.text, undefined);
    if (outputFormat) assert.match(body.system, /有效 JSON/);
    else assert.equal(body.system, undefined);
  } else {
    const expected = !outputFormat ? undefined : protocol === 'openai-responses' && outputFormat.schema
      ? { type: 'json_schema', name: outputFormat.name, schema: outputFormat.schema, strict: true }
      : { type: 'json_object' };
    assert.deepEqual(protocol === 'openai-responses' ? body.text?.format : body.response_format, expected);
  }
  assert.equal(body.outputFormat, undefined, '业务语义字段不能直接发送给供应商');
}

(async () => {
  for (const protocol of protocols) {
    for (const outputFormat of [undefined, { type: 'json' }, { type: 'json', name: 'fixture', schema }]) {
      const result = await call(protocol, { outputFormat, fetchImpl: async (_url, init) => {
        checkFormat(JSON.parse(init.body), protocol, outputFormat);
        return json(reply(protocol));
      } });
      assert.equal(result.success, true);
    }
    let rejectedCalls = 0;
    const rejected = await call(protocol, { outputFormat: { type: 'json' }, maxRetries: 3,
      fetchImpl: async (_url, init) => {
        rejectedCalls += 1; checkFormat(JSON.parse(init.body), protocol, { type: 'json' });
        return json({ error: { message: 'unsupported format' } }, 400);
      },
    });
    assert.equal(rejected.success, false);
    assert.equal(rejectedCalls, 1, '400 格式拒绝不能去掉约束或自动重发');
  }
  for (const protocol of [undefined, 'unrecognized']) {
    await call(protocol, { outputFormat: { type: 'json', name: 'fixture', schema }, fetchImpl: async (url, init) => {
      assert.ok(url.endsWith('/responses'));
      checkFormat(JSON.parse(init.body), 'openai-responses', { type: 'json', name: 'fixture', schema });
      return json(reply('openai-responses'));
    } });
  }
  const explicit = { type: 'json_schema', name: 'advanced', schema, strict: true };
  await call('openai-chat-completions', { outputFormat: { type: 'json' }, response_format: explicit,
    fetchImpl: async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body).response_format, { type: 'json_schema', json_schema: {
        name: 'advanced', schema, strict: true,
      } });
      return json(reply('openai-chat-completions'));
    },
  });
  for (const protocol of ['openai-responses', 'openai-chat-completions']) {
    for (const failure of ['missing_text', 'http_retry', 'gateway_fallback', 'request_timeout', 'stream_timeout']) {
      const requests = [];
      const stream = ['gateway_fallback', 'request_timeout', 'stream_timeout'].includes(failure);
      const result = await call(protocol, { outputFormat: { type: 'json' },
        maxRetries: stream ? 0 : 1, stream, onDelta: () => {}, fallbackToNonStreamOnGatewayTimeout: stream,
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(init.body); requests.push(body); checkFormat(body, protocol, { type: 'json' });
          if (requests.length === 1) {
            if (failure === 'missing_text') return json({ choices: [], output: [] });
            if (failure === 'http_retry') return json({ error: { message: 'fixture unavailable' } }, 502);
            if (failure === 'gateway_fallback') return json({ error: { message: 'fixture gateway timeout' } }, 504);
            if (failure === 'request_timeout') throw Object.assign(new Error('fixture timeout'), { name: 'AbortError' });
            return new Response(new ReadableStream({ start(controller) {
              controller.error(Object.assign(new Error('fixture stream timeout'), { name: 'AbortError' }));
            } }), { headers: { 'content-type': 'text/event-stream' } });
          }
          return json(reply(protocol));
        },
      });
      assert.equal(result.success, true, `${protocol}: ${failure}`);
      assert.equal(requests.length, 2, `${failure} 必须沿用同一格式约束`);
      if (stream) { assert.equal(requests[0].stream, true); assert.equal(requests[1].stream, undefined); }
    }
  }
  console.log('PASS 共用 JSON 输出：三协议语义映射、严格 Schema、普通文本、默认协议、显式格式兼容、格式拒绝及所有重试/流式降级保留约束；真实 provider 调用 0。');
})().catch(error => { console.error(error); process.exitCode = 1; });
