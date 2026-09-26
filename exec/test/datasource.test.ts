/**
 * 数据源（design `sandbox-data-sources.md`）：目录解析、转发器、输出脱敏、隔离层注入、
 * 内部 shell 路由接线。全部不起 bwrap；真实隔离下的连通性见 `datasource-bwrap.test.ts`。
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { Hono } from 'hono';
import type { ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell';
import { ContractError } from '@dsh/contract/errors.js';
import {
  DataSourceConfigError,
  plaintextExecEnvSecrets,
  readDataSourceCatalog,
  type DataSourceConfig,
} from '../src/datasource/catalog.js';
import type { ConnectionAuditRecord } from '../src/datasource/forwarder.js';
import { redactSecrets, StreamSecretRedactor } from '../src/datasource/redact.js';
import { DataSourceService, fetchDataSourcePasswords } from '../src/datasource/service.js';
import { buildIsolationProfile } from '../src/isolation/build.js';
import { registerInternalShellRoutes } from '../src/http/internal-shell.js';
import { IsolatedShellExecutor } from '../src/shell/executor.js';
import { MySqlJobRegistry } from '../src/shell/job-registry.js';
import { InMemoryJobStore } from '../src/shell/job-store-memory.js';
import { DEFAULT_SHELL_RESOURCE_LIMITS } from '../src/shell/resource-limits.js';
import { InMemoryQuotaStore } from '../src/workspace/quota-store.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import type { DataSourceMount, WorkspaceContext } from '../src/types.js';

const AUDIT = { requestId: 'req-1', orgId: 'org_a', userId: 'user_a', workspaceId: 'ws_a' };

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'employees',
    label: '员工库',
    endpoint: '127.0.0.1:3306',
    database: 'hr',
    dbpmDbName: 'hr_ro',
    userName: 'reader',
    ...overrides,
  };
}

function catalogOf(...entries: Record<string, unknown>[]): readonly DataSourceConfig[] {
  return readDataSourceCatalog({ SANDBOX_DATA_SOURCES_JSON: JSON.stringify(entries) });
}

async function scratch(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  // macOS 的 tmpdir 很长，unix socket 路径会超 104 字节；统一用 /tmp。
  const base = existsSync('/tmp') ? '/tmp' : tmpdir();
  const dir = await realpath(await mkdtemp(join(base, prefix)));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** 一个假的「业务库」：收到什么回什么，前面加上前缀。 */
