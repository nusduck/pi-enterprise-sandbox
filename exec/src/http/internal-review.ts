/**
 * 内部审核端点——审核面专用的五个动作（design `agent-output-review.md` §6.2）。
 *
 * | 端点 | 用途 |
 * |---|---|
 * | `POST /internal/v1/review/artifacts/snapshot`  | 附件快照：复制成不可变产物，`withdrawn` |
 * | `POST /internal/v1/review/artifacts/get`        | 按 id 读取（含字节），供审核员下载任一版本 |
 * | `POST /internal/v1/review/artifacts/revision`   | 审核员的修订上传：新产物 + `revision_of` 链 |
 * | `POST /internal/v1/review/artifacts/visibility` | 状态变更：`held` → `released` / `withdrawn` |
 * | `POST /internal/v1/review/artifacts/import`     | 修订版导入发起人工作区的 `审核版/`（§5.3 第 3 步） |
 *
 * **为什么单独一组而不是塞进 `/internal/v1/artifacts/*`**：那一组是**模型工具**的面
 * （`submit_artifact`），按 owner 作用域判定；这一组是**审核流程**的面，按 org 作用域
 * 判定（审核员不是发起人），而且其中两个端点只能由 outbox 投递的放行/撤回驱动。
 * 两组的调用方、作用域、幂等语义都不同，共用路径会让「谁在调」只能靠 payload 猜。
 *
 * **凭据**：整条 `/internal/v1/*` 前缀都由 HMAC + CIDR 中间件守着，MCP 窄桥走的是
 * 独立的 `/internal/mcp/v1/*` 与独立 token，够不到这里（AGENTS.md §1、ADR 0016 D5）。
 * 归属只取**已校验的信封**，绝不读 payload 里的 org/user——那正是"伪造 org 把记录写到
 * 别的租户名下"的老路。
 */

import type { Hono } from 'hono';
import { ContractError, toWireError } from '@dsh/contract/errors.js';
import { parseEnvelope } from '@dsh/contract/envelope.js';
import {
  assertNoDuplicateSkillScopes,
  parseEnabledSkills,
  parseSystemSkills,
  type EnabledSkillRef,
} from '@dsh/contract/skill-manifest.js';
import type { ArtifactService } from '../artifact/service.js';
import { ArtifactError } from '../artifact/service.js';
import type { ArtifactVisibilityUpdate } from '../db/repositories/artifacts.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import { skillPackagesForRequest } from './skill-context.js';
import type {
  EnabledSkillPackagesResolver,
  SystemSkillPackagesResolver,
  WorkspaceContext,
} from '../types.js';

export interface InternalReviewDeps {
  readonly workspaceManager: WorkspaceManager;
  readonly systemSkillRoot: string;
  readonly enabledSkillPackagesFor: EnabledSkillPackagesResolver;
  readonly systemSkillPackagesFor: SystemSkillPackagesResolver;
  readonly artifactService: ArtifactService;
}

interface Envelope {
  orgId: string;
  userId: string;
  workspaceId: string;
  sessionId?: string;
}

async function parseBody(c: import('hono').Context): Promise<{
  envelope: unknown;
  payload: Record<string, unknown>;
  enabledSkills: readonly EnabledSkillRef[];
  systemSkills: readonly string[] | null;
}> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw new ContractError('ENVELOPE_INVALID', 'body must be object');
  }
  const b = body as Record<string, unknown>;
  const systemSkills = parseSystemSkills(b['systemSkills']);
  const enabledSkills = parseEnabledSkills(b['enabledSkills']);
  assertNoDuplicateSkillScopes(systemSkills, enabledSkills);
  return {
    envelope: b['envelope'],
    payload: (b['payload'] ?? {}) as Record<string, unknown>,
    enabledSkills,
    systemSkills,
  };
}

function buildContext(
  deps: InternalReviewDeps,
  env: Envelope,
  enabledSkills: readonly EnabledSkillRef[],
  systemSkills: readonly string[] | null,
): WorkspaceContext {
  return {
    orgId: env.orgId,
    userId: env.userId,
    workspaceId: env.workspaceId,
    workspaceRoot: deps.workspaceManager.physicalWorkspacePath(env.workspaceId),
    tempRoot: deps.workspaceManager.physicalTempPath(env.workspaceId),
    systemSkillRoot: deps.systemSkillRoot,
    ...skillPackagesForRequest(deps, env, enabledSkills, systemSkills),
  };
}

function statusFor(err: unknown): number {
  if (err instanceof ArtifactError) return err.status;
  if (err instanceof ContractError) return 400;
  return 500;
}

