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
const TEST_API_TOKEN = 'exec-test-service-token-32-bytes-long';

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
      publicApiToken: null,
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
        tool_name: 'shell',
        scope: ['sandbox.shell'],
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
          scope: ['sandbox.fs'],
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
        scope: ['sandbox.fs'],
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
      SANDBOX_API_TOKEN: TEST_API_TOKEN,
      SANDBOX_WORKSPACES_ROOT: join(tmpdir(), 'exec-env-ws'),
      SANDBOX_TEMP_ROOT: join(tmpdir(), 'exec-env-tmp'),
    } as NodeJS.ProcessEnv);
    const res = await runtime.app.request('/health');
    assert.equal(res.status, 200);
    await runtime.dispose();
  });
});

describe('createExecAppFromEnv wires durable artifact/dataset stores', () => {
  // 回归：曾经只有 JobStore 接了 MySQL，ArtifactService/DatasetService 落回
  // 构造函数默认的内存实现——容器一重启，`GET /sessions/:id/artifacts`
  // 就返回空列表，下载全部 404。这里把库指向一个没人监听的端口：
  // 接了 MySQL 就必然连不上（5xx），没接就会安静地返回 200 空列表。
  const workspaceId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const dbEnv = {
    DEPLOYMENT_ENV: 'development',
    SANDBOX_INTERNAL_HMAC_KEYRING: KEYRING_JSON,
    SANDBOX_INTERNAL_HMAC_ACTIVE_KID: TEST_KID,
    SANDBOX_API_TOKEN: TEST_API_TOKEN,
    SANDBOX_WORKSPACES_ROOT: join(tmpdir(), 'exec-env-db-ws'),
    SANDBOX_TEMP_ROOT: join(tmpdir(), 'exec-env-db-tmp'),
    EXEC_DATABASE_URL: 'mysql://exec:secret@127.0.0.1:1/execdb',
  } as NodeJS.ProcessEnv;
  const acting = {
    'X-Acting-Organization-Id': '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    'X-Acting-User-Id': '01ARZ3NDEKTSV4RRFFQ69G5FAX',
    'X-API-Key': TEST_API_TOKEN,
  };

  test('artifact list goes to MySQL instead of an in-memory map', async () => {
    const runtime = createExecAppFromEnv(dbEnv);
    try {
      const res = await runtime.app.request(`/sessions/${workspaceId}/artifacts`, {
        headers: acting,
      });
      assert.notEqual(res.status, 200);
      assert.ok(res.status >= 500, `expected a DB failure, got ${res.status}`);
      // 脱敏不变量：DSN / 口令绝不能出现在错误体里。
      const body = await res.text();
      assert.ok(!body.includes('secret'), 'DB password leaked into the error body');
    } finally {
      await runtime.dispose();
    }
  });

  test('dataset list goes to MySQL instead of an in-memory map', async () => {
    const runtime = createExecAppFromEnv(dbEnv);
    try {
      const res = await runtime.app.request(`/sessions/${workspaceId}/datasets`, {
        headers: acting,
      });
      assert.notEqual(res.status, 200);
      assert.ok(res.status >= 500, `expected a DB failure, got ${res.status}`);
    } finally {
      await runtime.dispose();
    }
  });
});

