/**
 * Process Console sheet — logs (GET /api/processes/{id}/logs), stdin, signal, cancel,
 * offset history load, pause auto-scroll, stream filter, search, download.
 * (ADR 0003 §8.3 / F4)
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { ProcessEntity } from '../../entities';
import {
  cancelProcess,
  getProcess,
  getProcessLogs,
  signalProcess,
  writeProcessStdin,
} from '../../shared/api';
import { formatDuration } from '../runtime-timeline/buildTimeline';
import {
  buildLogLines,
  createProcessPoller,
  filterLogLines,
  formatLogsForDownload,
  formatProcessStatus,
  isProcessInteractive,
  PROCESS_SIGNALS,
  type LogStream,
  type ProcessSignal,
} from './logHelpers';

const STREAM_LABELS: Record<LogStream, string> = {
  both: '全部',
  stdout: '标准输出',
  stderr: '标准错误',
};

export function ProcessConsole({
  process,
  open,
  onClose,
  onUpdateProcess,
}: {
  process: ProcessEntity | null;
  open: boolean;
  onClose: () => void;
  onUpdateProcess?: (process: ProcessEntity) => void;
}) {
  const [streamFilter, setStreamFilter] = useState<LogStream>('both');
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [stdinText, setStdinText] = useState('');
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [historyStdout, setHistoryStdout] = useState('');
  const [historyStderr, setHistoryStderr] = useState('');
  const [, setHistoryOffset] = useState(0);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [liveProcess, setLiveProcess] = useState<ProcessEntity | null>(process);
  const logRef = useRef<HTMLPreElement>(null);
  const onUpdateProcessRef = useRef(onUpdateProcess);
  onUpdateProcessRef.current = onUpdateProcess;

  const activeProcess = liveProcess ?? process;

  // Reset local state when process changes or sheet toggles
  useEffect(() => {
    setStreamFilter('both');
    setSearch('');
    setAutoScroll(true);
    setStdinText('');
    setStatusMsg(null);
    setConfirmingCancel(false);
    setHistoryStdout('');
    setHistoryStderr('');
    setHistoryOffset(0);
    setLiveProcess(process);
  }, [process?.id, open]);

  const pollerRef = useRef<ReturnType<typeof createProcessPoller> | null>(null);
  if (!pollerRef.current) {
    pollerRef.current = createProcessPoller({
      getProcessLogs,
      getProcess,
      onLogs: (logs, offset) => {
        setHistoryOffset(logs.next_offset);
        setHistoryStdout((prev) => (offset === 0 ? logs.stdout : prev + logs.stdout));
        setHistoryStderr((prev) => (offset === 0 ? logs.stderr : prev + logs.stderr));
      },
      onProcess: (entity) => {
        setLiveProcess(entity);
        onUpdateProcessRef.current?.(entity);
      },
    });
  }
  const poller = pollerRef.current;

  // Auto-start polling on open / process change; clean up on close
  useEffect(() => {
    if (!open || !process?.id || !process?.sessionId) {
      poller.stop();
      return;
    }
    poller.resetOffset();
    poller.start(process.id, process.sessionId, process);
    return () => {
      poller.stop();
    };
  }, [open, process?.id, process?.sessionId]);

  useEffect(() => {
    if (activeProcess && !isProcessInteractive(activeProcess.status)) {
      poller.stop();
    }
  }, [activeProcess?.status]);

  // Logs come from GET /api/processes/{id}/logs; the stream carries no process output.
  const stdout = historyStdout;
  const stderr = historyStderr;

  const lines = useMemo(
    () =>
      filterLogLines(buildLogLines(stdout, stderr), {
        stream: streamFilter,
        search,
      }),
    [stdout, stderr, streamFilter, search],
  );

  // Auto-scroll when new lines arrive
  useEffect(() => {
    if (!autoScroll || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines.length, autoScroll, stdout, stderr]);

  // Pause auto-scroll when user scrolls up
  const onLogScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (!atBottom && autoScroll) setAutoScroll(false);
    if (atBottom && !autoScroll) setAutoScroll(true);
  }, [autoScroll]);

  const interactive = isProcessInteractive(activeProcess?.status);

  const flash = (msg: string) => {
    setStatusMsg(msg);
    window.setTimeout(() => {
      setStatusMsg((cur) => (cur === msg ? null : cur));
    }, 3000);
  };

  const loadHistory = async () => {
    if (!activeProcess?.sessionId) return;
    setBusy(true);
    try {
      const currentOffset = poller.getOffset();
      const logs = await getProcessLogs(activeProcess.id, {
        sessionId: activeProcess.sessionId,
        offset: currentOffset,
        limit: 50_000,
      });
      poller.setOffset(logs.next_offset);
      setHistoryOffset(logs.next_offset);
      setHistoryStdout((prev) =>
        currentOffset === 0 ? logs.stdout : prev + logs.stdout,
      );
      setHistoryStderr((prev) =>
        currentOffset === 0 ? logs.stderr : prev + logs.stderr,
      );
      flash(
        logs.truncated
          ? `已加载历史日志（已截断 · 偏移量 ${logs.next_offset}）`
          : `已加载历史日志 · 偏移量 ${logs.next_offset}`,
      );
    } catch (err) {
      flash((err as Error).message || '加载历史日志失败');
    } finally {
      setBusy(false);
    }
  };

  const sendStdin = async (eof = false) => {
    if (!activeProcess?.sessionId) return;
    const data = stdinText;
    if (!data && !eof) return;
    setBusy(true);
    try {
      const r = await writeProcessStdin(activeProcess.id, activeProcess.sessionId, data, eof);
      if (!r.ok) {
        flash(r.error || '标准输入写入失败');
        return;
      }
      setStdinText('');
      flash(eof ? '已发送 EOF' : '已写入标准输入');
      await poller.pollOnce(activeProcess.id, activeProcess.sessionId, activeProcess);
    } finally {
      setBusy(false);
    }
  };

  const sendSignal = async (sig: ProcessSignal) => {
    if (!activeProcess?.sessionId) return;
    setBusy(true);
    try {
      const r = await signalProcess(activeProcess.id, activeProcess.sessionId, sig);
      flash(r.ok ? `已发送 ${sig}` : r.error || `发送 ${sig} 失败`);
      await poller.pollOnce(activeProcess.id, activeProcess.sessionId, activeProcess);
    } finally {
      setBusy(false);
    }
  };

  const doCancel = async () => {
    if (!activeProcess?.sessionId) return;
    setBusy(true);
    try {
      const r = await cancelProcess(activeProcess.id, activeProcess.sessionId);
      flash(r.ok ? '已请求取消进程' : r.error || '取消进程失败');
      await poller.pollOnce(activeProcess.id, activeProcess.sessionId, activeProcess);
    } finally {
      setBusy(false);
      setConfirmingCancel(false);
    }
  };

  const downloadLogs = () => {
    const text = formatLogsForDownload(stdout, stderr);
    const blob = new Blob([text || '(空)'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `process-${activeProcess?.id || 'log'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!open || !activeProcess) return null;

  const duration = formatDuration(activeProcess.startedAt, activeProcess.finishedAt);

  return (
    <div
      className="process-console-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="进程控制台"
    >
      <div className="process-console-backdrop" onClick={onClose} />
      <div className="process-console-sheet">
        <header className="pc-head">
          <div className="pc-title-block">
            <h2 className="pc-title">进程控制台</h2>
            <p className="pc-cmd mono" title={activeProcess.command || activeProcess.id}>
              {activeProcess.command || activeProcess.id}
            </p>
          </div>
          <div className="pc-meta">
            <span className={`pc-badge status-${activeProcess.status}`}>
              {formatProcessStatus(activeProcess.status)}
            </span>
            {activeProcess.exitCode != null ? (
              <span className="pc-badge">退出码 {activeProcess.exitCode}</span>
            ) : null}
            <span className="pc-badge muted">{duration}</span>
            <span className="pc-badge mono muted" title={activeProcess.id}>
              {activeProcess.id.length > 16
                ? `${activeProcess.id.slice(0, 14)}…`
                : activeProcess.id}
            </span>
          </div>
          <button
            type="button"
            className="btn-icon pc-close"
            title="关闭控制台"
            aria-label="关闭控制台"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="pc-toolbar">
          <div className="pc-filters" role="group" aria-label="输出流筛选">
            {(['both', 'stdout', 'stderr'] as LogStream[]).map((s) => (
              <button
                key={s}
                type="button"
                className={`pc-chip${streamFilter === s ? ' active' : ''}`}
                onClick={() => setStreamFilter(s)}
              >
                {STREAM_LABELS[s]}
              </button>
            ))}
          </div>
          <input
            type="search"
            className="pc-search"
            placeholder="搜索日志…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="搜索日志"
          />
          <label className="pc-autoscroll">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            自动滚动
          </label>
          <button
            type="button"
            className="pc-tool-btn"
            disabled={busy}
            onClick={() => void loadHistory()}
            title="从偏移量加载日志（历史 API）"
          >
            加载历史
          </button>
          <button
            type="button"
            className="pc-tool-btn"
            onClick={downloadLogs}
            title="下载完整日志"
          >
            下载日志
          </button>
        </div>

        <pre
          className="pc-log"
          ref={logRef}
          onScroll={onLogScroll}
          aria-live="polite"
        >
          {lines.length === 0 ? (
            <span className="pc-log-empty">
              暂无日志输出
              {activeProcess.status === 'running' ? ' — 等待标准输出/标准错误…' : ''}
            </span>
          ) : (
            lines.map((ln) => (
              <div
                key={`${ln.stream}-${ln.index}`}
                className={`pc-line pc-${ln.stream}`}
              >
                <span className="pc-stream" aria-hidden="true">
                  {ln.stream === 'stderr' ? 'E' : 'O'}
                </span>
                <span className="pc-text">{ln.text}</span>
              </div>
            ))
          )}
        </pre>

        <footer className="pc-footer">
          <div className="pc-stdin-row">
            <input
              type="text"
              className="pc-stdin"
              placeholder={
                interactive
                  ? '写入标准输入… (按 Enter 发送)'
                  : '进程未在交互状态'
              }
              value={stdinText}
              disabled={!interactive || busy}
              onChange={(e) => setStdinText(e.target.value)}
              onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void sendStdin(false);
                }
              }}
            />
            <button
              type="button"
              className="pc-tool-btn"
              disabled={!interactive || busy || !stdinText}
              onClick={() => void sendStdin(false)}
            >
              标准输入
            </button>
            <button
              type="button"
              className="pc-tool-btn"
              disabled={!interactive || busy}
              onClick={() => void sendStdin(true)}
              title="发送 EOF"
            >
              发送 EOF
            </button>
          </div>
          <div className="pc-actions">
            {PROCESS_SIGNALS.map((sig) => (
              <button
                key={sig}
                type="button"
                className={`pc-tool-btn${sig === 'SIGKILL' ? ' danger' : ''}`}
                disabled={!interactive || busy}
                onClick={() => void sendSignal(sig)}
              >
                {sig}
              </button>
            ))}
            {confirmingCancel ? (
              <span className="pc-confirm-inline" role="group" aria-label="确认取消操作">
                <span className="pc-confirm-label">确认取消？</span>
                <button
                  type="button"
                  className="pc-tool-btn danger"
                  disabled={busy}
                  onClick={() => void doCancel()}
                >
                  确认
                </button>
                <button
                  type="button"
                  className="pc-tool-btn"
                  disabled={busy}
                  onClick={() => setConfirmingCancel(false)}
                >
                  返回
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="pc-tool-btn danger"
                disabled={!interactive || busy}
                onClick={() => setConfirmingCancel(true)}
              >
                取消进程
              </button>
            )}
          </div>
          {statusMsg ? (
            <p className="pc-status" role="status">
              {statusMsg}
            </p>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
