import { useEffect, useRef, useState } from 'react';
import { Download, Loader2, Package } from 'lucide-react';
import { api } from '@/api/client.js';
import { Button } from '@/components/ui/button.jsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog.jsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.jsx';

const displayBytes = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB`
  : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

export function TaskBundleButton({ workflowId }) {
  const [open, setOpen] = useState(false), [mode, setMode] = useState('diagnostics');
  const [preview, setPreview] = useState(null), [previewBusy, setPreviewBusy] = useState(false);
  const [job, setJob] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [downloadStarted, setDownloadStarted] = useState(false);
  const [estimateRetry, setEstimateRetry] = useState(0);
  const [previewError, setPreviewError] = useState(''), [downloading, setDownloading] = useState(false);
  const lock = useRef(false), generation = useRef(0), controller = useRef(null);
  const busyJob = job && ['collecting', 'packing'].includes(job.status);

  useEffect(() => {
    generation.current += 1;
    controller.current?.abort();
    lock.current = false;
    setOpen(false); setJob(null); setBusy(false); setError(''); setPreview(null); setDownloading(false);
    return () => { generation.current += 1; controller.current?.abort(); };
  }, [workflowId]);

  useEffect(() => {
    if (!open || busyJob || busy) return;
    const abort = new AbortController();
    setPreviewBusy(true); setPreview(null); setPreviewError('');
    api.previewTaskBundle(workflowId, mode === 'files', abort.signal).then(result => {
      if (!abort.signal.aborted) setPreview(result);
    }).catch(failure => {
      if (!abort.signal.aborted) setPreviewError(failure.message || '无法估算任务资料，请稍后重试。');
    }).finally(() => { if (!abort.signal.aborted) setPreviewBusy(false); });
    return () => abort.abort();
  }, [open, workflowId, mode, busyJob, busy, estimateRetry]);

  // 重新打开弹窗或短暂网络中断后可以继续查询同一个打包任务，不会重复建包。
  useEffect(() => {
    if (!open || !busyJob) return;
    const abort = new AbortController();
    let timer;
    const poll = async () => {
      try {
        const result = await api.getTaskBundle(workflowId, job.id, abort.signal);
        if (abort.signal.aborted) return;
        setJob(result); setError('');
        if (result.status === 'failed') setError(result.message);
        if (['collecting', 'packing'].includes(result.status)) timer = setTimeout(poll, 1000);
      } catch (failure) {
        if (abort.signal.aborted) return;
        setError(`${failure.message || '查询打包进度失败。'} ${failure.status === 404 ? '请重新打包。' : '正在继续查询已有打包任务…'}`);
        if (failure.status === 404) setJob(null);
        else timer = setTimeout(poll, 3000);
      }
    };
    poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [open, workflowId, job?.id, busyJob]);

  useEffect(() => {
    if (job?.status !== 'ready' || !job.expires_at) return;
    const timer = setTimeout(() => { setJob(null); setError('诊断包已过期，请重新打包。'); },
      Math.max(0, Date.parse(job.expires_at) - Date.now()));
    return () => clearTimeout(timer);
  }, [job?.id, job?.status, job?.expires_at]);

  useEffect(() => {
    if (!open || job?.status !== 'ready') return;
    const abort = new AbortController();
    api.getTaskBundle(workflowId, job.id, abort.signal).catch(failure => {
      if (abort.signal.aborted) return;
      setError(failure.message);
      if (failure.status === 404) setJob(null);
    });
    return () => abort.abort();
  }, [open, workflowId, job?.id, job?.status]);

  async function download() {
    if (lock.current || job?.status !== 'ready') return;
    lock.current = true;
    const request = generation.current;
    const abort = new AbortController(); controller.current = abort;
    setDownloading(true); setError('');
    try {
      await api.verifyTaskBundleDownload(workflowId, job.id, abort.signal);
      if (generation.current !== request) return;
      const anchor = document.createElement('a');
      anchor.href = api.getTaskBundleFileUrl(workflowId, job.id); anchor.download = '';
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setDownloadStarted(true);
    } catch (failure) {
      if (generation.current === request) {
        setError(failure.message || '下载失败，请重新打包。');
        if (failure.status === 404) setJob(null);
      }
    } finally { if (generation.current === request) { lock.current = false; setDownloading(false); } }
  }

  async function start() {
    if (lock.current || busyJob || previewBusy || !preview) return;
    lock.current = true;
    const request = generation.current;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(''); setDownloadStarted(false);
    try {
      const result = await api.createTaskBundle(workflowId, mode === 'files', abort.signal);
      if (generation.current === request) setJob(result);
    } catch (failure) {
      if (generation.current === request) setError(failure.message || '提交打包任务失败，请稍后重试。');
    } finally {
      if (generation.current === request) { lock.current = false; setBusy(false); }
    }
  }

  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button variant="outline" size="sm" disabled={!workflowId}>
      <Package size={14} />打包任务详情
    </Button></DialogTrigger>
    <DialogContent className="max-h-[85vh] overflow-y-auto">
      <DialogHeader><DialogTitle>打包任务详情</DialogTitle>
        <DialogDescription>下载当前任务的诊断 ZIP，发送给开发者排查。打包只读取本地资料，不会重新调用模型。</DialogDescription>
      </DialogHeader>
      <div className="grid gap-3 text-sm">
        <span className="break-all text-xs text-muted-foreground">任务 ID：{workflowId}</span>
        <Select value={mode} disabled={Boolean(busyJob) || busy || downloading} onValueChange={value => { setMode(value); setJob(null); setError(''); setDownloadStarted(false); }}>
          <SelectTrigger aria-label="打包内容"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="diagnostics">诊断包（推荐）</SelectItem>
            <SelectItem value="files">诊断包＋素材与工程文件</SelectItem></SelectContent>
        </Select>
        <p className="m-0 leading-relaxed text-muted-foreground">{mode === 'files'
          ? '包含诊断资料及本任务关联的图片、音频、字幕、工程和中间产物。大型视频可能使压缩包很大。'
          : '包含任务设置、阶段和错误、已保存的 API 请求与返回、方案及文件清单；不包含大型音视频。'}</p>
        <div className="rounded-md border p-3 text-xs leading-relaxed text-muted-foreground">
          密钥、Cookie 和常见签名会按规则隐藏；正文、提示词和素材仍可能包含私人内容，分享前请检查。
          运行中的任务也能打包，变化或缺失的文件会注明；历史版本未保存的信息无法补回。临时包保留 30 分钟。
        </div>
        {previewBusy && !busyJob ? <p role="status" className="m-0 flex items-center gap-2"><Loader2 size={16} className="animate-spin" />正在估算任务资料大小…</p> : null}
        {preview && !busyJob ? <p className="m-0 text-xs text-muted-foreground">关联文件约 {displayBytes(preview.estimated_bytes)}，{preview.total_files} 个文件；API 返回另计。超出上限的资料会在清单中注明。</p> : null}
        {busy || busyJob ? <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-md bg-muted p-3">
          <Loader2 size={16} className="shrink-0 animate-spin" />
          <span>{busy ? '正在提交打包任务…' : job.message}
            {job?.status === 'packing' ? `（文件 ${job.completed_files}/${job.total_files}，关联文件约 ${displayBytes(job.estimated_bytes)}）` : ''}</span>
        </div> : null}
        {job?.status === 'ready' ? <div role="status" className="rounded-md border p-3 text-sm leading-relaxed">
          压缩包已准备好：{displayBytes(job.bytes)}，API 记录 {job.apiRecords} 条。
          {job.skippedCount ? ` 有 ${job.skippedCount} 项未包含，详见包内清单。` : ''}
          {downloadStarted ? <p className="mb-0 mt-2">已请求下载，请检查浏览器下载列表；完成后可将 ZIP 发给开发者。</p> : null}
        </div> : null}
        {error || previewError || job?.status === 'failed' ? <p role="alert" className="m-0 break-words text-sm text-destructive">{error || previewError || job.message}</p> : null}
        {!preview && !previewBusy && !busy && !busyJob ? <Button variant="outline" onClick={() => setEstimateRetry(value => value + 1)}>重新估算资料</Button> : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => setOpen(false)}>关闭</Button>
        {job?.status === 'ready' ? <><Button variant="outline" disabled={downloading} onClick={() => { setJob(null); setError(''); setDownloadStarted(false); }}>重新打包</Button>
          <Button disabled={downloading} onClick={download}>{downloading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}{downloading ? '正在检查下载文件…' : '下载 ZIP'}</Button></>
          : <Button disabled={busy || Boolean(busyJob) || previewBusy || !preview} onClick={start}>
          {busy || busyJob ? <Loader2 size={16} className="animate-spin" /> : <Package size={16} />}
          {busyJob ? '正在打包…' : job?.status === 'failed' ? '重新打包' : '开始打包'}
        </Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
