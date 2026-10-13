const express = require('express');
const { defaultBundleJobs } = require('../services/diagnostics/taskDiagnosticBundleJobs');

const router = express.Router({ mergeParams: true });
router.use((req, res, next) => {
  if (!/^\d{5,32}$/.test(req.params.workflow_id || '')) return res.status(400).json({ success: false, message: '创作任务 ID 无效。' });
  res.set('Cache-Control', 'no-store');
  next();
});
const service = req => req.app.locals.taskDiagnosticBundles || defaultBundleJobs();
const failure = (res, error) => res.status(error.statusCode || 500).json({ success: false,
  message: error.statusCode ? error.message : '诊断包操作失败，请检查本地服务、文件权限和磁盘空间。' });

router.get('/preview', async (req, res) => {
  if (req.query.include_files !== undefined && !['0', '1'].includes(req.query.include_files)) return res.status(400).json({ success: false, message: '打包选项无效。' });
  try { res.json(await service(req).preview(req.params.workflow_id, { includeFiles: req.query.include_files === '1' })); }
  catch (error) { failure(res, error); }
});
router.post('/', async (req, res) => {
  try { res.status(202).json(await service(req).start(req.params.workflow_id, req.body || {})); }
  catch (error) { failure(res, error); }
});
router.get('/:bundle_id', (req, res) => {
  try { res.json(service(req).get(req.params.workflow_id, req.params.bundle_id)); }
  catch (error) { failure(res, error); }
});
router.get('/:bundle_id/file', (req, res) => {
  try {
    const file = service(req).file(req.params.workflow_id, req.params.bundle_id);
    res.set('Content-Type', 'application/zip');
    res.set('X-Content-Type-Options', 'nosniff');
    res.download(file.path, file.filename, error => {
      if (error && !res.headersSent) failure(res, { statusCode: 404, message: '压缩包文件不存在或无法读取，请重新打包。' });
    });
  } catch (error) { failure(res, error); }
});
module.exports = router;
