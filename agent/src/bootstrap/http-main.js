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
import { createAgentHttpServer } from './create-http-server.js';
import { ProcessAccessService } from '../application/process-access-service.js';
import { getExtensionDiagnostics as projectExtensionDiagnostics } from '../application/extension-diagnostics-service.js';
import { startTelemetry } from '../infrastructure/telemetry.js';

/**
 * Build the A2A artifact byte authority. It resolves the task's durable Run
 * and Agent Session under the credential owner before asking Sandbox for an
 * artifact by opaque id. Filesystem paths are never accepted or forwarded.
 *
 * @param {{
 *   createRepositories: (db?: any) => any,
 *   db?: any,
 *   artifactDownloadTransport: { downloadArtifact: Function },
 * }} deps
 */
export function createA2aArtifactByteStreamer(deps) {
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

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function startHttpMain(env = process.env) {
  try {
    validateProductionConfig(env, { skillsMode: config.SKILLS_MODE });
  } catch (err) {
    console.error(`[agent-server] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const telemetry = await startTelemetry(env, {
    serviceName: 'pi-enterprise-agent-http',
  });

  const container = createServiceContainer(env);
  const requireDataPlane =
    String(env.DEPLOYMENT_ENV || env.NODE_ENV || '').toLowerCase() ===
      'production' ||
    Boolean(String(env.AGENT_DATABASE_URL || '').trim());

  /** @type {Awaited<ReturnType<typeof container.createHttpServices>> | null} */
  let httpServices = null;

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

  let sandboxHealthCheck = null;
  try {
    const mod = await import('../infrastructure/sandbox/sandbox-client.js');
    sandboxHealthCheck = () => mod.checkHealth();
  } catch {
    sandboxHealthCheck = null;
  }

  const getExtensionDiagnostics = (options = {}) =>
    projectExtensionDiagnostics({
      ...options,
      skillRoots: config.SKILL_ROOTS,
      mcpServers: config.MCP_SERVERS,
    });

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
        return repos.runs.list(
          { orgId: owner.orgId, userId: owner.userId },
          {
            conversationId: conversationId || undefined,
            status: status || undefined,
            limit: limit || 50,
          },
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

  let processAccessService = null;
  if (httpServices) {
    const { createSandboxClient } = await import(
      '../infrastructure/sandbox/sandbox-client.js'
    );
    processAccessService = new ProcessAccessService({
      createRepositories: httpServices.createRepositories,
      db: httpServices.knex,
      createSandboxClient,
    });
  }

  /** @type {{ handle: Function } | null} */
  let a2aHandler = null;
  /** @type {{ handle: Function } | null} */
  let a2aAdminHandler = null;
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
      resolveAgentMeta: async (agentId) => {
        try {
          const repos = httpServices.createRepositories(httpServices.knex);
          const def = await repos.catalog.getDefinitionById(agentId);
          if (!def) return null;
          return { name: def.name, description: def.description };
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
    listRuns,
    listToolExecutions,
    processAccessService,
    config,
    sandboxHealthCheck: sandboxHealthCheck || undefined,
    // /ready requires data plane (MySQL+Redis started). Health-only mode → 503.
    dataPlaneReady: () => container.isDataPlaneReady(),
    getExtensionDiagnostics,
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
