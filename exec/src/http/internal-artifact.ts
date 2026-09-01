/**
 * 内部 Artifact 端点——submit / download（dsh-rebuild 5.6）。
 *
 * 2026-08-29 前是占位：submit 回一个 `art-xxxxxxxx-stub` 的假 id，download 回
 * 空字节。现在接 `ArtifactService`，与公共面共用同一个服务与同一份控制面存储。
 *
 * 归属取自**信封**（`orgId`/`userId` 已由 HMAC 校验过），不读 payload——
 * 与公共面"只认可信来源"是同一条纪律。
 */

import type { Hono } from 'hono';
import { ContractError, toWireError } from '@pi/contract/errors.js';
import { parseEnvelope } from '@pi/contract/envelope.js';
import type { ArtifactService } from '../artifact/service.js';
import { ArtifactError } from '../artifact/service.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import type { WorkspaceContext } from '../types.js';

export interface InternalArtifactDeps {
  readonly workspaceManager: WorkspaceManager;
  readonly systemSkillRoot: string;
  readonly enabledSkillPackagesFor: (
    orgId: string,
    userId: string,
  ) => readonly { name: string; sourcePath: string }[];
  readonly artifactService: ArtifactService;
}

interface Envelope {
  orgId: string;
  userId: string;
  workspaceId: string;
  sessionId?: string;
}

function buildContext(deps: InternalArtifactDeps, env: Envelope): WorkspaceContext {
  return {
    orgId: env.orgId,
    userId: env.userId,
    workspaceId: env.workspaceId,
    workspaceRoot: deps.workspaceManager.physicalWorkspacePath(env.workspaceId),
    tempRoot: deps.workspaceManager.physicalTempPath(env.workspaceId),
    systemSkillRoot: deps.systemSkillRoot,
    enabledSkillPackages: [...deps.enabledSkillPackagesFor(env.orgId, env.userId)],
  };
}

async function parseBody(
  c: import('hono').Context,
): Promise<{ envelope: unknown; payload: Record<string, unknown> }> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new ContractError('ENVELOPE_INVALID', 'body must be object');
  }
  const b = body as Record<string, unknown>;
  return { envelope: b['envelope'], payload: (b['payload'] ?? {}) as Record<string, unknown> };
}

function statusFor(err: unknown): number {
  if (err instanceof ArtifactError) return err.status;
  if (err instanceof ContractError) return 400;
  return 500;
}

export function registerInternalArtifactRoutes(app: Hono, deps: InternalArtifactDeps): void {
  app.post('/internal/v1/artifacts/submit', async (c) => {
    try {
      const { envelope: rawEnv, payload } = await parseBody(c);
      parseEnvelope(rawEnv);
      const env = rawEnv as Envelope;
      const workspace = buildContext(deps, env);
      const sourcePath = typeof payload['sourcePath'] === 'string' ? payload['sourcePath'] : '';
      if (!sourcePath) throw new ContractError('ENVELOPE_INVALID', 'sourcePath required');

      const sessionIdRaw = payload['sessionId'];
      const sessionId =
        typeof sessionIdRaw === 'string' && sessionIdRaw.trim() !== ''
          ? sessionIdRaw.trim()
          : env.sessionId ?? env.workspaceId;
      const externalIdRaw = payload['externalArtifactId'];
      const record = await deps.artifactService.submit({
        workspace,
        sessionId,
        sourcePath,
        name: (payload['name'] as string | undefined) ?? null,
        mimeType: (payload['mimeType'] as string | undefined) ?? null,
        expectedSha256: (payload['expectedSha256'] as string | undefined) ?? null,
        ...(typeof externalIdRaw === 'string' && externalIdRaw.trim() !== ''
          ? { externalArtifactId: externalIdRaw.trim() }
          : {}),
        owner: { orgId: env.orgId, userId: env.userId },
      });
      return c.json({
        ok: true,
        data: {
          artifactId: record.artifactId,
          name: record.name,
          mimeType: record.mimeType,
          sha256: record.sha256,
          size: record.sizeBytes,
        },
      });
    } catch (err) {
      const wire = toWireError(err, { physicalRoots: [] });
      return c.json({ ok: false, error: wire }, statusFor(err) as never);
    }
  });

  app.post('/internal/v1/artifacts/download', async (c) => {
    try {
      const { envelope: rawEnv, payload } = await parseBody(c);
      parseEnvelope(rawEnv);
      const env = rawEnv as Envelope;
      const artifactId = typeof payload['artifactId'] === 'string' ? payload['artifactId'] : '';
      if (!artifactId) throw new ContractError('ENVELOPE_INVALID', 'artifactId required');

      const owner = { orgId: env.orgId, userId: env.userId };
      const record = await deps.artifactService.get(artifactId, owner);
      // 归属不符与不存在同一个 404：存在性不能泄漏。
      if (record === null) throw new ArtifactError('artifact_not_found', 'artifact not found', 404);

      const chunks: Buffer[] = [];
      for await (const chunk of deps.artifactService.openSnapshot(record)) chunks.push(chunk);
      return c.json({
        ok: true,
        data: {
          artifactId,
          name: record.name,
          mimeType: record.mimeType,
          sha256: record.sha256,
          size: record.sizeBytes,
          bytes: Buffer.concat(chunks).toString('base64'),
        },
      });
    } catch (err) {
      const wire = toWireError(err, { physicalRoots: [] });
      return c.json({ ok: false, error: wire }, statusFor(err) as never);
    }
  });
}
