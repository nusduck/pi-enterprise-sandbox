/**
 * Worker main fatal consumer failure (offline DI).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerMain } from '../../src/bootstrap/worker-main.js';
import { createStubRunExecutor } from '../../src/application/run-executor.js';

describe('startWorkerMain', () => {
  it('fails fatally when BullMQ consumer cannot start and cleans up', async () => {
    const knex = { raw: async () => [[{}]] };
    const redis = {};
    let shutdowns = 0;
    const fakeContainer = {
      async start() {
        return this;
      },
      async createWorkerServices() {
        return {
          workerRuntime: {
            async processJob() {},
            async start() {},
            async shutdown() {
              shutdowns += 1;
            },
            isStarted: () => true,
            isShutdown: () => false,
          },
          recoveryService: {
            async scanAndRequeue() {
              return { actions: [] };
            },
          },
        };
      },
      async createOutboxPublisher() {
        return { publishOnce: async () => ({}) };
      },
      async shutdown() {
        shutdowns += 1;
      },
    };

    await assert.rejects(
      () =>
        startWorkerMain(
          {
            AGENT_DATABASE_URL: 'mysql://u:p@h/db',
            AGENT_REDIS_URL: 'redis://localhost:6379/0',
            AGENT_ALLOW_STUB_EXECUTOR: 'true',
            NODE_ENV: 'development',
          },
          {
            createContainer: () => fakeContainer,
            createRunWorker: () => {
              throw new Error('bullmq missing');
            },
          },
        ),
      /bullmq missing/,
    );
    assert.ok(shutdowns >= 1);
  });

  it('pre-injected factory is available; production without inject still needs ensure after start', async () => {
    const { createServiceContainer } = await import(
      '../../src/bootstrap/container.js'
    );
    const c = createServiceContainer({ DEPLOYMENT_ENV: 'production' });
    // Sync require: no pre-inject → not configured (async wire is ensure*)
    assert.throws(() => c.requireWorkerExecutorFactory(), (e) => {
      assert.equal(e.code, 'RUN_EXECUTOR_NOT_CONFIGURED');
      return true;
    });
    const c2 = createServiceContainer(
      { DEPLOYMENT_ENV: 'production' },
      { runExecutorFactory: () => createStubRunExecutor() },
    );
    assert.equal(typeof c2.requireWorkerExecutorFactory(), 'function');
  });

  it('createWorkerServices assembly fails closed without MySQL/Redis start', async () => {
    const { createServiceContainer } = await import(
      '../../src/bootstrap/container.js'
    );
    const c = createServiceContainer({
      DEPLOYMENT_ENV: 'production',
      AGENT_DATABASE_URL: 'mysql://u:p@h/db',
      AGENT_REDIS_URL: 'redis://localhost:6379/0',
    });
    await assert.rejects(
      () => c.createWorkerServices(),
      /MySQL and Redis/,
    );
  });
});
