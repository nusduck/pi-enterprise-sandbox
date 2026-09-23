#!/usr/bin/env node

/**
 * Real Agent Worker child-process fixture for the destructive restart gate.
 *
 * The production composition root is retained. Only the model/tool executor is
 * injected so the gate can create one durable, observable side effect and then
 * stay in-flight until the operating system kills the process.
 */

import { createMysqlKnex } from '../../src/infrastructure/mysql/client.js';
import { createServiceContainer } from '../../src/bootstrap/container.js';
import { startWorkerMain } from '../../src/bootstrap/worker-main.js';

// 夹具自己直连数据库写副作用表，用测试给的带口令连接串；被测的 Worker 本身
// 走 AGENT_DATABASE_URL（无口令）+ DBPM 取密，与生产一致。
const databaseUrl = String(
  process.env.TEST_FIXTURE_DATABASE_URL || process.env.AGENT_DATABASE_URL || '',
).trim();
const workerLabel = String(process.env.TEST_WORKER_LABEL || '').trim();
const sideEffectTable = String(
  process.env.TEST_SIDE_EFFECT_TABLE || '',
).trim();
const expectedRunId = String(process.env.TEST_RUN_ID || '').trim();
const toolCallId = String(
  process.env.TEST_TOOL_CALL_ID || 'release-gate-model-tool-call',
).trim();
const toolExecutionStatus = String(
  process.env.TEST_TOOL_STATUS || '',
).trim();
const executorMode = String(
  process.env.TEST_EXECUTOR_MODE || 'hang-after-side-effect',
).trim();
// 副作用表放在兄弟库：被测 Worker 启动时按发布清单核对自己的库，多一张表就会拒启（ADR 0011 D6）。
const sideEffectSchema = String(
  process.env.TEST_SIDE_EFFECT_SCHEMA || '',
).trim();

function emit(message) {
  process.stdout.write(
    `${JSON.stringify({ ...message, pid: process.pid, workerLabel })}\n`,
  );
}

if (
  !databaseUrl ||
  !workerLabel ||
  !expectedRunId ||
  !/^release_gate_[a-z0-9_]+$/.test(sideEffectTable) ||
  !/^pi_gate_[a-z0-9_]+$/.test(sideEffectSchema)
) {
  emit({ type: 'fatal', message: 'invalid Agent Worker fixture configuration' });
  process.exit(2);
}

const sideEffectDb = createMysqlKnex(databaseUrl, {
  pool: { min: 0, max: 2 },
});

const runExecutorFactory = ({ runId }) => ({
  async execute(ctx) {
    if (runId !== expectedRunId || String(ctx?.run?.runId || '') !== expectedRunId) {
      throw new Error('fixture executor received an unexpected run');
    }

    if (executorMode === 'hang-before-side-effect') {
      emit({ type: 'executor-entered', runId });
      await new Promise(() => {});
    }

    if (toolExecutionStatus) {
      await sideEffectDb('tbl_agsvc_tool_executions').insert({
        tool_execution_id: `01K0G2PAV8FPMVC9QHJ7JPN${runId.slice(-1)}`,
        run_id: runId,
        agent_session_id: ctx.run.agentSessionId,
        tool_call_id: toolCallId,
        tool_name: 'release_gate_side_effect',
        tool_source: 'internal',
        risk_level: 'low',
        arguments_json: JSON.stringify({}),
        result_json: null,
        status: toolExecutionStatus,
        error_code: null,
        trace_id: String(ctx.run.traceId),
        started_at: sideEffectDb.fn.now(3),
        completed_at: null,
        created_at: sideEffectDb.fn.now(3),
      });
    }

    await sideEffectDb.withSchema(sideEffectSchema).table(sideEffectTable)
      .insert({
        tool_call_id: toolCallId,
        run_id: runId,
        invocation_count: 1,
        first_worker: workerLabel,
        last_worker: workerLabel,
        created_at: sideEffectDb.fn.now(3),
        updated_at: sideEffectDb.fn.now(3),
      })
      .onConflict('tool_call_id')
      .merge({
        invocation_count: sideEffectDb.raw('invocation_count + 1'),
        last_worker: workerLabel,
        updated_at: sideEffectDb.fn.now(3),
      });

    const row = await sideEffectDb.withSchema(sideEffectSchema).table(sideEffectTable)
      .where({ tool_call_id: toolCallId })
      .first();
    emit({
      type: 'executor-side-effect',
      runId,
      toolCallId,
      invocationCount: Number(row?.invocation_count || 0),
    });

    if (executorMode === 'hang-after-side-effect') {
      // The process must be SIGKILLed while model/tool execution is in-flight.
      await new Promise(() => {});
    }
    return { outcome: 'SUCCEEDED' };
  },
  async dispose() {},
});

try {
  const started = await startWorkerMain(process.env, {
    createContainer: (env) =>
      createServiceContainer(env, { runExecutorFactory }),
  });

  // ADR 0012 之后每个子任务深度一层消费者；事件带上队列名，gate 才能断言
  // 子 Run 是在它自己那一层被接管和重放的，而不是被根队列捡走。
  for (const handle of started.workerHandles) {
    const queueName = handle.queueName;
    handle.worker.on('active', (job) => {
      emit({
        type: 'active',
        queueName,
        jobId: String(job.id),
        attemptsStarted: Number(job.attemptsStarted || 0),
      });
    });
    handle.worker.on('stalled', (jobId, previous) => {
      emit({
        type: 'stalled',
        queueName,
        jobId: String(jobId),
        previous: String(previous),
      });
    });
    handle.worker.on('completed', (job, result) => {
      emit({
        type: 'completed',
        queueName,
        jobId: String(job.id),
        data: job.data,
        attemptsStarted: Number(job.attemptsStarted || 0),
        stalledCounter: Number(job.stalledCounter || 0),
        result,
      });
    });
    handle.worker.on('failed', (job, error) => {
      emit({
        type: 'failed',
        queueName,
        jobId: job?.id == null ? null : String(job.id),
        message: error instanceof Error ? error.message.slice(0, 256) : 'error',
      });
    });
  }

  await Promise.all(
    started.workerHandles.map((handle) => handle.worker.waitUntilReady()),
  );
  emit({
    type: 'ready',
    queueName: started.workerHandle.queueName,
    queueNames: started.workerHandles.map((handle) => handle.queueName),
  });

  if (process.env.TEST_EMIT_RECOVERY_SCANS === 'true') {
    let scanning = false;
    const timer = setInterval(async () => {
      if (scanning) return;
      scanning = true;
      try {
        const scan = await started.recoveryService.scanAndRequeue({ limit: 10 });
        const action = scan.actions.find(
          (candidate) => candidate.runId === expectedRunId,
        );
        if (action) emit({ type: 'recovery-scan', ...action });
      } catch (error) {
        emit({
          type: 'recovery-scan-error',
          message: error instanceof Error ? error.message.slice(0, 256) : 'error',
        });
      } finally {
        scanning = false;
      }
    }, 500);
    timer.unref?.();
  }
} catch (error) {
  emit({
    type: 'fatal',
    message: error instanceof Error ? error.message.slice(0, 512) : 'error',
  });
  await sideEffectDb.destroy().catch(() => {});
  process.exit(1);
}
