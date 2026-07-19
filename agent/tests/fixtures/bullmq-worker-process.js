#!/usr/bin/env node

import {
  createRunWorker,
  destroyRunWorker,
} from '../../src/infrastructure/redis/run-queue.js';

const redisUrl = String(process.env.TEST_REDIS_URL || '').trim();
const queueName = String(process.env.TEST_BULLMQ_QUEUE || '').trim();
const prefix = String(process.env.TEST_BULLMQ_PREFIX || '').trim();
const mode = String(process.env.TEST_WORKER_MODE || '').trim();

function emit(message) {
  process.stdout.write(`${JSON.stringify({ ...message, pid: process.pid })}\n`);
}

if (!redisUrl || !queueName || !prefix || !['hang', 'complete'].includes(mode)) {
  emit({ type: 'fatal', message: 'invalid worker fixture configuration' });
  process.exit(2);
}

let handles = null;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  emit({ type: 'shutdown', signal });
  if (handles) {
    await destroyRunWorker(handles).catch(() => {});
  }
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  handles = createRunWorker(
    redisUrl,
    async (ref, job) => {
      emit({
        type: 'processing',
        mode,
        jobId: job.id,
        attemptsStarted: Number(job.attemptsStarted || 0),
        stalledCounter: Number(job.stalledCounter || 0),
        ref,
      });
      if (mode === 'hang') {
        await new Promise(() => {});
      }
      return { worker: mode, pid: process.pid };
    },
    { queueName, prefix, concurrency: 1 },
  );

  handles.worker.on('stalled', (jobId, previous) => {
    emit({ type: 'stalled', jobId: String(jobId), previous: String(previous) });
  });
  handles.worker.on('completed', (job, result) => {
    emit({ type: 'completed', jobId: String(job.id), result });
  });
  handles.worker.on('failed', (job, error) => {
    emit({
      type: 'failed',
      jobId: job?.id == null ? null : String(job.id),
      error: error instanceof Error ? error.message.slice(0, 256) : 'error',
    });
  });

  await handles.worker.waitUntilReady();
  emit({ type: 'ready', mode, queueName });
} catch (error) {
  emit({
    type: 'fatal',
    message: error instanceof Error ? error.message.slice(0, 256) : 'error',
  });
  if (handles) await destroyRunWorker(handles).catch(() => {});
  process.exit(1);
}
