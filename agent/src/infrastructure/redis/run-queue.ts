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
  RUN_JOB_TRACE_FIELDS,
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
import { RedisConfigError, RedisValidationError } from './errors.js';
import { assertOrgId, assertRunId, assertTraceId } from './validation.js';
import {
  contextFromRunJob,
  injectTraceCarrier,
  startSpan,
  withActiveContext,
  SpanKind,
} from '../telemetry.js';

/** 过渡期宽松类型：bullmq / ioredis 侧对象仍走 JS 形状。 */
type Loose = any;

/** 队列 key 前缀默认值：hash tag 让同一队列的全部 key 落到同一 slot（ADR 0011 D9）。 */
export const DEFAULT_AGENT_RUN_QUEUE_PREFIX = '{bull}';

/**
 * 解析并校验 BullMQ prefix。UPRedis Proxy 按 key 路由，BullMQ 的多 key 脚本要求
 * 同一队列的 key 落同一节点，所以 prefix 必须以非空 hash tag 开头的位置含 `{…}`；
 * 不带 tag 的旧值（如 `bull`）在建 Queue/Worker 前就拒绝，而不是等到脚本被代理拒。
 *
 * @param raw 未设置或空串时取默认 `{bull}`
 * @returns {string}
 */
export function resolveRunQueuePrefix(raw?: string | null) {
  const prefix = raw == null || String(raw).trim() === ''
    ? DEFAULT_AGENT_RUN_QUEUE_PREFIX
    : String(raw).trim();
  const open = prefix.indexOf('{');
  const close = open < 0 ? -1 : prefix.indexOf('}', open + 1);
  if (!/^[\x21-\x7e]{3,64}$/.test(prefix) || open < 0 || close <= open + 1) {
    throw new RedisConfigError(
      'AGENT_RUN_QUEUE_PREFIX must contain a non-empty Redis hash tag such as {bull} (printable ASCII, 3-64 chars)',
    );
  }
  return prefix;
}

/**
 * BullMQ re-emits connection failures on Queue/Worker. Without an `error`
 * listener QueueBase falls back to console.error for every reconnect attempt.
 *
 * @param target
 */
function disposeBullmqErrorGuard(target: Record<string, any> | null | undefined) {
  try {
    const cleanup = (target as Loose)?.[REDIS_ERROR_GUARD_CLEANUP];
    if (typeof cleanup === 'function') cleanup();
  } catch {
    // Teardown remains best-effort and idempotent.
  }
}

export type RunJobRef = {
  runId: string;
  orgId: string;
  traceId: string;
  traceparent?: string;
  tracestate?: string;
};

/**
 * Validate reference-only job payload. Rejects missing fields, extra keys, and bad ID shapes.
 *
 * @param payload
 * @returns {RunJobRef}
 */
export function assertRunJobRef(payload: unknown) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RedisValidationError('Run job payload must be an object with runId, orgId, traceId', {
      field: 'payload',
    });
  }

  const obj: Record<string, unknown> = (payload as Record<string, unknown>);
  const keys = Object.keys(obj);
  const allowed = new Set([...RUN_JOB_REF_FIELDS, ...RUN_JOB_TRACE_FIELDS]);

  for (const k of keys) {
    if (!allowed.has(k)) {
      throw new RedisValidationError(
        `Run job payload rejects extra field "${k}"; only reference and W3C carrier fields are allowed`,
        { field: k },
      );
    }
  }

  for (const field of ['runId', 'orgId', 'traceId']) {
    if (!(field in obj)) {
      throw new RedisValidationError(
        `Run job payload.${field} is required and must be a non-empty string`,
        { field },
      );
    }
  }

  // traceparent / tracestate 只在作业带 W3C 载体时才追加，字面量推断
  // 带不上没写出来的可选字段。
  const result: {
    runId: string;
    orgId: string;
    traceId: string;
    traceparent?: string;
    tracestate?: string;
  } = {
    runId: assertRunId(obj.runId),
    orgId: assertOrgId(obj.orgId),
    traceId: assertTraceId(obj.traceId),
  };
  if (obj.traceparent != null || obj.tracestate != null) {
    const traceparent = String(obj.traceparent || '').trim().toLowerCase();
    if (!/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(traceparent)) {
      throw new RedisValidationError('Run job traceparent is invalid', {
        field: 'traceparent',
      });
    }
    if (traceparent.slice(3, 35) !== result.traceId) {
      throw new RedisValidationError('Run job traceparent trace id must match traceId', {
        field: 'traceparent',
      });
    }
    result.traceparent = traceparent;
    if (obj.tracestate != null) {
      const tracestate = String(obj.tracestate).trim();
      if (!tracestate || tracestate.length > 512 || /[^\x20-\x7e]/.test(tracestate)) {
        throw new RedisValidationError('Run job tracestate is invalid', {
          field: 'tracestate',
        });
      }
      result.tracestate = tracestate;
    }
  }
  return result;
}

