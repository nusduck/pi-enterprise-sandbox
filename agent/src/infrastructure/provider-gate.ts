/**
 * Process-global provider concurrency gate + 429 cooldown.
 *
 * The observability extension is instantiated per Run, so a gate living on the
 * extension would only limit within a single (already-serial) prompt loop.
 * This module keeps ONE gate per Agent process — see
 * {@link getProcessProviderGate} — shared by every Run's extension instance:
 * Run A's before_provider_request can be made to wait while Run B..N hold the
 * slots, capping concurrent provider calls at the deployment level.
 *
 * Safety contract (mirrors "observability must never break execution"):
 * - acquire() is bounded: when the gate cannot grant a slot within maxWaitMs
 *   it proceeds anyway (degrade, never deadlock) and returns a **no-op**
 *   release, so a degraded caller can never decrement a slot it never held.
 * - The gate is only advisory throttling, never an authority: on timeout we
 *   let the provider call go out.
 */

export type ProviderGateOptions = {
  maxConcurrent?: number;
  maxWaitMs?: number;
  cooldownMs?: number;
  maxCooldownMs?: number;
};

export const DEFAULT_MAX_CONCURRENT = 32;
export const DEFAULT_MAX_WAIT_MS = 15_000;
export const DEFAULT_COOLDOWN_MS = 2_000;
export const DEFAULT_MAX_COOLDOWN_MS = 60_000;

/** No-op release handed to a caller that was never granted a slot. */
const NOOP_RELEASE = () => {};

export function createProviderGate(options: ProviderGateOptions = {}) {
  const maxConcurrent = positiveInt(options.maxConcurrent, DEFAULT_MAX_CONCURRENT);
  const maxWaitMs = positiveInt(options.maxWaitMs, DEFAULT_MAX_WAIT_MS);
  const cooldownMs = positiveInt(options.cooldownMs, DEFAULT_COOLDOWN_MS);
  const maxCooldownMs = Math.max(
    cooldownMs,
    positiveInt(options.maxCooldownMs, DEFAULT_MAX_COOLDOWN_MS),
  );

  // Slots are counted, never keyed: N concurrent calls to the *same* provider
  // are exactly what the cap exists to bound, so a per-name Set would collapse
  // them into one entry and never engage.
  let inFlight = 0;
  const waiters: Array<{ grant: () => void, cancel: () => void }> = [];
  const cooldowns: Map<string, { until: number, strikes: number }> = new Map();

  const sleep = (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve(undefined);
          },
          { once: true },
        );
      }
    });

  /**
   * @param {AbortSignal} [signal]
   * @returns {Promise<boolean>} true only when a slot is actually held.
   */
  const acquireSlot = async (signal) => {
    if (inFlight < maxConcurrent) {
      inFlight += 1;
      return true;
    }
    if (signal?.aborted) return false;

    // Gate full: wait bounded. On timeout degrade to pass-through (never block
    // a Run on a congested sibling).
    return new Promise((resolve) => {
      let settled = false;
      const finish = (granted) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = waiters.indexOf(entry);
        if (index >= 0) waiters.splice(index, 1);
        resolve(granted);
      };
      // unref: a caller queued behind a full gate must not keep the process
      // alive at shutdown. The trade-off is that this timer cannot keep the
      // loop running long enough to fire by itself — a caller in an otherwise
      // idle process may never observe the degrade, because that process is on
      // its way out anyway. Anything unit-testing this path has to hold the
      // loop open on its own (see withLoopAlive in provider-gate.unit.test.js).
      const timer = setTimeout(() => finish(false), maxWaitMs);
      if (typeof timer.unref === 'function') timer.unref();
      // release() hands the slot straight to this waiter: inFlight is never
      // decremented for a handover, so a third caller cannot steal it.
      const entry = { grant: () => finish(true), cancel: () => finish(false) };
      waiters.push(entry);
      if (signal) {
        signal.addEventListener('abort', () => finish(false), { once: true });
      }
    });
  };

  const releaseSlot = () => {
    const next = waiters.shift();
    if (next) {
      next.grant();
      return;
    }
    inFlight = Math.max(0, inFlight - 1);
  };

  /**
   * Called from before_provider_request. Returns a release function to call
   * from after_provider_response; it is a no-op when no slot was granted, and
   * calling it twice releases at most once.
   *
   * @param providerKey
   * @param [signal]
   * @returns {Promise<() => void>}
   */
  async function acquire(providerKey: string, signal?: AbortSignal) {
    const key = normalizeKey(providerKey);
    // 429 cooldown: if this provider was rate-limited recently, wait out the
    // remainder (bounded) before even attempting a request.
    const remaining = (cooldowns.get(key)?.until ?? 0) - Date.now();
    if (remaining > 0) {
      await sleep(Math.min(remaining, maxWaitMs), signal);
    }
    const granted = await acquireSlot(signal);
    if (!granted) return NOOP_RELEASE;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseSlot();
    };
  }

  /**
   * Called from after_provider_response with the observed status. Consecutive
   * 429s lengthen the window (capped); any other observed status clears it, so
   * a provider that recovers is not throttled for the rest of the process.
   *
   * @param providerKey
   * @param status
   */
  function observe(providerKey: string, status: number) {
    const key = normalizeKey(providerKey);
    if (!Number.isFinite(Number(status))) return;
    if (Number(status) !== 429) {
      cooldowns.delete(key);
      return;
    }
    const strikes = (cooldowns.get(key)?.strikes ?? 0) + 1;
    const window = Math.min(cooldownMs * 2 ** (strikes - 1), maxCooldownMs);
    cooldowns.set(key, { until: Date.now() + window, strikes });
  }

  return {
    acquire,
    observe,
    snapshot: () => ({
      maxConcurrent,
      maxWaitMs,
      cooldownMs,
      maxCooldownMs,
      inFlight,
      waiting: waiters.length,
      cooldownKeys: cooldowns.size,
    }),
  };
}

let processGate: ReturnType<typeof createProviderGate> | null = null;

/**
 * The one gate for this Agent process. Every Run's observability extension
 * shares it, which is the whole point: the cap is a deployment property, not a
 * per-Run one. Options are read from the first caller (the container passes
 * env-derived values); later callers get the same instance.
 *
 * @param [options]
 */
export function getProcessProviderGate(options: ProviderGateOptions = {}) {
  if (!processGate) processGate = createProviderGate(options);
  return processGate;
}

/** Test seam: drop the process gate so a suite can start from a clean cap. */
export function resetProcessProviderGate() {
  processGate = null;
}

/**
 * @param providerKey
 * @returns {string}
 */
function normalizeKey(providerKey: unknown) {
  const key = String(providerKey ?? '').trim();
  return key || 'default';
}

function positiveInt(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
