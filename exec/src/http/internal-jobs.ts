/**
 * 内部 Jobs 端点——status/read/kill/signal/stdin（dsh-rebuild 5.6）。
 *
 * 复用 `MySqlJobRegistry`（W2-B），本文件只做 HTTP 薄层：
 * 信封必带 workspaceId → 归属校验在 registry 内完成，
 * 错误经 `toWireError` 无条件脱敏。
 */

import type { Hono } from 'hono';
import { ContractError, toWireError } from '@pi/contract/errors.js';
import { parseEnvelope } from '@pi/contract/envelope.js';
import type { MySqlJobRegistry } from '../shell/job-registry.js';
import { JobNotFoundError, JobControlUnavailableError } from '../shell/job-owner-access.js';

export interface InternalJobsDeps {
  readonly jobRegistry: MySqlJobRegistry;
}

async function parseBody(c: import('hono').Context): Promise<{ envelope: unknown; payload: unknown }> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new ContractError('ENVELOPE_INVALID', 'body must be object');
  const b = body as Record<string, unknown>;
  return { envelope: b['envelope'], payload: b['payload'] };
}

function ownerFrom(envelope: unknown): { orgId: string; userId: string; workspaceId: string } {
  parseEnvelope(envelope);
  const e = envelope as Record<string, unknown>;
  return { orgId: String(e['orgId']), userId: String(e['userId']), workspaceId: String(e['workspaceId']) };
}

export function registerInternalJobsRoutes(app: Hono, deps: InternalJobsDeps): void {
  app.post('/internal/v1/jobs/status', async (c) => {
    try {
      const { envelope, payload } = await parseBody(c);
      const owner = ownerFrom(envelope);
      const p = payload as Record<string, unknown>;
      const id = typeof p['id'] === 'string' ? p['id'] : '';
      if (!id) throw new ContractError('ENVELOPE_INVALID', 'id required');
      const snap = await deps.jobRegistry.get(id, owner);
      return c.json({ ok: true, data: snap });
    } catch (err) {
      if (err instanceof JobNotFoundError) {
        const wire = toWireError(new ContractError('WORKSPACE_NOT_FOUND', 'job not found'), { physicalRoots: [] });
        return c.json({ ok: false, error: wire }, 404 as never);
      }
      const wire = toWireError(err, { physicalRoots: [] });
      const status = wire.code === 'ENVELOPE_INVALID' ? 400 : 500;
      return c.json({ ok: false, error: wire }, status as never);
    }
  });

  app.post('/internal/v1/jobs/read', async (c) => {
    try {
      const { envelope, payload } = await parseBody(c);
      const owner = ownerFrom(envelope);
      const p = payload as Record<string, unknown>;
      const id = typeof p['id'] === 'string' ? p['id'] : '';
      if (!id) throw new ContractError('ENVELOPE_INVALID', 'id required');
      const cursor = typeof p['cursor'] === 'string' ? (p['cursor'] as string) : null;
      const limit = typeof p['limit'] === 'number' ? (p['limit'] as number) : 64 * 1024;
      const data = await deps.jobRegistry.read(id, owner, cursor, limit);
      return c.json({ ok: true, data });
    } catch (err) {
      if (err instanceof JobNotFoundError) {
        const wire = toWireError(new ContractError('WORKSPACE_NOT_FOUND', 'job not found'), { physicalRoots: [] });
        return c.json({ ok: false, error: wire }, 404 as never);
      }
      const wire = toWireError(err, { physicalRoots: [] });
      const status = wire.code === 'ENVELOPE_INVALID' ? 400 : 500;
      return c.json({ ok: false, error: wire }, status as never);
    }
  });

  app.post('/internal/v1/jobs/kill', async (c) => {
    try {
      const { envelope, payload } = await parseBody(c);
      const owner = ownerFrom(envelope);
      const p = payload as Record<string, unknown>;
      const id = typeof p['id'] === 'string' ? p['id'] : '';
      if (!id) throw new ContractError('ENVELOPE_INVALID', 'id required');
      const snap = await deps.jobRegistry.kill(id, owner);
      return c.json({ ok: true, data: snap });
    } catch (err) {
      if (err instanceof JobNotFoundError) {
        const wire = toWireError(new ContractError('WORKSPACE_NOT_FOUND', 'job not found'), { physicalRoots: [] });
        return c.json({ ok: false, error: wire }, 404 as never);
      }
      if (err instanceof JobControlUnavailableError) {
        const wire = toWireError(new ContractError('INTERNAL_ERROR', 'no live handle'), { physicalRoots: [] });
        return c.json({ ok: false, error: wire }, 409 as never);
      }
      const wire = toWireError(err, { physicalRoots: [] });
      return c.json({ ok: false, error: wire }, 500 as never);
    }
  });

  app.post('/internal/v1/jobs/signal', async (c) => {
    try {
      const { envelope, payload } = await parseBody(c);
      const owner = ownerFrom(envelope);
      const p = payload as Record<string, unknown>;
      const id = typeof p['id'] === 'string' ? p['id'] : '';
      const signal = typeof p['signal'] === 'string' ? (p['signal'] as NodeJS.Signals) : 'SIGTERM';
      if (!id) throw new ContractError('ENVELOPE_INVALID', 'id required');
      const snap = await deps.jobRegistry.signal(id, owner, signal);
      return c.json({ ok: true, data: snap });
    } catch (err) {
      if (err instanceof JobNotFoundError) {
        const wire = toWireError(new ContractError('WORKSPACE_NOT_FOUND', 'job not found'), { physicalRoots: [] });
        return c.json({ ok: false, error: wire }, 404 as never);
      }
      const wire = toWireError(err, { physicalRoots: [] });
      return c.json({ ok: false, error: wire }, 500 as never);
    }
  });

  app.post('/internal/v1/jobs/stdin', async (c) => {
    try {
      const { envelope, payload } = await parseBody(c);
      const owner = ownerFrom(envelope);
      const p = payload as Record<string, unknown>;
      const id = typeof p['id'] === 'string' ? p['id'] : '';
      const data = typeof p['data'] === 'string' ? (p['data'] as string) : '';
      const eof = Boolean(p['eof']);
      if (!id) throw new ContractError('ENVELOPE_INVALID', 'id required');
      await deps.jobRegistry.writeStdin(id, owner, data, eof);
      return c.json({ ok: true, data: { ok: true } });
    } catch (err) {
      if (err instanceof JobNotFoundError) {
        const wire = toWireError(new ContractError('WORKSPACE_NOT_FOUND', 'job not found'), { physicalRoots: [] });
        return c.json({ ok: false, error: wire }, 404 as never);
      }
      const wire = toWireError(err, { physicalRoots: [] });
      return c.json({ ok: false, error: wire }, 500 as never);
    }
  });
}