/**
 * Create a BullMQ Queue for agent-runs. Lazy-imports bullmq.
 *
 * @param connectionUrl
 * @param [options]
 * @returns {{ queue: import('bullmq').Queue, connection: import('ioredis').default, queueName: string }}
 */
export function createRunQueue(connectionUrl: string, options: { queueName?: string, prefix?: string, password?: string } = {}) {
  assertRedisConnectionUrl(connectionUrl);
  const prefix = resolveRunQueuePrefix(options.prefix);
  assertBullmqInstalled();
  const { Queue } = loadBullmqModule();
  const queueName = options.queueName ?? AGENT_RUNS_QUEUE_NAME;
  // Dedicated connection + role label; error guard attaches in createRedisClient
  // (and on BullMQ duplicate() clones via GuardedRedis subclass).
  const connection = createBullMQConnection(connectionUrl, {
    connectionRole: 'bullmq-queue',
    ...(options.password !== undefined ? { password: options.password } : {}),
  });

  const queueOpts: import('bullmq').QueueOptions = { connection, prefix };

  const queue = new Queue(queueName, queueOpts);
  attachRedisConnectionErrorGuard(queue, {
    role: 'bullmq-queue-runtime',
  });
  return { queue, connection, queueName, prefix };
}

/**
 * Enqueue a run reference job. Deterministic jobId = runId (idempotent re-add).
 *
 * @param queue
 * @param ref
 * @param [jobOptions]
 * @returns {Promise<import('bullmq').Job>}
 */
export async function enqueueRunJob(queue: import('bullmq').Queue, ref: RunJobRef, jobOptions: import('bullmq').JobsOptions = {}) {
  if (!queue || typeof queue.add !== 'function') {
    throw new Error('enqueueRunJob requires a BullMQ Queue');
  }
  const jobRef = assertRunJobRef(ref);
  const enqueueSpan = startSpan(
    'agent.queue.enqueue',
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        'messaging.system': 'bullmq',
        'messaging.destination.name': AGENT_RUNS_QUEUE_NAME,
        'app.run_id': jobRef.runId,
      },
    },
  );
  return withActiveContext(enqueueSpan.activeContext, async () => {
    if (!jobRef.traceparent) {
      injectTraceCarrier(jobRef);
      // The active span may be absent in a unit-test/dev process. In that
      // case keep the compact reference payload; a later recovery span will
      // create a fresh carrier.
      if (jobRef.traceparent && jobRef.traceparent.slice(3, 35) !== jobRef.traceId) {
        delete jobRef.traceparent;
        delete jobRef.tracestate;
      }
    }
    const requestedJobId =
    jobOptions.jobId == null ? jobRef.runId : String(jobOptions.jobId);
  if (
    !requestedJobId ||
    requestedJobId.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(requestedJobId)
  ) {
    throw new RedisValidationError(
      'Run job options.jobId must be a non-empty string of at most 256 characters',
      { field: 'jobId' },
    );
  }
  // Deterministic jobId=runId: a prior completed/failed job with the same id
  // blocks legitimate recovery re-enqueue forever. Remove terminal jobs first.
  if (typeof queue.getJob === 'function') {
    try {
      const existing = await queue.getJob(requestedJobId);
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
    const job = await queue.add('execute', jobRef, {
    removeOnComplete: true,
    removeOnFail: 100,
    ...jobOptions,
    // The default remains runId for ordinary creation/recovery. Resume callers
    // may supply a durable interaction/approval suffix so an active original
    // job cannot swallow the wake-up enqueue through BullMQ job-id dedupe.
    jobId: requestedJobId,
  });
    enqueueSpan.end(null, 200);
    return job;
  }).catch((error) => {
    enqueueSpan.end(error, 500);
    throw error;
  });
}

export type RunJobProcessor = (ref: RunJobRef, job: import('bullmq').Job) => Promise<unknown>;

/**
 * Create a BullMQ Worker. Processor receives validated refs only (not full conversation payloads).
 *
 * @param connectionUrl
 * @param processor
 * @param [options]
 * @returns {{ worker: import('bullmq').Worker, connection: import('ioredis').default, queueName: string }}
 */
/**
 * 作业处理外壳：校验引用 → 暂停期间延后 → 追踪 → 调用处理器。抽出来是为了不连 Redis 也能测。
 *
 * 为什么需要「暂停期间延后」：`worker.pause(true)` 只置本地标志，不打断主循环里已经发出的
 * 阻塞取任务（bzpopmin）。暂停后到达的作业仍会被这次在途的取任务拿到并交给处理器——
 * 2026-09-15 在开发栈实测：MySQL 不可用、消费者已暂停时入队的作业被立即执行并以
 * `needs reconciliation` 失败。这里在执行前再看一次暂停状态，暂停中就原样放回 delayed，
 * 恢复后再取；`DelayedError` 由 BullMQ 识别为非失败，不消耗 attempts。
 */
export function createRunJobHandler(
  processor: RunJobProcessor,
  options: {
    queueName: string;
    DelayedError: new (message?: string) => Error;
    shouldDefer?: (() => boolean) | undefined;
    deferDelayMs?: number | undefined;
    now?: (() => number) | undefined;
  },
) {
  const deferDelayMs = options.deferDelayMs ?? 5000;
  const now = options.now ?? Date.now;
  return async (job: import('bullmq').Job, token?: string) => {
    const ref = assertRunJobRef(job.data);
    if (options.shouldDefer?.() === true) {
      await job.moveToDelayed(now() + deferDelayMs, token);
      throw new options.DelayedError();
    }
    const receiveSpan = startSpan(
      'agent.queue.process',
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          'messaging.system': 'bullmq',
          'messaging.destination.name': options.queueName,
          'app.run_id': ref.runId,
        },
      },
      contextFromRunJob(ref),
    );
    return withActiveContext(receiveSpan.activeContext, async () => {
      try {
        // Processor owns MySQL load / Run state transitions — not this factory.
        const result = await processor(ref, job);
        receiveSpan.end(null, 200);
        return result;
      } catch (error) {
        receiveSpan.end(error, 500);
        throw error;
      }
    });
  };
}

