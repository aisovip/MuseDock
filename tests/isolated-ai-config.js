const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

// 未创建的独立路径按空配置读取，避免模型替身测试依赖用户保存的全局开关。
module.exports = { isolatedConfigPath: path.join(os.tmpdir(), `musedock-ai-fixture-${randomUUID()}`, 'ai-models.json') };
