import { randomBytes } from 'node:crypto';

export function authSubjectsFromRequest(req) {
  const userId = req.headers['x-acting-user-id'];
  const organizationId = req.headers['x-acting-organization-id'];
  if (typeof userId !== 'string' || !userId.trim()) return null;
  if (typeof organizationId !== 'string' || !organizationId.trim()) return null;
  return {
    provider: 'bff',
    externalOrgId: organizationId.trim(),
    externalUserId: userId.trim(),
    requestId: req?.requestId || null,
    callerType: 'web',
    role:
      typeof req.headers['x-acting-role'] === 'string'
        ? req.headers['x-acting-role'].trim()
        : null,
  };
}

export function resolveRequestId(req) {
  const incoming = String(
    req?.headers?.['x-request-id'] || req?.headers?.['X-Request-Id'] || '',
  ).trim();
  return /^[A-Za-z0-9._:-]{8,128}$/.test(incoming)
    ? incoming
    : randomBytes(16).toString('hex');
}

export function readIdempotencyKey(req) {
  const value =
    req.headers['idempotency-key'] ||
    req.headers['Idempotency-Key'] ||
    req.headers['x-idempotency-key'] ||
    req.headers['X-Idempotency-Key'];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function json(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