export function createRunWorker(connectionUrl: string, processor: RunJobProcessor, options: { queueName?: string, prefix?: string, password?: string, concurrency?: number, lockDuration?: number, stalledInterval?: number, maxStalledCount?: number, shouldDefer?: () => boolean, deferDelayMs?: number } = {}) {
  assertRedisConnectionUrl(connectionUrl);
  const prefix = resolveRunQueuePrefix(options.prefix);
  assertBullmqInstalled();
  if (typeof processor !== 'function') {
    throw new Error('createRunWorker requires a processor function');
  }

  const { Worker, DelayedError } = loadBullmqModule();
  const queueName = options.queueName ?? AGENT_RUNS_QUEUE_NAME;
  const connection = createBullMQConnection(connectionUrl, {
    connectionRole: 'bullmq-worker',
    ...(options.password !== undefined ? { password: options.password } : {}),
  });

  const workerOpts: import('bullmq').WorkerOptions = {
    connection,
    prefix,
    concurrency: options.concurrency ?? 1,
  };
  if (Number.isFinite(options.lockDuration) && options.lockDuration > 0) {
    workerOpts.lockDuration = options.lockDuration;
  }
  if (Number.isFinite(options.stalledInterval) && options.stalledInterval > 0) {
    workerOpts.stalledInterval = options.stalledInterval;
  }
  if (
    Number.isFinite(options.maxStalledCount) &&
    options.maxStalledCount >= 0
  ) {
    workerOpts.maxStalledCount = options.maxStalledCount;
  }
  const worker = new Worker(
    queueName,
    createRunJobHandler(processor, {
      queueName,
      DelayedError,
      shouldDefer: options.shouldDefer,
      deferDelayMs: options.deferDelayMs,
    }),
    workerOpts,
  );
  attachRedisConnectionErrorGuard(worker, {
    role: 'bullmq-worker-runtime',
  });

  return { worker, connection, queueName, prefix };
}

/**
 * Close queue and its dedicated connection (idempotent).
 *
 * @param handles
 */
export async function destroyRunQueue(handles: { queue?: { close?: () => Promise<void> } | null, connection?: Parameters<typeof destroyRedisClient>[0] }) {
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
 * @param handles
 */
export async function destroyRunWorker(handles: { worker?: { close?: () => Promise<void> } | null, connection?: Parameters<typeof destroyRedisClient>[0] }) {
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
