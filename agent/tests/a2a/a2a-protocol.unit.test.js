/**
 * PR-12: JSON-RPC protocol, event projection, client isolation, audit, stream.
 * Offline fakes only.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  parseJsonRpcRequest,
  jsonRpcSuccess,
  jsonRpcError,
  formatA2aSseRpcFrame,
  A2A_METHODS,
  JSON_RPC_ERROR,
  A2A_RPC_ERROR,
  normalizeA2aMethod,
} from '../../src/application/a2a/json-rpc.js';
import {
  projectEnvelopeToA2aResult,
  buildA2aTaskObject,
  collectArtifactsFromEnvelopes,
} from '../../src/application/a2a/event-projector.js';
import {
  A2aTaskService,
  A2aTaskError,
  extractTextFromA2aMessage,
} from '../../src/application/a2a/task-service.js';
import { A2aStreamService } from '../../src/application/a2a/stream-service.js';
import { createA2aHttpHandler } from '../../src/presentation/a2a/http-handler.js';
import {
  createAgentHttpServer,
  resolveRequestTraceContext,
} from '../../src/bootstrap/create-http-server.js';
import { projectRunStatusToA2a } from '../../src/domain/a2a/status.js';
import { OwnerScopedNotFoundError } from '../../src/application/errors.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const AGENT = '01K0G2PAV8FPMVC9QHJG7JPN4A';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const TASK = '01K0G2PAV8FPMVC9QHJG7JPN5E';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const CRED = '01K0G2PAV8FPMVC9QHJG7JPN5C';
const TRACE = 'a'.repeat(32);
const EVT1 = '01K0G2PAV8FPMVC9QHJG7JPN58';
const EVT2 = '01K0G2PAV8FPMVC9QHJG7JPN59';
const ART = '01K0G2PAV8FPMVC9QHJG7JPN5F';

describe('JSON-RPC parse + method aliases', () => {
  it('accepts plan PascalCase and slash aliases', () => {
    assert.equal(normalizeA2aMethod('SendMessage'), A2A_METHODS.SEND_MESSAGE);
    assert.equal(normalizeA2aMethod('message/send'), A2A_METHODS.SEND_MESSAGE);
    assert.equal(normalizeA2aMethod('message/stream'), A2A_METHODS.SEND_STREAMING_MESSAGE);
    assert.equal(normalizeA2aMethod('tasks/get'), A2A_METHODS.GET_TASK);
    assert.equal(normalizeA2aMethod('tasks/resubscribe'), A2A_METHODS.SUBSCRIBE_TO_TASK);
    assert.equal(normalizeA2aMethod('unknown/method'), null);
  });

  it('rejects invalid JSON-RPC envelopes with correct codes', () => {
    const badVersion = parseJsonRpcRequest({ jsonrpc: '1.0', method: 'GetTask', id: 1 });
    assert.equal(badVersion.ok, false);
    assert.equal(badVersion.error.code, JSON_RPC_ERROR.INVALID_REQUEST.code);

    const badMethod = parseJsonRpcRequest({
      jsonrpc: '2.0',
      method: 'nope',
      id: 2,
    });
    assert.equal(badMethod.ok, false);
    assert.equal(badMethod.error.code, JSON_RPC_ERROR.METHOD_NOT_FOUND.code);

    const badParams = parseJsonRpcRequest({
      jsonrpc: '2.0',
      method: 'GetTask',
      params: [],
      id: 3,
    });
    assert.equal(badParams.ok, false);
    assert.equal(badParams.error.code, JSON_RPC_ERROR.INVALID_PARAMS.code);

    const ok = parseJsonRpcRequest({
      jsonrpc: '2.0',
      method: 'tasks/get',
      params: { id: TASK },
      id: 'x',
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.method, A2A_METHODS.GET_TASK);
  });

  it('formats SSE JSON-RPC frames without leaking stacks', () => {
    const frame = formatA2aSseRpcFrame(
      jsonRpcSuccess(1, { kind: 'status-update', taskId: TASK }),
      { id: '5', event: 'status-update' },
    );
    assert.match(frame, /^id: 5\n/);
    assert.match(frame, /event: status-update\n/);
    assert.match(frame, /"jsonrpc":"2.0"/);
    assert.match(frame, /\n\n$/);
    const errFrame = formatA2aSseRpcFrame(
      jsonRpcError(1, { ...JSON_RPC_ERROR.INTERNAL }),
    );
    assert.doesNotMatch(errFrame, /stack/i);
  });
});

describe('A2A event projector (artifact + status)', () => {
  const ctx = { a2aTaskId: TASK, contextId: CONV, runStatus: 'RUNNING' };

  it('projects run.* to TaskStatusUpdateEvent from Run status only', () => {
    const out = projectEnvelopeToA2aResult(
      {
        sequence: 2,
        eventId: EVT1,
        event: { type: 'run.started', status: 'RUNNING' },
        ts: Date.now(),
      },
      ctx,
    );
    assert.equal(out.kind, 'status-update');
    assert.equal(out.result.status.state, 'working');
    assert.equal(out.result.final, false);
    assert.equal(out.result.taskId, TASK);
  });

  it('projects only explicit artifact.ready with durable ULID (not workspace noise)', () => {
    const good = projectEnvelopeToA2aResult(
      {
        sequence: 3,
        eventId: EVT2,
        event: {
          type: 'artifact.ready',
          artifactId: ART,
          name: 'report.pdf',
          path: '/artifacts/report.pdf',
          mimeType: 'application/pdf',
        },
      },
      ctx,
    );
    assert.equal(good.kind, 'artifact-update');
    assert.equal(good.result.artifact.artifactId, ART);
    assert.ok(good.result.artifact.parts.some((p) => p.kind === 'file'));
    assert.doesNotMatch(JSON.stringify(good.result.artifact), /\/artifacts\//);

    const noise = projectEnvelopeToA2aResult(
      {
        sequence: 4,
        event: { type: 'tool.execution.completed', toolName: 'bash' },
      },
      ctx,
    );
    assert.equal(noise, null);

    const pathOnly = projectEnvelopeToA2aResult(
      {
        sequence: 5,
        event: {
          type: 'artifact.ready',
          path: '/home/sandbox/workspace/x',
          name: 'x',
        },
      },
      ctx,
    );
    assert.equal(pathOnly, null);

    const emptyArtifact = projectEnvelopeToA2aResult(
      {
        sequence: 5,
        event: { type: 'artifact.ready' },
      },
      ctx,
    );
    assert.equal(emptyArtifact, null);
  });

  it('replays artifact.ready metadata from canonical durable envelope data', () => {
    const projected = projectEnvelopeToA2aResult(
      {
        sequence: 6,
        eventId: EVT2,
        event: {
          type: 'artifact.ready',
          context: { runId: RUN },
          data: {
            artifactId: ART,
            name: '风险分析报告.pdf',
            description: '最终分析报告',
            mimeType: 'application/pdf',
            size: 1234,
            sha256: 'a'.repeat(64),
          },
        },
      },
      ctx,
    );

    assert.equal(projected.kind, 'artifact-update');
    assert.equal(projected.result.artifact.artifactId, ART);
    assert.equal(projected.result.artifact.name, '风险分析报告.pdf');
    assert.equal(projected.result.artifact.description, '最终分析报告');
    assert.equal(projected.result.artifact.metadata.mimeType, 'application/pdf');
    assert.equal(projected.result.artifact.metadata.sizeBytes, 1234);
  });

  it('buildA2aTaskObject never invents status independent of run', () => {
    const task = buildA2aTaskObject({
      a2aTaskId: TASK,
      runStatus: 'SUCCEEDED',
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    assert.equal(task.status.state, 'completed');
    assert.equal(task.id, TASK);
    assert.equal(projectRunStatusToA2a('SUCCEEDED'), task.status.state);
  });

  it('collectArtifactsFromEnvelopes dedupes explicit artifacts', () => {
    const arts = collectArtifactsFromEnvelopes(
      [
        {
          sequence: 1,
          event: {
            type: 'artifact.ready',
            artifactId: ART,
            name: 'a.pdf',
          },
        },
        {
          sequence: 2,
          event: {
            type: 'artifact.ready',
            artifactId: ART,
            name: 'a.pdf',
          },
        },
      ],
      ctx,
    );
    assert.equal(arts.length, 1);
  });
});

describe('extractTextFromA2aMessage', () => {
  it('requires text parts and rejects empty', () => {
    assert.equal(
      extractTextFromA2aMessage({
        role: 'user',
        parts: [{ kind: 'text', text: 'hello' }],
      }),
      'hello',
    );
    assert.throws(
      () => extractTextFromA2aMessage({ parts: [{ kind: 'file' }] }),
      /text part/,
    );
  });
});

describe('A2aTaskService client isolation + audit', () => {
  function makeWorld() {
    /** @type {Map<string, object>} */
    const tasks = new Map();
    /** @type {Map<string, object>} */
    const runs = new Map();
    /** @type {object[]} */
    const audits = [];
    let idSeq = 0;
    const gen = () => {
      const suffixes = 'EFGHIJKLMNOPQRSTUVWXYZ';
      const s = suffixes[idSeq % suffixes.length];
      idSeq += 1;
      return `01K0G2PAV8FPMVC9QHJG7JPN5${s}`;
    };

    const principalA = {
      orgId: ORG,
      agentId: AGENT,
      serviceUserId: USER,
      clientId: 'client-a',
      credentialId: CRED,
      scopes: ['agent.invoke', 'agent.read', 'agent.cancel', 'artifact.read'],
    };
    const principalB = {
      ...principalA,
      clientId: 'client-b',
      credentialId: '01K0G2PAV8FPMVC9QHJG7JPN5G',
    };

    const createRepositories = () => ({
      a2aTasks: {
        async insert(input) {
          const row = { ...input, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
          tasks.set(input.a2aTaskId, row);
          return row;
        },
        async getById(id, scope) {
          const row = tasks.get(id);
          if (!row) return null;
          if (row.orgId !== scope.orgId || row.clientId !== scope.clientId) return null;
          return row;
        },
        async getByRunId(runId, scope) {
          for (const row of tasks.values()) {
            if (
              row.runId === runId &&
              row.orgId === scope.orgId &&
              row.clientId === scope.clientId
            ) {
              return row;
            }
          }
          return null;
        },
      },
      a2aAudit: {
        async append(input) {
          audits.push(input);
          return input;
        },
      },
      // no externalRefs → ensureBindings no-ops; no artifacts repo → event scan
    });

    const createRunService = {
      async execute(input) {
        const runId = RUN;
        runs.set(runId, {
          runId,
          status: 'ACCEPTED',
          conversationId: CONV,
          orgId: ORG,
          userId: USER,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          clientKey: input.auth.externalUserId,
        });
        return {
          runId,
          status: 'ACCEPTED',
          conversationId: CONV,
          eventsUrl: `/api/runs/${runId}/events`,
        };
      },
    };
    const getRunService = {
      async execute({ runId }) {
        const r = runs.get(runId);
        if (!r) {
          throw new OwnerScopedNotFoundError('Run not found');
        }
        return r;
      },
    };
    const cancelRunService = {
      async execute({ runId }) {
        const r = runs.get(runId);
        r.status = 'CANCELLING';
        r.cancelRequested = true;
        return r;
      },
    };

    const svc = new A2aTaskService({
      createRunService,
      getRunService,
      cancelRunService,
      createRepositories,
      generateId: gen,
      defaultProvider: 'a2a',
    });

    return { svc, principalA, principalB, tasks, runs, audits, createRepositories };
  }

  it('SendMessage creates task; other client cannot GetTask', async () => {
    const { svc, principalA, principalB, audits } = makeWorld();
    const task = await svc.sendMessage({
      principal: principalA,
      agentId: AGENT,
      params: {
        message: {
          messageId: 'idem-1',
          role: 'user',
          parts: [{ kind: 'text', text: 'analyze' }],
        },
      },
      traceId: TRACE,
      idempotencyKey: 'idem-1',
    });
    assert.equal(task.status.state, 'submitted');
    assert.ok(task.id);
    assert.ok(audits.some((a) => a.eventType === 'a2a.send_message'));

    await assert.rejects(
      () =>
        svc.getTask({
          principal: principalB,
          agentId: AGENT,
          taskId: task.id,
        }),
      (e) => e instanceof A2aTaskError && e.code === 'TASK_NOT_FOUND',
    );

    const own = await svc.getTask({
      principal: principalA,
      agentId: AGENT,
      taskId: task.id,
    });
    assert.equal(own.id, task.id);
  });

  it('CancelTask audits and does not invent terminal canceled without run', async () => {
    const { svc, principalA, runs, audits } = makeWorld();
    const task = await svc.sendMessage({
      principal: principalA,
      agentId: AGENT,
      params: {
        message: {
          messageId: 'cancel-msg-1',
          parts: [{ kind: 'text', text: 'x' }],
        },
      },
      traceId: TRACE,
      idempotencyKey: 'cancel-msg-1',
    });
    const canceled = await svc.cancelTask({
      principal: principalA,
      agentId: AGENT,
      taskId: task.id,
    });
    assert.equal(runs.get(RUN).status, 'CANCELLING');
    // Projected from Run CANCELLING → working (not fake canceled).
    assert.equal(canceled.status.state, 'working');
    assert.ok(audits.some((a) => a.eventType === 'a2a.cancel_task'));
  });

  it('Artifact byte delivery records the caller, Run, Artifact, and trace', async () => {
    const { svc, principalA, audits } = makeWorld();
    await svc.auditArtifactDownload({
      principal: principalA,
      agentId: AGENT,
      taskId: TASK,
      runId: RUN,
      artifactId: ART,
      traceId: TRACE,
    });
    const audit = audits.at(-1);
    assert.equal(audit.eventType, 'a2a.artifact_download');
    assert.equal(audit.clientId, principalA.clientId);
    assert.equal(audit.a2aTaskId, TASK);
    assert.equal(audit.runId, RUN);
    assert.equal(audit.traceId, TRACE);
    assert.deepEqual(audit.payloadJson, {
      outcome: 'authorized',
      artifactId: ART,
    });
  });
});

