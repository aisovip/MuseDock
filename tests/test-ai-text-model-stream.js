const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const aiModelConfig = require('../server/services/ai/aiModelConfig');
const { callTextModel } = require('../server/services/ai/aiTextModel');
const { runWithApiCallContext, flushApiCallRecords } = require('../server/services/diagnostics/apiCallRecorder');

const protocols = ['openai-responses', 'openai-chat-completions', 'anthropic-messages'];
const config = protocol => ({ enabled: true, provider: 'fixture', apiKey: 'fixture-key',
  baseUrl: 'https://example.invalid/v1', modelId: 'fixture-model', protocol });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const encode = events => events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
const sse = events => new Response(encode(events), { headers: { 'content-type': 'text/event-stream' } });
const complete = (protocol, text = '{"ok":true}') => protocol === 'openai-responses' ? [
  { type: 'response.output_text.delta', delta: text },
  { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } },
] : protocol === 'openai-chat-completions' ? [
  { choices: [{ index: 0, delta: { reasoning_content: '不可拼入正文' } }] },
  { choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }, '[DONE]',
] : [
  { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
  { type: 'message_stop' },
];
const tool = { type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } } };
function toolEvents(protocol) {
  if (protocol === 'openai-chat-completions') return [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-0', type: 'function', function: { name: 'lookup', arguments: '{"q":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"测试"}' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]',
  ];
  if (protocol === 'openai-responses') return [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item-0', call_id: 'call-0', name: 'lookup', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'item-0', delta: '{"q":' },
    { type: 'response.function_call_arguments.delta', item_id: 'item-0', delta: '"测试"}' },
    { type: 'response.completed', response: { status: 'completed' } },
  ];
  return [
    { type: 'message_start', message: { usage: { input_tokens: 2 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-0', name: 'lookup', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"测试"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ];
}

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'analysis-stream-'));
  const configPath = path.join(directory, 'ai-models.json');
  const stored = { providers: { fixture: { ...config('openai-responses'), models: { text: { enabled: true, modelId: 'fixture-model' } } } },
    active: { text: 'fixture/text' }, analysisStreaming: true };
  const call = (protocol, options = {}) => callTextModel({ configPath, textConfig: config(protocol),
    messages: [{ role: 'user', content: '测试' }], maxRetries: 0, retryDelayMs: 1, ...options });
  try {
    await aiModelConfig.saveConfig(stored, { configPath });
    for (const protocol of protocols) {
      const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
      const result = await call(protocol, { stream: false, outputFormat: { type: 'json', name: 'fixture', schema }, fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        assert.equal(body.stream, true, '全局开启覆盖显式 false，且无需 onDelta');
        if (protocol === 'openai-responses') assert.equal(body.text.format.type, 'json_schema');
        if (protocol === 'openai-chat-completions') {
          assert.deepEqual(body.stream_options, { include_usage: true });
          assert.equal(body.response_format.type, 'json_object');
        }
        if (protocol === 'anthropic-messages') assert.match(body.system, /有效 JSON/);
        return sse(complete(protocol));
      } });
      assert.equal(result.success, true, protocol);
      assert.deepEqual(JSON.parse(result.text), { ok: true });
      assert.equal(result.usage.prompt_tokens, 3);
      assert.equal(result.usage.completion_tokens, 4);
      const toolResult = await call(protocol, { tools: [tool], tool_choice: { type: 'function', function: { name: 'lookup' } }, fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        assert.equal(body.stream, true);
        assert.ok(body.tools.length);
        if (protocol === 'anthropic-messages') assert.deepEqual(body.tool_choice, { type: 'tool', name: 'lookup' });
        return sse(toolEvents(protocol));
      } });
      assert.equal(toolResult.success, true, `${protocol} 纯工具流也应成功`);
      assert.equal(toolResult.text, '');
      assert.equal(toolResult.raw_response.normalized_tool_calls[0].function.name, 'lookup');
      assert.deepEqual(JSON.parse(toolResult.raw_response.normalized_tool_calls[0].function.arguments), { q: '测试' });

      const partial = complete(protocol).filter(event => event !== '[DONE]' && !['response.completed', 'message_delta', 'message_stop'].includes(event.type))
        .map(event => event.choices ? { ...event, choices: event.choices.map(choice => ({ ...choice, finish_reason: null })) } : event);
      const truncated = await call(protocol, { fetchImpl: async () => sse(partial) });
      assert.equal(truncated.success, false, `${protocol} 缺终态不能交付半截正文`);
      assert.match(truncated.message, /完整结束标记/);
    }
    console.log('PASS 三协议全局流式、无回调、JSON约束、用量、纯工具聚合及缺终态拒绝');

    // 直接从当前保存配置解析模型，也覆盖不传 textConfig 的调用路径。
    const runtime = await callTextModel({ configPath, messages: [], maxRetries: 0, fetchImpl: async (_url, init) => {
      assert.equal(JSON.parse(init.body).stream, true);
      return sse(complete('openai-responses'));
    } });
    assert.equal(runtime.success, true);

    for (const protocol of protocols) {
      const failedEvents = protocol === 'openai-responses'
        ? [{ type: 'response.output_text.delta', delta: '部分内容' }, { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]
        : protocol === 'openai-chat-completions' ? [{ choices: [{ delta: { content: '部分内容' }, finish_reason: 'length' }] }, '[DONE]']
          : [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '部分内容' } }, { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' }];
      const failed = await call(protocol, { fetchImpl: async () => sse(failedEvents) });
      assert.equal(failed.success, false);
      assert.match(failed.message, /不完整|未完整/);
      const error = await call(protocol, { fetchImpl: async () => sse([{ type: 'error', error: { message: 'fixture-key 发生故障' } }]) });
      assert.equal(error.success, false);
      assert.ok(!JSON.stringify(error).includes('fixture-key'));
    }
    const finalOnly = await call('openai-responses', { fetchImpl: async () => sse([{ type: 'response.completed', response: {
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '最终正文' }] }], usage: { input_tokens: 8 },
    } }]) });
    assert.equal(finalOnly.text, '最终正文');
    const authoritative = await call('openai-responses', { fetchImpl: async () => sse([
      { type: 'response.output_text.delta', delta: '前半' },
      { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: '前半后半' }] }] } },
    ]) });
    assert.equal(authoritative.text, '前半后半', '完整终态正文优先于部分增量');

    for (const protocol of protocols) {
      let cancelled = false;
      const record = {};
      const memoryStore = { start(value) { Object.assign(record, value); return 'fixture-record'; },
        update(_id, value) { Object.assign(record, value); } };
      const ended = await runWithApiCallContext({ store: memoryStore }, () => call(protocol, {
        streamChunkTimeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
          controller.enqueue(Buffer.from(encode(complete(protocol))));
          // 故意保持 HTTP body 打开，协议终态已经确认完整。
        }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }),
      }));
      assert.equal(ended.success, true, `${protocol} 终态后无需等待EOF`);
      await flushApiCallRecords();
      assert.equal(cancelled, true);
      assert.equal(record.transport_status, 'complete', '正常终态关闭连接不能记为断流');
      assert.ok(record.response_bytes > 0);
      assert.equal(ended.usage.completion_tokens, 4);
    }
    console.log('PASS 终态正文优先、三协议结束后立即释放连接与成功诊断记录');
    console.log('PASS 额度截断、流内错误脱敏、Responses终态完整正文');

    // SSE 多行 data、CRLF、末帧无空行；每个UTF-8字节单独到达。
    const bytes = Buffer.from('data: {"choices":\r\ndata: [{"delta":{"content":"你好"}}]}\r\n\r\ndata: [DONE]');
    const split = await call('openai-chat-completions', { fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } }) });
    assert.equal(split.success, true);
    assert.equal(split.text, '你好');

    const interleaved = await call('openai-chat-completions', { fetchImpl: async () => sse([
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call-1', function: { name: 'lookup', arguments: '{"q":' } },
        { index: 0, id: 'call-0', function: { name: 'lookup', arguments: '{"q":"甲"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"乙"}' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]',
    ]) });
    assert.equal(interleaved.success, true);
    assert.deepEqual(interleaved.raw_response.normalized_tool_calls.map(c => JSON.parse(c.function.arguments).q), ['甲', '乙']);
    const malformedTool = await call('openai-chat-completions', { fetchImpl: async () => sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'lookup', arguments: '{' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]',
    ]) });
    assert.equal(malformedTool.success, false);
    assert.match(malformedTool.message, /工具参数/);
    console.log('PASS UTF-8跨块、多行SSE、CRLF、尾帧与交错工具参数');

    for (const failure of ['http', 'request_timeout', 'stream_timeout', 'chunk_timeout', 'ignored_stream', 'bad_json']) {
      let requests = 0;
      let cancelled = false;
      const result = await call('openai-responses', { stream: false, fallbackToNonStreamOnGatewayTimeout: true,
        streamChunkTimeoutMs: failure === 'chunk_timeout' ? 10 : undefined,
        fetchImpl: async (_url, init) => {
          requests++;
          assert.equal(JSON.parse(init.body).stream, true);
          if (failure === 'http') return json({ error: { message: '超时' } }, 504);
          if (failure === 'request_timeout') throw Object.assign(new Error('fixture timeout'), { name: 'AbortError' });
          if (failure === 'ignored_stream') return json({ output_text: '不允许默默接受非流式' });
          if (failure === 'bad_json') return new Response('data: {bad}\n\n', { headers: { 'content-type': 'text/event-stream' } });
          return new Response(new ReadableStream({ start(controller) {
            if (failure === 'stream_timeout') controller.error(Object.assign(new Error('fixture timeout'), { name: 'AbortError' }));
          }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
        },
      });
      assert.equal(result.success, false, failure);
      assert.equal(requests, 1, '全局开启禁止自动非流式降级');
      if (failure === 'chunk_timeout') assert.equal(cancelled, true);
    }
    let retries = 0;
    const retry = await call('openai-responses', { maxRetries: 1, fetchImpl: async (_url, init) => {
      assert.equal(JSON.parse(init.body).stream, true);
      return retries++ ? sse(complete('openai-responses')) : json({ error: { message: '忙' } }, 502);
    } });
    assert.equal(retry.success, true);
    assert.equal(retries, 2);
    console.log('PASS 禁止非流式降级、失败时清理读取器、已允许的重试仍走流式');

    // 用短时限模拟超过 180 秒的持续输出，模拟 fetch 必须实际遵守 AbortSignal。
    for (const protocol of protocols) {
      let aborted = false;
      const result = await call(protocol, { requestTimeoutMs: 80, fetchImpl: async (_url, init) => {
        let interval;
        let tick = 0;
        const events = complete(protocol);
        return new Response(new ReadableStream({ start(controller) {
          init.signal.addEventListener('abort', () => { aborted = true; clearInterval(interval); controller.error(init.signal.reason); }, { once: true });
          interval = setInterval(() => {
            if (tick++ < 7) controller.enqueue(Buffer.from(': keep-alive\n\n'));
            else { clearInterval(interval); controller.enqueue(Buffer.from(encode(events))); controller.close(); }
          }, 20);
        }, cancel() { clearInterval(interval); } }), { headers: { 'content-type': 'text/event-stream' } });
      } });
      assert.equal(result.success, true, `${protocol} 持续有数据可超过初始总时限`);
      assert.equal(aborted, false, '收到SSE后不再被旧总时限定时器中断');
    }
    let idleRequests = 0;
    let idleCancelled = false;
    const idle = await call('openai-responses', { requestTimeoutMs: 20, fetchImpl: async () => {
      idleRequests++;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(Buffer.from(encode([{ type: 'response.output_text.delta', delta: '部分内容' }])));
      }, cancel() { idleCancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
    } });
    assert.equal(idle.success, false);
    assert.match(idle.failureReason, /等待新数据/);
    assert.equal(idleRequests, 1);
    assert.equal(idleCancelled, true);
    let headerCancelled = false;
    const headersTimeout = await call('openai-responses', { requestTimeoutMs: 20,
      fetchImpl: async (_url, init) => new Promise((_, reject) => {
        const keeper = setTimeout(() => reject(new Error('未发生首响应超时')), 200);
        init.signal.addEventListener('abort', () => { headerCancelled = true; clearTimeout(keeper); reject(init.signal.reason); }, { once: true });
      }),
    });
    assert.equal(headersTimeout.success, false);
    assert.equal(headerCancelled, true, '首次等待响应仍受超时保护');
    const nonSseRecord = {};
    let nonSseCancelled = false;
    const unsupported = await runWithApiCallContext({ store: { start: () => 'non-sse', update(_id, patch) { Object.assign(nonSseRecord, patch); } } },
      () => call('openai-responses', { fetchImpl: async () => new Response(new ReadableStream({
        cancel() { nonSseCancelled = true; },
      }), { headers: { 'content-type': 'application/json' } }) }));
    assert.equal(unsupported.success, false);
    await flushApiCallRecords();
    assert.equal(nonSseCancelled, true);
    assert.equal(nonSseRecord.transport_status, 'incomplete', '拒绝非SSE不会留下接收中的诊断');
    console.log('PASS 长流持续输出不受总时限截断、空闲/首响应超时仍有效、拒绝非SSE关闭诊断副本');

    // 同一显式模型快照，关闭全局开关后下一次请求恢复既有行为。
    await aiModelConfig.saveConfig({ ...stored, analysisStreaming: false }, { configPath });
    for (const option of [{ stream: false }, { stream: true }]) {
      const disabled = await call('openai-chat-completions', { ...option, fetchImpl: async (_url, init) => {
        assert.equal(JSON.parse(init.body).stream, undefined);
        return json({ choices: [{ message: { content: '旧行为' } }] });
      } });
      assert.equal(disabled.success, true);
    }
    let reads = 0;
    const readError = await call('openai-chat-completions', { maxRetries: 1, fetchImpl: async () => {
      reads++;
      return { ok: true, status: 200, text: async () => { throw Object.assign(new Error('fixture-key terminated'), { cause: { code: 'UND_ERR_SOCKET' } }); },
        json: async () => assert.fail('正文读取失败不应再消费同一响应') };
    } });
    assert.equal(readError.success, false);
    assert.match(readError.message, /正文读取失败.*UND_ERR_SOCKET/);
    assert.ok(!JSON.stringify(readError).includes('fixture-key'));
    assert.equal(reads, 1, '读取失败不能误判为缺正文重发');
    console.log('PASS 开关关闭兼容、正文原始异常保留与脱敏、不重复消费或重发');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
