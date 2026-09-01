/**
 * Agent HTTP process entry (PR-04 T4).
 * Explicit start of container + listen. No worker/BullMQ consumer in this process.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  config,
  validateProductionConfig,
  effectiveConfig,
} from '../../config.js';
import { createServiceContainer } from './container.js';
import {
  resolveSkillRootsForRun,
  resolveSkillScopeForIdentity,
} from './container-env.js';
import { ExternalIdentityResolver } from '../application/parent/external-identity-resolver.js';
import { createSkillManager } from '../skills/manager.js';
import { draftSkillRootFor } from '../skills/paths.js';
import { mutateSkillWithLedger } from '../application/skill-enablement-service.js';
import { createAgentHttpServer } from './create-http-server.js';
import { getExtensionDiagnostics as projectExtensionDiagnostics } from '../application/extension-diagnostics-service.js';
import { startTelemetry } from '../infrastructure/telemetry.js';
import { BrowserAuthService } from '../application/browser-auth-service.js';

/**
 * Build the lightweight observability columns for the operator Run list.
 * Model identity is emitted by model.request.* events, while token usage is
 * emitted by assistant message.completed events. Neither belongs on the Run
 * state row itself, so this projection deliberately reads only durable events.
 */
export function summarizeRunObservability(
  events: Array<{ eventType?: string; payloadJson?: unknown }>,
) {
  let modelId: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let hasUsage = false;

  for (const event of events || []) {
    const data = event?.payloadJson;
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const payload = data as Record<string, unknown>;
    if (String(event.eventType || '').toLowerCase().startsWith('model.request.')) {
      const model = payload.model;
      const candidate =
        payload.modelId ??
        payload.model_id ??
        (model && typeof model === 'object' && !Array.isArray(model)
          ? (model as Record<string, unknown>).id
          : null);
      if (typeof candidate === 'string' && candidate.trim()) {
        modelId = candidate.trim();
      }
    }
    const usage = payload.usage;
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue;
    const u = usage as Record<string, unknown>;
    const input = Number(u.inputTokens ?? u.input_tokens ?? u.input ?? 0);
    const output = Number(u.outputTokens ?? u.output_tokens ?? u.output ?? 0);
    const total = Number(u.totalTokens ?? u.total_tokens ?? u.total ?? 0);
    if (!Number.isFinite(input) || !Number.isFinite(output) || !Number.isFinite(total)) {
      continue;
    }
    hasUsage = true;
    inputTokens += Math.max(0, input);
    outputTokens += Math.max(0, output);
    totalTokens += total > 0 ? total : Math.max(0, input) + Math.max(0, output);
  }

  return {
    modelId,
    usage: hasUsage
      ? {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: totalTokens,
        }
      : null,
  };
}

/**
 * Build the A2A artifact byte authority. It resolves the task's durable Run
 * and Agent Session under the credential owner before asking Sandbox for an
 * artifact by opaque id. Filesystem paths are never accepted or forwarded.
 */
