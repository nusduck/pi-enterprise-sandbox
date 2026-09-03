#!/usr/bin/env node

/**
 * Independent Agent Worker process for the destructive real-Pi restart gate.
 *
 * No RunExecutor is injected here. startWorkerMain builds the production Pi
 * runtime, enterprise extensions, model HTTP client, and Sandbox transports.
 */

import { startWorkerMain } from '../../src/bootstrap/worker-main.js';

const expectedRunIds = new Set(
  String(process.env.TEST_RUN_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const workerLabel = String(process.env.TEST_WORKER_LABEL || '').trim();

function emit(message) {
  process.stdout.write(
    `${JSON.stringify({ ...message, pid: process.pid, workerLabel })}\n`,
  );
}

if (
  process.env.TEST_EXPECT_REAL_PI !== '1' ||
  !workerLabel ||
  expectedRunIds.size === 0
) {
  emit({ type: 'fatal', message: 'invalid real-Pi Worker fixture configuration' });
  process.exit(2);
}

try {
  const started = await startWorkerMain(process.env);
  const worker = started.workerHandle.worker;

  worker.on('active', (job, previous) => {
    emit({
      type: 'active',
      jobId: String(job.id),
      previous: String(previous || ''),
      attemptsStarted: Number(job.attemptsStarted || 0),
    });
  });
  worker.on('stalled', (jobId, previous) => {
    emit({
      type: 'stalled',
      jobId: String(jobId),
      previous: String(previous || ''),
    });
  });
  worker.on('completed', (job, result) => {
    emit({
      type: 'completed',
      jobId: String(job.id),
      data: job.data,
      attemptsStarted: Number(job.attemptsStarted || 0),
      stalledCounter: Number(job.stalledCounter || 0),
      result,
    });
  });
  worker.on('failed', (job, error) => {
    emit({
      type: 'failed',
      jobId: job?.id == null ? null : String(job.id),
      message: error instanceof Error ? error.message.slice(0, 256) : 'error',
      stack:
        error instanceof Error && error.stack
          ? error.stack.slice(0, 2048)
          : null,
    });
  });

  await worker.waitUntilReady();
  emit({
    type: 'ready',
    queueName: started.workerHandle.queueName,
    executor: 'production-pi',
  });

  if (process.env.TEST_EMIT_RECOVERY_SCANS === 'true') {
    let scanning = false;
    const timer = setInterval(async () => {
      if (scanning) return;
      scanning = true;
      try {
        const scan = await started.recoveryService.scanAndRequeue({ limit: 100 });
        for (const action of scan.actions) {
          if (expectedRunIds.has(action.runId)) {
            emit({ type: 'recovery-scan', ...action });
          }
        }
      } catch (error) {
        emit({
          type: 'recovery-scan-error',
          message: error instanceof Error ? error.message.slice(0, 256) : 'error',
        });
      } finally {
        scanning = false;
      }
    }, 200);
    timer.unref?.();
  }
} catch (error) {
  emit({
    type: 'fatal',
    message: error instanceof Error ? error.message.slice(0, 512) : 'error',
  });
  process.exit(1);
}
