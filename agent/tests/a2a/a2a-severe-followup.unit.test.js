/**
 * PR-12 severe follow-up: gap/dedupe, idempotency, host injection, expiry/rotation,
 * audit fail-closed, artifact isolation/download token.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import {
  A2aStreamService,
  formatA2aSseHeartbeatComment,
} from '../../src/application/a2a/stream-service.js';
import {
  A2aTaskService,
  A2aTaskError,
  A2aAuditError,
  requireStableIdempotencyKey,
} from '../../src/application/a2a/task-service.js';
import {
  A2aCredentialService,
  A2aAuthError,
  normalizeFutureExpiresAt,
  evaluateStoredExpiry,
} from '../../src/application/a2a/credential-service.js';
import { ValidationError } from '../../src/application/errors.js';
import {
  A2A_CREDENTIAL_STATUS,
  hashA2aToken,
} from '../../src/infrastructure/mysql/repositories/a2a-credential-repository.js';
import {
  projectEnvelopeToA2aResult,
  buildA2aTaskObject,
} from '../../src/application/a2a/event-projector.js';
import {
  mintArtifactDownloadToken,
  verifyArtifactDownloadToken,
  buildArtifactDownloadUri,
} from '../../src/application/a2a/artifact-download.js';
import {
  assertPublicBaseUrl,
  resolvePublicBaseUrl,
} from '../../src/application/a2a/agent-card.js';
import { deterministicA2aTaskId } from '../../src/application/a2a/deterministic-task-id.js';
import {
  formatA2aSseRpcFrame,
  jsonRpcSuccess,
  JSON_RPC_ERROR,
} from '../../src/application/a2a/json-rpc.js';
import { createA2aHttpHandler } from '../../src/presentation/a2a/http-handler.js';
import { createAgentHttpServer } from '../../src/bootstrap/create-http-server.js';
import { createA2aArtifactByteStreamer } from '../../src/bootstrap/http-main.js';
import { isUlid } from '../../src/domain/shared/ulid.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const AGENT = '01K0G2PAV8FPMVC9QHJG7JPN4A';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const TASK = '01K0G2PAV8FPMVC9QHJG7JPN5E';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const CRED = '01K0G2PAV8FPMVC9QHJG7JPN5C';
const ART = '01K0G2PAV8FPMVC9QHJG7JPN5F';
const SESSION = '01K0G2PAV8FPMVC9QHJG7JPN5G';
const SANDBOX_SESSION = '01K0G2PAV8FPMVC9QHJG7JPN5H';
const TRACE = 'a'.repeat(32);
const SECRET = 'x'.repeat(40);

describe('stable idempotency (no random keys)', () => {
  it('requires messageId or Idempotency-Key', () => {
    assert.throws(
      () => requireStableIdempotencyKey({}),
      (e) => e instanceof ValidationError,
    );
    assert.equal(
      requireStableIdempotencyKey({ messageId: 'm-1' }),
      'm-1',
    );
    assert.equal(
      requireStableIdempotencyKey({ idempotencyKey: 'ik-1' }),
      'ik-1',
    );
  });
});

describe('deterministic task id + orphan compensate', () => {
  it('same run → same task id (ULID alphabet)', () => {
    const a = deterministicA2aTaskId(ORG, 'client-a', RUN);
    const b = deterministicA2aTaskId(ORG, 'client-a', RUN);
    assert.equal(a, b);
    assert.equal(isUlid(a), true);
    assert.notEqual(
      deterministicA2aTaskId(ORG, 'client-b', RUN),
      a,
    );
  });

  it('mapping insert failure cancels run; retry does not create second Run', async () => {
    let createCalls = 0;
    let cancelCalls = 0;
    const runsCreated = [];
    /** @type {object[]} */
    const audits = [];
    let insertFailOnce = true;

    const principal = {
      orgId: ORG,
      agentId: AGENT,
      serviceUserId: USER,
      clientId: 'client-a',
      credentialId: CRED,
      scopes: ['agent.invoke', 'agent.read', 'agent.cancel', 'artifact.read'],
    };

    /** @type {Map<string, object>} */
    const tasks = new Map();
    /** @type {Map<string, object>} */
    const runs = new Map();

    const svc = new A2aTaskService({
      createRunService: {
        async execute(input) {
          createCalls += 1;
          // Idempotent: always same run for same key
          const runId = RUN;
          if (!runs.has(runId)) {
            runs.set(runId, {
              runId,
              status: 'ACCEPTED',
              conversationId: CONV,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
            runsCreated.push(runId);
          }
          return {
            runId,
            status: 'ACCEPTED',
            conversationId: CONV,
            replayed: createCalls > 1,
          };
        },
      },
      getRunService: {
        async execute({ runId }) {
          return runs.get(runId);
        },
      },
      cancelRunService: {
        async execute({ runId }) {
          cancelCalls += 1;
          const r = runs.get(runId);
          if (r) r.status = 'CANCELLING';
          return r;
        },
      },
      createRepositories: () => ({
        a2aTasks: {
          async insert(row) {
            if (insertFailOnce) {
              insertFailOnce = false;
              const err = new Error('dup');
              err.code = 'ER_DUP_ENTRY';
              throw err;
            }
            tasks.set(row.a2aTaskId, row);
            return row;
          },
          async getByRunId(runId, scope) {
            for (const t of tasks.values()) {
              if (
                t.runId === runId &&
                t.orgId === scope.orgId &&
                t.clientId === scope.clientId
              ) {
                return { ...t, createdAt: t.createdAt || new Date().toISOString(), updatedAt: t.updatedAt || new Date().toISOString() };
              }
            }
            return null;
          },
          async getById(id, scope) {
            const t = tasks.get(id);
            if (!t || t.orgId !== scope.orgId || t.clientId !== scope.clientId) {
              return null;
            }
            return { ...t, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
          },
        },
        a2aAudit: {
          async append(row) {
            audits.push(row);
            return row;
          },
        },
      }),
      generateId: () => '01K0G2PAV8FPMVC9QHJG7JPN5Z',
      requireAudit: true,
    });

    await assert.rejects(
      () =>
        svc.sendMessage({
          principal,
          agentId: AGENT,
          params: {
            message: {
              messageId: 'stable-msg-1',
              parts: [{ kind: 'text', text: 'hi' }],
            },
          },
          traceId: TRACE,
          idempotencyKey: 'stable-msg-1',
        }),
      (e) => e instanceof A2aTaskError && e.code === 'A2A_MAPPING_FAILED',
    );
    assert.equal(cancelCalls, 1);
    assert.equal(createCalls, 1);
    assert.equal(runsCreated.length, 1);

    // Retry: createRun replays same run; mapping succeeds with deterministic id
    const task = await svc.sendMessage({
      principal,
      agentId: AGENT,
      params: {
        message: {
          messageId: 'stable-msg-1',
          parts: [{ kind: 'text', text: 'hi' }],
        },
      },
      traceId: TRACE,
      idempotencyKey: 'stable-msg-1',
    });
    assert.equal(createCalls, 2);
    assert.equal(runsCreated.length, 1); // no second run
    assert.equal(task.id, deterministicA2aTaskId(ORG, 'client-a', RUN));
    assert.ok(audits.some((a) => a.eventType === 'a2a.send_message'));
  });
});

