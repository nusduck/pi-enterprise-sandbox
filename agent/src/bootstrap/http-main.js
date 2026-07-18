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
    const mod = await import('../../infrastructure/sandbox-client.js');
    sandboxHealthCheck = () => mod.checkHealth();
  } catch {
    sandboxHealthCheck = null;
  }

  let getExtensionDiagnostics = null;
  try {
    const mod = await import(
      '../../application/extension-diagnostics-service.js'
    );
    getExtensionDiagnostics = mod.getExtensionDiagnostics;
  } catch {
    getExtensionDiagnostics = null;
  }

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

  /** @type {{ handle: Function } | null} */
  let a2aHandler = null;
  if (httpServices?.a2aCredentialService && httpServices?.a2aTaskService) {
    const { createA2aHttpHandler } = await import(
      '../presentation/a2a/http-handler.js'
    );
    const { resolveRequestTraceId, readBody, json } = await import(
      './create-http-server.js'
    );
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
      // No safe byte streamer in Agent plane — download route fail-closed (503).
      streamArtifactBytes: null,
      createRepositories: httpServices.createRepositories,
      db: httpServices.knex,
      resolveTraceId: resolveRequestTraceId,
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
  }

  const server = createAgentHttpServer({
    createRunService: httpServices?.createRunService ?? {
      execute: notReady,
    },
    getRunService: httpServices?.getRunService ?? { execute: notReady },
    cancelRunService: httpServices?.cancelRunService ?? {
      execute: notReady,
    },
    eventQueryService: httpServices?.eventQueryService ?? {
      listEvents: notReady,
    },
    eventSseService: httpServices?.eventSseService ?? null,
    a2aHandler,
    listRuns,
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
  console.log('[agent-server] Run authority: MySQL Create/Get/Cancel services');

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