/**
 * 错误 → 线上形状。
 *
 * `toWireError` 只认 ContractError / FsError，其余一律 `INTERNAL_ERROR`；而这一族
 * 端点的稳定错误码（`artifact_not_found` / `artifact_too_large` / `TOO_LARGE`）来自
 * `ArtifactError` 与 `ControlPlaneError`。调用方（agent 的审核客户端）按码分流，
 * 全都收成 `INTERNAL_ERROR` 会让「产物不存在」与「exec 挂了」看起来一样。
 *
 * 只透出**本来就带 `code` 属性**的错误（那是有意留下的稳定码）；普通 Error 没有这个
 * 属性，仍然落回 `INTERNAL_ERROR`。消息仍走 `toWireError` 的物理路径脱敏。
 */
function wireFor(err: unknown): { code: string; message: string } {
  const wire = toWireError(err, { physicalRoots: [] });
  const code = (err as { code?: unknown } | null)?.code;
  if (
    wire.code === 'INTERNAL_ERROR' &&
    typeof code === 'string' &&
    /^[A-Za-z][A-Za-z0-9_]*$/.test(code)
  ) {
    return { code, message: wire.message };
  }
  return wire;
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = typeof payload[key] === 'string' ? String(payload[key]).trim() : '';
  if (!value) throw new ContractError('ENVELOPE_INVALID', `${key} is required`);
  return value;
}

/** base64 → bytes；非法 base64 不静默当成空文件。 */
function decodeBase64(payload: Record<string, unknown>, key: string): Buffer {
  const raw = requiredString(payload, key);
  const buffer = Buffer.from(raw, 'base64');
  // Node 的 base64 解码是宽松的：`Buffer.from('!!!', 'base64')` 得到空 buffer 而
  // 不报错。重新编码比对，把「传了个不是 base64 的东西」变成 400 而不是「上传成功、
  // 文件是空的」。
  if (buffer.toString('base64').replace(/=+$/, '') !== raw.replace(/=+$/, '')) {
    throw new ContractError('ENVELOPE_INVALID', `${key} is not valid base64`);
  }
  return buffer;
}

/** 只接受两个终态取值；`held` 不是能被外部设置的目标值。 */
function parseVisibilityUpdates(payload: Record<string, unknown>): ArtifactVisibilityUpdate[] {
  const raw = payload['updates'];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ContractError('ENVELOPE_INVALID', 'updates must be a non-empty array');
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ContractError('ENVELOPE_INVALID', `updates[${index}] must be an object`);
    }
    const rec = entry as Record<string, unknown>;
    const artifactId = typeof rec['artifactId'] === 'string' ? rec['artifactId'].trim() : '';
    const visibility = typeof rec['visibility'] === 'string' ? rec['visibility'].trim() : '';
    if (!artifactId) {
      throw new ContractError('ENVELOPE_INVALID', `updates[${index}].artifactId is required`);
    }
    if (visibility !== 'released' && visibility !== 'withdrawn') {
      // `held` 只能由提交时决定；允许外部把产物改**回**待审等于给了撤销放行的口子。
      throw new ContractError(
        'ENVELOPE_INVALID',
        `updates[${index}].visibility must be released|withdrawn`,
      );
    }
    return { artifactId, visibility };
  });
}

