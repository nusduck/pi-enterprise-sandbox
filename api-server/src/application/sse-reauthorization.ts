/**
 * Bounded re-authorization for already-open browser SSE streams
 * (design `sso-integration-reservation.md` §5.2).
 *
 * A revoked session must not keep streaming data through a relay that was
 * authorized once at open time. While the relay is open the BFF re-resolves
 * the caller through the Agent every {@link SSE_REAUTH_INTERVAL_MS}. The call
 * inherits the normal bounded outbound timeout (`AGENT_REQUEST_TIMEOUT_MS`);
 * a 401 or an authority-dependency failure closes the stream **fail-closed**
 * and releases the timer and relay. It never cancels the Run — only this HTTP
 * subscription stops (plan §12.4).
 */

import type { IncomingMessage } from 'node:http';
import { config } from '../config.js';
import { authFromRequest } from '../services/sandbox-client.js';
import { authMe } from '../services/agent-auth-client.js';
import type { ReqWithTrace } from '../application/run-access-service.js';

/** Target re-authorization cadence for open SSE relays. */
export const SSE_REAUTH_INTERVAL_MS = 15_000;

export interface SseReauthorizationOptions {
  req: (IncomingMessage & ReqWithTrace) | null;
  /** Called once when the session can no longer be confirmed. */
  onRevoked: () => void;
  intervalMs?: number;
  authEnabled?: boolean;
  reauthorize?: (
    req: (IncomingMessage & ReqWithTrace) | null,
  ) => Promise<void>;
}

export interface SseReauthorization {
  stop(): void;
}

/**
 * Re-resolve the browser credential through the Agent. Any throw (401, 403,
 * 5xx, timeout, network) is treated as "cannot confirm" by the caller.
 */
export function defaultSseReauthorize(
  req: (IncomingMessage & ReqWithTrace) | null,
): Promise<void> {
  const forwarded = authFromRequest(req);
  if (!forwarded.authorization) {
    // AUTH_ENABLED streams always carry a credential; absence cannot be
    // confirmed, so fail closed instead of silently trusting the open relay.
    return Promise.reject(new Error('SSE re-authorization has no credential'));
  }
  return authMe(forwarded, {
    traceId: req?.traceId || null,
    traceContext: req?.traceContext || null,
  }).then(() => undefined);
}

/**
 * Start the periodic re-authorization. Returns a handle whose `stop()` clears
 * the timer; callers must invoke it from the relay's `finally` path. The first
 * check runs after one interval — the open-time `authMe` already authorized
 * the stream.
 */
export function startSseReauthorization({
  req,
  onRevoked,
  intervalMs = SSE_REAUTH_INTERVAL_MS,
  authEnabled = config.AUTH_ENABLED,
  reauthorize = defaultSseReauthorize,
}: SseReauthorizationOptions): SseReauthorization {
  if (!authEnabled) return { stop() {} };

  let stopped = false;
  let inFlight = false;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = true;
    // `Promise.resolve().then` also funnels a synchronous throw from
    // `reauthorize` into the same fail-closed path.
    Promise.resolve()
      .then(() => reauthorize(req))
      .then(
        () => {
          inFlight = false;
        },
        () => {
          inFlight = false;
          if (stopped) return;
          stopped = true;
          clearInterval(timer);
          try {
            onRevoked();
          } catch {
            /* closing the relay must not throw back into the timer */
          }
        },
      );
  }, intervalMs);

  // Never keep the process alive just for a re-auth tick.
  timer.unref?.();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
