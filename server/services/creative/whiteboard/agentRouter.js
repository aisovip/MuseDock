'use strict';

// 白板对话意图理解层：把用户自由文本交给已配置的文本模型，输出结构化意图，
// 替代历史正则猜测。安全边界：这里永远不会输出确认产物、授权扣费类动作，
// 那些操作只能由用户通过审批卡按钮显式触发。

const defaultTextModel = require('../../ai/aiTextModel');
const { WhiteboardError } = require('./contracts');
const { validatePrompt } = require('./lineartPrompts');

const INTENT_CONTRACT = 'whiteboard-message-intent-v1';

function intentSchema(context = {}) {
  const ids = (context.scenes || []).map(scene => scene.id);
  const sceneId = { type: 'string', ...(ids.length ? { enum: ids } : {}) };
  return { type: 'object', additionalProperties: false,
    required: ['action', 'sceneIds', 'instruction', 'edits', 'regenerate'],
    properties: {
      action: { type: 'string', enum: ['revise_scenes', 'revise_plan', 'edit_lineart_prompts', 'answer'] },
      sceneIds: { type: 'array', items: sceneId },
      instruction: { type: 'string' },
      edits: { type: 'array', items: { type: 'object', additionalProperties: false,
        required: ['sceneId', 'imagePrompt', 'revision'], properties: {
          sceneId, imagePrompt: { type: 'string' }, revision: { type: 'string' },
        } } },
      regenerate: { type: 'boolean' },
    } };
}

function buildContextBlock(context = {}) {
  const lines = [];
  lines.push(context.phase === 'production' ? '当前处于视频制作阶段。' : '当前处于内容与分镜方案阶段。');
  if (context.stageLabel) lines.push(`当前阶段：${context.stageLabel}${context.gateTitle ? `（${context.gateTitle}）` : ''}。`);
  if (context.progressMessage) lines.push(`当前状态：${context.progressMessage}。`);
  if (context.lastError) lines.push(`最近一次错误：${context.lastError}。`);
  if (context.opening?.mode === 'question') lines.push(`当前提问开场（卡片叠放）：${JSON.stringify(context.opening.question)}。可在调整制作设置中单独编辑问题。`);
  if (context.opening?.mode === 'image-montage') lines.push('当前视频开头：图片汇总，使用全部成品图制作 3 秒开头，不添加文字或开场配音。');
  if (Array.isArray(context.scenes) && context.scenes.length) {
    lines.push('可用幕列表（序号. 标题 [id]，括号内为已完成产物）：');
    for (const scene of context.scenes) {
      const products = [
        scene.hasLineart ? '线稿' : '',
        scene.hasAnnotation ? '落墨标注' : '',
        scene.hasVideo ? '单幕动画' : '',
      ].filter(Boolean).join('、');
      lines.push(`${scene.index}. ${scene.title} [${scene.id}]${products ? `（已完成：${products}）` : '（尚无产物）'}`);
      if (scene.imagePrompt) lines.push(`本幕当前提示词及附加要求：${JSON.stringify({ imagePrompt: scene.imagePrompt, revision: scene.revision || '' })}`);
      if (scene.lastError) lines.push(`本幕最近请求状态：${scene.lastError}`);
    }
  }
  lines.push(context.canReviseScenes ? '当前允许修改指定幕（revise_scenes）。' : '当前不允许修改指定幕。');
  lines.push(context.canRevisePlan ? '当前允许修改整体内容与分镜方案（revise_plan）。' : '当前不允许修改整体方案（制作已开始）。');
  lines.push(context.canEditLineartPrompts ? '当前允许改写并保存线稿提示词（edit_lineart_prompts）。' : '当前不允许编辑线稿提示词。');
  lines.push(context.canRegenerateLineart ? '修改提示词后可以按用户明确要求启动重新生成。' : '当前不能自动重新生成；结果待核实时须使用核实后授权按钮。');
  if (context.messages?.length) lines.push(`最近对话（只作上下文，操作必须由本轮用户消息提出）：${JSON.stringify(context.messages)}`);
  return lines.join('\n');
}

