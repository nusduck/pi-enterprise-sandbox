/**
 * 公共面进程路由——对 BFF `routes/processes.js` 与 Python `routers/session_processes.py` 逐字节不变。
 *
 * Python 语义：
 * - GET    /sessions/:id/processes                 → 200 {processes} / 404
 * - GET    /sessions/:id/processes/:pid            → 200 entry / 404
 * - GET    /sessions/:id/processes/:pid/logs?offset&limit → 200 {process_id,...logs} / 400 offset/limit /404
 * - GET    /sessions/:id/processes/:pid/read?stream&cursor&limit → 200 {text,...} /400 stream/cursor/limit /404
 * - POST   /sessions/:id/processes/:pid/signal {signal} → 200 /400 signal不在允许集 /404 /409 unavailable
 * - POST   /sessions/:id/processes/:pid/stdin {data,eof} → 200 /413 >64KiB /404 /409
 * - POST   /sessions/:id/processes/:pid/cancel → 200 /404 /409
 *
 * 跨租户一律 404（不泄漏存在性），会话无 org 亦 404。错误文本经 redactPhysicalRoots 无条件脱敏。
 */

import { Hono } from 'hono';
import { badRequest, conflict, errorBody, HttpError, notFound, payloadTooLarge } from './errors.js';
import { parseActingHeaders, requireOwnedSession } from './ownership.js';
import { redactPhysicalRoots } from '../../fs/redact.js';
import type { WorkspaceManager } from '../../workspace/manager.js';
import type { MySqlJobRegistry } from '../../shell/job-registry.js';
import type { JobSnapshot } from '../../shell/job-types.js';

export interface PublicProcessDeps {
  readonly workspaceManager: WorkspaceManager;
  readonly systemSkillRoot: string;
  readonly enabledSkillPackagesFor: (orgId: string, userId: string) => readonly { name: string; sourcePath: string }[];
  readonly jobRegistry: MySqlJobRegistry;
}

const ALLOWED_SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP']);
const MAX_STDIN_BYTES = 64 * 1024;

function actingFrom(c: import('hono').Context): Record<string, string | undefined> {
  const h: Record<string, string | undefined> = {};
  for (const k of ['x-acting-organization-id', 'x-acting-user-id']) {
    const v = c.req.header(k);
    if (v !== undefined) h[k] = v;
  }
  return h;
}

function publicStatus(status: JobSnapshot['status']): string {
  if (status === 'stopping') return 'cancel_requested';
  if (status === 'killed') return 'cancelled';
  return status;
}

function publicProcess(entry: JobSnapshot, sessionId: string) {
  return {
    process_id: entry.id,
    session_id: sessionId,
    run_id: entry.runId ?? null,
    command: entry.label,
    status: publicStatus(entry.status),
    pid: entry.pid,
    exit_code: entry.exitCode,
    started_at: new Date(entry.startedAt).toISOString(),
    finished_at: entry.finishedAt == null
      ? null
      : new Date(entry.finishedAt).toISOString(),
  };
}

