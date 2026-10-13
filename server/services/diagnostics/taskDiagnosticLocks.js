const path = require('path');

// 导出不锁住制作；只与会删除资料的操作互斥。同步获取锁，避免检查后竞态。
const exportsByTask = new Map();
const deletes = new Set();
let cleaning = false;
const keyFor = (rootDir, workflowId) => path.resolve(rootDir, `${workflowId}.json`);

function beginExport(rootDir, workflowId) {
  const key = keyFor(rootDir, workflowId);
  if (cleaning || deletes.has(key)) return null;
  exportsByTask.set(key, (exportsByTask.get(key) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = exportsByTask.get(key) - 1;
    if (count) exportsByTask.set(key, count); else exportsByTask.delete(key);
  };
}

function beginDelete(rootDir, workflowId) {
  const key = keyFor(rootDir, workflowId);
  if (cleaning || exportsByTask.has(key) || deletes.has(key)) return null;
  deletes.add(key);
  return () => deletes.delete(key);
}

function beginCleanup() {
  if (cleaning || exportsByTask.size || deletes.size) return null;
  cleaning = true;
  return () => { cleaning = false; };
}

module.exports = { beginExport, beginDelete, beginCleanup };
