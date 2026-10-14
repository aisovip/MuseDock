const assert = require('node:assert/strict');
const workflows = require('../server/services/creative/creativeWorkflows');
const agentRouter = require('../server/services/creative/whiteboard/agentRouter');
const aiTextModel = require('../server/services/ai/aiTextModel');
const { fixture } = require('./test-whiteboard-annotation-workflow');

const prompt = id => `纸面上用简洁线条描绘小鸟和树枝，主体完整、充分留白。测试编号 ${id}`;
const editIntent = (ids, regenerate = true) => ({ action: 'edit_lineart_prompts',
  edits: ids.map(sceneId => ({ sceneId, imagePrompt: prompt(sceneId), revision: '' })), regenerate });
async function failedFixture({ unknown = false } = {}) {
  const ctx = await fixture(2, { startStage: 'lineart_generation' });
  ctx.imageFaults.set('scene_2', unknown ? 'unknown' : 'rejected');
  await ctx.run();
  assert.equal((await ctx.read()).status, unknown ? 'unknown_external_outcome' : 'failed');
  return ctx;
}
function model(ctx, intent, hook = async () => {}) {
  let calls = 0;
  ctx.options.services.aiTextModel = { callTextModel: async request => {
    calls += 1;
    assert.equal(request.outputFormat.type, 'json');
    assert.ok(request.outputFormat.schema.required.includes('edits'));
    assert.ok(request.messages[1].content.includes('本幕当前提示词'));
    assert.ok(request.messages[1].content.includes('scene_2'));
    await hook(request);
    return { success: true, text: JSON.stringify(intent) };
  } };
  return () => calls;
}
async function chat(ctx, message, extra = {}) {
  return workflows.chatOnWhiteboardWorkflow(ctx.id, ctx.payload(await ctx.read(), 'message', { message, ...extra }), ctx.options);
}
async function testFailedEditAndRegenerate() {
  const ctx = await failedFixture();
  const before = await ctx.read();
  const kept = before.whiteboard.media.lineart.scene_1.identity;
  const calls = model(ctx, editIntent(['scene_2']), request => {
    assert.ok(request.messages[1].content.includes('IMAGE_REQUEST_REJECTED'));
    assert.ok(request.messages[1].content.includes('测试编号 scene_2'));
  });
  const payload = ctx.payload(before, 'message', { message: '最后一幕的提示词违规，调整一下提示词重新生成' });
  const result = await workflows.chatOnWhiteboardWorkflow(ctx.id, payload, ctx.options);
  assert.equal(result.startTask, true);
  const after = await ctx.read();
  assert.equal(after.status, 'queued');
  assert.equal(after.whiteboard.media.lineartPrompts.scene_2, prompt('scene_2'));
  assert.equal(after.whiteboard.current.identity, before.whiteboard.current.identity);
  assert.equal(after.whiteboard.media.lineart.scene_1.identity, kept);
  assert.equal(ctx.imageRequests.length, 2, '聊天只安排任务，由后台执行图片请求');
  const replay = await workflows.chatOnWhiteboardWorkflow(ctx.id, payload, ctx.options);
  assert.equal(replay.startTask, false, '同一请求不得重复启动任务');
  assert.equal(calls(), 1, '重复请求不重复调用分析模型');
  assert.equal((await ctx.read()).whiteboard.media.lineartPromptHistory.length, 1);
  ctx.imageFaults.clear();
  await ctx.run();
  assert.equal(ctx.imageCalls.get('scene_1'), 1);
  assert.equal(ctx.imageCalls.get('scene_2'), 2);
  assert.ok(ctx.imageRequests.at(-1).prompt.includes(prompt('scene_2')));
  console.log('PASS 失败自由对话改写实际提示词、启动制作、幂等及复用其他幕');
}
async function testOnlySaveAndMultipleScenes() {
  const ctx = await failedFixture();
  model(ctx, editIntent(['scene_1', 'scene_2'], false));
  // 不含“提示词/生成”等关键词，执行取决于模型结构化结果。
  const result = await chat(ctx, '把这两处换成我们刚才讨论的版本，先留着。');
  assert.equal(result.startTask, false);
  const after = await ctx.read();
  assert.equal(after.whiteboard.media.lineartPrompts.scene_1, prompt('scene_1'));
  assert.equal(after.whiteboard.media.lineartPrompts.scene_2, prompt('scene_2'));
  assert.equal(ctx.imageRequests.length, 2);
  console.log('PASS 无固定句式路由，多幕仅保存不会生成');
}
async function testUnknownOutcome() {
  const ctx = await failedFixture({ unknown: true });
  model(ctx, editIntent(['scene_2']));
  const result = await chat(ctx, '把最后一幕改好再生成');
  assert.equal(result.startTask, false);
  assert.equal((await ctx.read()).status, 'unknown_external_outcome');
  assert.equal((await ctx.read()).whiteboard.media.lineartPrompts.scene_2, prompt('scene_2'));
  assert.ok(result.workflow.whiteboard.allowedActions.some(action => action.id === 'authorize_media_retry'));
  assert.ok(result.workflow.whiteboard.messages.at(-1).text.includes('核实后授权新请求'));
  assert.equal(ctx.imageRequests.length, 2);
  console.log('PASS 未知结果可以改词但不越过授权边界');
}
async function testStaleContextAndInvalidBatch() {
  const ctx = await failedFixture();
  model(ctx, editIntent(['scene_2']), async () => {
    const view = await workflows.getCreativeWorkflow(ctx.id, ctx.options);
    const detail = view.data.whiteboard.media.lineartPromptDetails.scene_2;
    assert.equal((await ctx.action('save_lineart_prompt', { sceneId: 'scene_2', imagePrompt: `${prompt('scene_2')}用户的新修改。`,
      revision: '', expectedPromptIdentity: detail.identity })).success, true);
  });
  await assert.rejects(chat(ctx, '换最后那一张的描述并重做'), error => error.code === 'STALE_IDENTITY');
  assert.ok((await ctx.read()).whiteboard.media.lineartPrompts.scene_2.endsWith('用户的新修改。'));
  assert.equal(ctx.imageRequests.length, 2);

  const invalid = editIntent(['scene_1', 'scene_2']);
  invalid.edits[1].imagePrompt = '短';
  model(ctx, invalid);
  const before = JSON.stringify(await ctx.read());
  await assert.rejects(chat(ctx, '两张都改'), error => error.code === 'INTENT_CLASSIFICATION_FAILED');
  assert.equal(JSON.stringify(await ctx.read()), before, '部分非法编辑不得落盘任何一幕');
  console.log('PASS 模型耗时期间版本变化与非法多幕结果均不会覆盖用户修改');
}
async function testNoRegexFallbackAndDiscussion() {
  const ctx = await failedFixture();
  ctx.options.services.aiModelConfig = { getRuntimeConfig: async () => ({ enabled: false }) };
  const before = JSON.stringify(await ctx.read());
  await assert.rejects(chat(ctx, '最后一幕提示词违规，重新生成'), error => error.code === 'INTENT_MODEL_NOT_CONFIGURED');
  assert.equal(JSON.stringify(await ctx.read()), before);
  ctx.options.services.aiModelConfig = { getRuntimeConfig: async () => ({ enabled: true, apiKey: 'fixture',
    baseUrl: 'https://example.invalid', modelId: 'fixture' }) };
  let count = 0;
  ctx.options.services.aiTextModel = { callTextModel: async request => {
    if (++count === 1) return { success: true, text: JSON.stringify({ action: 'answer' }) };
    request.onDelta('最近图片请求被服务拒绝，请查看 API 返回记录。');
    return { success: true, text: '最近图片请求被服务拒绝，请查看 API 返回记录。' };
  } };
  const result = await chat(ctx, '为什么最后一幕提示词违规？');
  assert.equal(result.startTask, false);
  assert.equal((await ctx.read()).status, 'failed');
  assert.equal((await ctx.read()).whiteboard.media.lineartPrompts?.scene_2, undefined);
  assert.equal(ctx.imageRequests.length, 2);
  assert.throws(() => agentRouter.normalizeIntent(editIntent(['scene_9']), {
    canEditLineartPrompts: true, scenes: [{ id: 'scene_2' }] }), /无效或重复/);
  console.log('PASS 模型不可用明确失败，无正则降级；问原因不会自动修改或生成');
}
async function testObservedPromptsField() {
  const ctx = await failedFixture();
  const canonical = editIntent(['scene_2']);
  const calls = model(ctx, { action: canonical.action, prompts: canonical.edits, regenerate: true,
    regenerateSceneIds: ['scene_2'], reuseExistingArtifacts: true });
  const result = await chat(ctx, '最后一幕调整提示词重新生成');
  assert.equal(result.startTask, true);
  assert.equal(calls(), 1, '已取得完整等价改稿不应再次请求分析模型');
  assert.equal((await ctx.read()).whiteboard.media.lineartPrompts.scene_2, prompt('scene_2'));
  assert.equal(ctx.imageRequests.length, 2);
  const context = { canEditLineartPrompts: true, scenes: [{ id: 'scene_2' }] };
  assert.throws(() => agentRouter.normalizeIntent({ ...canonical, prompts: canonical.edits }, context), /同时包含/);
  assert.throws(() => agentRouter.normalizeIntent({ ...canonical, regenerateSceneIds: ['scene_1'] }, context), /不一致/);
  console.log('PASS 实际故障返回的 prompts 数组可安全归一化；冲突字段或生成目标不得猜测');
}
async function testBoundedCorrection() {
  const ctx = await failedFixture();
  const before = JSON.stringify(await ctx.read());
  const events = [];
  const payload = ctx.payload(await ctx.read(), 'message', { message: '末尾那张换个合规的描述并重做' });
  let count = 0;
  ctx.options.services.aiTextModel = { callTextModel: async request => {
    assert.equal(JSON.stringify(await ctx.read()), before, '候选未通过校验前不得落盘');
    if (++count === 1) return { success: true, text: JSON.stringify({ action: 'edit_lineart_prompts', sceneIds: ['scene_2'], regenerate: true }) };
    assert.ok(request.messages.at(-1).content.includes('非空 edits'));
    assert.ok(request.messages[1].content.includes(payload.message));
    assert.equal(request.maxRetries, 0);
    return { success: true, text: JSON.stringify(editIntent(['scene_2'])) };
  } };
  const result = await workflows.chatOnWhiteboardWorkflow(ctx.id, payload, { ...ctx.options, onEvent: e => events.push(e) });
  assert.equal(result.startTask, true);
  assert.equal(count, 2);
  assert.ok(events.some(e => e.type === 'chat_phase' && e.phase === 'repair'));
  assert.equal((await ctx.read()).whiteboard.media.lineartPromptHistory.length, 1);

  const failing = await failedFixture();
  const unchanged = JSON.stringify(await failing.read());
  let failingCalls = 0;
  failing.options.services.aiTextModel = { callTextModel: async () => {
    failingCalls += 1;
    return { success: true, text: '{"action":"edit_lineart_prompts","regenerate":true}' };
  } };
  await assert.rejects(chat(failing, '改最后一张并生成'), error => error.code === 'INTENT_CLASSIFICATION_FAILED' && /自动补正/.test(error.message));
  assert.equal(failingCalls, 2, '结构补正严格限制一次');
  assert.equal(JSON.stringify(await failing.read()), unchanged);
  assert.equal(failing.imageRequests.length, 2);
  console.log('PASS 自动补正一次并保留最初要求；补正失败不保存、不生成');
}
async function testProtocolSchemaAndCorrection() {
  const context = { canEditLineartPrompts: true, canRegenerateLineart: true,
    scenes: [{ id: 'scene_2', index: 2, title: '最后一幕', imagePrompt: prompt('scene_2') }] };
  for (const protocol of ['openai-responses', 'openai-chat-completions', 'anthropic-messages']) {
    const requests = [];
    const services = {
      aiModelConfig: { getRuntimeConfig: async () => ({ enabled: true, apiKey: 'fixture-only',
        baseUrl: 'https://example.invalid', modelId: 'fixture', protocol }) },
      aiTextModel: { callTextModel: options => aiTextModel.callTextModel({ ...options,
        fetchImpl: async (_url, init) => {
          requests.push(JSON.parse(init.body));
          const text = JSON.stringify(requests.length === 1 ? { action: 'edit_lineart_prompts', regenerate: true } : editIntent(['scene_2']));
          const data = protocol === 'openai-responses' ? { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
            : protocol === 'anthropic-messages' ? { content: [{ type: 'text', text }] } : { choices: [{ message: { content: text } }] };
          return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => data };
        } }) },
    };
    const result = await agentRouter.classifyIntent({ message: '调整最后一幕并重新生成', context, services });
    assert.equal(result.action, 'edit_lineart_prompts');
    assert.equal(requests.length, 2);
    for (const request of requests) {
      if (protocol === 'openai-responses') {
        assert.equal(request.text.format.type, 'json_schema');
        assert.ok(request.text.format.schema.required.includes('edits'));
      } else if (protocol === 'openai-chat-completions') assert.deepEqual(request.response_format, { type: 'json_object' });
      else assert.equal(request.response_format, undefined);
    }
  }
  console.log('PASS Responses 严格 Schema、Chat JSON 模式及 Anthropic 本地校验，补正保留协议约束');
}
(async () => {
  await testFailedEditAndRegenerate();
  await testOnlySaveAndMultipleScenes();
  await testUnknownOutcome();
  await testStaleContextAndInvalidBatch();
  await testNoRegexFallbackAndDiscussion();
  await testObservedPromptsField();
  await testBoundedCorrection();
  await testProtocolSchemaAndCorrection();
  console.log('白板 Agent 提示词自由编辑回归通过；真实模型请求 0。');
})().catch(error => { console.error(error); process.exitCode = 1; });