export function registerInternalReviewRoutes(app: Hono, deps: InternalReviewDeps): void {
  app.post('/internal/v1/review/artifacts/snapshot', async (c) => {
    try {
      const { envelope: rawEnv, payload, enabledSkills, systemSkills } = await parseBody(c);
      parseEnvelope(rawEnv);
      const env = rawEnv as Envelope;
      const workspace = buildContext(deps, env, enabledSkills, systemSkills);
      const sourcePath = requiredString(payload, 'sourcePath');
      const sessionIdRaw = payload['sessionId'];
      const sessionId =
        typeof sessionIdRaw === 'string' && sessionIdRaw.trim() !== ''
          ? sessionIdRaw.trim()
          : env.sessionId ?? env.workspaceId;

      const record = await deps.artifactService.submit({
        workspace,
        sessionId,
        sourcePath,
        name: (payload['name'] as string | undefined) ?? null,
        mimeType: (payload['mimeType'] as string | undefined) ?? null,
        owner: { orgId: env.orgId, userId: env.userId },
        // 快照恒 `withdrawn`：它只供审核员读取，永远不对发起人可见（design §6.2）。
        visibility: 'withdrawn',
        createdByKind: 'agent',
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
      const wire = wireFor(err);
      return c.json({ ok: false, error: wire }, statusFor(err) as never);
    }
  });

  app.post('/internal/v1/review/artifacts/get', async (c) => {
    try {
      const { envelope: rawEnv, payload } = await parseBody(c);
      parseEnvelope(rawEnv);
      const env = rawEnv as Envelope;
      const artifactId = requiredString(payload, 'artifactId');
      // org 作用域、不看可见性：审核员要能读**任一版本**（含已撤回的原件），
      // 而「这件产物属于本任务」由 agent 的审核账本判定（design §6.1）。
      const record = await deps.artifactService.getInOrg(artifactId, env.orgId);
      // 跨 org 与不存在同一个 404。
      if (record === null) {
        throw new ArtifactError('artifact_not_found', 'artifact not found', 404);
      }
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
          visibility: record.visibility,
          revisionOf: record.revisionOf,
          bytes: Buffer.concat(chunks).toString('base64'),
        },
      });
    } catch (err) {
      const wire = wireFor(err);
      return c.json({ ok: false, error: wire }, statusFor(err) as never);
    }
  });

  app.post('/internal/v1/review/artifacts/revision', async (c) => {
    try {
      const { envelope: rawEnv, payload } = await parseBody(c);
      parseEnvelope(rawEnv);
      const env = rawEnv as Envelope;
      const originalArtifactId = requiredString(payload, 'originalArtifactId');
      const bytes = decodeBase64(payload, 'bytesBase64');
      // 修订上传走 base64 而不是流式：整条内部面是 JSON + HMAC（签名覆盖
      // `body_sha256`），加一条二进制通道要同时改签名、重试与幂等语义。
      // 代价是内存里多一份 4/3 的字节；单件上限仍受 `maxBytes` 约束。
      const record = await deps.artifactService.submitRevision({
        originalArtifactId,
        orgId: env.orgId,
        name: (payload['name'] as string | undefined) ?? null,
        mimeType: (payload['mimeType'] as string | undefined) ?? null,
        bytes,
      });
      return c.json({
        ok: true,
        data: {
          artifactId: record.artifactId,
          name: record.name,
          mimeType: record.mimeType,
          sha256: record.sha256,
          size: record.sizeBytes,
          revisionOf: record.revisionOf,
        },
      });
    } catch (err) {
      const wire = wireFor(err);
      return c.json({ ok: false, error: wire }, statusFor(err) as never);
    }
  });

  app.post('/internal/v1/review/artifacts/visibility', async (c) => {
    try {
      const { envelope: rawEnv, payload } = await parseBody(c);
      parseEnvelope(rawEnv);
      const env = rawEnv as Envelope;
      const updates = parseVisibilityUpdates(payload);
      // 单事务、幂等（`WHERE visibility='held'`）：outbox 是至少一次投递，
      // 重复放行不会把已撤回的历史版本再放出来。
      const changed = await deps.artifactService.applyVisibilities(env.orgId, updates);
      return c.json({ ok: true, data: { changed } });
    } catch (err) {
      const wire = wireFor(err);
      return c.json({ ok: false, error: wire }, statusFor(err) as never);
    }
  });

  /**
   * 修订版导入工作区（design §5.3 第 3 步）：把审核员改过的版本写到发起人工作区的
   * `审核版/<name>`，好让模型在追问中基于它继续修改（§5.4）。
   *
   * 与 `visibility` 分开而不是塞进同一个请求：放行是**状态**（单事务、幂等），
   * 导入是**写工作区字节**（可重放、覆盖同名文件）。合成一个端点会让「状态已放行、
   * 文件没落盘」变成一个说不清的部分成功。
   */
  app.post('/internal/v1/review/artifacts/import', async (c) => {
    try {
      const { envelope: rawEnv, payload, enabledSkills, systemSkills } = await parseBody(c);
      parseEnvelope(rawEnv);
      const env = rawEnv as Envelope;
      const workspace = buildContext(deps, env, enabledSkills, systemSkills);
      const artifactId = requiredString(payload, 'artifactId');
      const targetPath = requiredString(payload, 'targetPath');
      const result = await deps.artifactService.importRevisionToWorkspace({
        artifactId,
        orgId: env.orgId,
        workspace,
        targetPath,
      });
      return c.json({ ok: true, data: { artifactId, path: result.path } });
    } catch (err) {
      const wire = wireFor(err);
      return c.json({ ok: false, error: wire }, statusFor(err) as never);
    }
  });
}
