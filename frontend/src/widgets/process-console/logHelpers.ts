/**
 * Process Console pure helpers (ADR 0003 §8.3).
 */

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

export const PROCESS_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGKILL'] as const;
export type ProcessSignal = (typeof PROCESS_SIGNALS)[number];
