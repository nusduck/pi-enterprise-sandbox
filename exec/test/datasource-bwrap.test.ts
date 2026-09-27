/**
 * 数据源在**真实 Bubblewrap** 下的连通性（design `sandbox-data-sources.md` §8 第 1 步）：
 *
 * - 子进程仍在 `--unshare-net` 的空网络命名空间里，TCP 一律不可达；
 * - 只读挂载进来的 unix socket 能连，数据经 exec 转发到登记的地址；
 * - 注入的环境变量在子进程里可见。
 *
 * 需要 bwrap、python3 与非 root 用户（与生产一致），否则跳过——macOS 与多数 CI 容器
 * 跑不了，在带 `exec/seccomp-bubblewrap.json` 的 Linux 容器里以 uid 10001 执行。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { readDataSourceCatalog } from '../src/datasource/catalog.js';
import { DataSourceService } from '../src/datasource/service.js';
import { IsolatedShellExecutor } from '../src/shell/executor.js';
import { makeTestWorkspace } from './helpers.js';

const bwrap = spawnSync('which', ['bwrap'], { encoding: 'utf-8' }).stdout?.trim() ?? '';
const python = spawnSync('which', ['python3'], { encoding: 'utf-8' }).stdout?.trim() ?? '';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const skip = !bwrap || !existsSync(bwrap) || !python || isRoot ? 'needs bwrap + python3 as a non-root user' : false;

const PROBE = String.raw`
import os, socket
path = os.environ["DSH_DB_EMPLOYEES_SOCKET"]
s = socket.socket(socket.AF_UNIX); s.connect(path); s.sendall(b"ping")
print("unix:", s.recv(100).decode())
print("user:", os.environ["DSH_DB_EMPLOYEES_USER"], "sources:", os.environ["DSH_DB_SOURCES"])
host, port = os.environ["UPSTREAM"].split(":")
t = socket.socket(); t.settimeout(2)
try:
    t.connect((host, int(port))); print("tcp: CONNECTED")
except OSError as e:
    print("tcp: blocked", e.errno)
print("pw:", os.environ["DSH_DB_EMPLOYEES_PASSWORD"])
`;

test('断网子进程经 socket 连到业务库，TCP 仍不可达', { skip }, async () => {
  const sockets = new Set<net.Socket>();
  const db = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('data', (chunk) => socket.write(`db:${chunk.toString()}`));
  });
  await new Promise<void>((resolve) => db.listen(0, '127.0.0.1', resolve));
  const port = (db.address() as net.AddressInfo).port;
  const ws = await makeTestWorkspace();
  const socketBase = await mkdtemp('/tmp/dsh-dsb-');
  try {
    const service = new DataSourceService({
      catalog: readDataSourceCatalog({
        SANDBOX_DATA_SOURCES_JSON: JSON.stringify([
          { id: 'employees', label: 'HR', endpoint: `127.0.0.1:${port}`, database: 'hr', dbpmDbName: 'hr', userName: 'reader' },
        ]),
      }),
      passwords: new Map([['employees', 'pw-in-env']]),
      socketRoot: join(socketBase, 'dbs'),
      audit: () => undefined,
    });
    const session = await service.open(['employees'], {
      requestId: 'r',
      orgId: 'o',
      userId: 'u',
      workspaceId: 'w',
    });
    try {
      const exec = new IsolatedShellExecutor({
        workspace: { ...ws.context, dataSources: session.mounts },
        bwrapExecutable: bwrap,
        mode: 'workspace-write',
      });
      const spec = exec.resolve({
        command: `python3 -c '${PROBE.replaceAll("'", "'\\''")}'`,
        env: { UPSTREAM: `127.0.0.1:${port}` },
      });
      const result = await exec.run(spec);
      assert.equal(result.exitCode, 0, result.stderr.text);
      assert.match(result.stdout.text, /unix: db:ping/);
      assert.match(result.stdout.text, /user: reader sources: employees/);
      assert.match(result.stdout.text, /tcp: blocked/);
      assert.doesNotMatch(result.stdout.text, /tcp: CONNECTED/);
      // 执行器本身不脱敏（那是路由的事），这里证明口令确实进了子进程环境。
      assert.match(result.stdout.text, /pw: pw-in-env/);

      // 没有数据源的同一执行器：socket 路径不存在。
      const bare = new IsolatedShellExecutor({ workspace: ws.context, bwrapExecutable: bwrap, mode: 'workspace-write' });
      const none = await bare.run(bare.resolve({ command: 'ls /run/dsh-db 2>&1; env | grep -c DSH_DB_ || true' }));
      assert.match(none.stdout.text, /No such file or directory/);
      assert.match(none.stdout.text.trim(), /0$/);
    } finally {
      await session.close();
    }
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => db.close(resolve));
    await ws.cleanup();
    await rm(socketBase, { recursive: true, force: true });
  }
});
