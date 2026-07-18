/**
 * BullMQ Run queue factories (plan §9.1).
 *
 * Job payload is a pure reference { runId, orgId, traceId }.
 * Worker processor receives that ref and owns MySQL load / Run transitions elsewhere.
 * This module performs no Run state machine updates.
 */

import {
  AGENT_RUNS_QUEUE_NAME,
  RUN_JOB_REF_FIELDS,
} from './constants.js';
import {
  assertBullmqInstalled,
  assertRedisConnectionUrl,
  createBullMQConnection,
  destroyRedisClient,
  loadBullmqModule,
} from './client.js';
import {
  attachRedisConnectionErrorGuard,
  REDIS_ERROR_GUARD_CLEANUP,
} from './redis-connection-error-guard.js';
import { RedisValidationError } from './errors.js';
import { assertOrgId, assertRunId, assertTraceId } from './validation.js';

/**
 * BullMQ re-emits connection failures on Queue/Worker. Without an `error`
 * listener QueueBase falls back to console.error for every reconnect attempt.
 *
 * @param {object | null | undefined} target
 */
function disposeBullmqErrorGuard(target) {
  try {
    const cleanup = target?.[REDIS_ERROR_GUARD_CLEANUP];
    if (typeof cleanup === 'function') cleanup();
  } catch {
    // Teardown remains best-effort and idempotent.
  }
}

/**
 * @typedef {object} RunJobRef
 * @property {string} runId
 * @property {string} orgId
 * @property {string} traceId
 */

/**
 * Validate reference-only job payload. Rejects missing fields, extra keys, and bad ID shapes.
 *
 * @param {unknown} payload
 * @returns {RunJobRef}
 */
export function assertRunJobRef(payload) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RedisValidationError('Run job payload must be an object with runId, orgId, traceId', {
      field: 'payload',
    });
  }

  /** @type {Record<string, unknown>} */
  const obj = /** @type {Record<string, unknown>} */ (payload);
  const keys = Object.keys(obj);
  const allowed = new Set(RUN_JOB_REF_FIELDS);

  for (const k of keys) {
    if (!allowed.has(k)) {
      throw new RedisValidationError(
        `Run job payload rejects extra field "${k}"; only runId, orgId, traceId are allowed`,
        { field: k },
      );
    }
  }

  for (const field of RUN_JOB_REF_FIELDS) {
    if (!(field in obj)) {
      throw new RedisValidationError(
        `Run job payload.${field} is required and must be a non-empty string`,
        { field },
      );
    }
  }

  return {
    runId: assertRunId(obj.runId),
    orgId: assertOrgId(obj.orgId),
    traceId: assertTraceId(obj.traceId),
  };
}

/**
 * Create a BullMQ Queue for agent-runs. Lazy-imports bullmq.
 *
 * @param {string} connectionUrl
 * @param {{ queueName?: string, prefix?: string }} [options]
 * @returns {{ queue: import('bullmq').Queue, connection: import('ioredis').default, queueName: string }}
 */
export function createRunQueue(connectionUrl, options = {}) {
  assertRedisConnectionUrl(connectionUrl);
  assertBullmqInstalled();
  const { Queue } = loadBullmqModule();
  const queueName = options.queueName ?? AGENT_RUNS_QUEUE_NAME;
  // Dedicated connection + role label; error guard attaches in createRedisClient
  // (and on BullMQ duplicate() clones via GuardedRedis subclass).
  const connection = createBullMQConnection(connectionUrl, {
    connectionRole: 'bullmq-queue',
  });

  /** @type {import('bullmq').QueueOptions} */
  const queueOpts = { connection };
  if (options.prefix != null) {
    queueOpts.prefix = options.prefix;
  }

  const queue = new Queue(queueName, queueOpts);
  attachRedisConnectionErrorGuard(queue, {
    role: 'bullmq-queue-runtime',
  });
  return { queue, connection, queueName };
}