describe('stream contiguous sequence + SSE id + heartbeat', () => {
  it('Redis gap triggers MySQL catch-up before later events; no cursor skip', async () => {
    const mysqlEvents = [
      {
        sequence: 1,
        eventId: '01K0G2PAV8FPMVC9QHJG7JPN58',
        event: { type: 'run.accepted', status: 'ACCEPTED' },
        ts: 1,
      },
      {
        sequence: 2,
        eventId: '01K0G2PAV8FPMVC9QHJG7JPN59',
        event: { type: 'run.started', status: 'RUNNING' },
        ts: 2,
      },
      {
        sequence: 3,
        eventId: '01K0G2PAV8FPMVC9QHJG7JPN5A',
        event: { type: 'run.succeeded', status: 'SUCCEEDED' },
        ts: 3,
      },
    ];

    // Redis jumps from empty to seq 3 first (gap) — must not emit 3 before 1-2.
    const redisBatches = [
      [
        {
          streamId: '1-0',
          eventId: '01K0G2PAV8FPMVC9QHJG7JPN5A',
          sequence: '3',
          type: 'run.succeeded',
          payload: JSON.stringify({ status: 'SUCCEEDED' }),
          createdAt: '2026-07-18T00:00:03.000Z',
        },
      ],
      [],
    ];
    let redisCall = 0;

    const frames = [];
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
        async listEvents({ afterSequence }) {
          const events = mysqlEvents.filter((e) => e.sequence > afterSequence);
          return {
            events,
            status: events.some((e) => e.event.status === 'SUCCEEDED')
              ? 'SUCCEEDED'
              : 'RUNNING',
            terminal:
              afterSequence >= 3 ||
              (events.length === 0 && afterSequence >= 3),
          };
        },
      },
      getRunService: {
        async execute() {
          return { status: 'SUCCEEDED' };
        },
      },
      runEventStream: {
        async readAfter(_runId, opts) {
          assert.equal(typeof opts, 'object');
          assert.ok('afterId' in opts || opts.afterId === undefined);
          const batch = redisBatches[Math.min(redisCall, redisBatches.length - 1)];
          redisCall += 1;
          return batch;
        },
      },
      pollMs: 1,
      heartbeatMs: 60_000,
      mysqlCatchupMs: 1,
      sleep: async () => {},
    });

    await stream.openTaskStream(
      {
        principal: {},
        agentId: AGENT,
        taskId: TASK,
        rpcId: 1,
        afterSequence: 0,
        includeInitialTask: true,
      },
      {
        write: (c) => {
          frames.push(c);
          return true;
        },
        isClosed: () => false,
      },
    );

    const dataLines = frames
      .join('')
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)));

    // Snapshot has no id line for task ULID
    const firstFrame = frames[0];
    assert.ok(firstFrame.includes('data: '));
    assert.doesNotMatch(firstFrame, new RegExp(`^id: ${TASK}`, 'm'));

    // Status sequences must be non-decreasing without emitting 3 before 1/2
    const statusSeqs = dataLines
      .filter((d) => d.result?.kind === 'status-update')
      .map((d) => d.result.metadata.sequence);
    for (let i = 1; i < statusSeqs.length; i += 1) {
      assert.ok(statusSeqs[i] >= statusSeqs[i - 1]);
    }
    if (statusSeqs.length >= 2) {
      assert.ok(statusSeqs[0] <= 2 || statusSeqs.includes(1));
    }

    // Heartbeat comment format
    assert.match(formatA2aSseHeartbeatComment(), /^: ping /);
    assert.doesNotMatch(formatA2aSseHeartbeatComment(), /^data:/m);
  });

  it('formatA2aSseRpcFrame never uses result.id as SSE id', () => {
    const frame = formatA2aSseRpcFrame(
      jsonRpcSuccess(1, { id: TASK, kind: 'task', status: { state: 'working' } }),
      {},
    );
    assert.doesNotMatch(frame, new RegExp(`^id: ${TASK}`, 'm'));
  });
});

