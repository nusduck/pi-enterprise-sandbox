/**
 * The one place a Sandbox transport decides *where* to send a request.
 *
 * Every workspace-bound transport shares the same two-attempt shape:
 *
 *   1. send to the replica we believe owns the workspace;
 *   2. if it answers 409 PLACEMENT_MISMATCH, adopt the owner it named and send
 *      again — exactly once.
 *
 * One retry, not a loop: a second mismatch means placement is genuinely
 * unstable (a scale event mid-flight), and retrying harder would just spread
 * one confused request across the fleet.
 *
 * A mismatch is a clean, authenticated HTTP response, so it must never be
 * folded into the transport's network-failure path. Reporting it as
 * TOOL_OUTCOME_UNKNOWN would tell the run "this may or may not have executed"
 * when the truthful answer is "this definitely did not execute, and here is
 * where it should have gone".
 */

import { readPlacementMismatch } from './placement-resolver.js';

/**
 * Build the per-request base URL selector a transport should use.
 *
 * Transports keep accepting a static `baseUrl` so single-shard deployments and
 * existing tests need no routing wiring at all.
 *
 * @param {{ baseUrl: string, placement?: { resolve: Function, onMismatch: Function } }} options
 */
export function createBaseUrlSelector(options) {
  const staticBaseUrl = options?.baseUrl;
  const placement = options?.placement;
  if (!placement || typeof placement.resolve !== 'function') {
    return async () => staticBaseUrl;
  }
  return async (identity) => {
    try {
      const resolved = await placement.resolve(identity ?? {});
      return resolved || staticBaseUrl;
    } catch {
      // Routing is best-effort; the guard on the Sandbox side is what makes
      // a wrong answer safe.
      return staticBaseUrl;
    }
  };
}

/**
 * Run one request, retrying once if the Sandbox says we reached the wrong replica.
 *
 * `send` receives the base URL to use and returns `{ status, parsed }` plus
 * whatever else the caller needs. It is invoked at most twice.
 *
 * @param {object} args
 * @param {(baseUrl: string) => Promise<{ status: number, parsed?: unknown }>} args.send
 * @param {(identity: object) => Promise<string>} args.selectBaseUrl
 * @param {{ onMismatch: Function }} [args.placement]
 * @param {{ sandboxSessionId?: string }} [args.identity]
 */
export async function sendWithPlacementRetry({
  send,
  selectBaseUrl,
  placement,
  identity,
}) {
  const baseUrl = await selectBaseUrl(identity);
  const first = await send(baseUrl);

  const mismatch = readPlacementMismatch(first?.status, first?.parsed);
  if (!mismatch || !placement || typeof placement.onMismatch !== 'function') {
    return first;
  }

  const ownerBaseUrl = placement.onMismatch(
    identity?.sandboxSessionId,
    mismatch.ownerAddress,
  );
  // Without an address there is nowhere new to go. The cache entry is already
  // dropped, so the next call re-resolves from MySQL.
  if (!ownerBaseUrl || ownerBaseUrl === baseUrl) return first;

  return send(ownerBaseUrl);
}

/**
 * Peek at a 409 and, if it is a placement instruction, re-dispatch once.
 *
 * For transports that hand back a live `Response` rather than a parsed body.
 * The response is cloned before reading so the caller's normal error path still
 * sees an unconsumed body when this turns out not to be a placement mismatch.
 *
 * @param {Response} response the 409 already received
 * @param {{ sandboxSessionId?: string }} identity
 * @param {{ onMismatch: Function }} placement
 * @param {(baseUrl: string) => Promise<Response>} dispatch
 * @returns {Promise<Response|null>} the retried response, or null to keep the original
 */
export async function retryOnPlacementMismatch(
  response,
  identity,
  placement,
  dispatch,
) {
  if (typeof response?.clone !== 'function') return null;
  let parsed;
  try {
    parsed = JSON.parse(await response.clone().text());
  } catch {
    return null;
  }
  const mismatch = readPlacementMismatch(response.status, parsed);
  if (!mismatch) return null;

  const ownerBaseUrl = placement.onMismatch(
    identity?.sandboxSessionId,
    mismatch.ownerAddress,
  );
  if (!ownerBaseUrl) return null;
  return dispatch(ownerBaseUrl);
}

export { readPlacementMismatch };