async function echoServer(): Promise<{ port: number; close: () => Promise<void>; received: string[] }> {
  const received: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      received.push(chunk.toString());
      socket.write(`db:${chunk.toString()}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    received,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

function roundTrip(socketPath: string, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.connect(socketPath);
    client.once('error', reject);
    client.once('data', (data) => {
      client.end();
      resolve(data.toString());
    });
    client.write(message);
  });
}

describe('readDataSourceCatalog', () => {
  test('未配置即空目录', () => {
    assert.deepEqual(readDataSourceCatalog({}), []);
  });

  test('解析一条合法登记，engine 默认 mysql', () => {
    const [cfg] = catalogOf(entry());
    assert.deepEqual(cfg, {
      id: 'employees',
      label: '员工库',
      description: '',
      engine: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      database: 'hr',
      dbpmDbName: 'hr_ro',
      userName: 'reader',
    });
  });

  test('配置里夹口令直接拒绝，而不是忽略', () => {
    for (const key of ['password', 'pwd', 'dbPassword', 'secret']) {
      assert.throws(() => catalogOf(entry({ [key]: 'x' })), /must not embed credentials/);
    }
  });

  test('非法 id、重复 id、坏 endpoint、未知键、未知引擎都拒绝启动', () => {
    assert.throws(() => catalogOf(entry({ id: 'Bad-Id' })), DataSourceConfigError);
    assert.throws(() => catalogOf(entry(), entry()), /duplicate id/);
    assert.throws(() => catalogOf(entry({ endpoint: 'db-host' })), /host:port/);
    assert.throws(() => catalogOf(entry({ endpoint: 'db:70000' })), /host:port/);
    assert.throws(() => catalogOf(entry({ url: 'mysql://x' })), /unsupported key/);
    assert.throws(() => catalogOf(entry({ engine: 'postgres' })), /engine/);
    assert.throws(() => readDataSourceCatalog({ SANDBOX_DATA_SOURCES_JSON: '{' }), /valid JSON/);
  });

  test('找出 SANDBOX_EXEC_ENV_* 里看起来像口令的旧写法', () => {
    assert.deepEqual(
      plaintextExecEnvSecrets({
        SANDBOX_EXEC_ENV_EMPLOYEES_DB_PWD: 'x',
        SANDBOX_EXEC_ENV_EMPLOYEES_DB_HOST: 'h',
        SANDBOX_EXEC_ENV_X_PASSWORD: 'y',
        SANDBOX_EXEC_ENV_EMPLOYEES_DSN: 'mysql+pymysql://app:s3cret@db:3306/hr',
        SANDBOX_EXEC_ENV_PLAIN_DSN: 'mysql://db:3306/hr',
        OTHER_PWD: 'z',
      }),
      ['SANDBOX_EXEC_ENV_EMPLOYEES_DB_PWD', 'SANDBOX_EXEC_ENV_EMPLOYEES_DSN', 'SANDBOX_EXEC_ENV_X_PASSWORD'],
    );
  });
});

describe('fetchDataSourcePasswords', () => {
  const env = { DBPM_URL: 'dbpm-a:7000,dbpm-b:7001' };

  test('按目录逐个取密；单个失败只让它不可用', async () => {
    const logs: string[] = [];
    const passwords = await fetchDataSourcePasswords(
      catalogOf(entry(), entry({ id: 'sales', dbpmDbName: 'sales_ro' })),
      env,
      {
        fetchPassword: async (_endpoints, e) => {
          if (e.dbName === 'sales_ro') throw Object.assign(new Error('boom'), { code: 'ALL_ENDPOINTS_FAILED' });
          return `pw-${e.dbName}-${e.userName}`;
        },
        log: (line) => logs.push(line),
      },
    );
    assert.deepEqual([...passwords], [['employees', 'pw-hr_ro-reader']]);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /sales is unavailable \(DBPM ALL_ENDPOINTS_FAILED\)/);
    assert.doesNotMatch(logs[0]!, /boom/);
  });

  test('配了数据源但 DBPM 端点缺失 → 抛出（拒绝启动）', async () => {
    await assert.rejects(fetchDataSourcePasswords(catalogOf(entry()), {}), /DBPM_URL/);
  });

  test('没配数据源不碰 DBPM', async () => {
    const passwords = await fetchDataSourcePasswords([], {}, {
      fetchPassword: async () => assert.fail('must not fetch'),
    });
    assert.equal(passwords.size, 0);
  });
});

describe('secret redaction', () => {
  test('全文替换，长口令优先', () => {
    assert.equal(redactSecrets('a=s3cr3t b=s3cr3t-long', ['s3cr3t', 's3cr3t-long']), 'a=*** b=***');
  });

  test('流式：口令被切在两次读取之间也不会漏出', () => {
    const r = new StreamSecretRedactor(['hunter2']);
    const out = [r.push('pw=hun', false), r.push('ter2 done', false), r.push('', true)].join('');
    assert.equal(out, 'pw=*** done');
    // 任何一次单独的输出都不含口令的片段拼接
    const r2 = new StreamSecretRedactor(['hunter2']);
    const parts = ['hu', 'nt', 'er', '2!'].map((d) => r2.push(d, false));
    parts.push(r2.push('', true));
    assert.equal(parts.join(''), '***!');
    assert.ok(parts.every((p) => !p.includes('hunter2')));
  });

  test('流式：普通输出只扣住末尾 口令长度-1 个字符，结束时全部放出', () => {
    const r = new StreamSecretRedactor(['abcd']);
    assert.equal(r.push('hello world', false), 'hello wo');
    assert.equal(r.push('', true), 'rld');
  });
});

describe('DataSourceService', () => {
  test('转发到登记的地址、审计只记元数据、close 后目录消失', async () => {
    const db = await echoServer();
    const { dir, cleanup } = await scratch('dsh-ds-');
    const audits: ConnectionAuditRecord[] = [];
    try {
      const service = new DataSourceService({
        catalog: catalogOf(entry({ endpoint: `127.0.0.1:${db.port}` })),
        passwords: new Map([['employees', 'pw-1']]),
        socketRoot: join(dir, 'dbs'),
        audit: (r) => audits.push(r),
      });
      const session = await service.open(['employees'], AUDIT);
      const [mount] = session.mounts;
      assert.equal(mount!.id, 'employees');
      assert.equal(mount!.secret, 'pw-1');
      assert.deepEqual(mount!.env, {
        DSH_DB_EMPLOYEES_ENGINE: 'mysql',
        DSH_DB_EMPLOYEES_SOCKET: '/run/dsh-db/employees/mysql.sock',
        DSH_DB_EMPLOYEES_DATABASE: 'hr',
        DSH_DB_EMPLOYEES_USER: 'reader',
        DSH_DB_EMPLOYEES_PASSWORD: 'pw-1',
      });
      assert.equal(await roundTrip(join(mount!.hostDir, 'mysql.sock'), 'SELECT 1'), 'db:SELECT 1');
      await session.close();
      await session.close();
      assert.equal(existsSync(mount!.hostDir), false);
      assert.deepEqual(await readdir(join(dir, 'dbs')), []);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(audits.length, 1);
      assert.equal(audits[0]!.dataSourceId, 'employees');
      assert.equal(audits[0]!.orgId, 'org_a');
      assert.equal(audits[0]!.bytesToDatabase, 'SELECT 1'.length);
      assert.equal(JSON.stringify(audits).includes('pw-1'), false);
    } finally {
      await cleanup();
      await db.close();
    }
  });

  test('未登记 → DATA_SOURCE_UNKNOWN；没取到口令 → DATA_SOURCE_UNAVAILABLE；都不留目录', async () => {
    const { dir, cleanup } = await scratch('dsh-ds-');
    try {
      const service = new DataSourceService({
        catalog: catalogOf(entry()),
        passwords: new Map(),
        socketRoot: join(dir, 'dbs'),
      });
      await assert.rejects(service.open(['sales'], AUDIT), (e: unknown) => e instanceof ContractError && e.code === 'DATA_SOURCE_UNKNOWN');
      await assert.rejects(service.open(['employees'], AUDIT), (e: unknown) => e instanceof ContractError && e.code === 'DATA_SOURCE_UNAVAILABLE');
      assert.equal(existsSync(join(dir, 'dbs')), false);
    } finally {
      await cleanup();
    }
  });

  test('单次执行连接数到上限后拒绝新连接', async () => {
    const db = await echoServer();
    const { dir, cleanup } = await scratch('dsh-ds-');
    const audits: ConnectionAuditRecord[] = [];
    try {
      const service = new DataSourceService({
        catalog: catalogOf(entry({ endpoint: `127.0.0.1:${db.port}` })),
        passwords: new Map([['employees', 'pw']]),
        socketRoot: join(dir, 'dbs'),
        limits: { connectTimeoutMs: 1000, idleTimeoutMs: 5000, maxConnectionsPerExecution: 1, maxConnectionsPerSource: 10 },
        audit: (r) => audits.push(r),
      });
      const session = await service.open(['employees'], AUDIT);
      const sock = join(session.mounts[0]!.hostDir, 'mysql.sock');
      const first = net.connect(sock);
      await new Promise((r) => first.once('connect', r));
      await new Promise((r) => setTimeout(r, 30));
      const second = net.connect(sock);
      await new Promise((r) => second.once('close', r));
      assert.ok(audits.some((a) => a.closeReason === 'rejected_execution_limit'));
      first.destroy();
      await session.close();
    } finally {
      await cleanup();
      await db.close();
    }
  });

  test('socket 根太长时拒绝装配（unix socket 路径 108 字节上限）', () => {
    assert.throws(
      () => new DataSourceService({ catalog: catalogOf(entry()), passwords: new Map(), socketRoot: `/${'x'.repeat(80)}` }),
      /too long/,
    );
  });
});

describe('隔离层注入', () => {
  const ctx = (dataSources?: DataSourceMount[]): WorkspaceContext => ({
    orgId: 'o',
    userId: 'u',
    workspaceId: 'w',
    workspaceRoot: '/phys/ws',
    tempRoot: '/phys/tmp',
    systemSkillRoot: '/phys/skills',
    enabledSkillPackages: [],
    ...(dataSources !== undefined ? { dataSources } : {}),
  });
  const mount: DataSourceMount = {
    id: 'employees',
    hostDir: '/phys/control/dbs/abc/employees',
    env: { DSH_DB_EMPLOYEES_SOCKET: '/run/dsh-db/employees/mysql.sock', DSH_DB_EMPLOYEES_PASSWORD: 'pw' },
    secret: 'pw',
  };
  const build = (c: WorkspaceContext, envOverrides: Record<string, string> = {}) =>
    buildIsolationProfile({
      context: c,
      mode: 'workspace-write',
      command: ['true'],
      envOverrides,
      writableRootsFn: () => ['/phys/ws', '/phys/tmp'],
    });

  test('只读挂载 socket 目录、注入环境变量，网络命名空间仍然隔离', () => {
    const profile = build(ctx([mount]));
    assert.ok(profile.namespace.namespaces.includes('net'));
    const m = profile.mounts.find((x) => x.target === '/run/dsh-db/employees');
    assert.deepEqual(m, {
      kind: 'ro_bind',
      source: '/phys/control/dbs/abc/employees',
      target: '/run/dsh-db/employees',
      required: true,
      sessionSpecific: true,
    });
    assert.equal(profile.env.vars['DSH_DB_SOURCES'], 'employees');
    assert.equal(profile.env.vars['DSH_DB_EMPLOYEES_PASSWORD'], 'pw');
  });

  test('没有数据源时不挂载、不注入；调用方传入的 DSH_DB_* 一律丢弃', () => {
    const profile = build(ctx(), { DSH_DB_EMPLOYEES_SOCKET: '/tmp/evil.sock', dsh_db_x: '1', KEEP: 'yes' });
    assert.equal(profile.mounts.some((x) => x.target.startsWith('/run/dsh-db')), false);
    assert.equal(profile.env.vars['DSH_DB_EMPLOYEES_SOCKET'], undefined);
    assert.equal(profile.env.vars['dsh_db_x'], undefined);
    assert.equal(profile.env.vars['KEEP'], 'yes');
    const withSource = build(ctx([mount]), { DSH_DB_EMPLOYEES_SOCKET: '/tmp/evil.sock' });
    assert.equal(withSource.env.vars['DSH_DB_EMPLOYEES_SOCKET'], '/run/dsh-db/employees/mysql.sock');
  });
});

describe('内部 shell 路由接线', () => {
  const ENVELOPE = { requestId: 'req-1', orgId: 'org_a', userId: 'user_a', workspaceId: 'ws_a', fenceToken: 1 };

  async function harness(service: DataSourceService | undefined) {
    const { dir, cleanup } = await scratch('dsh-ds-route-');
    const app = new Hono();
    const jobRegistry = new MySqlJobRegistry(new InMemoryJobStore());
    registerInternalShellRoutes(app, {
      workspaceManager: new WorkspaceManager({ workspacesBaseRoot: join(dir, 'ws'), tempBaseRoot: join(dir, 'tmp') }),
      jobRegistry,
      systemSkillRoot: join(dir, 'skills'),
      enabledSkillPackagesFor: () => [],
      bwrapExecutable: '/unused',
      modeFor: () => 'workspace-write',
      resourceLimits: DEFAULT_SHELL_RESOURCE_LIMITS,
      quotaStore: new InMemoryQuotaStore(),
      ...(service !== undefined ? { dataSources: service } : {}),
    });
    return { app, dir, jobRegistry, cleanup };
  }

  const post = (app: Hono, path: string, body: Record<string, unknown>) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envelope: ENVELOPE, ...body }),
    });

  function result(spec: ShellExecSpec, stdout: string): ShellRunResult {
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: stdout, truncated: false },
      stderr: { text: '', truncated: false },
      sandbox: { mode: 'workspace-write', denied: false },
    };
  }

  test('run：清单里的数据源在执行期间可连、口令被脱敏、结束后收回', async () => {
    const db = await echoServer();
    const scratchRoot = await scratch('dsh-ds-sock-');
    const service = new DataSourceService({
      catalog: catalogOf(entry({ endpoint: `127.0.0.1:${db.port}` })),
      passwords: new Map([['employees', 'topsecret-pw']]),
      socketRoot: join(scratchRoot.dir, 'dbs'),
      audit: () => undefined,
    });
    const h = await harness(service);
    const original = IsolatedShellExecutor.prototype.run;
    let seenMounts: readonly DataSourceMount[] | undefined;
    let reply = '';
    IsolatedShellExecutor.prototype.run = async function (this: IsolatedShellExecutor, spec: ShellExecSpec) {
      seenMounts = this.workspace.dataSources;
      reply = await roundTrip(join(seenMounts![0]!.hostDir, 'mysql.sock'), 'ping');
      return result(spec, 'password is topsecret-pw');
    };
    try {
      const res = await post(h.app, '/internal/v1/shell/run', { payload: { command: 'python q.py' }, dataSources: ['employees'] });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { data: ShellRunResult };
      assert.equal(body.data.stdout.text, 'password is ***');
      assert.equal(reply, 'db:ping');
      assert.equal(seenMounts?.length, 1);
      assert.equal(existsSync(seenMounts![0]!.hostDir), false);
    } finally {
      IsolatedShellExecutor.prototype.run = original;
      await h.cleanup();
      await scratchRoot.cleanup();
      await db.close();
    }
  });

  test('run：不带清单时不挂任何数据源', async () => {
    const scratchRoot = await scratch('dsh-ds-sock-');
    const service = new DataSourceService({
      catalog: catalogOf(entry()),
      passwords: new Map([['employees', 'pw']]),
      socketRoot: join(scratchRoot.dir, 'dbs'),
    });
    const h = await harness(service);
    const original = IsolatedShellExecutor.prototype.run;
    let seen: unknown = 'unset';
    IsolatedShellExecutor.prototype.run = async function (this: IsolatedShellExecutor, spec: ShellExecSpec) {
      seen = this.workspace.dataSources;
      return result(spec, '');
    };
    try {
      const res = await post(h.app, '/internal/v1/shell/run', { payload: { command: 'true' } });
      assert.equal(res.status, 200);
      assert.deepEqual(seen, []);
    } finally {
      IsolatedShellExecutor.prototype.run = original;
      await h.cleanup();
      await scratchRoot.cleanup();
    }
  });

  test('start：后台输出里跨段的口令被脱敏，作业结束后收回 socket 目录', async () => {
    const scratchRoot = await scratch('dsh-ds-sock-');
    const service = new DataSourceService({
      catalog: catalogOf(entry()),
      passwords: new Map([['employees', 'hunter2']]),
      socketRoot: join(scratchRoot.dir, 'dbs'),
    });
    const h = await harness(service);
    const original = IsolatedShellExecutor.prototype.start;
    let hostDir = '';
    let finish: () => void = () => undefined;
    const chunks = ['pw=hun', 'ter2 ok\n'];
    IsolatedShellExecutor.prototype.start = function (this: IsolatedShellExecutor): ShellProcess {
      hostDir = this.workspace.dataSources![0]!.hostDir;
      const done = new Promise<void>((resolve) => {
        finish = () => {
          proc.status = 'completed';
          proc.exitCode = 0;
          resolve();
        };
      });
      const proc: ShellProcess = {
        status: 'running',
        exitCode: null,
        signal: null,
        done,
        readOutput: () => ({ delta: chunks.shift() ?? '', lossy: false }),
        kill: () => false,
      };
      return proc;
    };
    try {
      const res = await post(h.app, '/internal/v1/shell/start', { payload: { command: 'python q.py' }, dataSources: ['employees'] });
      assert.equal(res.status, 200);
      const { data: snapshot } = (await res.json()) as { data: { id: string } };
      const owner = { orgId: 'org_a', userId: 'user_a', workspaceId: 'ws_a' };
      const first = JSON.stringify(await h.jobRegistry.read(snapshot.id, owner, null, 100));
      assert.equal(first.includes('hun'), false, 'a partial secret must be held back');
      assert.equal(existsSync(hostDir), true);
      finish();
      await new Promise((r) => setTimeout(r, 50));
      const all = JSON.stringify(await h.jobRegistry.read(snapshot.id, owner, null, 100));
      assert.match(all, /pw=\*\*\* ok/);
      assert.equal(all.includes('hunter2'), false);
      assert.equal(existsSync(hostDir), false);
    } finally {
      IsolatedShellExecutor.prototype.start = original;
      await h.cleanup();
      await scratchRoot.cleanup();
    }
  });

  test('未登记的数据源 400、没配数据源服务也 400、不可用 503——都不执行', async () => {
    const scratchRoot = await scratch('dsh-ds-sock-');
    const service = new DataSourceService({
      catalog: catalogOf(entry()),
      passwords: new Map(),
      socketRoot: join(scratchRoot.dir, 'dbs'),
    });
    const original = IsolatedShellExecutor.prototype.run;
    let ran = false;
    IsolatedShellExecutor.prototype.run = async function (spec: ShellExecSpec) {
      ran = true;
      return result(spec, '');
    };
    const configured = await harness(service);
    const unconfigured = await harness(undefined);
    try {
      const cases: [Hono, string[], number, string][] = [
        [configured.app, ['sales'], 400, 'DATA_SOURCE_UNKNOWN'],
        [unconfigured.app, ['employees'], 400, 'DATA_SOURCE_UNKNOWN'],
        [configured.app, ['employees'], 503, 'DATA_SOURCE_UNAVAILABLE'],
        [configured.app, ['BAD'], 400, 'ENVELOPE_INVALID'],
      ];
      for (const [app, ids, status, code] of cases) {
        for (const path of ['/internal/v1/shell/run', '/internal/v1/shell/start']) {
          const res = await post(app, path, { payload: { command: 'true' }, dataSources: ids });
          assert.equal(res.status, status, `${path} ${ids.join(',')}`);
          const body = (await res.json()) as { error: { code: string } };
          assert.equal(body.error.code, code);
        }
      }
      assert.equal(ran, false);
    } finally {
      IsolatedShellExecutor.prototype.run = original;
      await configured.cleanup();
      await unconfigured.cleanup();
      await scratchRoot.cleanup();
    }
  });
});
