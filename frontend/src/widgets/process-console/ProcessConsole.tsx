/**
 * Process Console sheet — live stdout/stderr, stdin, signal, cancel,
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
  getProcessLogs,
  signalProcess,
  writeProcessStdin,
} from '../../shared/api';
import { formatDuration } from '../runtime-timeline/buildTimeline';
import {
  buildLogLines,
  filterLogLines,
  formatLogsForDownload,
  isProcessInteractive,
  PROCESS_SIGNALS,
  type LogStream,
  type ProcessSignal,
} from './logHelpers';

export function ProcessConsole({
  process,
  open,
  onClose,
}: {
  process: ProcessEntity | null;
  open: boolean;
  onClose: () => void;
}) {
  const [streamFilter, setStreamFilter] = useState<LogStream>('both');
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [stdinText, setStdinText] = useState('');
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [historyStdout, setHistoryStdout] = useState('');
  const [historyStderr, setHistoryStderr] = useState('');
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  // Reset local state when process changes
  useEffect(() => {
    setStreamFilter('both');
    setSearch('');
    setAutoScroll(true);
    setStdinText('');
    setStatusMsg(null);
    setHistoryStdout('');
    setHistoryStderr('');
    setHistoryOffset(0);
    setHistoryLoaded(false);
  }, [process?.id]);

  const liveStdout = process?.stdout || '';
  const liveStderr = process?.stderr || '';
  // Prefer live entity logs; prepend history only when it adds content
  const stdout = historyLoaded
    ? mergeLogs(historyStdout, liveStdout)
    : liveStdout;
  const stderr = historyLoaded
    ? mergeLogs(historyStderr, liveStderr)
    : liveStderr;

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

  const interactive = isProcessInteractive(process?.status);

  const flash = (msg: string) => {
    setStatusMsg(msg);
    window.setTimeout(() => {
      setStatusMsg((cur) => (cur === msg ? null : cur));
    }, 3000);
  };

  const loadHistory = async () => {
    if (!process) return;
    setBusy(true);
    try {
      const logs = await getProcessLogs(process.id, {
        offset: historyOffset,
        limit: 50_000,
      });
      if (!logs) {
        flash('History API unavailable — showing live stream only');
        return;
      }
      setHistoryStdout((prev) =>
        historyOffset === 0 ? logs.stdout : prev + logs.stdout,
      );
      setHistoryStderr((prev) =>
        historyOffset === 0 ? logs.stderr : prev + logs.stderr,
      );
      setHistoryOffset(logs.next_offset);
      setHistoryLoaded(true);
      flash(
        logs.truncated
          ? `Loaded history (truncated · offset ${logs.next_offset})`
          : `Loaded history · offset ${logs.next_offset}`,
      );
    } catch (err) {
      flash((err as Error).message || 'Failed to load history');
    } finally {
      setBusy(false);
    }
  };

  const sendStdin = async (eof = false) => {
    if (!process) return;
    const data = stdinText;
    if (!data && !eof) return;
    setBusy(true);
    try {
      const r = await writeProcessStdin(process.id, data, eof);
      if (!r.ok) {
        flash(r.error || 'stdin failed');
        return;
      }
      setStdinText('');
      flash(eof ? 'EOF sent' : 'stdin written');
    } finally {
      setBusy(false);
    }
  };

  const sendSignal = async (sig: ProcessSignal) => {
    if (!process) return;
    if (sig === 'SIGKILL' && !confirm(`Send ${sig} to process?`)) return;
    setBusy(true);
    try {
      const r = await signalProcess(process.id, sig);
      flash(r.ok ? `Sent ${sig}` : r.error || `${sig} failed`);
    } finally {
      setBusy(false);
    }
  };

  const doCancel = async () => {
    if (!process) return;
    if (!confirm('Cancel this process?')) return;
    setBusy(true);
    try {
      const r = await cancelProcess(process.id);
      flash(r.ok ? 'Cancel requested' : r.error || 'Cancel failed');
    } finally {
      setBusy(false);
    }
  };

  const downloadLogs = () => {
    const text = formatLogsForDownload(stdout, stderr);
    const blob = new Blob([text || '(empty)'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `process-${process?.id || 'log'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!open || !process) return null;

  const duration = formatDuration(process.startedAt, process.finishedAt);

  return (
    <div
      className="process-console-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Process console"
    >
      <div className="process-console-backdrop" onClick={onClose} />
      <div className="process-console-sheet">
        <header className="pc-head">
          <div className="pc-title-block">
            <h2 className="pc-title">Process Console</h2>
            <p className="pc-cmd mono" title={process.command || process.id}>
              {process.command || process.id}
            </p>
          </div>
          <div className="pc-meta">
            <span className={`pc-badge status-${process.status}`}>
              {process.status}
            </span>
            {process.exitCode != null ? (
              <span className="pc-badge">exit {process.exitCode}</span>
            ) : null}
            <span className="pc-badge muted">{duration}</span>
            <span className="pc-badge mono muted" title={process.id}>
              {process.id.length > 16
                ? `${process.id.slice(0, 14)}…`
                : process.id}
            </span>
          </div>
          <button
            type="button"
            className="btn-icon pc-close"
            title="Close console"
            aria-label="Close process console"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="pc-toolbar">
          <div className="pc-filters" role="group" aria-label="Stream filter">
            {(['both', 'stdout', 'stderr'] as LogStream[]).map((s) => (
              <button
                key={s}
                type="button"
                className={`pc-chip${streamFilter === s ? ' active' : ''}`}
                onClick={() => setStreamFilter(s)}
              >
                {s}
              </button>
            ))}
          </div>
          <input
            type="search"
            className="pc-search"
            placeholder="Search logs…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search logs"
          />
          <label className="pc-autoscroll">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Auto-scroll
          </label>
          <button
            type="button"
            className="pc-tool-btn"
            disabled={busy}
            onClick={() => void loadHistory()}
            title="Load logs from offset (history API)"
          >
            Load history
          </button>
          <button
            type="button"
            className="pc-tool-btn"
            onClick={downloadLogs}
            title="Download full log"
          >
            Download
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
              No log output yet
              {process.status === 'running' ? ' — waiting for stdout/stderr…' : ''}
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
                  ? 'Write to stdin… (Enter to send)'
                  : 'Process is not interactive'
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
              Stdin
            </button>
            <button
              type="button"
              className="pc-tool-btn"
              disabled={!interactive || busy}
              onClick={() => void sendStdin(true)}
              title="Send EOF"
            >
              EOF
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
            <button
              type="button"
              className="pc-tool-btn danger"
              disabled={!interactive || busy}
              onClick={() => void doCancel()}
            >
              Cancel process
            </button>
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

/** Prefer longer live buffer; otherwise concatenate unique prefix history. */
function mergeLogs(history: string, live: string): string {
  if (!history) return live;
  if (!live) return history;
  if (live.startsWith(history)) return live;
  if (history.includes(live)) return history;
  // Overlap heuristic: if live is a suffix of history+live, just append
  return history + live;
}
