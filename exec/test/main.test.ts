/**
 * main/app 必须挂上内部 HMAC 面与公共会话面，不能只回 /health。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { issueInternalToken } from '@pi/contract/hmac.js';
import { createExecApp, createExecAppFromEnv } from '../src/http/app.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { MySqlJobRegistry } from '../src/shell/job-registry.js';
import { InMemoryJobStore } from '../src/shell/job-store-memory.js';

const TEST_KID = 'test-kid-1';
const TEST_KEY_B64URL = Buffer.from('0'.repeat(32), 'utf8').toString('base64url');
const KEYRING_JSON = JSON.stringify({ [TEST_KID]: TEST_KEY_B64URL });

function sha256Hex(data: Uint8Array | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  return createHash('sha256').update(buf).digest('hex');
}

describe('createExecApp mounts health + internal + public routers', () => {
  let root: string;
  let app: ReturnType<typeof createExecApp>;
  let workspaceId: string;

  before(async () => {
    const base = await realpath(tmpdir());
    root = await mkdtemp(join(base, 'exec-main-'));
    const manager = new WorkspaceManager({
      workspacesBaseRoot: join(root, 'ws'),
      tempBaseRoot: join(root, 'tmp'),
    });
    const registry = new MySqlJobRegistry(new InMemoryJobStore());
    app = createExecApp({
      workspaceManager: manager,
      jobRegistry: registry,
      keyring: KEYRING_JSON,
      systemSkillRoot: join(root, 'skills'),
      bwrapExecutable: '/usr/bin/bwrap',
      allowCidr: [],
    });
    workspaceId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('GET /health and /ready', async () => {
    const health = await app.request('/health');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    const ready = await app.request('/ready');
    assert.equal(ready.status, 200);
  });

  test('POST /internal/v1/sessions/ensure is mounted (not the health-only 404)', async () => {
    const body = JSON.stringify({
      envelope: {
        requestId: 'r1',
        workspaceId,
        orgId: 'org_test',
        userId: 'user_test',
        fenceToken: 1,
      },
      payload: {},
    });
    const token = issueInternalToken({
      keyring: { [TEST_KID]: TEST_KEY_B64URL },
      activeKid: TEST_KID,
      claims: {
        org_id: 'org_test',
        user_id: 'user_test',
        conversation_id: 'conv_test',
        agent_session_id: 'as_test',
        sandbox_session_id: 'ss_test',
        run_id: 'run_test',
        tool_execution_id: 'te_test',
        tool_call_id: 'tc_test',
        tool_name: 'session.ensure',
        scope: ['sandbox.sessions.ensure'],
        request_hash: 'a'.repeat(64),
        execution_fence_token: 1,
        trace_id: 'trace_test',
        htm: 'POST',
        htu: '/internal/v1/sessions/ensure',
        body_sha256: sha256Hex(body),
      },
    });
    const res = await app.request('/internal/v1/sessions/ensure', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body,
    });
    assert.notEqual(res.status, 404);
    const json = (await res.json()) as { ok?: boolean; error?: { code?: string } };
    assert.equal(json.ok, true);
    assert.notEqual(json.error?.code, 'NOT_FOUND');
  });

  test('POST /internal/v1/sessions/ensure accepts Agent { workspaceId } body', async () => {
    const body = JSON.stringify({ workspaceId });
    const token = issueInternalToken({
      keyring: { [TEST_KID]: TEST_KEY_B64URL },
      activeKid: TEST_KID,
      claims: {
        org_id: 'org_test',
        user_id: 'user_test',
        conversation_id: 'conv_test',
        agent_session_id: 'as_test',
        sandbox_session_id: 'ss_test',
        run_id: 'run_test',
        tool_execution_id: 'te_test',
        tool_call_id: 'tc_test',
        tool_name: 'session.ensure',
        scope: ['sandbox.sessions.ensure'],
        request_hash: 'a'.repeat(64),
        execution_fence_token: 1,
        trace_id: 'trace_test',
        htm: 'POST',
        htu: '/internal/v1/sessions/ensure',
        body_sha256: sha256Hex(body),
      },
    });
    const res = await app.request('/internal/v1/sessions/ensure', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body,
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      ok?: boolean;
      status?: string;
      workspaceId?: string;
      sandboxSessionId?: string;
      agentSessionId?: string;
    };
    assert.equal(json.ok, true);
    assert.equal(json.status, 'ACTIVE');
    assert.equal(json.workspaceId, workspaceId);
    assert.equal(json.sandboxSessionId, 'ss_test');
    assert.equal(json.agentSessionId, 'as_test');
  });

  test('POST /internal/v1/shell/run is mounted (HMAC tools are not 404)', async () => {
    const body = JSON.stringify({
      envelope: {
        requestId: 'r-shell',
        workspaceId,
        orgId: 'org_test',
        userId: 'user_test',
        fenceToken: 1,
      },
      payload: { command: 'ls', workdir: '/home/sandbox/workspace' },
    });
    const token = issueInternalToken({
      keyring: { [TEST_KID]: TEST_KEY_B64URL },
      activeKid: TEST_KID,
      claims: {
        org_id: 'org_test',
        user_id: 'user_test',
        conversation_id: 'conv_test',
        agent_session_id: 'as_test',
        sandbox_session_id: 'ss_test',
        run_id: 'run_test',
        tool_execution_id: 'te_test',
        tool_call_id: 'tc_test',
        tool_name: 'bash',
        scope: ['internal:shell'],
        request_hash: 'a'.repeat(64),
        execution_fence_token: 1,
        trace_id: 'trace_test',
        htm: 'POST',
        htu: '/internal/v1/shell/run',
        body_sha256: sha256Hex(body),
      },
    });
    const res = await app.request('/internal/v1/shell/run', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body,
    });
    assert.notEqual(res.status, 404);
    const json = (await res.json()) as { ok?: boolean };
    assert.equal(typeof json.ok, 'boolean');
  });

  test('POST /internal/v1/fs/resolve succeeds twice (fresh Cordis ctx per request)', async () => {
    await app.request('/internal/v1/sessions/ensure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId }),
    });
    const postResolve = async () => {
      const body = JSON.stringify({
        envelope: {
          requestId: `r-fs-${Math.random()}`,
          workspaceId,
          orgId: 'org_test',
          userId: 'user_test',
          fenceToken: 1,
        },
        payload: { path: '/home/sandbox/workspace' },
      });
      const token = issueInternalToken({
        keyring: { [TEST_KID]: TEST_KEY_B64URL },
        activeKid: TEST_KID,
        claims: {
          org_id: 'org_test',
          user_id: 'user_test',
          conversation_id: 'conv_test',
          agent_session_id: 'as_test',
          sandbox_session_id: 'ss_test',
          run_id: 'run_test',
          tool_execution_id: 'te_test',
          tool_call_id: 'tc_test',
          tool_name: 'fs',
          scope: ['internal:fs'],
          request_hash: 'a'.repeat(64),
          execution_fence_token: 1,
          trace_id: 'trace_test',
          htm: 'POST',
          htu: '/internal/v1/fs/resolve',
          body_sha256: sha256Hex(body),
        },
      });
      return app.request('/internal/v1/fs/resolve', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body,
      });
    };
    const first = await postResolve();
    const second = await postResolve();
    assert.equal(first.status, 200, await first.clone().text());
    assert.equal(second.status, 200, await second.clone().text());
    const json = (await second.json()) as { ok?: boolean; data?: { displayPath?: string; targetKey?: string } };
    assert.equal(json.ok, true);
    assert.equal(typeof json.data?.displayPath, 'string');
    const listBody = JSON.stringify({
      envelope: {
        requestId: 'r-list',
        workspaceId,
        orgId: 'org_test',
        userId: 'user_test',
        fenceToken: 1,
      },
      payload: { target: json.data },
    });
    const listToken = issueInternalToken({
      keyring: { [TEST_KID]: TEST_KEY_B64URL },
      activeKid: TEST_KID,
      claims: {
        org_id: 'org_test',
        user_id: 'user_test',
        conversation_id: 'conv_test',
        agent_session_id: 'as_test',
        sandbox_session_id: 'ss_test',
        run_id: 'run_test',
        tool_execution_id: 'te_test',
        tool_call_id: 'tc_test',
        tool_name: 'fs',
        scope: ['internal:fs'],
        request_hash: 'a'.repeat(64),
        execution_fence_token: 1,
        trace_id: 'trace_test',
        htm: 'POST',
        htu: '/internal/v1/fs/list',
        body_sha256: sha256Hex(listBody),
      },
    });
    const listed = await app.request('/internal/v1/fs/list', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${listToken}`,
      },
      body: listBody,
    });
    assert.equal(listed.status, 200, await listed.clone().text());
    const listJson = (await listed.json()) as { ok?: boolean; data?: unknown };
    assert.equal(listJson.ok, true);
    assert.equal(Array.isArray(listJson.data), true);
  });

  test('GET /sessions/:id/files is the public router, not the stub NOT_FOUND envelope', async () => {
    const res = await app.request(`/sessions/${workspaceId}/files?path=.`);
    assert.equal(res.status, 404);
    const json = (await res.json()) as { ok?: boolean; error?: unknown };
    assert.equal(json.ok, undefined);
  });
});

describe('createExecAppFromEnv fail-closed without HMAC', () => {
  test('throws when keyring missing', () => {
    assert.throws(
      () =>
        createExecAppFromEnv({
          DEPLOYMENT_ENV: 'development',
        } as NodeJS.ProcessEnv),
      /SANDBOX_INTERNAL_HMAC_KEYRING/,
    );
  });

  test('builds an app when keyring is present and DB is optional in development', async () => {
    const runtime = createExecAppFromEnv({
      DEPLOYMENT_ENV: 'development',
      SANDBOX_INTERNAL_HMAC_KEYRING: KEYRING_JSON,
      SANDBOX_INTERNAL_HMAC_ACTIVE_KID: TEST_KID,
      SANDBOX_WORKSPACES_ROOT: join(tmpdir(), 'exec-env-ws'),
      SANDBOX_TEMP_ROOT: join(tmpdir(), 'exec-env-tmp'),
    } as NodeJS.ProcessEnv);
    const res = await runtime.app.request('/health');
    assert.equal(res.status, 200);
    await runtime.dispose();
  });
});
