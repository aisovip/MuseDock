const assert = require('node:assert/strict');
const { structuredVision, annotationOutputSchema, validateAnnotation } = require('../server/services/creative/whiteboard/mediaModels');

const textConfig = { enabled: true, apiKey: 'fixture-key', baseUrl: 'https://example.invalid/v1',
  modelId: 'deepseek-flash', protocol: 'openai-chat-completions', supportsMultimodal: true };
const privateText = 'private-validation-canary';
const candidate = { schemaVersion: 2,
  visualGrouping: { mode: 'single_continuous', reason: '图中是一棵根、干、枝叶连接的完整树木，属于同一连续主体。' },
  elements: [{ label: '完整树木', region: { x: 50, y: 80, width: 500, height: 700 },
    direction: 'top-to-bottom', weight: 1, protectedRegions: [] }] };
const response = content => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { status: 200 });

async function repair(firstText, verifyFeedback, options = {}) {
  const requests = []; const diagnostics = [];
  const result = await structuredVision({ textConfig, prompt: '按原图编排落墨区域',
    outputSchema: annotationOutputSchema(), validate: validateAnnotation,
    onValidation: value => diagnostics.push(value), ...options,
    services: { fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body);
      assert.deepEqual(body.response_format, { type: 'json_object' });
      const prompt = body.messages[1].content[0].text;
      const schema = JSON.parse(prompt.split('实际坐标必须根据本次图像和原合同确定：\n')[1]);
      assert.deepEqual(schema.required, ['schemaVersion', 'visualGrouping', 'elements']);
      assert.equal(schema.properties.visualGrouping.additionalProperties, false);
      assert.equal(schema.properties.visualGrouping.properties.elements, undefined);
      if (requests.length === 2) {
        assert.equal(body.messages.at(-2).content, firstText, '补正携带原始失败正文');
        verifyFeedback(body.messages.at(-1).content, diagnostics[0]);
      }
      return response(requests.length === 1 ? firstText : JSON.stringify(candidate));
    } },
  });
  assert.deepEqual(result, candidate);
  assert.equal(requests.length, 2, '只允许一次模型补正');
}

(async () => {
  await repair('{\n "schemaVersion": 2', (feedback, diagnostic) => {
    assert.match(feedback, /JSON 语法错误/);
    assert.match(feedback, /第 2 行/);
    assert.match(feedback, /结构完整闭合前结束/);
    assert.equal(diagnostic.category, 'candidate_invalid');
    assert.match(diagnostic.validationErrors[0], /JSON 语法错误/);
  });
  await repair(`{"schemaVersion":2,"label":${privateText}}`, (feedback, diagnostic) => {
    assert.match(feedback, /JSON 语法错误/);
    assert.equal(feedback.includes(privateText), false, '不将解析异常中的供应商正文复制到诊断反馈');
    assert.equal(JSON.stringify(diagnostic).includes(privateText), false);
  });
  for (const value of [null, [], 123, 'string']) {
    await repair(JSON.stringify(value), feedback => assert.match(feedback, /JSON 根值必须是一个对象/));
  }
  const nested = { schemaVersion: 2, visualGrouping: { ...candidate.visualGrouping, elements: candidate.elements } };
  await repair(JSON.stringify(nested), feedback => {
    assert.match(feedback, /schemaVersion=2/);
    assert.doesNotMatch(feedback, /JSON 语法错误/, '合法 JSON 的字段错误不能冒充语法错误');
  });
  const extra = { ...candidate, visualGrouping: { ...candidate.visualGrouping, regions: [] } };
  await repair(JSON.stringify(extra), feedback => assert.match(feedback, /visualGrouping 只能包含 mode 和 reason/));

  let failedCalls = 0; const failedDiagnostics = [];
  await assert.rejects(structuredVision({ textConfig, prompt: '按原图编排', validate: () => {
    throw new Error(privateText);
  }, onValidation: value => failedDiagnostics.push(value), services: { fetchImpl: async () => {
    failedCalls += 1; return response(JSON.stringify(candidate));
  } } }), error => error.code === 'VISION_VALIDATION_FAILED' && error.diagnostics.category === 'validator_error'
    && !JSON.stringify(error.diagnostics).includes(privateText));
  assert.equal(failedCalls, 1, '本地校验器异常不能触发付费补正');
  assert.equal(failedDiagnostics[0].category, 'validator_error');

  let invalidCalls = 0;
  await assert.rejects(structuredVision({ textConfig, prompt: '按原图编排', validate: validateAnnotation,
    services: { fetchImpl: async () => { invalidCalls += 1; return response('{"schemaVersion":2'); } },
  }), error => error.code === 'CANDIDATE_INVALID' && /JSON 语法错误/.test(error.message));
  assert.equal(invalidCalls, 2, '持续语法错误不能无限补正');

  for (const protocol of ['openai-chat-completions', 'openai-responses']) {
    let rejectedCalls = 0;
    await assert.rejects(structuredVision({ textConfig: { ...textConfig, protocol }, prompt: '按原图编排',
      validate: validateAnnotation, services: { fetchImpl: async (_url, init) => {
        rejectedCalls += 1; const body = JSON.parse(init.body);
        assert.deepEqual(protocol === 'openai-chat-completions' ? body.response_format : body.text.format, { type: 'json_object' });
        return new Response(JSON.stringify({ error: { message: 'unsupported response_format' } }), { status: 400 });
      } },
    }), error => error.code === 'VISION_REQUEST_REJECTED');
    assert.equal(rejectedCalls, 1, '服务商拒绝 JSON 参数时不能取消格式约束重发');
  }
  await structuredVision({ textConfig: { ...textConfig, protocol: 'anthropic-messages' }, prompt: '按原图编排',
    validate: validateAnnotation, services: { fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.response_format, undefined, 'Anthropic 不携带 OpenAI 格式参数');
      assert.equal(body.text, undefined);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(candidate) }], stop_reason: 'end_turn' }), { status: 200 });
    } },
  });
  console.log('PASS 白板 JSON 输出：接口格式、字段结构、语法位置、根对象、合同补正、本地异常、单次补正、格式拒绝及 Anthropic 兼容；真实 provider 调用 0。');
})().catch(error => { console.error(error); process.exitCode = 1; });