describe('artifact projector + download token isolation', () => {
  it('streams by owner-scoped Run and opaque artifact id only', async () => {
    const calls = [];
    const streamer = createA2aArtifactByteStreamer({
      createRepositories() {
        return {
          runs: {
            async getById(runId, scope) {
              calls.push(['run', runId, scope]);
              return {
                runId,
                agentSessionId: SESSION,
                conversationId: CONV,
              };
            },
          },
          sessions: {
            async getById(sessionId, scope) {
              calls.push(['session', sessionId, scope]);
              return {
                agentSessionId: sessionId,
                conversationId: CONV,
                sandboxSessionId: SANDBOX_SESSION,
                executionFenceToken: 7,
              };
            },
          },
        };
      },
      artifactDownloadTransport: {
        async downloadArtifact(input, options) {
          calls.push(['download', input, options]);
          return {
            body: new Response(Buffer.from('real-bytes')).body,
            contentType: 'application/octet-stream',
            contentDisposition: 'attachment; filename="report.bin"',
            contentLength: 10,
            sha256: 'b'.repeat(64),
          };
        },
      },
    });

    const result = await streamer({
      principal: { orgId: ORG, serviceUserId: USER },
      mapping: { runId: RUN },
      artifact: {
        artifactId: ART,
        mimeType: 'application/octet-stream',
        sizeBytes: 10,
        sha256: 'b'.repeat(64),
      },
      traceId: TRACE,
      traceState: 'vendor=value',
      req: { once() {}, off() {} },
    });

    assert.equal(
      Buffer.from(await new Response(result.body).arrayBuffer()).toString(),
      'real-bytes',
    );
    assert.deepEqual(calls[0], [
      'run',
      RUN,
      { orgId: ORG, userId: USER },
    ]);
    assert.deepEqual(calls[1], [
      'session',
      SESSION,
      { orgId: ORG, userId: USER },
    ]);
    const downloadCall = calls.at(-1);
    assert.deepEqual(downloadCall.slice(0, 2), [
      'download',
      {
        artifactId: ART,
        identity: {
          orgId: ORG,
          userId: USER,
          conversationId: CONV,
          agentSessionId: SESSION,
          runId: RUN,
          sandboxSessionId: SANDBOX_SESSION,
          traceId: TRACE,
          executionFenceToken: 7,
        },
        expectedSizeBytes: 10,
        expectedSha256: 'b'.repeat(64),
      },
    ]);
    assert.equal(downloadCall[2].traceState, 'vendor=value');
    assert.ok(downloadCall[2].signal instanceof AbortSignal);
    assert.equal(JSON.stringify(calls).includes('relativePath'), false);
  });

  it('fails closed when the owner-scoped Agent Session is unavailable', async () => {
    let downloaded = false;
    const streamer = createA2aArtifactByteStreamer({
      createRepositories() {
        return {
          runs: {
            async getById() {
              return {
                runId: RUN,
                agentSessionId: SESSION,
                conversationId: CONV,
              };
            },
          },
          sessions: {
            async getById() {
              return null;
            },
          },
        };
      },
      artifactDownloadTransport: {
        async downloadArtifact() {
          downloaded = true;
        },
      },
    });
    const result = await streamer({
      principal: { orgId: ORG, serviceUserId: USER },
      mapping: { runId: RUN },
      artifact: { artifactId: ART },
      traceId: TRACE,
      req: { once() {}, off() {} },
    });
    assert.equal(result.body, null);
    assert.equal(downloaded, false);
  });

  it('rejects path/name-only artifacts; requires durable ULID', () => {
    const ctx = {
      a2aTaskId: TASK,
      principal: { orgId: ORG, clientId: 'c1' },
      // No configured byte streamer means no URI mint.
      buildDownloadUri: null,
    };
    assert.equal(
      projectEnvelopeToA2aResult(
        {
          sequence: 1,
          event: {
            type: 'artifact.ready',
            path: '/home/sandbox/workspace/secret.csv',
            name: 'secret.csv',
          },
        },
        ctx,
      ),
      null,
    );
    const ok = projectEnvelopeToA2aResult(
      {
        sequence: 2,
        event: {
          type: 'artifact.ready',
          artifactId: ART,
          name: 'report.pdf',
          path: '/should/not/leak',
        },
      },
      ctx,
    );
    assert.ok(ok);
    assert.equal(ok.result.artifact.artifactId, ART);
    const json = JSON.stringify(ok.result.artifact);
    assert.doesNotMatch(json, /should\/not\/leak/);
    assert.doesNotMatch(json, /workspace/);
    // Fail closed: no download URI without byte transport
    const filePart = ok.result.artifact.parts.find((p) => p.kind === 'file');
    assert.equal(filePart.file.uri, undefined);
  });

  it('does not emit file.uri when buildDownloadUri is null or returns null', () => {
    for (const mint of [null, () => null]) {
      const projected = projectEnvelopeToA2aResult(
        {
          sequence: 1,
          event: {
            type: 'artifact.ready',
            artifactId: ART,
            name: 'report.pdf',
          },
        },
        {
          a2aTaskId: TASK,
          principal: { orgId: ORG, clientId: 'c1' },
          buildDownloadUri: mint,
        },
      );
      assert.ok(projected);
      const file = projected.result.artifact.parts.find((p) => p.kind === 'file');
      assert.equal(file.file.uri, undefined);
    }
  });

  it('HMAC token binds org+client+task+artifact+exp; cross-client fails', () => {
    const { token, claims } = mintArtifactDownloadToken({
      orgId: ORG,
      clientId: 'client-a',
      taskId: TASK,
      artifactId: ART,
      secret: SECRET,
      ttlSec: 60,
    });
    const verified = verifyArtifactDownloadToken(token, SECRET);
    assert.equal(verified.clientId, 'client-a');
    assert.equal(verified.artifactId, ART);

    // Tamper client
    const [payload] = token.split('.');
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    body.clientId = 'client-b';
    const bad = `${Buffer.from(JSON.stringify(body)).toString('base64url')}.${token.split('.')[1]}`;
    assert.throws(() => verifyArtifactDownloadToken(bad, SECRET));

    // No secret → no URI
    assert.equal(
      buildArtifactDownloadUri({
        baseUrl: 'https://agent.example.com',
        orgId: ORG,
        clientId: 'client-a',
        taskId: TASK,
        artifactId: ART,
        secret: null,
      }),
      null,
    );
    assert.ok(claims.exp > Math.floor(Date.now() / 1000));
  });

  it('download route without streamer returns 503, never metadata 200', async () => {
    const a2aHandler = createA2aHttpHandler({
      credentialService: {
        async authenticate() {
          return {
            orgId: ORG,
            agentId: AGENT,
            serviceUserId: USER,
            clientId: 'client-a',
            credentialId: CRED,
            scopes: ['artifact.read'],
          };
        },
      },
      taskService: {
        async sendMessage() {},
        async getTask() {},
        async cancelTask() {},
      },
      streamService: { async openTaskStream() {} },
      streamArtifactBytes: null,
      artifactDownloadSecret: SECRET,
      publicBaseUrl: 'https://agent.example.com',
      deploymentEnv: 'production',
      resolveTraceId: () => TRACE,
      readBody: async () => '',
      json: (res, status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      },
    });

    // Exercise handler via createAgentHttpServer without bind race: call handle directly
    const chunks = [];
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        this.statusCode = status;
        this.headers = headers;
      },
      end(body) {
        chunks.push(body);
      },
      write() {
        return true;
      },
    };
    const req = { method: 'GET', headers: {}, url: '/a2a/artifacts/download?token=x' };
    const handled = await a2aHandler.handle(
      req,
      res,
      new URL('http://localhost/a2a/artifacts/download?token=x'),
    );
    assert.equal(handled, true);
    assert.equal(res.statusCode, 503);
    const body = JSON.parse(chunks.join('') || '{}');
    assert.equal(body.code, 'A2A_DOWNLOAD_BYTES_UNAVAILABLE');
    assert.equal(body.artifactId, undefined);
  });

  it('download route owner-checks task and artifact before streaming bytes', async () => {
    const bytes = Buffer.from('downloaded-through-a2a', 'utf8');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const { token } = mintArtifactDownloadToken({
      orgId: ORG,
      clientId: 'client-a',
      taskId: TASK,
      artifactId: ART,
      secret: SECRET,
      ttlSec: 60,
    });
    const calls = [];
    const audits = [];
    let auditFails = false;
    const a2aHandler = createA2aHttpHandler({
      credentialService: {
        async authenticate(authorization, options) {
          calls.push(['authenticate', authorization, options]);
          return {
            orgId: ORG,
            agentId: AGENT,
            serviceUserId: USER,
            clientId: 'client-a',
            credentialId: CRED,
            scopes: ['artifact.read'],
          };
        },
      },
      taskService: {
        async resolveOwnedTask(principal, taskId) {
          calls.push(['task', principal.clientId, taskId]);
          return { a2aTaskId: TASK, runId: RUN };
        },
        async auditArtifactDownload(input) {
          audits.push(input);
          if (auditFails) throw new Error('audit unavailable');
        },
      },
      streamService: { async openTaskStream() {} },
      createRepositories() {
        return {
          artifacts: {
            async getById(artifactId, scope) {
              calls.push(['artifact', artifactId, scope]);
              return {
                artifactId: ART,
                runId: RUN,
                displayName: 'report.bin',
                mimeType: 'application/octet-stream',
                sizeBytes: bytes.byteLength,
                sha256: digest,
              };
            },
          },
        };
      },
      async streamArtifactBytes(context) {
        calls.push(['stream', context]);
        assert.equal('relativePath' in context.artifact, false);
        return {
          body: new Response(bytes).body,
          contentType: 'application/octet-stream',
          contentDisposition: 'attachment; filename="report.bin"',
          contentLength: bytes.byteLength,
          sha256: digest,
        };
      },
      artifactDownloadSecret: SECRET,
      publicBaseUrl: 'https://agent.example.com',
      deploymentEnv: 'production',
      resolveTraceId: () => TRACE,
      resolveTraceContext: () => ({
        traceId: TRACE,
        parentSpanId: 'e'.repeat(16),
        traceFlags: '01',
        traceState: 'vendor=value',
      }),
      readBody: async () => '',
      json: (res, status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      },
    });
    const server = createAgentHttpServer({
      createRunService: { async execute() {} },
      getRunService: { async execute() {} },
      cancelRunService: { async execute() {} },
      eventQueryService: { async listEvents() { return { events: [] }; } },
      a2aHandler,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/a2a/artifacts/download?token=${encodeURIComponent(token)}`,
        { headers: { Authorization: 'Bearer a2a-test' } },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      assert.equal(response.headers.get('x-artifact-id'), ART);
      assert.equal(response.headers.get('x-artifact-sha256'), digest);
      assert.equal(response.headers.get('x-trace-id'), TRACE);
      assert.equal(response.headers.get('content-length'), String(bytes.byteLength));
      assert.deepEqual(calls[2], [
        'artifact',
        ART,
        { orgId: ORG, userId: USER },
      ]);
      assert.equal(calls[3][0], 'stream');
      assert.equal(calls[3][1].mapping.runId, RUN);
      assert.equal(calls[3][1].principal.serviceUserId, USER);
      assert.equal(calls[3][1].traceState, 'vendor=value');
      assert.deepEqual(audits, [
        {
          principal: {
            orgId: ORG,
            agentId: AGENT,
            serviceUserId: USER,
            clientId: 'client-a',
            credentialId: CRED,
            scopes: ['artifact.read'],
          },
          agentId: AGENT,
          taskId: TASK,
          runId: RUN,
          artifactId: ART,
          traceId: TRACE,
        },
      ]);

      const streamsBeforeAuditFailure = calls.filter(
        (entry) => entry[0] === 'stream',
      ).length;
      auditFails = true;
      const rejected = await fetch(
        `http://127.0.0.1:${port}/a2a/artifacts/download?token=${encodeURIComponent(token)}`,
        { headers: { Authorization: 'Bearer a2a-test' } },
      );
      assert.equal(rejected.status, 503);
      assert.equal(
        (await rejected.json()).code,
        'A2A_AUDIT_UNAVAILABLE',
      );
      assert.equal(
        calls.filter((entry) => entry[0] === 'stream').length,
        streamsBeforeAuditFailure,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('public base URL / host injection', () => {
  it('production requires https origin without userinfo/query/fragment', () => {
    assert.throws(
      () => assertPublicBaseUrl('http://evil.com'),
      /https/,
    );
    assert.throws(
      () => assertPublicBaseUrl('https://user:pass@evil.com'),
      /userinfo/,
    );
    assert.throws(
      () => assertPublicBaseUrl('https://evil.com?x=1'),
      /query/,
    );
    assert.throws(
      () => assertPublicBaseUrl('https://evil.com#frag'),
      /fragment/,
    );
    assert.equal(
      assertPublicBaseUrl('https://agent.example.com'),
      'https://agent.example.com',
    );
  });

  it('never trusts X-Forwarded-Host; dev fallback only loopback', () => {
    assert.throws(
      () =>
        resolvePublicBaseUrl(
          {
            headers: {
              host: 'evil.example.com',
              'x-forwarded-host': 'evil.example.com',
            },
          },
          {
            deploymentEnv: 'development',
            allowDevHostFallback: true,
          },
        ),
      /loopback/,
    );
    const base = resolvePublicBaseUrl(
      { headers: { host: '127.0.0.1:4100' } },
      { deploymentEnv: 'development', allowDevHostFallback: true },
    );
    assert.equal(base, 'http://127.0.0.1:4100');

    assert.throws(
      () =>
        resolvePublicBaseUrl(
          { headers: { host: 'localhost' } },
          { deploymentEnv: 'production' },
        ),
      /required in production/,
    );
  });
});

describe('credential expiry + rotation race', () => {
  function makeStore() {
    /** @type {Map<string, object>} */
    const byId = new Map();
    /** @type {Map<string, object>} */
    const byKey = new Map();
    return {
      byId,
      byKey,
      createRepositories() {
        return {
          a2aCredentials: {
            async insert(input) {
              if (byKey.has(input.keyId)) {
                const err = new Error('dup');
                err.code = 'ER_DUP_ENTRY';
                throw err;
              }
              const row = {
                credentialId: input.credentialId,
                orgId: input.orgId,
                agentId: input.agentId,
                serviceUserId: input.serviceUserId,
                clientId: input.clientId,
                keyId: input.keyId,
                secretHash: input.secretHash,
                scopes: input.scopes,
                status: input.status,
                expiresAt: input.expiresAt
                  ? new Date(input.expiresAt).toISOString()
                  : null,
                rotatedFromId: input.rotatedFromId ?? null,
                lastUsedAt: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              };
              byId.set(row.credentialId, row);
              byKey.set(row.keyId, row);
              return row;
            },
            async getById(id) {
              return byId.get(id) || null;
            },
            async getByKeyId(keyId) {
              return byKey.get(keyId.toLowerCase()) || null;
            },
            async updateStatus(id, status, opts = {}) {
              const row = byId.get(id);
              if (!row) throw Object.assign(new Error('nf'), { name: 'NotFoundError' });
              if (opts.expectedStatus) {
                const exp = Array.isArray(opts.expectedStatus)
                  ? opts.expectedStatus
                  : [opts.expectedStatus];
                if (!exp.includes(row.status)) {
                  throw Object.assign(new Error('cas'), { name: 'NotFoundError' });
                }
              }
              row.status = status;
              return row;
            },
            async touchLastUsed() {},
          },
        };
      },
    };
  }

  it('rejects past expiresAt on issue; invalid stored expiry fail-closed', async () => {
    assert.throws(
      () => normalizeFutureExpiresAt('2020-01-01T00:00:00.000Z'),
      /future/,
    );
    assert.equal(evaluateStoredExpiry('not-a-date'), 'invalid');
    assert.equal(evaluateStoredExpiry('2020-01-01T00:00:00.000Z'), 'expired');

    const store = makeStore();
    const svc = new A2aCredentialService({
      createRepositories: store.createRepositories,
      generateId: () => CRED,
      now: () => new Date('2026-07-18T00:00:00.000Z'),
    });
    await assert.rejects(
      () =>
        svc.issue({
          orgId: ORG,
          agentId: AGENT,
          serviceUserId: USER,
          clientId: 'c1',
          expiresAt: '2020-01-01T00:00:00.000Z',
        }),
      ValidationError,
    );

    const issued = await svc.issue({
      orgId: ORG,
      agentId: AGENT,
      serviceUserId: USER,
      clientId: 'c1',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    // Corrupt stored expiry
    store.byId.get(CRED).expiresAt = 'not-a-date';
    await assert.rejects(
      () => svc.authenticate(`Bearer ${issued.token}`, { agentId: AGENT }),
      (e) => e instanceof A2aAuthError && e.code === 'A2A_AUTH_EXPIRY_INVALID',
    );
  });

  it('rotation CAS in single txn path: only one winner; old token dead', async () => {
    const store = makeStore();
    let n = 0;
    const ids = [CRED, '01K0G2PAV8FPMVC9QHJG7JPN5D', '01K0G2PAV8FPMVC9QHJG7JPN5E'];
    const svc = new A2aCredentialService({
      createRepositories: store.createRepositories,
      generateId: () => ids[n++] || `01K0G2PAV8FPMVC9QHJG7JPN5${n}`,
      now: () => new Date('2026-07-18T00:00:00.000Z'),
      transactionManager: {
        async run(fn) {
          return fn(null);
        },
      },
    });
    const first = await svc.issue({
      orgId: ORG,
      agentId: AGENT,
      serviceUserId: USER,
      clientId: 'c1',
    });
    const rotated = await svc.rotate({ credentialId: CRED, orgId: ORG });
    assert.notEqual(rotated.token, first.token);
    assert.equal(store.byId.get(CRED).status, A2A_CREDENTIAL_STATUS.ROTATED);
    await assert.rejects(
      () => svc.authenticate(`Bearer ${first.token}`, { agentId: AGENT }),
      A2aAuthError,
    );
    await svc.authenticate(`Bearer ${rotated.token}`, { agentId: AGENT });

    // Second rotate of already-rotated fails (CAS)
    await assert.rejects(
      () => svc.rotate({ credentialId: CRED, orgId: ORG }),
      /Only active|not found|CAS|nf|cas/i,
    );
  });

  it('expired/invalid source expiresAt: rotate fails before ROTATED; no non-expiring mint', async () => {
    const store = makeStore();
    let n = 0;
    const ids = [CRED, '01K0G2PAV8FPMVC9QHJG7JPN5D'];
    const now = () => new Date('2026-07-18T12:00:00.000Z');
    const svc = new A2aCredentialService({
      createRepositories: store.createRepositories,
      generateId: () => ids[n++] || `01K0G2PAV8FPMVC9QHJG7JPN5${n}`,
      now,
      transactionManager: {
        async run(fn) {
          return fn(null);
        },
      },
    });

    // Issue with future expiry, then corrupt to expired while still ACTIVE.
    await svc.issue({
      orgId: ORG,
      agentId: AGENT,
      serviceUserId: USER,
      clientId: 'c1',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    store.byId.get(CRED).expiresAt = '2020-01-01T00:00:00.000Z';
    store.byId.get(CRED).status = A2A_CREDENTIAL_STATUS.ACTIVE;

    await assert.rejects(
      () => svc.rotate({ credentialId: CRED, orgId: ORG }),
      (e) => e instanceof ValidationError && /expired or invalid/i.test(e.message),
    );
    assert.equal(store.byId.get(CRED).status, A2A_CREDENTIAL_STATUS.ACTIVE);
    assert.equal(store.byId.size, 1); // no new credential row

    // Invalid stored expiry
    store.byId.get(CRED).expiresAt = 'not-a-date';
    await assert.rejects(
      () => svc.rotate({ credentialId: CRED, orgId: ORG }),
      /expired or invalid/i,
    );
    assert.equal(store.byId.get(CRED).status, A2A_CREDENTIAL_STATUS.ACTIVE);

    // Explicit null (clear expiry) from expired source also rejected
    store.byId.get(CRED).expiresAt = '2020-01-01T00:00:00.000Z';
    await assert.rejects(
      () => svc.rotate({ credentialId: CRED, orgId: ORG, expiresAt: null }),
      /non-expiring|expired or invalid/i,
    );
    assert.equal(store.byId.get(CRED).status, A2A_CREDENTIAL_STATUS.ACTIVE);

    // Providing a new future expiresAt succeeds (ops recovery)
    const rotated = await svc.rotate({
      credentialId: CRED,
      orgId: ORG,
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    assert.equal(store.byId.get(CRED).status, A2A_CREDENTIAL_STATUS.ROTATED);
    assert.ok(rotated.credential.expiresAt);
  });

  it('rotate without transaction manager fails closed; no partial ROTATED', async () => {
    const store = makeStore();
    const svc = new A2aCredentialService({
      createRepositories: store.createRepositories,
      generateId: () => CRED,
      now: () => new Date('2026-07-18T00:00:00.000Z'),
      // deliberately no transactionManager / allowNonTransactionalRotate
    });
    await svc.issue({
      orgId: ORG,
      agentId: AGENT,
      serviceUserId: USER,
      clientId: 'c1',
    });
    await assert.rejects(
      () => svc.rotate({ credentialId: CRED, orgId: ORG }),
      /transaction manager/i,
    );
    assert.equal(store.byId.get(CRED).status, A2A_CREDENTIAL_STATUS.ACTIVE);
  });

  it('txn rollback: insert failure after CAS rolls back (simulated tx)', async () => {
    const store = makeStore();
    let n = 0;
    const ids = [CRED, '01K0G2PAV8FPMVC9QHJG7JPN5D'];
    /** @type {Map<string, object> | null} */
    let snapshot = null;
    const svc = new A2aCredentialService({
      createRepositories: () => ({
        a2aCredentials: {
          async insert(input) {
            if (input.rotatedFromId) {
              throw new Error('insert boom');
            }
            return store.createRepositories().a2aCredentials.insert(input);
          },
          async getById(id) {
            return store.byId.get(id) || null;
          },
          async getByKeyId(keyId) {
            return store.byKey.get(keyId.toLowerCase()) || null;
          },
          async updateStatus(id, status, opts) {
            return store.createRepositories().a2aCredentials.updateStatus(id, status, opts);
          },
          async touchLastUsed() {},
        },
      }),
      generateId: () => ids[n++] || `01K0G2PAV8FPMVC9QHJG7JPN5${n}`,
      now: () => new Date('2026-07-18T00:00:00.000Z'),
      transactionManager: {
        async run(fn) {
          // Snapshot for rollback
          snapshot = {
            byId: new Map(
              [...store.byId.entries()].map(([k, v]) => [k, { ...v }]),
            ),
            byKey: new Map(store.byKey),
          };
          try {
            return await fn(null);
          } catch (err) {
            store.byId.clear();
            store.byKey.clear();
            for (const [k, v] of snapshot.byId) store.byId.set(k, v);
            for (const [k, v] of snapshot.byKey) store.byKey.set(k, v);
            throw err;
          }
        },
      },
    });

    // Use real store for issue outside broken insert path
    const issueSvc = new A2aCredentialService({
      createRepositories: store.createRepositories,
      generateId: () => CRED,
      now: () => new Date('2026-07-18T00:00:00.000Z'),
      allowNonTransactionalRotate: true,
    });
    await issueSvc.issue({
      orgId: ORG,
      agentId: AGENT,
      serviceUserId: USER,
      clientId: 'c1',
    });

    await assert.rejects(
      () => svc.rotate({ credentialId: CRED, orgId: ORG }),
      /insert boom/,
    );
    assert.equal(store.byId.get(CRED).status, A2A_CREDENTIAL_STATUS.ACTIVE);
    assert.equal(store.byId.size, 1);
  });

  it('missing key still runs hash path without throwing early on compare', async () => {
    const store = makeStore();
    const svc = new A2aCredentialService({
      createRepositories: store.createRepositories,
      generateId: () => CRED,
    });
    await assert.rejects(
      () =>
        svc.authenticate(
          'Bearer a2a_' + 'f'.repeat(16) + '_' + '0'.repeat(64),
          { agentId: AGENT },
        ),
      A2aAuthError,
    );
  });
});

describe('audit fail-closed on mutating ops', () => {
  it('sendMessage fails when audit append throws', async () => {
    const principal = {
      orgId: ORG,
      agentId: AGENT,
      serviceUserId: USER,
      clientId: 'client-a',
      credentialId: CRED,
      scopes: ['agent.invoke', 'agent.read', 'agent.cancel', 'artifact.read'],
    };
    const taskId = deterministicA2aTaskId(ORG, 'client-a', RUN);
    const svc = new A2aTaskService({
      createRunService: {
        async execute() {
          return {
            runId: RUN,
            status: 'ACCEPTED',
            conversationId: CONV,
          };
        },
      },
      getRunService: {
        async execute() {
          return {
            runId: RUN,
            status: 'ACCEPTED',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        },
      },
      cancelRunService: { async execute() {} },
      createRepositories: () => ({
        a2aTasks: {
          async insert(row) {
            return row;
          },
          async getByRunId() {
            return null;
          },
          async getById(id) {
            if (id === taskId) {
              return {
                a2aTaskId: taskId,
                orgId: ORG,
                clientId: 'client-a',
                agentId: AGENT,
                runId: RUN,
                conversationId: CONV,
                contextId: CONV,
                traceId: TRACE,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              };
            }
            return null;
          },
        },
        a2aAudit: {
          async append() {
            throw new Error('audit down');
          },
        },
      }),
      generateId: () => '01K0G2PAV8FPMVC9QHJG7JPN5Z',
      requireAudit: true,
    });

    await assert.rejects(
      () =>
        svc.sendMessage({
          principal,
          agentId: AGENT,
          params: {
            message: {
              messageId: 'm1',
              parts: [{ kind: 'text', text: 'x' }],
            },
          },
          traceId: TRACE,
          idempotencyKey: 'm1',
        }),
      (e) => e instanceof A2aAuditError,
    );
  });
});

describe('Agent Card meta 404 + HTTP invalid params', () => {
  it('valid ULID without meta returns 404; missing idempotency INVALID_PARAMS', async () => {
    const a2aHandler = createA2aHttpHandler({
      credentialService: {
        async authenticate() {
          return {
            orgId: ORG,
            agentId: AGENT,
            serviceUserId: USER,
            clientId: 'client-a',
            credentialId: CRED,
            scopes: ['agent.invoke', 'agent.read', 'agent.cancel', 'artifact.read'],
            callerType: 'a2a',
            callerId: 'client-a',
          };
        },
      },
      taskService: {
        async sendMessage() {
          throw new Error('should not reach');
        },
        async getTask() {
          return buildA2aTaskObject({ a2aTaskId: TASK, runStatus: 'RUNNING' });
        },
        async cancelTask() {
          return buildA2aTaskObject({ a2aTaskId: TASK, runStatus: 'CANCELLING' });
        },
      },
      streamService: {
        async openTaskStream() {},
      },
      publicBaseUrl: 'https://agent.example.com',
      deploymentEnv: 'production',
      resolveAgentMeta: async () => null,
      resolveTraceId: () => TRACE,
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
      createRunService: { async execute() {} },
      getRunService: { async execute() {} },
      cancelRunService: { async execute() {} },
      eventQueryService: { async listEvents() { return { events: [] }; } },
      a2aHandler,
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const card = await fetch(
        `http://127.0.0.1:${port}/a2a/agents/${AGENT}/.well-known/agent-card.json`,
      );
      assert.equal(card.status, 404);

      const bad = await fetch(`http://127.0.0.1:${port}/a2a/agents/${AGENT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer x',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: {
            message: { parts: [{ kind: 'text', text: 'no id' }] },
          },
        }),
      });
      const body = await bad.json();
      assert.equal(body.error.code, JSON_RPC_ERROR.INVALID_PARAMS.code);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