export function createA2aArtifactByteStreamer(deps: {
  createRepositories: (db?: any) => any;
  db?: any;
  artifactDownloadTransport: { downloadArtifact: (...args: any[]) => any };
}) {
  if (typeof deps?.createRepositories !== 'function') {
    throw new Error('createA2aArtifactByteStreamer requires repositories');
  }
  if (typeof deps?.artifactDownloadTransport?.downloadArtifact !== 'function') {
    throw new Error(
      'createA2aArtifactByteStreamer requires internal artifact transport',
    );
  }

  return async ({ principal, mapping, artifact, traceId, traceState, req }) => {
    const scope = {
      orgId: principal.orgId,
      userId: principal.serviceUserId,
    };
    const repos = deps.createRepositories(deps.db);
    const run = await repos.runs.getById(mapping.runId, scope);
    if (!run) {
      return { body: null };
    }
    const session = await repos.sessions.getById(run.agentSessionId, scope);
    if (
      !session?.sandboxSessionId ||
      session.agentSessionId !== run.agentSessionId ||
      session.conversationId !== run.conversationId ||
      !Number.isSafeInteger(session.executionFenceToken) ||
      session.executionFenceToken <= 0 ||
      typeof traceId !== 'string' ||
      !/^[0-9a-f]{32}$/.test(traceId)
    ) {
      return { body: null };
    }

    const abort = new AbortController();
    const onClose = () => abort.abort();
    req?.once?.('close', onClose);
    try {
      return await deps.artifactDownloadTransport.downloadArtifact(
        {
          artifactId: artifact.artifactId,
          identity: {
            orgId: principal.orgId,
            userId: principal.serviceUserId,
            conversationId: run.conversationId,
            agentSessionId: run.agentSessionId,
            runId: run.runId,
            sandboxSessionId: session.sandboxSessionId,
            traceId,
            executionFenceToken: session.executionFenceToken,
          },
          expectedSizeBytes: artifact.sizeBytes ?? null,
          expectedSha256: artifact.sha256,
        },
        {
          signal: abort.signal,
          ...(traceState ? { traceState } : {}),
        },
      );
    } finally {
      req?.off?.('close', onClose);
    }
  };
}

