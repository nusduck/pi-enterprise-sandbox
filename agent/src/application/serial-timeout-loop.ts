/**
 * Serial setTimeout loop: at most one async tick in flight; stop waits for it.
 *
 * A tick that throws is reported to `onError` and the loop keeps its schedule.
 * The in-flight promise must never reject: it is only awaited by `stop()`, so a
 * rejection between ticks was an unhandled rejection that crashed the whole
 * Worker whenever the cancel poll hit a MySQL outage (K8s deployment review K4
 * sim drill, 2026-09-19).
 * @param {{
 *   intervalMs: number,
 *   tick: () => Promise<void>,
 *   isStopped: () => boolean,
 *   onError?: (err: unknown) => void,
 * }} opts
 */
export function createSerialTimeoutLoop(opts: { intervalMs: number, tick: () => Promise<void>, isStopped: () => boolean, onError?: (err: unknown) => void, }) {
  const intervalMs = Math.max(1, Number(opts.intervalMs) || 1);
  const onError = opts.onError ?? ((err: unknown) => {
    console.error('[execute-run] periodic tick failed:', err instanceof Error ? err.message : 'error');
  });
  let stopped = false;
  let timer = null;
  let inFlight: Promise<void> | null = null;

  const schedule = () => {
    if (stopped || opts.isStopped()) return;
    timer = setTimeout(() => {
      timer = null;
      if (stopped || opts.isStopped()) return;
      const tickPromise: Promise<void> = (async () => {
        try {
          if (stopped || opts.isStopped()) return;
          await opts.tick();
        } catch (err) {
          try {
            onError(err);
          } catch {
            /* reporting must not break the loop */
          }
        }
      })().finally(() => {
        if (inFlight === tickPromise) inFlight = null;
        if (!stopped && !opts.isStopped()) schedule();
      });
      inFlight = tickPromise;
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  };

  return {
    start() {
      if (stopped) return;
      schedule();
    },
    async stop() {
      stopped = true;
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          /* tick errors are owned by the tick body */
        }
      }
    },
  };
}
