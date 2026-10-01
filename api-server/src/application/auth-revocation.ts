/**
 * BFF-side classification of `POST /internal/auth/logout` outcomes.
 *
 * The locked contract (design `sso-integration-reservation.md` §5.2 / §6):
 *   - 200 `{ok:true, revocation:"confirmed"}`   — a valid `sid` was revoked.
 *   - 200 `{ok:true, revocation:"not_required"}` — no credential / bad
 *     signature / expired / already revoked; nothing to revoke.
 *   - 409 `LEGACY_SESSION_NOT_REVOCABLE`         — valid unexpired pre-`sid`
 *     JWT; local logout happened but server-side revocation cannot be claimed.
 *   - 503 `AUTH_REVOCATION_UNCONFIRMED`          — DB/upstream failure or
 *     timeout; must never be reported as `{ok:true}`.
 *
 * Only the enumerated "nothing to revoke" classes map to success. Every other
 * upstream status (including 5xx, 404 and an unrecognized 200 body) is treated
 * as unconfirmed, so a broken authority can never be swallowed into success.
 */

export const REVOCATION_CONFIRMED = 'confirmed';
export const REVOCATION_NOT_REQUIRED = 'not_required';

export interface RevocationDecision {
  status: number;
  body: Record<string, unknown>;
}

export interface UpstreamLogoutResponse {
  status: number;
  body?: unknown;
}

function unconfirmed(): RevocationDecision {
  return {
    status: 503,
    body: {
      error: 'Session revocation could not be confirmed',
      code: 'AUTH_REVOCATION_UNCONFIRMED',
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Map one upstream logout result onto the browser contract.
 * Pass `null` when the upstream call failed before a response (timeout,
 * network) — that is necessarily unconfirmed.
 */
export function classifyLogoutResponse(
  upstream: UpstreamLogoutResponse | null | undefined,
): RevocationDecision {
  if (!upstream) return unconfirmed();
  const status = Number(upstream.status) || 0;
  const body = asRecord(upstream.body);

  if (status === 200) {
    const revocation = body.revocation;
    if (revocation === REVOCATION_CONFIRMED || revocation === REVOCATION_NOT_REQUIRED) {
      return { status: 200, body: { ok: true, revocation } };
    }
    // A 200 without a recognized revocation is not proof of revocation.
    return unconfirmed();
  }

  if (status === 409 && body.code === 'LEGACY_SESSION_NOT_REVOCABLE') {
    return {
      status: 409,
      body: {
        error:
          typeof body.error === 'string' && body.error
            ? body.error
            : 'Legacy session cannot be revoked',
        code: 'LEGACY_SESSION_NOT_REVOCABLE',
      },
    };
  }

  if (status === 401 && body.code === 'INVALID_TOKEN') {
    // The Agent's logout service returns 200 `not_required` for an invalid
    // signature / expired / revoked sid. A coded `INVALID_TOKEN` is the same
    // session-level class on the `me`/`profile` surface; treat it as "nothing
    // left to revoke".
    //
    // Anything else on 401 is *not* a session fact: the Agent's internal-token
    // gate answers 401 without a code (wrong `AGENT_INTERNAL_TOKEN`) and a
    // missing internal secret answers 401 `INTERNAL_AUTH_NOT_CONFIGURED`.
    // Mapping those to success would hide a BFF↔Agent misconfiguration, so
    // they stay unconfirmed.
    return { status: 200, body: { ok: true, revocation: REVOCATION_NOT_REQUIRED } };
  }

  return unconfirmed();
}