function intentMessages({ message, context }) {
  const system = [
    '你是白板视频创作流程的意图理解模块。根据【当前制作状态】与【用户消息】，判定用户意图，只返回一个 JSON 对象：',
    '{"action":"...","sceneIds":["..."],"instruction":"...","edits":[{"sceneId":"...","imagePrompt":"完整新提示词","revision":""}],"regenerate":false}',
    'action 只能取以下值之一：',
    '- "revise_scenes"：用户明确要求重新生成或修改某些幕的画面（线稿、落墨编排、单幕动画）。sceneIds 必须从可用幕列表中选取 id；用户用序号指代（如"1、2、6、7"）时转换为对应 id。instruction 为用户的完整修改要求，保留用户原话中的原因与要求，不要自行扩展。',
    '- "revise_plan"：用户要求修改整体内容、分镜或旁白方案（仅当允许方案修订时可选）。',
    '- "edit_lineart_prompts"：用户要求改写图片提示词、调整被图片服务拒绝的画面描述，或改提示词并重新生成。根据当前幕列表、当前提示词、错误与本轮要求，自行选幕并写出独立完整的新提示词。edits 仅包含要修改的幕，revision 中旧要求应合入新提示词后留空。只有本轮用户明确要求生成或重生成时 regenerate 才为 true。不要仅把“调整提示词”作为附加要求保存。',
    '- "answer"：询问进度、询问原因、一般讨论，或意图不明确。',
    '判定规则：',
    '- 用户消息同时包含疑问和明确的重新生成/修改指令时，选择符合要求的修改动作。',
    '- 只有疑问没有修改指令时（例如"为什么有边框？"），选 answer。',
    '- 不确定时一律选 answer，宁可不猜。',
    '- “最后一幕”、标题、序号等指代由你结合真实幕列表理解，不要修改其他幕。画面提示词的调整优先 edit_lineart_prompts，不要为此重做整体方案。',
    '- 内容审核拒绝不能证明具体触发词。保留正常叙事与画风，改为清晰、合规的画面描述；不要掩饰违规内容、绕过审核或承诺通过。',
    '- 用户只询问原因时不调用修改动作。缺少目标或要求时选 answer 并澄清；不要从历史消息推定本轮授权。确认产物与未知外部结果的授权仍由界面按钮完成。',
    '- 必须使用 edits 字段返回实际改稿，不使用 prompts 或其他自定义字段。修改提示词时 edits 不得为空，每项包含 sceneId、完整 imagePrompt 和 revision。其他动作的 edits 为空数组；不适用的 sceneIds、instruction 分别为空数组、空字符串。',
    '只输出 JSON，不要输出任何其他文字。',
  ].join('\n');
  // OpenAI Responses 协议要求 input 消息中出现 "json" 字样才允许 json_object 格式，
  // system 消息会被拆到 instructions 字段、不参与该校验，因此在这里显式声明。
  const user = `【当前制作状态】\n${buildContextBlock(context)}\n\n【用户消息】\n${message}\n\n请只返回符合以下结构的 JSON 对象：\n${JSON.stringify(intentSchema(context))}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function normalizeIntent(candidate, context = {}) {
  if (!candidate || typeof candidate !== 'object') throw new Error('意图理解结果不是 JSON 对象。');
  const action = candidate.action;
  if (!['revise_scenes', 'revise_plan', 'edit_lineart_prompts', 'answer'].includes(action)) throw new Error(`未知意图：${action}`);
  if (action === 'answer') return { action, instruction: '' };
  if (action === 'edit_lineart_prompts') {
    if (!context.canEditLineartPrompts) throw new Error('当前阶段不允许修改线稿提示词。');
    const validIds = new Set((context.scenes || []).map(scene => scene.id));
    // 兼容已观察到的等价模型字段，只归一化输出，不猜测用户输入或修改内容。
    const proposed = candidate.edits === undefined ? candidate.prompts : candidate.edits;
    if (candidate.edits !== undefined && candidate.prompts !== undefined) throw new Error('修改结果同时包含 edits 和 prompts，请只返回 edits。');
    if (!Array.isArray(proposed) || !proposed.length || proposed.length > validIds.size) throw new Error('修改提示词动作必须包含非空 edits 数组及完整改稿。');
    const seen = new Set();
    const edits = proposed.map(edit => {
      if (!edit || !validIds.has(edit.sceneId) || seen.has(edit.sceneId)) throw new Error('提示词修改包含无效或重复的分镜。');
      seen.add(edit.sceneId);
      return { sceneId: edit.sceneId, ...validatePrompt({ imagePrompt: edit.imagePrompt, revision: edit.revision ?? '' }) };
    });
    if (typeof candidate.regenerate !== 'boolean') throw new Error('必须明确是否重新生成。');
    if (candidate.regenerateSceneIds !== undefined && (!Array.isArray(candidate.regenerateSceneIds)
      || candidate.regenerateSceneIds.length !== edits.length
      || new Set(candidate.regenerateSceneIds).size !== edits.length
      || candidate.regenerateSceneIds.some(id => !seen.has(id)))) throw new Error('重新生成的分镜与改稿目标不一致。');
    return { action, sceneIds: edits.map(edit => edit.sceneId), edits, regenerate: candidate.regenerate };
  }
  if (action === 'revise_plan') {
    if (!context.canRevisePlan) throw new Error('当前阶段不允许修改整体方案。');
    const instruction = String(candidate.instruction || '').trim();
    if (!instruction) throw new Error('缺少方案修改意见。');
    return { action, instruction };
  }
  if (!context.canReviseScenes) throw new Error('当前阶段不允许修改指定幕。');
  const validIds = new Set((context.scenes || []).map(scene => scene.id));
  const requested = Array.isArray(candidate.sceneIds) ? candidate.sceneIds : [];
  const sceneIds = [...new Set(requested.map(id => String(id).trim()).filter(id => validIds.has(id)))];
  if (!sceneIds.length) throw new Error('未能从消息中识别出要修改的幕。');
  const instruction = String(candidate.instruction || '').trim();
  return { action, sceneIds, instruction };
}

async function getTextConfig(services = {}) {
  const aiModelConfig = services.aiModelConfig || require('../../ai/aiModelConfig');
  return aiModelConfig.getRuntimeConfig('text');
}

// 仅对结构无效的候选有界补正一次，失败不降级为正则路由或执行未经校验的改稿。
async function classifyIntent({ message, context, services = {}, onRequest } = {}) {
  const textConfig = await getTextConfig(services);
  if (!textConfig?.enabled || !textConfig.apiKey || !textConfig.baseUrl || !textConfig.modelId) {
    throw new WhiteboardError('INTENT_MODEL_NOT_CONFIGURED', '自然语言意图理解需要在设置中配置分析模型。');
  }
  const messages = intentMessages({ message, context });
  let validationError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await onRequest?.({ repair: attempt > 0 });
    const response = await (services.aiTextModel || defaultTextModel).callTextModel({
      textConfig, messages, temperature: 0,
      maxTokens: context.canEditLineartPrompts ? 16000 : 1200,
      outputFormat: { type: 'json', name: 'whiteboard_message_intent', schema: intentSchema(context), strict: true },
      requestTimeoutMs: 60000, maxRetries: attempt ? 0 : 1,
    });
    if (!response?.success || typeof response.text !== 'string') {
      throw new WhiteboardError('INTENT_CLASSIFICATION_FAILED', response?.message || '意图理解请求失败，请稍后重试。');
    }
    try {
      let parsed;
      try { parsed = JSON.parse(response.text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); }
      catch { throw new Error('返回内容不是有效 JSON 对象。'); }
      return { contract: INTENT_CONTRACT, ...normalizeIntent(parsed, context) };
    } catch (error) {
      validationError = error.message;
      if (!attempt) messages.push({ role: 'assistant', content: response.text }, { role: 'user', content:
        `上次 JSON 操作结果未通过校验：${validationError}。请根据最初用户要求及当前状态补正一次，只返回规定结构的完整 JSON 对象。不得扩大目标、补造授权或改用其他动作来绕过权限校验。edit_lineart_prompts 必须包含非空 edits 和实际 imagePrompt，不要只返回修改指令。` });
    }
  }
  throw new WhiteboardError('INTENT_CLASSIFICATION_FAILED', `模型返回的操作格式在自动补正后仍未通过校验：${validationError} 未修改提示词或启动生成，请稍后重试。`);
}

function answerMessages({ message, context }) {
  const system = [
    '你是白板视频创作助手。根据【当前制作状态】回答用户的问题或回应用户的讨论。',
    '规则：',
    '- 只依据当前制作状态回答，不要编造没有的进度、原因或承诺。',
    '- 用户对产物提出质疑时，结合最近一次错误如实解释，并提示可以用修改指定幕或确认/重试按钮继续流程。',
    '- 用简洁的中文回答，一般不超过 200 字。',
    '- 不输出 JSON，直接输出自然语言。',
  ].join('\n');
  const user = `【当前制作状态】\n${buildContextBlock(context)}\n\n【用户消息】\n${message}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// 状态问答的流式回答；onDelta 逐块收到增量文本，返回完整文本。
async function streamAnswer({ message, context, services = {}, onDelta, onRequest } = {}) {
  const textConfig = await getTextConfig(services);
  if (!textConfig?.enabled || !textConfig.apiKey || !textConfig.baseUrl || !textConfig.modelId) {
    throw new WhiteboardError('INTENT_MODEL_NOT_CONFIGURED', '自然语言问答需要在设置中配置分析模型。');
  }
  await onRequest?.();
  const response = await (services.aiTextModel || defaultTextModel).callTextModel({
    textConfig,
    messages: answerMessages({ message, context }),
    temperature: 0.4,
    maxTokens: 1200,
    stream: true,
    onDelta,
    streamChunkTimeoutMs: 30000,
    requestTimeoutMs: 120000,
    maxRetries: 1,
  });
  if (!response?.success || typeof response.text !== 'string') {
    throw new WhiteboardError('ANSWER_GENERATION_FAILED', response?.message || '回答生成失败，请稍后重试。');
  }
  return response.text;
}

module.exports = { INTENT_CONTRACT, intentSchema, buildContextBlock, classifyIntent, streamAnswer, normalizeIntent };