export async function startHttpMain(env: NodeJS.ProcessEnv = process.env) {
  try {
    validateProductionConfig(env);
  } catch (err) {
    console.error(`[agent-server] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const telemetry = await startTelemetry(env, {
    serviceName: 'pi-enterprise-agent-http',
  });

  const container = createServiceContainer(env);
  await container.preflightMcpServers();
  const requireDataPlane =
    String(env.DEPLOYMENT_ENV || env.NODE_ENV || '').toLowerCase() ===
      'production' ||
    Boolean(String(env.AGENT_DATABASE_URL || '').trim());

  let httpServices: Awaited<
    ReturnType<typeof container.createHttpServices>
  > | null = null;

  if (requireDataPlane) {
    await container.start({
      connectMysql: true,
      connectRedis: true,
      migrate: env.AGENT_MIGRATE_ON_START === 'true',
    });
    httpServices = await container.createHttpServices();
  } else {
    console.warn(
      '[agent-server] AGENT_DATABASE_URL unset — HTTP up for /health only; create/get return 503',
    );
  }

  let sandboxHealthCheck: (() => Promise<{ status?: string } | null>) | null = null;
  try {
    const mod = await import('../infrastructure/sandbox/sandbox-client.js');
    sandboxHealthCheck = () => mod.checkHealth();
  } catch {
    sandboxHealthCheck = null;
  }

  // Skills are per-caller: the bundled tier plus that user's own directory.
  // Without an identity on the request there is no user tier to project, and
  // the process-wide roots list bundled packages only.
  const resolveOwner = httpServices
    ? async (auth: object) => {
        const repos = httpServices.createRepositories(httpServices.knex);
        return new ExternalIdentityResolver({
          organizations: repos.organizations,
          externalRefs: repos.externalRefs,
        }).resolveOwner(auth as never);
      }
    : null;

  const getExtensionDiagnostics = async (
    options: {
      auth?: object | null;
      [key: string]: unknown;
    } = {},
  ) => {
    const identity = options.auth && resolveOwner
      ? await resolveOwner(options.auth)
      : null;
    const { skillRoots, userSkillRoot } = identity
      ? resolveSkillScopeForIdentity(env, identity)
      : { skillRoots: config.SKILL_ROOTS, userSkillRoot: null };
    return projectExtensionDiagnostics({
      ...options,
      skillRoots,
      userSkillRoot,
      draftSkillRoot: identity ? draftSkillRootFor(identity) : null,
      mcpServers: config.MCP_SERVERS,
      mcpDiscovery: container.getMcpReadiness(),
      toolRiskPolicy: config.TOOL_RISK_POLICY,
    });
  };

  const mutateSkill = resolveOwner
    ? async ({ auth, action, name }) => {
        const owner = await resolveOwner(auth);
        const manager = createSkillManager({
          identity: owner,
          skillRoots: resolveSkillRootsForRun(env, owner),
          draftSkillRoot: draftSkillRootFor(owner),
        });
        const repos = httpServices.createRepositories(httpServices.knex);
        return mutateSkillWithLedger({
          action,
          name,
          owner,
          manager,
          ledger: repos.skillEnablements,
        });
      }
    : null;

  const notReady = async () => {
    const err = new Error('Agent data plane not started');
    // @ts-ignore
    err.code = 'MYSQL_CONFIG_ERROR';
    throw err;
  };

  const listRuns = httpServices
    ? async ({ auth, conversationId, status, limit }) => {
        const { ExternalIdentityResolver } = await import(
          '../application/parent/external-identity-resolver.js'
        );
        const repos = httpServices.createRepositories(httpServices.knex);
        const resolver = new ExternalIdentityResolver({
          organizations: repos.organizations,
          externalRefs: repos.externalRefs,
        });
        const owner = await resolver.resolveOwner(auth);
        const runs = await repos.runs.list(
          { orgId: owner.orgId, userId: owner.userId },
          {
            conversationId: conversationId || undefined,
            status: status || undefined,
            limit: limit || 50,
          },
        );
        const scope = { orgId: owner.orgId, userId: owner.userId };
        // Batch-load AgentSessions so each run can carry sandbox_session_id for
        // browser artifact download/export/upload rehydration.
        const sessionByAgentId = new Map();
        if (repos.sessions?.getById) {
          // repos 经 knex 出来是 any，`new Set(any)` 会塌成 Set<unknown>，
          // 所以显式给出元素类型——它由紧跟着的 `id is string` 断言保证。
          const uniqueAgentSessionIds = [
            ...new Set<string>(
              runs
                .map((run) => run.agentSessionId)
                .filter((id): id is string => typeof id === 'string' && Boolean(id)),
            ),
          ];
          await Promise.all(
            uniqueAgentSessionIds.map(async (agentSessionId) => {
              try {
                const session = await repos.sessions.getById(
                  agentSessionId,
                  scope,
                );
                if (session) sessionByAgentId.set(agentSessionId, session);
              } catch {
                /* leave missing; presentGetRunResponse emits null session_id */
              }
            }),
          );
        }
        return Promise.all(
          runs.map(async (run) => {
            const events = await repos.runEvents.listByRun(run.runId, scope, {
              limit: 500,
            });
            const session = sessionByAgentId.get(run.agentSessionId) || null;
            return {
              ...run,
              sandboxSessionId:
                session?.sandboxSessionId ?? run.sandboxSessionId ?? null,
              workspaceId: session?.workspaceId ?? run.workspaceId ?? null,
              ...summarizeRunObservability(events),
            };
          }),
        );
      }
    : null;

  const listToolExecutions = httpServices
    ? async ({ runId, auth }) => {
        const { ExternalIdentityResolver } = await import(
          '../application/parent/external-identity-resolver.js'
        );
        const repos = httpServices.createRepositories(httpServices.knex);
        const resolver = new ExternalIdentityResolver({
          organizations: repos.organizations,
          externalRefs: repos.externalRefs,
        });
        const owner = await resolver.resolveOwner(auth);
        return repos.toolExecutions.listByRun(runId, {
          orgId: owner.orgId,
          userId: owner.userId,
        });
      }
    : null;

  let browserAuthService = null;
  if (httpServices) {
    const repos = httpServices.createRepositories(httpServices.knex);
    browserAuthService = new BrowserAuthService({
      credentials: repos.authCredentials,
      secret: env.SANDBOX_JWT_SECRET,
      issuer: env.SANDBOX_JWT_ISSUER,
      audience: env.SANDBOX_JWT_AUDIENCE,
      ttlSeconds: Number(env.SANDBOX_JWT_TTL_SECONDS),
      allowPublicRegister:
        String(env.SANDBOX_AUTH_ALLOW_PUBLIC_REGISTER || 'true').toLowerCase() !== 'false',
      adminUsernames: String(env.SANDBOX_AUTH_ADMIN_USERNAMES || '').split(','),
    });
  }

  type RequestHandler = { handle: (...args: any[]) => any };
  let a2aHandler: RequestHandler | null = null;
  let a2aAdminHandler: RequestHandler | null = null;
  if (httpServices?.a2aCredentialService && httpServices?.a2aTaskService) {
    const { createA2aHttpHandler } = await import(
      '../presentation/a2a/http-handler.js'
    );
    const {
      authSubjectsFromRequest,
      resolveRequestTraceId,
      resolveRequestTraceContext,
      readBody,
      json,
    } = await import(
      './create-http-server.js'
    );
    const internalKeyring = String(
      env.SANDBOX_INTERNAL_HMAC_KEYRING || '',
    ).trim();
    const internalActiveKid = String(
      env.SANDBOX_INTERNAL_HMAC_ACTIVE_KID || '',
    ).trim();
    let streamArtifactBytes = null;
    if (internalKeyring && internalActiveKid) {
      const { createInternalArtifactDownloadTransport } = await import(
        '../infrastructure/sandbox/internal-artifact-download-http.js'
      );
      const artifactDownloadTransport =
        createInternalArtifactDownloadTransport({
          baseUrl: env.SANDBOX_BASE_URL || config.SANDBOX_BASE_URL,
          keyring: internalKeyring,
          activeKid: internalActiveKid,
          allowInsecureHttp: true,
        });
      streamArtifactBytes = createA2aArtifactByteStreamer({
        createRepositories: httpServices.createRepositories,
        db: httpServices.knex,
        artifactDownloadTransport,
      });
    }
    a2aHandler = createA2aHttpHandler({
      credentialService: httpServices.a2aCredentialService,
      taskService: httpServices.a2aTaskService,
      streamService: httpServices.a2aStreamService,
      publicBaseUrl: env.A2A_PUBLIC_BASE_URL || config.A2A_PUBLIC_BASE_URL || '',
      deploymentEnv: env.DEPLOYMENT_ENV || env.NODE_ENV || config.DEPLOYMENT_ENV,
      allowDevHostFallback:
        String(env.A2A_ALLOW_DEV_HOST_FALLBACK || '').toLowerCase() === 'true' ||
        config.A2A_ALLOW_DEV_HOST_FALLBACK === true,
      artifactDownloadSecret:
        env.A2A_ARTIFACT_DOWNLOAD_SECRET ||
        config.A2A_ARTIFACT_DOWNLOAD_SECRET ||
        '',
      streamArtifactBytes,
      createRepositories: httpServices.createRepositories,
      db: httpServices.knex,
      resolveTraceId: resolveRequestTraceId,
      resolveTraceContext: resolveRequestTraceContext,
      readBody,
      json,
      // Bundled skill packages (repo skills/ or container /home/sandbox/skill).
      // config 上没有 SYSTEM_SKILL_ROOT 这个键（config.ts 导出的是
      // SKILLS_ROOT / SKILL_ROOTS / DEFAULT_SKILL_ROOTS），原来那一档回落
      // 永远是 undefined。env 侧的 SYSTEM_SKILL_ROOT 保留：它是环境变量名。
      skillRoot: env.SKILLS_ROOT || env.SYSTEM_SKILL_ROOT || config.SKILLS_ROOT || '',
      resolveAgentMeta: async (agentId) => {
        try {
          const repos = httpServices.createRepositories(httpServices.knex);
          const def = await repos.catalog.getDefinitionById(agentId);
          if (!def) return null;
          let skills: unknown[] = [];
          if (def.activeVersionId) {
            try {
              const ver = await repos.catalog.getVersionById(def.activeVersionId);
              const cfg = ver?.configJson;
              if (cfg && typeof cfg === 'object' && Array.isArray(cfg.skills)) {
                skills = cfg.skills;
              }
            } catch {
              skills = [];
            }
          }
          const description =
            (typeof def.description === 'string' && def.description.trim()) ||
            `Enterprise agent "${def.name}" (Pi Enterprise Sandbox)`;
          return {
            name: def.name,
            description,
            skills,
          };
        } catch {
          return null;
        }
      },
    });
    const { createA2aAdminHttpHandler } = await import(
      '../presentation/a2a/admin-http-handler.js'
    );
    a2aAdminHandler = createA2aAdminHttpHandler({
      credentialService: httpServices.a2aCredentialService,
      createRepositories: httpServices.createRepositories,
      db: httpServices.knex,
      generateId: container.generateId,
      publicBaseUrl:
        env.A2A_PUBLIC_BASE_URL || config.A2A_PUBLIC_BASE_URL || '',
      authSubjectsFromRequest,
      resolveTraceId: resolveRequestTraceId,
      readBody,
      json,
    });
  }

  const server = createAgentHttpServer({
    createRunService: httpServices?.createRunService ?? {
      execute: notReady,
    },
    getRunService: httpServices?.getRunService ?? { execute: notReady },
    cancelRunService: httpServices?.cancelRunService ?? {
      execute: notReady,
    },
    steerRunService: httpServices?.steerRunService ?? { execute: notReady },
    followUpService: httpServices?.followUpService ?? { execute: notReady },
    eventQueryService: httpServices?.eventQueryService ?? {
      listEvents: notReady,
    },
    traceQueryService: httpServices?.traceQueryService ?? null,
    eventSseService: httpServices?.eventSseService ?? null,
    a2aHandler,
    a2aAdminHandler,
    conversationService: httpServices?.conversationService ?? null,
    approvalQueryService: httpServices?.approvalQueryService ?? null,
    approvalDecisionService: httpServices?.approvalDecisionService ?? null,
    interactionResponseService: httpServices?.interactionResponseService ?? null,
    cronJobService: httpServices?.cronJobService ?? null,
    listRuns,
    listToolExecutions,
    browserAuthService,
    config,
    sandboxHealthCheck: sandboxHealthCheck || undefined,
    // /ready requires data plane (MySQL+Redis started). Health-only mode → 503.
    dataPlaneReady: () => container.isDataPlaneReady(),
    mcpReadiness: () => container.getMcpReadiness(),
    getExtensionDiagnostics,
    mutateSkill,
    activeRunHint: () => 0,
  });

  const port = Number(env.PORT) || config.PORT || 4100;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(undefined));
  });

  console.log(
    `[agent-server] pi-enterprise-agent v4.0.0 (${config.DEPLOYMENT_ENV}/${config.NODE_ENV}) on port ${port}`,
  );
  console.log(
    '[agent-server] Effective config:',
    JSON.stringify(effectiveConfig()),
  );
  console.log(
    '[agent-server] Run authority: MySQL Create/Get/Cancel/Steer/Follow-up services',
  );

  if (sandboxHealthCheck) {
    try {
      const health = await sandboxHealthCheck();
      if (health?.status === 'ok') {
        console.log('[agent-server] Sandbox healthy');
      } else {
        console.warn('[agent-server] Sandbox not ready — will retry on demand');
      }
    } catch {
      console.warn('[agent-server] Sandbox health check failed');
    }
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[agent-server] ${signal} — shutting down`);
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    try {
      await container.shutdown();
    } catch (err) {
      console.error('[agent-server] container shutdown error');
    }
    try {
      await telemetry.shutdown();
    } catch {
      console.error('[agent-server] telemetry shutdown error');
    }
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  return { server, container, port };
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  startHttpMain().catch((err) => {
    console.error(
      '[agent-server] fatal:',
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
}
