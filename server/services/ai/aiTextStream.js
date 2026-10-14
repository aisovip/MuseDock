// 三种分析协议的 SSE 聚合。只有协议终态确认完整后才交付业务结果。
const { STREAM_COMPLETED } = require('../diagnostics/apiCallRecorder');
async function readWithChunkTimeout(reader, timeoutMs) {
  if (!(timeoutMs > 0)) return reader.read();
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`流式响应块读取超时：${Math.round(timeoutMs / 1000)} 秒内未收到新数据。`),
          { code: 'STREAM_IDLE_TIMEOUT' })), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readStreamResponse(response, options = {}) {
  const protocol = options.protocol;
  const contentType = response?.headers?.get?.('content-type') || '';
  if (contentType && !/text\/event-stream/i.test(contentType)) {
    // 业务拒绝非 SSE 时也关闭诊断副本，避免清除请求计时器后记录永久停在接收中。
    if (typeof response.body?.cancel === 'function') response.body.cancel().catch(() => {});
    return { success: false, text: '', raw_response: { message: '服务商未返回 SSE 流式响应，请检查所选协议与服务商的流式支持。', content_type: contentType } };
  }
  if (!response?.body || typeof response.body.getReader !== 'function') {
    return { success: false, text: '', raw_response: { message: '流式响应缺少可读取的 body。' } };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  const calls = new Map();
  const output = new Map();
  const blocks = new Map();
  let buffer = '';
  let text = '';
  let terminal = false;
  let streamEnded = false;
  let eof = false;
  let failure = '';
  let usage = {};
  let stopReason;
  let completedResponse;
  const addText = delta => {
    if (typeof delta !== 'string') return;
    text += delta;
    if (delta && typeof options.onDelta === 'function') options.onDelta(delta);
  };
  const errorMessage = value => typeof value?.error === 'string' ? value.error
    : value?.error?.message || value?.message || '服务商返回了流式错误。';
  const responseItemKey = event => event.output_index ?? event.item_id ?? event.item?.id;

  function accept(parsed) {
    events.push(parsed);
    if (parsed.error || parsed.type === 'error' || parsed.type === 'response.failed') {
      failure = errorMessage(parsed.response || parsed);
      return;
    }
    if (protocol === 'openai-chat-completions') {
      if (parsed.usage) usage = { ...usage, ...parsed.usage };
      const choice = parsed.choices?.find(item => (item.index ?? 0) === 0);
      if (!choice) return;
      const delta = choice.delta || {};
      addText(typeof delta.content === 'string' ? delta.content : undefined);
      for (const item of delta.tool_calls || []) {
        const index = item.index ?? 0;
        const call = calls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (item.id) call.id = item.id;
        if (item.type) call.type = item.type;
        if (item.function?.name) call.function.name += item.function.name;
        if (typeof item.function?.arguments === 'string') call.function.arguments += item.function.arguments;
        calls.set(index, call);
      }
      if (choice.finish_reason) {
        stopReason = choice.finish_reason;
        if (['stop', 'tool_calls', 'function_call'].includes(stopReason)) terminal = true;
        else failure = `模型流式输出未完整结束（${stopReason}），请检查输出额度或服务端记录。`;
      }
    } else if (protocol === 'openai-responses') {
      if (parsed.type === 'response.output_text.delta') addText(parsed.delta);
      if (['response.output_item.added', 'response.output_item.done'].includes(parsed.type) && parsed.item) {
        const key = responseItemKey(parsed);
        output.set(key, { ...output.get(key), ...parsed.item });
      }
      if (['response.function_call_arguments.delta', 'response.function_call_arguments.done'].includes(parsed.type)) {
        let key = responseItemKey(parsed);
        if (!output.has(key) && parsed.item_id) {
          const match = [...output].find(([, item]) => item.id === parsed.item_id);
          if (match) key = match[0];
        }
        const item = output.get(key) || { type: 'function_call', id: parsed.item_id || '', arguments: '' };
        item.arguments = parsed.type.endsWith('.done') ? parsed.arguments : (item.arguments || '') + (parsed.delta || '');
        output.set(key, item);
      }
      if (parsed.type === 'response.incomplete') {
        failure = `模型流式输出不完整（${parsed.response?.incomplete_details?.reason || '未取得完整结果'}），请检查输出额度或服务端记录。`;
      }
      if (parsed.type === 'response.completed') {
        completedResponse = parsed.response || {};
        if (completedResponse.status && completedResponse.status !== 'completed') {
          failure = `模型流式输出未完成（${completedResponse.status}）。`;
        } else { terminal = true; streamEnded = true; }
        usage = { ...usage, ...completedResponse.usage };
      }
    } else if (protocol === 'anthropic-messages') {
      if (parsed.type === 'message_start') usage = { ...usage, ...parsed.message?.usage };
      if (parsed.type === 'content_block_start') {
        const block = { ...parsed.content_block };
        blocks.set(parsed.index, block);
        if (block.type === 'text') addText(block.text);
      }
      if (parsed.type === 'content_block_delta') {
        const block = blocks.get(parsed.index);
        if (parsed.delta?.type === 'text_delta') {
          addText(parsed.delta.text);
          if (block) block.text = (block.text || '') + (parsed.delta.text || '');
        }
        if (parsed.delta?.type === 'input_json_delta' && block) {
          block.partial_json = (block.partial_json || '') + (parsed.delta.partial_json || '');
        }
      }
      if (parsed.type === 'message_delta') {
        usage = { ...usage, ...parsed.usage };
        stopReason = parsed.delta?.stop_reason || stopReason;
        if (stopReason && !['end_turn', 'tool_use', 'stop_sequence'].includes(stopReason)) {
          failure = `模型流式输出未完整结束（${stopReason}），请检查输出额度或服务端记录。`;
        }
      }
      if (parsed.type === 'message_stop') { terminal = true; streamEnded = true; }
    }
  }

  function frame(part) {
    const lines = part.split(/\r?\n/);
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n').trim();
    if (!data) return;
    if (data === '[DONE]') {
      if (protocol === 'openai-chat-completions') { terminal = true; streamEnded = true; }
      return;
    }
    let parsed;
    try { parsed = JSON.parse(data); }
    catch (error) {
      failure = `流式响应包含无效 JSON 片段：${error.message}`;
      return;
    }
    if (event && !parsed.type && protocol !== 'openai-chat-completions') parsed.type = event;
    accept(parsed);
  }

  function rawResponse() {
    const raw = { stream: true, chunks: events, usage };
    if (protocol === 'openai-chat-completions') {
      const toolCalls = [...calls].sort(([a], [b]) => a - b).map(([, call]) => call);
      raw.choices = [{ message: { role: 'assistant', content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: stopReason }];
    } else if (protocol === 'openai-responses') {
      Object.assign(raw, completedResponse, { stream: true, chunks: events, usage });
      raw.output = completedResponse?.output ?? [...output.values()];
      // 有些兼容服务只在 completed 中提供完整正文。
      const finalBlocks = raw.output.filter(item => item.type === 'message' && (!item.role || item.role === 'assistant'))
        .flatMap(item => item.content || []).filter(block => block.type === 'output_text' && typeof block.text === 'string');
      raw.output_text = completedResponse?.output_text ?? (finalBlocks?.length ? finalBlocks.map(block => block.text).join('') : text);
    } else {
      raw.content = [...blocks].sort(([a], [b]) => a - b).map(([, block]) => {
        const { partial_json, ...item } = block;
        if (item.type === 'tool_use' && partial_json !== undefined) {
          try { item.input = JSON.parse(partial_json); }
          catch { failure ||= '流式工具参数不是完整 JSON，不能执行工具调用。'; }
        }
        return item;
      });
      raw.stop_reason = stopReason;
    }
    if (failure) raw.message = failure;
    return raw;
  }

  try {
    while (!failure && !streamEnded) {
      const { done, value } = await readWithChunkTimeout(reader, Number(options.chunkTimeoutMs));
      if (done) { eof = true; break; }
      buffer += typeof value === 'string' ? value : decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || '';
      for (const part of parts) {
        frame(part);
        if (failure || streamEnded) break;
      }
    }
    buffer += decoder.decode();
    if (!failure && !streamEnded && buffer.trim()) frame(buffer);
    if (!terminal && !failure) failure = '流式连接已结束，但未收到完整结束标记；已接收的部分内容不能作为完整结果。';
    if (protocol === 'anthropic-messages' && !stopReason && !failure) failure = '流式响应缺少模型结束原因，无法确认完整结果。';
    const raw = rawResponse();
    const functionCalls = protocol === 'openai-chat-completions' ? [...calls.values()]
      : protocol === 'openai-responses' ? raw.output.filter(item => item.type === 'function_call') : [];
    for (const call of functionCalls) {
      const fn = call.function || call;
      if (!fn.name) { failure ||= '流式工具调用缺少完整名称。'; break; }
      try { JSON.parse(fn.arguments || '{}'); }
      catch { failure ||= '流式工具参数不是完整 JSON，不能执行工具调用。'; }
    }
    if (failure) raw.message = failure;
    return { success: !failure, text: protocol === 'openai-responses' ? raw.output_text : text, raw_response: raw };
  } catch (error) {
    error.raw_response = rawResponse();
    throw error;
  } finally {
    if (!eof && typeof reader.cancel === 'function') reader.cancel(streamEnded && !failure ? STREAM_COMPLETED : undefined).catch(() => {});
    reader.releaseLock?.();
  }
}

module.exports = { readStreamResponse };
