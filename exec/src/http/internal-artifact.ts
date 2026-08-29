/**
 * 内部 Artifact/附件 端点——submit/download（dsh-rebuild 5.6）。
 *
 * 占位实现：W3-B 才会落地完整的 `exec/src/artifact/` 持久化。
 * 这里先保证路由与信封/HMAC/CIDR 链路可测，且错误无条件脱敏。
 */

import type { Hono } from 'hono';
import { ContractError, toWireError } from '@pi/contract/errors.js';
import { parseEnvelope } from '@pi/contract/envelope.js';

async function parseBody(c: import('hono').Context): Promise<{ envelope: unknown; payload: unknown }> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new ContractError('ENVELOPE_INVALID', 'body must be object');
  const b = body as Record<string, unknown>;
  return { envelope: b['envelope'], payload: b['payload'] };
}

export function registerInternalArtifactRoutes(app: Hono): void {
  app.post('/internal/v1/artifacts/submit', async (c) => {
    try {
      const { envelope } = await parseBody(c);
      parseEnvelope(envelope);
      // 占位：回显 workspaceId，真实实现落库后返回 artifactId
      const env = envelope as Record<string, unknown>;
      return c.json({ ok: true, data: { artifactId: `art-${String(env['workspaceId']).slice(0, 8)}-stub` } });
    } catch (err) {
      const wire = toWireError(err, { physicalRoots: [] });
      return c.json({ ok: false, error: wire }, 400 as never);
    }
  });

  app.post('/internal/v1/artifacts/download', async (c) => {
    try {
      const { envelope, payload } = await parseBody(c);
      parseEnvelope(envelope);
      const p = payload as Record<string, unknown>;
      const artifactId = typeof p['artifactId'] === 'string' ? p['artifactId'] : '';
      if (!artifactId) throw new ContractError('ENVELOPE_INVALID', 'artifactId required');
      // 占位下载：返回空字节，真实实现从 artifact store 读
      return c.json({ ok: true, data: { artifactId, bytes: '' } });
    } catch (err) {
      const wire = toWireError(err, { physicalRoots: [] });
      return c.json({ ok: false, error: wire }, 400 as never);
    }
  });
}