/**
 * Enqueue a run reference job. Deterministic jobId = runId (idempotent re-add).
 *
 * @param {import('bullmq').Queue} queue
 * @param {RunJobRef} ref
 * @param {import('bullmq').JobsOptions} [jobOptions]
 * @returns {Promise<import('bullmq').Job>}
 */
export async function enqueueRunJob(queue, ref, jobOptions = {}) {
  if (!queue || typeof queue.add !== 'function') {
    throw new Error('enqueueRunJob requires a BullMQ Queue');
  }
  const jobRef = assertRunJobRef(ref);
  // Deterministic jobId=runId: a prior completed/failed job with the same id
  // blocks legitimate recovery re-enqueue forever. Remove terminal jobs first.
  if (typeof queue.getJob === 'function') {
    try {
      const existing = await queue.getJob(jobRef.runId);
      if (existing && typeof existing.getState === 'function') {
        const state = await existing.getState();
        if (state === 'completed' || state === 'failed') {
          await existing.remove();
        }
      }
    } catch {
      // Best-effort; add may still succeed or surface a clear error.
    }
  }
  return queue.add('execute', jobRef, {
    removeOnComplete: true,
    removeOnFail: 100,
    ...jobOptions,
    jobId: jobRef.runId,
  });
}

/**
 * @typedef {(ref: RunJobRef, job: import('bullmq').Job) => Promise<unknown>} RunJobProcessor
 */

/**
 * Create a BullMQ Worker. Processor receives validated refs only (not full conversation payloads).
 *
 * @param {string} connectionUrl
 * @param {RunJobProcessor} processor
 * @param {{ queueName?: string, prefix?: string, concurrency?: number }} [options]
 * @returns {{ worker: import('bullmq').Worker, connection: import('ioredis').default, queueName: string }}
 */
export function createRunWorker(connectionUrl, processor, options = {}) {
  assertRedisConnectionUrl(connectionUrl);
  assertBullmqInstalled();
  if (typeof processor !== 'function') {
    throw new Error('createRunWorker requires a processor function');
  }

  const { Worker } = loadBullmqModule();
  const queueName = options.queueName ?? AGENT_RUNS_QUEUE_NAME;
  const connection = createBullMQConnection(connectionUrl, {
    connectionRole: 'bullmq-worker',
  });

  /** @type {import('bullmq').WorkerOptions} */
  const workerOpts = {
    connection,
    concurrency: options.concurrency ?? 1,
  };
  if (options.prefix != null) {
    workerOpts.prefix = options.prefix;
  }

  const worker = new Worker(
    queueName,
    async (job) => {
      const ref = assertRunJobRef(job.data);
      // Processor owns MySQL load / Run state transitions — not this factory.
      return processor(ref, job);
    },
    workerOpts,
  );
  attachRedisConnectionErrorGuard(worker, {
    role: 'bullmq-worker-runtime',
  });

  return { worker, connection, queueName };
}

/**
 * Close queue and its dedicated connection (idempotent).
 *
 * @param {{ queue?: { close?: () => Promise<void> } | null, connection?: Parameters<typeof destroyRedisClient>[0] }} handles
 */
export async function destroyRunQueue(handles) {
  if (!handles) return;
  if (handles.queue && typeof handles.queue.close === 'function') {
    disposeBullmqErrorGuard(handles.queue);
    try {
      await handles.queue.close();
    } catch {
      // ignore double-close
    }
  }
  await destroyRedisClient(handles.connection);
}

/**
 * Close worker and its dedicated connection (idempotent).
 *
 * @param {{ worker?: { close?: () => Promise<void> } | null, connection?: Parameters<typeof destroyRedisClient>[0] }} handles
 */
export async function destroyRunWorker(handles) {
  if (!handles) return;
  if (handles.worker && typeof handles.worker.close === 'function') {
    disposeBullmqErrorGuard(handles.worker);
    try {
      await handles.worker.close();
    } catch {
      // ignore double-close
    }
  }
  await destroyRedisClient(handles.connection);
}
