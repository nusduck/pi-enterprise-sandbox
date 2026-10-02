/**
 * Process Console pure helpers (ADR 0003 §8.3).
 */
import type { ProcessEntity } from '../../entities';
import type { ManagedProcess, ProcessLogs } from '../../shared/api';
import { processRowToEntity } from '../../features/chat/entityBridge';

export type LogStream = 'stdout' | 'stderr' | 'both';

export type LogLine = {
  stream: 'stdout' | 'stderr';
  text: string;
  /** Monotonic index within the merged view. */
  index: number;
};

/**
 * Split stdout/stderr into tagged lines for the console view.
 * Empty trailing newline does not produce an extra blank line.
 */
export function buildLogLines(
  stdout: string,
  stderr: string,
): LogLine[] {
  const lines: LogLine[] = [];
  let index = 0;

  function push(stream: 'stdout' | 'stderr', body: string) {
    if (!body) return;
    const parts = body.split('\n');
    // Drop final empty segment from trailing newline
    if (parts.length && parts[parts.length - 1] === '') parts.pop();
    for (const text of parts) {
      lines.push({ stream, text, index: index++ });
    }
  }

  push('stdout', stdout || '');
  push('stderr', stderr || '');
  return lines;
}

/** Filter by stream + case-insensitive search. */
export function filterLogLines(
  lines: LogLine[],
  opts: { stream?: LogStream; search?: string } = {},
): LogLine[] {
  const stream = opts.stream || 'both';
  const q = (opts.search || '').trim().toLowerCase();
  return lines.filter((ln) => {
    if (stream === 'stdout' && ln.stream !== 'stdout') return false;
    if (stream === 'stderr' && ln.stream !== 'stderr') return false;
    if (q && !ln.text.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Full log text for download (tagged). */
export function formatLogsForDownload(
  stdout: string,
  stderr: string,
): string {
  const parts: string[] = [];
  if (stdout) {
    parts.push('=== stdout ===\n' + stdout.replace(/\n?$/, '\n'));
  }
  if (stderr) {
    parts.push('=== stderr ===\n' + stderr.replace(/\n?$/, '\n'));
  }
  return parts.join('\n');
}

/** Whether process can accept stdin / signals / cancel. */
export function isProcessInteractive(status: string | null | undefined): boolean {
  return (
    status === 'running' ||
    status === 'waiting_input' ||
    status === 'created' ||
    status === 'cancel_requested'
  );
}

/** Localized status label for managed sandbox process. */
export function formatProcessStatus(status: string | null | undefined): string {
  switch (status) {
    case 'created':
      return '已创建';
    case 'running':
      return '运行中';
    case 'waiting_input':
      return '等待输入';
    case 'cancel_requested':
      return '取消中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'timeout':
      return '超时';
    case 'cancelled':
      return '已取消';
    case 'orphaned':
      return '已遗留';
    default:
      return status || '未知';
  }
}

export const PROCESS_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGKILL'] as const;
export type ProcessSignal = (typeof PROCESS_SIGNALS)[number];

export type ProcessPollerDeps = {
  getProcessLogs: (
    processId: string,
    opts: { sessionId: string; offset?: number; limit?: number },
  ) => Promise<ProcessLogs>;
  getProcess: (processId: string, sessionId: string) => Promise<ManagedProcess>;
  onLogs?: (logs: ProcessLogs, offset: number) => void;
  onProcess?: (entity: ProcessEntity) => void;
  intervalMs?: number;
};

export function createProcessPoller(deps: ProcessPollerDeps) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let offset = 0;
  let inFlight = false;
  let stopped = false;
  const interval = deps.intervalMs ?? 2000;

  async function pollOnce(
    processId: string,
    sessionId: string,
    currentProcess?: ProcessEntity | null,
  ): Promise<{ logs: ProcessLogs | null; entity: ProcessEntity | null }> {
    if (inFlight) return { logs: null, entity: null };
    inFlight = true;
    try {
      const currentOffset = offset;
      const [logsResult, procResult] = await Promise.allSettled([
        deps.getProcessLogs(processId, {
          sessionId,
          offset: currentOffset,
          limit: 50_000,
        }),
        deps.getProcess(processId, sessionId),
      ]);

      let logs: ProcessLogs | null = null;
      if (logsResult.status === 'fulfilled') {
        logs = logsResult.value;
        offset = logs.next_offset;
        deps.onLogs?.(logs, currentOffset);
      }

      let entity: ProcessEntity | null = null;
      if (procResult.status === 'fulfilled') {
        const raw = procResult.value;
        const converted = processRowToEntity(raw, { sessionId });
        if (converted) {
          entity = currentProcess
            ? {
                ...currentProcess,
                ...converted,
                runId: converted.runId || currentProcess.runId,
                toolExecutionId:
                  converted.toolExecutionId || currentProcess.toolExecutionId,
                command: converted.command || currentProcess.command,
              }
            : converted;
          deps.onProcess?.(entity);
          if (!isProcessInteractive(entity.status)) {
            stop();
          }
        }
      }
      return { logs, entity };
    } finally {
      inFlight = false;
    }
  }

  function start(
    processId: string,
    sessionId: string,
    initialProcess?: ProcessEntity | null,
  ) {
    stop();
    stopped = false;
    // Immediate fetch on open / start
    void pollOnce(processId, sessionId, initialProcess);

    // If initial process is already terminal, do not poll
    if (initialProcess && !isProcessInteractive(initialProcess.status)) {
      return;
    }

    timer = setInterval(() => {
      if (stopped) return;
      void pollOnce(processId, sessionId, initialProcess);
    }, interval);
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function resetOffset() {
    offset = 0;
  }

  function setOffset(newOffset: number) {
    offset = newOffset;
  }

  function getOffset() {
    return offset;
  }

  return {
    start,
    stop,
    pollOnce,
    resetOffset,
    setOffset,
    getOffset,
    isPolling: () => Boolean(timer),
  };
}