describe('A2aStreamService reconnect + dedupe + disconnect cleanup', () => {
  it('replays history without duplicates and honors afterSequence', async () => {
    const events = [
      {
        sequence: 1,
        eventId: EVT1,
        event: { type: 'run.accepted', status: 'ACCEPTED', eventId: EVT1 },
        ts: 1,
      },
      {
        sequence: 2,
        eventId: EVT2,
        event: { type: 'run.started', status: 'RUNNING', eventId: EVT2 },
        ts: 2,
      },
      {
        sequence: 3,
        eventId: ART,
        event: {
          type: 'artifact.ready',
          artifactId: ART,
          name: 'out.csv',
          eventId: ART,
        },
        ts: 3,
      },
      {
        sequence: 4,
        eventId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
        event: {
          type: 'run.succeeded',
          status: 'SUCCEEDED',
          eventId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
        },
        ts: 4,
      },
    ];

    const taskService = {
      async resolveOwnedTask() {
        return {
          a2aTaskId: TASK,
          runId: RUN,
          contextId: CONV,
          clientId: 'client-a',
          orgId: ORG,
          agentId: AGENT,
          traceId: TRACE,
        };
      },
      runAuthForPrincipal() {
        return { provider: 'a2a', externalOrgId: ORG, externalUserId: 'client-a' };
      },
      async getTask() {
        return buildA2aTaskObject({
          a2aTaskId: TASK,
          runStatus: 'RUNNING',
          contextId: CONV,
        });
      },
    };

    let listCalls = 0;
    const eventQueryService = {
      async listEvents({ afterSequence }) {
        listCalls += 1;
        const page = events.filter((e) => e.sequence > afterSequence);
        const terminal = page.some(
          (e) => e.event.status === 'SUCCEEDED',
        ) || afterSequence >= 4;
        return {
          events: page,
          status: terminal ? 'SUCCEEDED' : 'RUNNING',
          terminal: terminal && page.length === 0 ? true : page.some((e) => e.event.status === 'SUCCEEDED') && page[page.length - 1].sequence >= 4,
        };
      },
    };

    // Fix terminal detection: after emitting seq 4, next list returns empty+terminal
    eventQueryService.listEvents = async ({ afterSequence }) => {
      listCalls += 1;
      const page = events.filter((e) => e.sequence > afterSequence);
      if (page.length === 0) {
        return { events: [], status: 'SUCCEEDED', terminal: afterSequence >= 4 };
      }
      return {
        events: page,
        status: page[page.length - 1].event.status || 'RUNNING',
        terminal: false,
      };
    };

    const stream = new A2aStreamService({
      taskService,
      eventQueryService,
      getRunService: {
        async execute() {
          return { runId: RUN, status: 'SUCCEEDED' };
        },
      },
      pollMs: 5,
      heartbeatMs: 60_000,
      mysqlCatchupMs: 1,
      sleep: async () => {},
    });

    /** @type {string[]} */
    const frames = [];
    const result = await stream.openTaskStream(
      {
        principal: { clientId: 'client-a', orgId: ORG, agentId: AGENT },
        agentId: AGENT,
        taskId: TASK,
        rpcId: 1,
        afterSequence: 0,
        includeInitialTask: true,
      },
      {
        write: (chunk) => {
          frames.push(chunk);
          return true;
        },
        isClosed: () => false,
      },
    );

    assert.ok(result.lastSequence >= 4);
    // Parse data lines with status-update / artifact-update
    const dataLines = frames
      .join('')
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)));
    const statusUpdates = dataLines.filter(
      (d) => d.result?.kind === 'status-update' || d.result?.status?.state,
    );
    const artifactUpdates = dataLines.filter(
      (d) => d.result?.kind === 'artifact-update',
    );
    assert.ok(artifactUpdates.length >= 1);
    // Initial task + status updates present
    assert.ok(dataLines.length >= 2);

    // Reconnect after sequence 2 — should not re-emit 1..2
    const frames2 = [];
    await stream.openTaskStream(
      {
        principal: { clientId: 'client-a', orgId: ORG, agentId: AGENT },
        agentId: AGENT,
        taskId: TASK,
        rpcId: 2,
        afterSequence: 2,
        includeInitialTask: false,
      },
      {
        write: (chunk) => {
          frames2.push(chunk);
          return true;
        },
        isClosed: () => false,
      },
    );
    const data2 = frames2
      .join('')
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)));
    for (const d of data2) {
      const seq = d.result?.metadata?.sequence;
      if (seq != null) assert.ok(seq > 2, `seq ${seq} should be > 2`);
    }
    assert.ok(listCalls >= 2);
    assert.ok(statusUpdates.length >= 1);
  });

  it('replays terminal history when reconnecting with an initial snapshot', async () => {
    const terminalEvents = [
      {
        sequence: 1,
        eventId: EVT1,
        event: { type: 'run.accepted', status: 'ACCEPTED', eventId: EVT1 },
      },
      {
        sequence: 2,
        eventId: EVT2,
        event: { type: 'run.started', status: 'RUNNING', eventId: EVT2 },
      },
      {
        sequence: 3,
        eventId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
        event: { type: 'run.succeeded', status: 'SUCCEEDED' },
      },
    ];
    const frames = [];
    const stream = new A2aStreamService({
      taskService: {
        async resolveOwnedTask() {
          return { a2aTaskId: TASK, runId: RUN, contextId: CONV };
        },
        runAuthForPrincipal: () => ({}),
        async getTask() {
          return buildA2aTaskObject({
            a2aTaskId: TASK,
            runStatus: 'SUCCEEDED',
            contextId: CONV,
          });
        },
      },
      eventQueryService: {
        async listEvents({ afterSequence }) {
          const events = terminalEvents.filter((e) => e.sequence > afterSequence);
          return {
            events,
            status: 'SUCCEEDED',
            terminal: events.length === 0,
          };
        },
      },
      getRunService: { async execute() { return { status: 'SUCCEEDED' }; } },
      sleep: async () => {},
    });

    await stream.openTaskStream(
      {
        principal: {},
        agentId: AGENT,
        taskId: TASK,
        rpcId: 9,
        afterSequence: 2,
        includeInitialTask: true,
      },
      {
        write: (chunk) => {
          frames.push(chunk);
          return true;
        },
        isClosed: () => false,
      },
    );

    const data = frames
      .join('')
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
    const sequences = data
      .map((entry) => entry.result?.metadata?.sequence)
      .filter((sequence) => sequence != null);
    assert.deepEqual(sequences, [3]);
  });

  it('disconnect aborts without requiring cancel', async () => {
    let cancelled = false;
    const ac = new AbortController();
    const stream = new A2aStreamService({
      taskService: {
        async resolveOwnedTask() {
          return {
            a2aTaskId: TASK,
            runId: RUN,
            contextId: CONV,
          };
        },
        runAuthForPrincipal: () => ({}),
        async getTask() {
          return buildA2aTaskObject({
            a2aTaskId: TASK,
            runStatus: 'RUNNING',
          });
        },
      },
      eventQueryService: {
        async listEvents() {
          return { events: [], status: 'RUNNING', terminal: false };
        },
      },
      getRunService: { async execute() { return { status: 'RUNNING' }; } },
      pollMs: 20,
      heartbeatMs: 60_000,
      sleep: (ms, signal) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(resolve, ms);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    });

    setTimeout(() => ac.abort(), 30);
    const result = await stream.openTaskStream(
      {
        principal: {},
        agentId: AGENT,
        taskId: TASK,
        rpcId: 1,
        includeInitialTask: true,
      },
      {
        write: () => true,
        isClosed: () => ac.signal.aborted,
        signal: ac.signal,
      },
    );
    assert.equal(cancelled, false);
    assert.ok(result);
  });
});

