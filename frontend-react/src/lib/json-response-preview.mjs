export const PREVIEW_CHARACTERS = 100000;
const MAX_PREVIEW_NODES = 2000;
const MAX_PREVIEW_DEPTH = 32;

// 不用正则匹配整个长字符串：token 的扫描和保存均受预览字符预算限制。
function* previewTokens(text) {
  const limit = Math.min(text.length, PREVIEW_CHARACTERS);
  let cursor = 0;
  const whitespace = char => char === ' ' || char === '\t' || char === '\r' || char === '\n';
  const punctuation = char => '{}[],:'.includes(char);
  while (cursor < limit) {
    if (whitespace(text[cursor])) { cursor += 1; continue; }
    const index = cursor;
    let complete = true;
    if (text[cursor] === '"') {
      cursor += 1;
      complete = false;
      while (cursor < limit) {
        const char = text[cursor++];
        if (char === '"') { complete = true; break; }
        if (char === '\\') cursor = Math.min(limit, cursor + 1);
      }
    } else if (punctuation(text[cursor])) cursor += 1;
    else {
      while (cursor < limit && !whitespace(text[cursor]) && !punctuation(text[cursor])) cursor += 1;
      complete = cursor < text.length ? whitespace(text[cursor]) || punctuation(text[cursor]) : true;
    }
    yield { raw: text.slice(index, cursor), incomplete: !complete };
  }
}

export function createJsonPreview(text) {
  try {
    JSON.parse(text);
    return buildPreview(text);
  } catch {
    // 校验或预览异常都回退到有限长度的原文展示，不能中断整页渲染。
    return null;
  }
}

function buildPreview(text) {
  // 展示保留原始 token，避免改写长整数、数值格式和重复字段。
  const stack = [];
  let root = null;
  let nodeCount = 0;
  let truncated = text.length > PREVIEW_CHARACTERS;

  for (const { raw, incomplete } of previewTokens(text)) {
    if (raw === ',' || raw === ':') continue;
    if (raw === '}' || raw === ']') { stack.pop(); continue; }

    const parent = stack.at(-1);
    if (parent?.node.type === 'object' && parent.key === null) {
      parent.key = raw;
      if (incomplete) {
        parent.node.children.push({ type: 'string', key: raw, text: '', truncated: true });
        truncated = true;
        break;
      }
      continue;
    }
    if (nodeCount >= MAX_PREVIEW_NODES || stack.length >= MAX_PREVIEW_DEPTH) {
      truncated = true;
      break;
    }
    const type = raw === '{' ? 'object' : raw === '[' ? 'array'
      : raw.startsWith('"') ? 'string' : raw === 'null' ? 'null'
        : raw === 'true' || raw === 'false' ? 'boolean' : 'number';
    const node = { type, key: parent?.key ?? null };
    if (type === 'object' || type === 'array') node.children = [];
    else {
      node.text = raw;
      node.truncated = incomplete;
    }
    if (parent) {
      parent.node.children.push(node);
      parent.key = null;
    } else root = node;
    nodeCount += 1;

    if (node.children) stack.push({ node, key: null });
    if (node.truncated) { truncated = true; break; }
  }
  for (const { node } of stack) node.truncated = true;
  return root ? { root, truncated } : null;
}