describe('public session plane requires the service token', () => {
  // 回归：`SANDBOX_API_TOKEN` 一直被 compose、`.env.example` 与 BFF（`X-API-Key`）
  // 两侧要求，但 exec 换成 TS 之后公共面从来没校验过它——调用方以为有门，
  // 服务方根本没开。
  const workspaceId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const acting = {
    'X-Acting-Organization-Id': '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    'X-Acting-User-Id': '01ARZ3NDEKTSV4RRFFQ69G5FAX',
  };

  function appWithToken() {
    const manager = new WorkspaceManager({
      workspacesBaseRoot: join(tmpdir(), 'exec-token-ws'),
      tempBaseRoot: join(tmpdir(), 'exec-token-tmp'),
    });
    return createExecApp({
      workspaceManager: manager,
      jobRegistry: new MySqlJobRegistry(new InMemoryJobStore()),
      keyring: KEYRING_JSON,
      systemSkillRoot: join(tmpdir(), 'exec-token-skills'),
      bwrapExecutable: '/usr/bin/bwrap',
      allowCidr: [],
      publicApiToken: TEST_API_TOKEN,
    });
  }

  test('a request without X-API-Key is rejected before ownership is even considered', async () => {
    const res = await appWithToken().request(`/sessions/${workspaceId}/artifacts`, { headers: acting });
    assert.equal(res.status, 401);
  });

  test('a wrong X-API-Key is rejected', async () => {
    const res = await appWithToken().request(`/sessions/${workspaceId}/artifacts`, {
      headers: { ...acting, 'X-API-Key': 'exec-test-service-token-32-bytes-WRONG' },
    });
    assert.equal(res.status, 401);
  });

  test('the correct X-API-Key gets through to the session-scoped routes', async () => {
    const res = await appWithToken().request(`/sessions/${workspaceId}/artifacts`, {
      headers: { ...acting, 'X-API-Key': TEST_API_TOKEN },
    });
    assert.notEqual(res.status, 401);
  });

  test('health probes stay open — they are not part of the session plane', async () => {
    for (const path of ['/health', '/ready', '/health/live', '/health/ready']) {
      assert.equal((await appWithToken().request(path)).status, 200, path);
    }
  });

  test('createExecAppFromEnv refuses to start without SANDBOX_API_TOKEN', () => {
    assert.throws(
      () =>
        createExecAppFromEnv({
          DEPLOYMENT_ENV: 'development',
          SANDBOX_INTERNAL_HMAC_KEYRING: KEYRING_JSON,
          SANDBOX_INTERNAL_HMAC_ACTIVE_KID: TEST_KID,
        } as NodeJS.ProcessEnv),
      /SANDBOX_API_TOKEN/,
    );
  });
});

describe('startup orphan recovery is wired, not just defined', () => {
  // 回归：`MySqlJobRegistry.recoverOrphans()` 的注释从第一天就写着「启动期调用
  // （用户路由挂载之前）」，但 2026-09-04 之前**没有任何调用点**——只有一条单测
  // 调它。后果不是脏数据而已：`countActiveForOwner` 把 running/stopping 都算进
  // 每 owner 的并发上限，exec 每重启一次就多攒几条僵尸行，攒够 20 条这个 owner
  // 再也起不了新作业。开发栈上实测到过 5 条 running（最老的两天前），而容器里
  // 一个对应进程都没有。
  test('createExecAppFromEnv exposes a recoverOrphans bound to the real registry', async () => {
    const runtime = createExecAppFromEnv({
      DEPLOYMENT_ENV: 'development',
      SANDBOX_INTERNAL_HMAC_KEYRING: KEYRING_JSON,
      SANDBOX_INTERNAL_HMAC_ACTIVE_KID: TEST_KID,
      SANDBOX_API_TOKEN: TEST_API_TOKEN,
      SANDBOX_WORKSPACES_ROOT: join(tmpdir(), 'exec-recover-ws'),
      SANDBOX_TEMP_ROOT: join(tmpdir(), 'exec-recover-tmp'),
    } as NodeJS.ProcessEnv);
    try {
      assert.equal(typeof runtime.recoverOrphans, 'function');
      // 内存 store：没有历史行，回收 0 条且不抛。
      assert.equal(await runtime.recoverOrphans(), 0);
    } finally {
      await runtime.dispose();
    }
  });

  test('recovery failure propagates so the entrypoint can refuse to start', async () => {
    // 库连不上时 recoverOrphans 必须抛，main.ts 才有机会 fail-closed 退出。
    const runtime = createExecAppFromEnv({
      DEPLOYMENT_ENV: 'development',
      SANDBOX_INTERNAL_HMAC_KEYRING: KEYRING_JSON,
      SANDBOX_INTERNAL_HMAC_ACTIVE_KID: TEST_KID,
      SANDBOX_API_TOKEN: TEST_API_TOKEN,
      SANDBOX_WORKSPACES_ROOT: join(tmpdir(), 'exec-recover-db-ws'),
      SANDBOX_TEMP_ROOT: join(tmpdir(), 'exec-recover-db-tmp'),
      EXEC_DATABASE_URL: 'mysql://exec:secret@127.0.0.1:1/execdb',
    } as NodeJS.ProcessEnv);
    try {
      await assert.rejects(() => runtime.recoverOrphans());
    } finally {
      await runtime.dispose();
    }
  });
});