describe('A2A HTTP Agent Card + JSON-RPC isolation', () => {
  it('serves agent card and enforces auth + client isolation on GetTask', async () => {
    const principalA = {
      orgId: ORG,
      agentId: AGENT,
      serviceUserId: USER,
      clientId: 'client-a',
      credentialId: CRED,
      scopes: ['agent.invoke', 'agent.read', 'agent.cancel', 'artifact.read'],
      callerType: 'a2a',
      callerId: 'client-a',
    };

    /** @type {Map<string, object>} */
    const taskByClient = new Map();
    let sentMessageInput = null;
    taskByClient.set(`client-a:${TASK}`, {
      id: TASK,
      status: { state: 'working' },
      kind: 'task',
    });

    const a2aHandler = createA2aHttpHandler({
      credentialService: {
        async authenticate(header, opts) {
          if (!header || !String(header).includes('good-token')) {
            const { A2aAuthError } = await import(
              '../../src/application/a2a/credential-service.js'
            );
            throw new A2aAuthError('bad', { code: 'A2A_AUTH_INVALID' });
          }
          if (opts?.agentId && opts.agentId !== AGENT) {
            const { A2aAuthError } = await import(
              '../../src/application/a2a/credential-service.js'
            );
            throw new A2aAuthError('mismatch', { code: 'A2A_AUTH_AGENT_MISMATCH' });
          }
          return principalA;
        },
      },
      taskService: {
        async sendMessage(input) {
          sentMessageInput = input;
          return buildA2aTaskObject({ a2aTaskId: TASK, runStatus: 'ACCEPTED' });
        },
        async getTask({ principal, taskId }) {
          const row = taskByClient.get(`${principal.clientId}:${taskId}`);
          if (!row) {
            throw new A2aTaskError('Task not found', {
              code: 'TASK_NOT_FOUND',
              rpc: A2A_RPC_ERROR.TASK_NOT_FOUND,
            });
          }
          return row;
        },
        async cancelTask() {
          return buildA2aTaskObject({ a2aTaskId: TASK, runStatus: 'CANCELLING' });
        },
      },
      streamService: {
        async openTaskStream(_input, sinks) {
          sinks.write(
            formatA2aSseRpcFrame(
              jsonRpcSuccess(1, buildA2aTaskObject({ a2aTaskId: TASK, runStatus: 'RUNNING' })),
              { omitId: true },
            ),
          );
        },
      },
      publicBaseUrl: 'https://agent.example.com',
      deploymentEnv: 'production',
      resolveAgentMeta: async (id) =>
        id === AGENT ? { name: 'Test Agent', description: 'd' } : null,
      resolveTraceId: () => TRACE,
      resolveTraceContext: resolveRequestTraceContext,
      readBody: async (req) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        return Buffer.concat(chunks).toString('utf8');
      },
      json: (res, status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      },
    });

    const server = createAgentHttpServer({
      createRunService: { async execute() { throw new Error('no'); } },
      getRunService: { async execute() { throw new Error('no'); } },
      cancelRunService: { async execute() { throw new Error('no'); } },
      eventQueryService: { async listEvents() { return { events: [] }; } },
      a2aHandler,
    });

    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    try {
      const cardRes = await fetch(
        `http://127.0.0.1:${port}/a2a/agents/${AGENT}/.well-known/agent-card.json`,
      );
      assert.equal(cardRes.status, 200);
      const card = await cardRes.json();
      assert.equal(card.capabilities.streaming, true);
      assert.match(card.url, new RegExp(AGENT));

      const unauth = await fetch(`http://127.0.0.1:${port}/a2a/agents/${AGENT}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'GetTask',
          params: { id: TASK },
        }),
      });
      assert.equal(unauth.status, 401);

      const ok = await fetch(`http://127.0.0.1:${port}/a2a/agents/${AGENT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer good-token',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tasks/get',
          params: { id: TASK },
        }),
      });
      assert.equal(ok.status, 200);
      const okBody = await ok.json();
      assert.equal(okBody.result.id, TASK);

      const sent = await fetch(`http://127.0.0.1:${port}/a2a/agents/${AGENT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer good-token',
          'Idempotency-Key': 'a2a-http-trace-1',
          traceparent: `00-${TRACE}-${'c'.repeat(16)}-01`,
          tracestate: 'vendor=value',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'SendMessage',
          params: {
            message: {
              messageId: 'a2a-http-trace-1',
              parts: [{ kind: 'text', text: 'trace me' }],
            },
          },
        }),
      });
      assert.equal(sent.status, 200);
      assert.equal(sent.headers.get('x-trace-id'), TRACE);
      assert.equal(sentMessageInput.traceId, TRACE);
      assert.equal(sentMessageInput.spanId, 'c'.repeat(16));
      assert.equal(sentMessageInput.traceState, 'vendor=value');

      // Invalid params
      const badParams = await fetch(`http://127.0.0.1:${port}/a2a/agents/${AGENT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer good-token',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'GetTask',
          params: {},
        }),
      });
      const badBody = await badParams.json();
      assert.equal(badBody.error.code, JSON_RPC_ERROR.INVALID_PARAMS.code);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