export function registerPublicProcessRoutes(app: Hono, deps: PublicProcessDeps): void {
  app.get('/sessions/:sessionId/processes', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    let roots: readonly string[] = [];
    try {
      const acting = parseActingHeaders(actingFrom(c));
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const url = new URL(c.req.url);
      const limit = Number(url.searchParams.get('limit') ?? '100');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        throw badRequest('limit must be 1..1000');
      }
      const owner = { orgId: own.workspace.orgId, userId: own.workspace.userId, workspaceId: own.workspace.workspaceId };
      const runId = url.searchParams.get('run_id');
      const status = url.searchParams.get('status');
      const entries = runId
        ? await deps.jobRegistry.listByRun(runId, owner, limit)
        : await deps.jobRegistry.list(owner, limit);
      const processes = entries
        .map((entry) => publicProcess(entry, sessionId))
        .filter((entry) => !status || entry.status === status);
      return c.json({ processes });
    } catch (err) {
      const code = err instanceof HttpError ? err.status : 500;
      return c.json(errorBody(err, roots), code as never);
    }
  });

  // GET single
  app.get('/sessions/:sessionId/processes/:processId', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const processId = c.req.param('processId') ?? '';
    let roots: readonly string[] = [];
    try {
      const acting = parseActingHeaders(actingFrom(c));
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const owner = { orgId: own.workspace.orgId, userId: own.workspace.userId, workspaceId: own.workspace.workspaceId };
      const entry = await deps.jobRegistry.get(processId, owner).catch(() => null);
      if (!entry) throw notFound('Process not found');
      return c.json(publicProcess(entry, sessionId));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return c.json(errorBody(err, roots), status as never);
    }
  });

  // GET logs
  app.get('/sessions/:sessionId/processes/:processId/logs', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const processId = c.req.param('processId') ?? '';
    let roots: readonly string[] = [];
    try {
      const acting = parseActingHeaders(actingFrom(c));
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const url = new URL(c.req.url);
      const offsetRaw = url.searchParams.get('offset');
      const limitRaw = url.searchParams.get('limit');
      const offset = offsetRaw !== null ? Number(offsetRaw) : 0;
      const limit = limitRaw !== null ? Number(limitRaw) : undefined;
      if (!Number.isFinite(offset) || offset < 0) throw badRequest('offset must be >= 0');
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) throw badRequest('limit must be > 0');
      const owner = { orgId: own.workspace.orgId, userId: own.workspace.userId, workspaceId: own.workspace.workspaceId };
      const logs = await deps.jobRegistry.read(processId, owner, `0-${offset}`, limit ?? 8192).catch(() => null);
      if (!logs) throw notFound('Process not found');
      return c.json({
        process_id: processId,
        stdout: logs.text,
        stderr: '',
        next_offset: Number(logs.nextCursor.split('-')[1] ?? offset),
        completed: !['running', 'stopping'].includes(logs.snapshot.status),
        truncated: logs.truncated,
        full_log_location: logs.stdoutSpillRef ?? null,
        log_total: logs.logTotal,
      });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return c.json(errorBody(err, roots), status as never);
    }
  });

  // GET read
  app.get('/sessions/:sessionId/processes/:processId/read', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const processId = c.req.param('processId') ?? '';
    let roots: readonly string[] = [];
    try {
      const acting = parseActingHeaders(actingFrom(c));
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const url = new URL(c.req.url);
      const stream = url.searchParams.get('stream') ?? 'stdout';
      const cursor = url.searchParams.get('cursor') ?? '0-0';
      const limitRaw = url.searchParams.get('limit') ?? '8192';
      const limit = Number(limitRaw);
      if (stream !== 'stdout' && stream !== 'stderr') throw badRequest('stream must be stdout or stderr');
      if (!Number.isFinite(limit) || limit < 1 || limit > 65536) throw badRequest('limit must be 1..65536');
      if (!cursor || cursor.length === 0 || cursor.length > 128) throw badRequest('cursor must be 1..128 chars');
      const owner = { orgId: own.workspace.orgId, userId: own.workspace.userId, workspaceId: own.workspace.workspaceId };
      const result = await deps.jobRegistry.read(processId, owner, cursor, limit).catch(() => null);
      if (!result) throw notFound('Process not found');
      return c.json(result);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return c.json(errorBody(err, roots), status as never);
    }
  });

  // POST signal
  app.post('/sessions/:sessionId/processes/:processId/signal', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const processId = c.req.param('processId') ?? '';
    let roots: readonly string[] = [];
    try {
      const acting = parseActingHeaders(actingFrom(c));
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const body = (await c.req.json().catch(() => ({}))) as { signal?: string };
      const sig = String(body.signal ?? 'SIGTERM').trim().toUpperCase();
      if (!ALLOWED_SIGNALS.has(sig)) throw badRequest(`signal must be one of ${[...ALLOWED_SIGNALS].sort().join(', ')}`);
      const owner = { orgId: own.workspace.orgId, userId: own.workspace.userId, workspaceId: own.workspace.workspaceId };
      const result = await deps.jobRegistry.signal(processId, owner, sig as NodeJS.Signals).catch((e: unknown) => {
        const raw = e instanceof Error ? e.message : String(e);
        if (/not_found/i.test(raw)) throw notFound('Process not found');
        if (/unavailable/i.test(raw)) throw conflict('Process control unavailable after restart');
        throw e;
      });
      return c.json(result ?? {});
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return c.json(errorBody(err, roots), status as never);
    }
  });

  // POST stdin
  app.post('/sessions/:sessionId/processes/:processId/stdin', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const processId = c.req.param('processId') ?? '';
    let roots: readonly string[] = [];
    try {
      const acting = parseActingHeaders(actingFrom(c));
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const body = (await c.req.json().catch(() => ({}))) as { data?: string; eof?: boolean };
      const data = String(body.data ?? '');
      if (Buffer.byteLength(data, 'utf8') > MAX_STDIN_BYTES) throw payloadTooLarge('stdin data too large', 'stdin_too_large');
      const owner = { orgId: own.workspace.orgId, userId: own.workspace.userId, workspaceId: own.workspace.workspaceId };
      const result = await deps.jobRegistry.writeStdin(processId, owner, data, Boolean(body.eof)).catch((e: unknown) => {
        const raw = e instanceof Error ? e.message : String(e);
        if (/not_found/i.test(raw)) throw notFound('Process not found');
        if (/unavailable/i.test(raw)) throw conflict('Process control unavailable after restart');
        throw e;
      });
      return c.json(result ?? {});
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return c.json(errorBody(err, roots), status as never);
    }
  });

  // POST cancel
  app.post('/sessions/:sessionId/processes/:processId/cancel', async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const processId = c.req.param('processId') ?? '';
    let roots: readonly string[] = [];
    try {
      const acting = parseActingHeaders(actingFrom(c));
      const own = await requireOwnedSession(sessionId, deps, acting, roots);
      roots = own.physicalRoots;
      const owner = { orgId: own.workspace.orgId, userId: own.workspace.userId, workspaceId: own.workspace.workspaceId };
      const result = await deps.jobRegistry.kill(processId, owner).catch((e: unknown) => {
        const raw = e instanceof Error ? e.message : String(e);
        if (/not_found/i.test(raw)) throw notFound('Process not found');
        if (/unavailable/i.test(raw)) throw conflict('Process control unavailable after restart');
        throw e;
      });
      return c.json(result ?? {});
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return c.json(errorBody(err, roots), status as never);
    }
  });
}
