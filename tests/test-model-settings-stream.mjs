import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 对实际 hook 执行读取、草稿修改、保存与重新加载，不调用本机配置接口。
const source = await readFile('frontend-react/src/hooks/useSettings.js', 'utf8');
const slots = [];
let cursor = 0;
let saved = { providers: {}, active: {}, analysisStreaming: false };
let saveCount = 0;
let finishSave;
const context = {
  BUILTIN_FIRERED_REF: 'builtin/firered', DEFAULT_FIRERED_BASE_URL: 'http://example.invalid/v1',
  useState(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = initial;
    return [slots[index], update => { slots[index] = typeof update === 'function' ? update(slots[index]) : update; }];
  },
  useCallback: callback => callback, useMemo: callback => callback(), useEffect() {},
  api: {
    getAiModels: async () => structuredClone(saved),
    async saveAiModels(payload) {
      saveCount++;
      await new Promise(resolve => { finishSave = resolve; });
      saved = structuredClone(payload);
      return saved;
    },
  },
};
vm.createContext(context);
vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replace('export function useSettings()', 'function useSettings()')
  + '\nthis.useSettings = useSettings;', context);
const render = () => { cursor = 0; return context.useSettings(); };

await render().load();
assert.equal(render().state.analysisStreaming, false);
render().setAnalysisStreaming(true);
assert.equal(render().state.analysisStreaming, true);
assert.equal(render().dirty, true);
assert.equal(saveCount, 0, '切换开关只改草稿');
const pending = render().save();
assert.equal(render().saving, true);
assert.equal(render().status.message, '正在保存配置...');
finishSave();
await pending;
assert.equal(saved.analysisStreaming, true);
assert.equal(render().saving, false);
assert.equal(render().dirty, false);
await render().load();
assert.equal(render().state.analysisStreaming, true, '重新加载保留已保存开关');
render().setAnalysisStreaming(false);
const disabling = render().save();
finishSave();
await disabling;
assert.equal(saved.analysisStreaming, false);

context.api.saveAiModels = async () => { throw new Error('配置保存失败，请重试'); };
render().setAnalysisStreaming(true);
await render().save();
assert.equal(render().saving, false);
assert.equal(render().dirty, true, '保存失败应保留草稿');
assert.equal(render().status.type, 'error');
console.log('PASS 流式开关草稿、保存loading、往返重载、关闭与保存失败；真实接口请求 0');
