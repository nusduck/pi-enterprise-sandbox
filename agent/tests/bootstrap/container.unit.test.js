/**
 * ServiceContainer construction is offline / no network (PR-04 T4 fixes).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createServiceContainer,
  resolveMysqlUrlFromEnv,
  resolveRedisUrlFromEnv,
  createRepositoryBundle,
  resolveWorkerExecutorFactory,
  resolveAgentPiAgentDir,
  ensureAgentPiAgentDir,
  assertWorkerSandboxServiceToken,
} from '../../src/bootstrap/container.js';

describe('ServiceContainer', () => {
  it('constructs without connecting', () => {
    const c = createServiceContainer({
      AGENT_DATABASE_URL: 'mysql://u:p@localhost:3306/db',
      AGENT_REDIS_URL: 'redis://localhost:6379/0',
    });
    assert.equal(c.started, false);
    assert.equal(c.knex, null);
    assert.equal(c.redis, null);
  });

  it('resolves env URL names without echoing secrets in helpers', () => {
    assert.equal(
      resolveMysqlUrlFromEnv({ AGENT_DATABASE_URL: 'mysql://x' }),
      'mysql://x',
    );
    assert.equal(
      resolveRedisUrlFromEnv({ REDIS_URL: 'redis://localhost:6379/0' }),
      'redis://localhost:6379/0',
    );
    assert.equal(resolveMysqlUrlFromEnv({}), null);
  });

  it('createRepositoryBundle wires all expected repos including sessionSnapshots and journal', () => {
    const fakeDb = () => ({});
    const bundle = createRepositoryBundle(fakeDb);
    for (const k of [
      'organizations',
      'externalRefs',
      'catalog',
      'conversations',
      'sessions',
      'sessionSnapshots',
      'messages',
      'journal',
      'runs',
      'runEvents',
      'idempotency',
      'toolExecutions',
      'approvals',
      'sandboxAudit',
      'outbox',
    ]) {
      assert.ok(bundle[k], `missing ${k}`);
    }
  });

  it('exposes PR-05 factory methods without enabling stub executor by default', async () => {
    const c = createServiceContainer({
      AGENT_DATABASE_URL: 'mysql://u:p@localhost:3306/db',
      AGENT_REDIS_URL: 'redis://localhost:6379/0',
    });
    assert.equal(typeof c.createSessionLockManager, 'function');
    assert.equal(typeof c.createPiRuntimeFactory, 'function');
    assert.equal(typeof c.createPiSessionAdapter, 'function');
    assert.equal(typeof c.createPlatformEventProjector, 'function');
    assert.equal(typeof c.createPiRunExecutorFactory, 'function');
    assert.equal(typeof c.createSessionRecoveryService, 'function');
    assert.throws(
      () => c.requireWorkerExecutorFactory(),
      (err) => err?.code === 'RUN_EXECUTOR_NOT_CONFIGURED',
    );
    // No pre-injected factory until createWorkerServices / ensureWorkerRunExecutorFactory
    assert.equal(c.runExecutorFactory, null);
    const projector = await c.createPlatformEventProjector();
    assert.equal(typeof projector.project, 'function');
  });

  it('start without URL throws config-style error (no DSN leak on empty)', async () => {
    const c = createServiceContainer({});
    await assert.rejects(() => c.start(), /AGENT_DATABASE_URL|required/);
  });

  it('partial start failure rolls back MySQL handle', async () => {
    let destroyed = 0;
    const knex = {
      raw: async () => [[{ '1': 1 }]],
    };
    const c = createServiceContainer(
      {
        AGENT_DATABASE_URL: 'mysql://u:p@h/db',
        AGENT_REDIS_URL: 'redis://localhost:6379/0',
      },
      {
        createMysqlKnex: () => knex,
        destroyMysqlKnex: async () => {
          destroyed += 1;
        },
        createRedisClient: () => {
          throw new Error('redis boom');
        },
        createRunQueue: () => {
          throw new Error('should not reach');
        },
      },
    );
    await assert.rejects(() => c.start(), /redis boom/);
    assert.equal(c.knex, null);
    assert.equal(c.started, false);
    assert.equal(destroyed, 1);
    // Retry allowed after failed start
    assert.equal(c.startPromise, null);
  });

  it('concurrent start shares one promise', async () => {
    let creates = 0;
    const knex = { raw: async () => [[{}]] };
    const redis = { status: 'ready' };
    const c = createServiceContainer(
      {
        AGENT_DATABASE_URL: 'mysql://u:p@h/db',
        AGENT_REDIS_URL: 'redis://localhost:6379/0',
      },
      {
        createMysqlKnex: () => {
          creates += 1;
          return knex;
        },
        createRedisClient: () => redis,
        createRunQueue: () => ({ queue: { add: async () => ({}) } }),
        destroyMysqlKnex: async () => {},
        destroyRedisClient: async () => {},
        destroyRunQueue: async () => {},
      },
    );
    await Promise.all([c.start(), c.start(), c.start()]);
    assert.equal(creates, 1);
    assert.equal(c.started, true);
    assert.equal(c.isDataPlaneReady(), true);
  });

  it('worker executor factory required in production', () => {
    assert.equal(
      resolveWorkerExecutorFactory({ DEPLOYMENT_ENV: 'production' }, {}),
      null,
    );
    const c = createServiceContainer({ DEPLOYMENT_ENV: 'production' });
    assert.throws(
      () => c.requireWorkerExecutorFactory(),
      (err) => err?.code === 'RUN_EXECUTOR_NOT_CONFIGURED',
    );
  });

  it('stub allowed only when AGENT_ALLOW_STUB_EXECUTOR and non-production', () => {
    const f = resolveWorkerExecutorFactory(
      { AGENT_ALLOW_STUB_EXECUTOR: 'true', NODE_ENV: 'development' },
      {},
    );
    assert.equal(typeof f, 'function');
    assert.equal(
      resolveWorkerExecutorFactory(
        { AGENT_ALLOW_STUB_EXECUTOR: 'true', DEPLOYMENT_ENV: 'production' },
        {},
      ),
      null,
    );
  });

  it('ensureAgentPiAgentDir creates concrete agentDir (runtime create boundary)', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'pi-agent-dir-'));
    const dir = path.join(base, 'nested-home');
    try {
      const resolved = ensureAgentPiAgentDir({ AGENT_PI_AGENT_DIR: dir });
      assert.equal(resolved, path.resolve(dir));
      assert.equal(resolveAgentPiAgentDir({ AGENT_PI_AGENT_DIR: dir }), resolved);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('assertWorkerSandboxServiceToken fail-closed in production without token', () => {
    assert.throws(
      () =>
        assertWorkerSandboxServiceToken({
          DEPLOYMENT_ENV: 'production',
          SANDBOX_API_TOKEN: '',
        }),
      (e) => e?.code === 'SANDBOX_API_TOKEN_REQUIRED',
    );
    assert.equal(
      assertWorkerSandboxServiceToken({
        DEPLOYMENT_ENV: 'development',
        SANDBOX_API_TOKEN: '',
        SANDBOX_AUTH_ENABLED: 'false',
      }),
      '',
    );
    assert.throws(
      () =>
        assertWorkerSandboxServiceToken({
          DEPLOYMENT_ENV: 'development',
          SANDBOX_AUTH_ENABLED: 'true',
          SANDBOX_API_TOKEN: '',
        }),
      (e) => e?.code === 'SANDBOX_API_TOKEN_REQUIRED',
    );
  });

  it('createWorkerServices wires Pi factory when none pre-injected (assembly gate)', async () => {
    const knex = { raw: async () => [[{}]], transaction: async (fn) => fn({}) };
    const redis = { status: 'ready' };
    const agentDir = mkdtempSync(path.join(tmpdir(), 'pi-agent-ws-'));
    const c = createServiceContainer(
      {
        AGENT_DATABASE_URL: 'mysql://u:p@h/db',
        AGENT_REDIS_URL: 'redis://localhost:6379/0',
        AGENT_SESSION_WORKSPACE_CWD: '/home/sandbox/workspace',
        AGENT_PI_AGENT_DIR: agentDir,
        SANDBOX_API_TOKEN: 'dev_only_sandbox_api_token_not_for_prod_32b',
        DEPLOYMENT_ENV: 'production',
        LLMIO_BASE_URL: 'http://llm.example',
        MODEL_ID: 'deepseek-v4-flash',
      },
      {
        createMysqlKnex: () => knex,
        createRedisClient: () => redis,
        createRunQueue: () => ({ queue: { add: async () => ({}) } }),
        destroyMysqlKnex: async () => {},
        destroyRedisClient: async () => {},
        destroyRunQueue: async () => {},
      },
    );
    await c.start();

    let piFactoryCalls = 0;
    /** @type {unknown} */
    let capturedOpts = null;
    c.createPiRunExecutorFactory = async (opts) => {
      piFactoryCalls += 1;
      capturedOpts = opts;
      assert.equal(typeof opts.modelResolver, 'function');
      assert.equal(typeof opts.workspaceResolver, 'function');
      // Real Pi factory marker — not createStubRunExecutor
      return function productionPiRunExecutorFactory() {
        return {
          kind: 'pi-run-executor-factory',
          execute: async () => ({ outcome: 'SUCCEEDED' }),
        };
      };
    };

    // Minimal Redis deps for cancel/lease used by createWorkerServices
    c.createCancelSignal = async () => ({
      request: async () => {},
      isRequested: async () => false,
    });
    c.createLeaseManager = async () => ({
      acquire: async () => true,
      renew: async () => true,
      release: async () => true,
      getOwner: async () => null,
    });

    const services = await c.createWorkerServices();
    assert.equal(piFactoryCalls, 1, 'must call createPiRunExecutorFactory once');
    assert.equal(typeof services.runExecutorFactory, 'function');
    assert.equal(
      services.runExecutorFactory().kind,
      'pi-run-executor-factory',
    );
    // Default resolvers present
    const opts = /** @type {{ modelResolver: Function, workspaceResolver: Function, agentDir?: string }} */ (
      capturedOpts
    );
    const cwd = await opts.workspaceResolver({ workspaceId: '01W' });
    assert.equal(cwd, '/home/sandbox/workspace');
    rmSync(agentDir, { recursive: true, force: true });
  });

  it('createPiRunExecutorFactory assembly requires agentDir and refuses null-auth transport', async () => {
    const knex = { raw: async () => [[{}]], transaction: async (fn) => fn({}) };
    const redis = { status: 'ready' };
    const agentDir = mkdtempSync(path.join(tmpdir(), 'pi-agent-exec-'));
    const c = createServiceContainer(
      {
        AGENT_DATABASE_URL: 'mysql://u:p@h/db',
        AGENT_REDIS_URL: 'redis://localhost:6379/0',
        AGENT_PI_AGENT_DIR: agentDir,
        SANDBOX_API_TOKEN: 'dev_only_sandbox_api_token_not_for_prod_32b',
        DEPLOYMENT_ENV: 'development',
      },
      {
        createMysqlKnex: () => knex,
        createRedisClient: () => redis,
        createRunQueue: () => ({ queue: { add: async () => ({}) } }),
        destroyMysqlKnex: async () => {},
        destroyRedisClient: async () => {},
        destroyRunQueue: async () => {},
      },
    );
    await c.start();
    const factory = await c.createPiRunExecutorFactory({
      modelResolver: () => ({ id: 'm', name: 'm', api: 'openai-completions', provider: 'x', baseUrl: 'http://x', reasoning: false, input: ['text'], cost: {}, contextWindow: 1, maxTokens: 1 }),
      workspaceResolver: () => '/home/sandbox/workspace',
      sessionLockManager: {
        acquire: async () => true,
        renew: async () => true,
        release: async () => true,
      },
      piRuntimeFactory: {
        agentDir,
        create: async (input) => {
          assert.ok(String(input.agentDir || '').trim(), 'runtime create must receive agentDir');
          assert.equal(path.resolve(input.agentDir), path.resolve(agentDir));
          return { session: {} };
        },
      },
      sessionAdapter: {},
      projector: { project: () => [] },
      recoveryService: {
        recover: async () => ({ payload: null, checksum: null }),
        checkpoint: async () => {},
      },
    });
    assert.equal(typeof factory, 'function');
    // Extension factory must be per-run scoped (createTransportForRun path).
    // Building the executor instance must not throw assembly errors.
    const exec = factory({ runId: '01RUNTEST' });
    assert.ok(exec);
    assert.equal(path.resolve(String(exec.agentDir)), path.resolve(agentDir));
    rmSync(agentDir, { recursive: true, force: true });
  });

  it('createWorkerServices uses stub only when explicitly allowed and non-production', async () => {
    const knex = { raw: async () => [[{}]], transaction: async (fn) => fn({}) };
    const redis = { status: 'ready' };
    const c = createServiceContainer(
      {
        AGENT_DATABASE_URL: 'mysql://u:p@h/db',
        AGENT_REDIS_URL: 'redis://localhost:6379/0',
        AGENT_ALLOW_STUB_EXECUTOR: 'true',
        DEPLOYMENT_ENV: 'development',
      },
      {
        createMysqlKnex: () => knex,
        createRedisClient: () => redis,
        createRunQueue: () => ({ queue: { add: async () => ({}) } }),
        destroyMysqlKnex: async () => {},
        destroyRedisClient: async () => {},
        destroyRunQueue: async () => {},
      },
    );
    await c.start();
    let piFactoryCalls = 0;
    c.createPiRunExecutorFactory = async () => {
      piFactoryCalls += 1;
      throw new Error('must not build Pi factory when stub allowed');
    };
    c.createCancelSignal = async () => ({
      request: async () => {},
      isRequested: async () => false,
    });
    c.createLeaseManager = async () => ({
      acquire: async () => true,
      renew: async () => true,
      release: async () => true,
      getOwner: async () => null,
    });
    const services = await c.createWorkerServices();
    assert.equal(piFactoryCalls, 0);
    assert.equal(typeof services.runExecutorFactory, 'function');
  });

  it('production refuses stub allowlist (still wires Pi factory path)', async () => {
    assert.equal(
      resolveWorkerExecutorFactory(
        {
          AGENT_ALLOW_STUB_EXECUTOR: 'true',
          DEPLOYMENT_ENV: 'production',
        },
        {},
      ),
      null,
    );
  });

  it('createPiRunExecutorFactory forwards extensionBundleFactory (no network)', async () => {
    const knex = { raw: async () => [[{}]], transaction: async (fn) => fn({}) };
    const redis = { status: 'ready' };
    const c = createServiceContainer(
      {
        AGENT_DATABASE_URL: 'mysql://u:p@h/db',
        AGENT_REDIS_URL: 'redis://localhost:6379/0',
      },
      {
        createMysqlKnex: () => knex,
        createRedisClient: () => redis,
        createRunQueue: () => ({ queue: { add: async () => ({}) } }),
        destroyMysqlKnex: async () => {},
        destroyRedisClient: async () => {},
        destroyRunQueue: async () => {},
      },
    );
    await c.start();

    function sentinelExtensionBundleFactory() {
      return [];
    }

    const factory = await c.createPiRunExecutorFactory({
      modelResolver: () => ({ id: 'm' }),
      workspaceResolver: () => '/tmp/ws',
      extensionBundleFactory: sentinelExtensionBundleFactory,
      // Inject fakes so no Redis lock / Pi / recovery connections are needed.
      sessionLockManager: {
        acquire: async () => true,
        renew: async () => true,
        release: async () => true,
      },
      piRuntimeFactory: { create: async () => ({ session: {} }) },
      sessionAdapter: {},
      projector: { project: () => [] },
      recoveryService: {
        recover: async () => ({ payload: null, checksum: null }),
        checkpoint: async () => {},
      },
    });

    assert.equal(typeof factory, 'function');
    const executor = factory({ runId: 'job-1' });
    assert.equal(
      executor.extensionBundleFactory,
      sentinelExtensionBundleFactory,
      'exact same extensionBundleFactory function must reach PiRunExecutor',
    );
  });

  it('mints A2A artifact URIs only when the internal byte transport is configured', async () => {
    const key = Buffer.alloc(32, 1).toString('base64url');
    const baseEnv = {
      AGENT_DATABASE_URL: 'mysql://u:p@h/db',
      AGENT_REDIS_URL: 'redis://localhost:6379/0',
      DEPLOYMENT_ENV: 'development',
      A2A_PUBLIC_BASE_URL: 'https://agent.example.com',
      A2A_ARTIFACT_DOWNLOAD_SECRET: 'x'.repeat(40),
    };

    async function createBuilder(extraEnv) {
      const knex = {
        raw: async () => [[{}]],
        transaction: async (fn) => fn({}),
      };
      const container = createServiceContainer(
        { ...baseEnv, ...extraEnv },
        {
          createMysqlKnex: () => knex,
          createRedisClient: () => ({ status: 'ready' }),
          createRunQueue: () => ({ queue: { add: async () => ({}) } }),
          destroyMysqlKnex: async () => {},
          destroyRedisClient: async () => {},
          destroyRunQueue: async () => {},
        },
      );
      await container.start();
      container.createCancelSignal = async () => ({
        request: async () => {},
        isRequested: async () => false,
      });
      try {
        const services = await container.createHttpServices();
        assert.equal(typeof services.steerRunService?.execute, 'function');
        assert.equal(typeof services.followUpService?.execute, 'function');
        return services.a2aTaskService.buildArtifactDownloadUri;
      } finally {
        await container.shutdown();
      }
    }

    assert.equal(await createBuilder({}), null);
    const builder = await createBuilder({
      SANDBOX_INTERNAL_HMAC_KEYRING: JSON.stringify({ current: key }),
      SANDBOX_INTERNAL_HMAC_ACTIVE_KID: 'current',
    });
    assert.equal(typeof builder, 'function');
    const uri = builder({
      orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
      clientId: 'client-a',
      taskId: '01K0G2PAV8FPMVC9QHJG7JPN5E',
      artifactId: '01K0G2PAV8FPMVC9QHJG7JPN5F',
    });
    assert.match(uri, /^https:\/\/agent\.example\.com\/a2a\/artifacts\/download\?token=/);
    assert.doesNotMatch(uri, /workspace|relativePath/);
  });
});
