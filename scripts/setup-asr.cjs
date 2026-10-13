const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dataRoot = require('../server/dataRoot');
const resources = path.join(__dirname, '../server/resources/firered');
const root = path.join(dataRoot, 'data/runtime/firered');
const managedPython = path.join(root, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const args = process.argv.slice(2);
function argument(name) {
  const index = args.indexOf(name);
  if (index < 0) return '';
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} 需要填写路径`);
  return args[index + 1];
}
const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
function run(file, parameters, inherit = true) {
  return spawnSync(file, parameters, { env, shell: false, windowsHide: true,
    stdio: inherit ? 'inherit' : 'pipe', encoding: 'utf8', timeout: inherit ? 1800000 : 15000 });
}
function checked(file, parameters) {
  const result = run(file, parameters);
  if (result.error || result.status !== 0) throw new Error('安装步骤失败，请检查上方下载/依赖错误及磁盘空间后重试。');
}
function main() {
  for (let i = 0; i < args.length; i += 2) if (!['--python', '--model-cache', '--source-cache'].includes(args[i])) throw new Error('仅支持 --python、--model-cache、--source-cache 参数。');
  const explicit = argument('--python') || process.env.MUSEDOCK_PYTHON;
  const candidates = explicit ? [[explicit, []]] : [['py', ['-3.11']], ['py', ['-3.12']], ['python3', []], ['python', []]];
  const versionCheck = ['-B', '-c', 'import sys; assert (3,11) <= sys.version_info[:2] < (3,13)'];
  let selected;
  for (const [file, prefix] of candidates) if (run(file, [...prefix, ...versionCheck], false).status === 0) { selected = [file, prefix]; break; }
  if (!selected) throw new Error('请先安装 Python 3.11 或 3.12，再运行 npm run setup:asr -- --python Python解释器路径。');
  console.log('正在准备独立 FireRed CPU 环境及字词对齐模型。首次下载约 1.36 GB，请预留至少 5 GB 磁盘空间。');
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const lock = `${root}.install.lock`;
  let descriptor;
  try { descriptor = fs.openSync(lock, 'wx'); } catch { throw new Error('另一个 ASR 安装正在执行。若安装被强制中断，请确认没有安装进程后移除数据目录中的 firered.install.lock 再重试。'); }
  try {
    if (!fs.existsSync(managedPython)) checked(selected[0], [...selected[1], '-m', 'venv', root]);
    checked(managedPython, versionCheck);
    checked(managedPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', path.join(resources, 'requirements.txt')]);
    const cache = argument('--model-cache') || process.env.FIRERED_MODEL_CACHE || path.join(dataRoot, 'data/models/firered');
    const source = argument('--source-cache');
    checked(managedPython, ['-B', path.join(resources, 'download_models.py'), '--model-cache', cache,
      ...(source ? ['--source-cache', source] : [])]);
    console.log('本地 ASR 配置完成，下一次转写时 MuseDock 会自动启动 FireRed。');
  } finally { fs.closeSync(descriptor); fs.unlinkSync(lock); }
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { main };
