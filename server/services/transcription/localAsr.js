const { transcribeFunasrAudio } = require('./funasr');
const { transcribeFireRedAudio } = require('./firered');
const { createFunasrRuntime, ensureFunasrService } = require('./funasrRuntime');
const runtime = createFunasrRuntime({ backend: 'firered' });
const backendFor = config => config.backend || config.provider;
function ensureLocalAsrService(config, options) {
  return backendFor(config) === 'firered' ? runtime.ensure({ ...config, provider: 'firered' }, options) : ensureFunasrService(config, options);
}
function transcribeLocalAsrAudio(audioPath, config, options) {
  return backendFor(config) === 'firered' ? transcribeFireRedAudio(audioPath, config, options) : transcribeFunasrAudio(audioPath, config, options);
}
module.exports = { ensureLocalAsrService, transcribeLocalAsrAudio };
