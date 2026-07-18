/**
 * Short-lived A2A artifact download capability tokens (plan §20.5).
 *
 * Token binds: org_id + client_id + task_id + artifact_id + expiry.
 * HMAC-SHA256 over canonical payload; constant-time verify.
 * Download handler MUST re-check owner-scoped artifact authority after verify.
 */

import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { assertUlid, isUlid } from '../../domain/shared/ulid.js';
import { ValidationError } from '../errors.js';

export const DEFAULT_ARTIFACT_TOKEN_TTL_SEC = 300;
export const MAX_ARTIFACT_TOKEN_TTL_SEC = 3600;
export const MIN_DOWNLOAD_SECRET_LEN = 32;

/**
 * @param {unknown} secret
 * @returns {string}
 */
export function assertDownloadSecret(secret) {
  if (typeof secret !== 'string' || secret.trim().length < MIN_DOWNLOAD_SECRET_LEN) {
    throw new ValidationError(
      `A2A artifact download secret must be at least ${MIN_DOWNLOAD_SECRET_LEN} chars`,
    );
  }
  return secret.trim();
}

/**
 * Canonical unsigned payload (no path/workspace leakage).
 * @param {{
 *   orgId: string,
 *   clientId: string,
 *   taskId: string,
 *   artifactId: string,
 *   exp: number,
 *   nonce: string,
 * }} claims
 */
export function canonicalizeArtifactClaims(claims) {
  return [
    'a2a-artifact-dl-v1',
    claims.orgId,
    claims.clientId,
    claims.taskId,
    claims.artifactId,
    String(claims.exp),
    claims.nonce,
  ].join('|');
}

/**
 * @param {{
 *   orgId: string,
 *   clientId: string,
 *   taskId: string,
 *   artifactId: string,
 *   secret: string,
 *   ttlSec?: number,
 *   now?: () => number,
 * }} input
 * @returns {{ token: string, exp: number, claims: object }}
 */
export function mintArtifactDownloadToken(input) {
  const secret = assertDownloadSecret(input.secret);
  const orgId = assertUlid(input.orgId, 'orgId');
  const taskId = assertUlid(input.taskId, 'taskId');
  const artifactId = assertUlid(input.artifactId, 'artifactId');
  if (typeof input.clientId !== 'string' || !input.clientId.trim()) {
    throw new ValidationError('clientId is required');
  }
  const clientId = input.clientId.trim();
  const ttl = Math.min(
    MAX_ARTIFACT_TOKEN_TTL_SEC,
    Math.max(1, Number(input.ttlSec) || DEFAULT_ARTIFACT_TOKEN_TTL_SEC),
  );
  const nowMs = typeof input.now === 'function' ? input.now() : Date.now();
  const exp = Math.floor(nowMs / 1000) + ttl;
  const nonce = randomBytes(16).toString('hex');
  const claims = { orgId, clientId, taskId, artifactId, exp, nonce };
  const body = canonicalizeArtifactClaims(claims);
  const sig = createHmac('sha256', secret).update(body, 'utf8').digest('base64url');
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return {
    token: `${payload}.${sig}`,
    exp,
    claims,
  };
}

/**
 * @param {string} token
 * @param {string} secret
 * @param {{ now?: () => number }} [opts]
 * @returns {{
 *   orgId: string,
 *   clientId: string,
 *   taskId: string,
 *   artifactId: string,
 *   exp: number,
 *   nonce: string,
 * }}
 */
export function verifyArtifactDownloadToken(token, secret, opts = {}) {
  const sec = assertDownloadSecret(secret);
  if (typeof token !== 'string' || !token.includes('.')) {
    throw new ValidationError('invalid artifact download token');
  }
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) {
    throw new ValidationError('invalid artifact download token');
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('invalid artifact download token');
  }
  if (!claims || typeof claims !== 'object') {
    throw new ValidationError('invalid artifact download token');
  }
  const orgId = isUlid(claims.orgId) ? String(claims.orgId).toUpperCase() : null;
  const taskId = isUlid(claims.taskId) ? String(claims.taskId).toUpperCase() : null;
  const artifactId = isUlid(claims.artifactId)
    ? String(claims.artifactId).toUpperCase()
    : null;
  const clientId =
    typeof claims.clientId === 'string' ? claims.clientId.trim() : '';
  const exp = Number(claims.exp);
  const nonce = typeof claims.nonce === 'string' ? claims.nonce : '';
  if (!orgId || !taskId || !artifactId || !clientId || !nonce || !Number.isFinite(exp)) {
    throw new ValidationError('invalid artifact download token');
  }
  const body = canonicalizeArtifactClaims({
    orgId,
    clientId,
    taskId,
    artifactId,
    exp,
    nonce,
  });
  const expected = createHmac('sha256', sec).update(body, 'utf8').digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ValidationError('invalid artifact download token');
  }
  const nowSec = Math.floor(
    (typeof opts.now === 'function' ? opts.now() : Date.now()) / 1000,
  );
  if (exp <= nowSec) {
    throw new ValidationError('artifact download token expired');
  }
  return { orgId, clientId, taskId, artifactId, exp, nonce };
}

/**
 * Build public download URL (no path leakage). Returns null when secret absent.
 *
 * @param {{
 *   baseUrl: string,
 *   orgId: string,
 *   clientId: string,
 *   taskId: string,
 *   artifactId: string,
 *   secret: string | null | undefined,
 *   ttlSec?: number,
 *   now?: () => number,
 * }} input
 * @returns {string | null}
 */
export function buildArtifactDownloadUri(input) {
  if (!input.secret || typeof input.secret !== 'string' || !input.secret.trim()) {
    return null;
  }
  if (!input.baseUrl || typeof input.baseUrl !== 'string') {
    return null;
  }
  try {
    const { token } = mintArtifactDownloadToken({
      orgId: input.orgId,
      clientId: input.clientId,
      taskId: input.taskId,
      artifactId: input.artifactId,
      secret: input.secret,
      ttlSec: input.ttlSec,
      now: input.now,
    });
    const base = input.baseUrl.replace(/\/$/, '');
    return `${base}/a2a/artifacts/download?token=${encodeURIComponent(token)}`;
  } catch {
    return null;
  }
}
