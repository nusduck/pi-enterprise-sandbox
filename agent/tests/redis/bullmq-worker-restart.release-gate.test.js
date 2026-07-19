/**
 * Destructive BullMQ Worker process-restart gate.
 *
 * Uses project queue/worker factories and two real Node child processes. Worker
 * A is SIGKILLed while holding the Job lock; Worker B must recover the stalled
 * Job under BullMQ's production-default lock/stalled timings.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  createRunQueue,
  destroyRunQueue,
  enqueueRunJob,
} from '../../src/infrastructure/redis/run-queue.js';

const execFileAsync = promisify(execFile);
const FIXTURE = fileURLToPath(
  new URL('../fixtures/bullmq-worker-process.js', import.meta.url),
);

const TEST_REDIS_URL = String(process.env.TEST_REDIS_URL || '').trim();
const TEST_REDIS_CONTAINER = String(
  process.env.TEST_REDIS_CONTAINER || '',
).trim();
const explicitlyEnabled =
  process.env.RUN_BULLMQ_WORKER_RESTART_GATE === '1';
const safeContainer = /^pi-release-gate-redis-[a-z0-9-]+$/.test(
  TEST_REDIS_CONTAINER,
);
const runLive = explicitlyEnabled && safeContainer && Boolean(TEST_REDIS_URL);
const describeLive = runLive ? describe : describe.skip;

const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const TRACE = 'e'.repeat(32);
const QUEUE = 'release-gate-worker-restart';
const PREFIX = 'release-gate-bullmq-20260719';

async function docker(...args) {
  return execFileAsync('docker', args, {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function createWorkerHarness(mode) {
  const child = spawn(process.execPath, [FIXTURE], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: {
      ...process.env,
      TEST_REDIS_URL,
      TEST_BULLMQ_QUEUE: QUEUE,
      TEST_BULLMQ_PREFIX: PREFIX,
      TEST_WORKER_MODE: mode,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const messages = [];
  const waiters = new Set();
  let stdoutBuffer = '';
  let stderr = '';
  let exitResult = null;

  const dispatch = (message) => {
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    while (stdoutBuffer.includes('\n')) {
      const newline = stdoutBuffer.indexOf('\n');
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        dispatch(JSON.parse(line));
      } catch {
        dispatch({ type: 'invalid-output', line: line.slice(0, 512) });
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4_096);
  });

  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exitResult = { code, signal };
      resolve(exitResult);
      for (const waiter of [...waiters]) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.reject(
          new Error(
            `worker ${mode} exited before expected message ` +
              `(code=${String(code)} signal=${String(signal)} stderr=${stderr})`,
          ),
        );
      }
    });
  });

  return {
    child,
    mode,
    messages,
    waitFor(predicate, timeoutMs = 10_000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      if (exitResult) {
        return Promise.reject(
          new Error(`worker ${mode} already exited: ${JSON.stringify(exitResult)}`),
        );
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(
              new Error(
                `timed out waiting for worker ${mode}; messages=${JSON.stringify(messages)} stderr=${stderr}`,
              ),
            );
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    async terminate(signal = 'SIGTERM', timeoutMs = 10_000) {
      if (exitResult) return exitResult;
      child.kill(signal);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`worker ${mode} did not exit after ${signal}`)),
          timeoutMs,
        );
        exited.then((result) => {
          clearTimeout(timer);
          resolve(result);
        });
      });
    },
  };
}

async function waitForJobState(queue, jobId, expected, timeoutMs = 80_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (job) {
      last = await job.getState();
      if (last === expected) return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `job ${jobId} did not reach ${expected}; last state=${String(last)}`,
  );
}

describe('BullMQ Worker restart gate safety', () => {
  it('requires explicit opt-in and a dedicated Redis container', () => {
    if (!explicitlyEnabled) {
      assert.ok(true, 'skipped: RUN_BULLMQ_WORKER_RESTART_GATE is not 1');
      return;
    }
    assert.ok(
      safeContainer,
      'TEST_REDIS_CONTAINER must match pi-release-gate-redis-*',
    );
    assert.ok(TEST_REDIS_URL, 'TEST_REDIS_URL is required');
  });
});

describeLive('BullMQ Worker process restart and stalled Job recovery', () => {
  let queueHandles = null;
  const workers = [];

  before(async () => {
    const inspected = await docker(
      'inspect',
      '--format',
      '{{.Name}}|{{.Config.Image}}|{{.State.Running}}',
      TEST_REDIS_CONTAINER,
    );
    const [name, image, running] = inspected.stdout.trim().split('|');
    assert.equal(name, `/${TEST_REDIS_CONTAINER}`);
    assert.equal(image, 'redis:7.2');
    assert.equal(running, 'true');

    queueHandles = createRunQueue(TEST_REDIS_URL, {
      queueName: QUEUE,
      prefix: PREFIX,
    });
    await queueHandles.queue.waitUntilReady();
    await queueHandles.queue.obliterate({ force: true });
  });

  after(async () => {
    for (const worker of workers) {
      await worker.terminate('SIGKILL').catch(() => {});
    }
    if (queueHandles) {
      await queueHandles.queue.obliterate({ force: true }).catch(() => {});
      await destroyRunQueue(queueHandles);
    }
  });

  it('reprocesses the same Job after the lock-owning process is SIGKILLed', async () => {
    const workerA = createWorkerHarness('hang');
    workers.push(workerA);
    await workerA.waitFor((message) => message.type === 'ready');

    await enqueueRunJob(
      queueHandles.queue,
      { runId: RUN, orgId: ORG, traceId: TRACE },
      { removeOnComplete: false, removeOnFail: false },
    );
    const first = await workerA.waitFor(
      (message) => message.type === 'processing' && message.jobId === RUN,
    );
    assert.equal(first.mode, 'hang');
    assert.equal(first.attemptsStarted, 1);
    assert.deepEqual(first.ref, { runId: RUN, orgId: ORG, traceId: TRACE });

    const killed = await workerA.terminate('SIGKILL');
    assert.equal(killed.signal, 'SIGKILL');

    const workerB = createWorkerHarness('complete');
    workers.push(workerB);
    await workerB.waitFor((message) => message.type === 'ready');

    const stalled = await workerB.waitFor(
      (message) => message.type === 'stalled' && message.jobId === RUN,
      80_000,
    );
    assert.equal(stalled.previous, 'active');

    const second = await workerB.waitFor(
      (message) => message.type === 'processing' && message.jobId === RUN,
      10_000,
    );
    assert.equal(second.mode, 'complete');
    assert.ok(second.attemptsStarted >= 2);
    assert.ok(second.stalledCounter >= 1);
    assert.deepEqual(second.ref, { runId: RUN, orgId: ORG, traceId: TRACE });

    const completed = await workerB.waitFor(
      (message) => message.type === 'completed' && message.jobId === RUN,
    );
    assert.equal(completed.result.worker, 'complete');

    const recovered = await waitForJobState(
      queueHandles.queue,
      RUN,
      'completed',
    );
    assert.equal(recovered.id, RUN);
    assert.deepEqual(recovered.data, { runId: RUN, orgId: ORG, traceId: TRACE });
    assert.ok(Number(recovered.attemptsStarted) >= 2);
    assert.ok(Number(recovered.stalledCounter) >= 1);
    assert.equal(recovered.returnvalue.worker, 'complete');
    assert.equal(recovered.returnvalue.pid, workerB.child.pid);
    await workerB.terminate('SIGTERM');
  });
});
