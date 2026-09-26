/**
 * 数据源转发器（design `sandbox-data-sources.md` §4.4）：沙箱内的 unix socket →
 * 目录里登记的 `host:port`，纯字节双向搬运。
 *
 * 子进程仍在 `--unshare-net` 的空网络命名空间里；按路径的 unix socket 走文件系统，
 * bind-mount 进去后照样能 `connect()`。转发目标只来自目录——这里没有任何
 * 「由客户端指定目标」的入口，模型能到达的只有这一处。
 *
 * 不解析、不改写协议：认证、TLS 协商都是客户端与业务库之间的事。
 */

import net from 'node:net';

export interface ForwarderLimits {
  /** 向业务库建连的超时。 */
  readonly connectTimeoutMs: number;
  /** 两端都没有数据往来多久后断开。 */
  readonly idleTimeoutMs: number;
  /** 一次执行里同时打开的连接上限（所有数据源合计）。 */
  readonly maxConnectionsPerExecution: number;
  /** 单个数据源在整个 exec 进程内同时打开的连接上限。 */
  readonly maxConnectionsPerSource: number;
}

export const DEFAULT_FORWARDER_LIMITS: ForwarderLimits = Object.freeze({
  connectTimeoutMs: 10_000,
  idleTimeoutMs: 600_000,
  maxConnectionsPerExecution: 8,
  maxConnectionsPerSource: 64,
});

/** 一条连接结束时的审计记录。只有元数据，没有内容。 */
export interface ConnectionAuditRecord {
  readonly event: 'data_source_connection';
  readonly dataSourceId: string;
  readonly requestId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly agentSessionId?: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly bytesToDatabase: number;
  readonly bytesFromDatabase: number;
  readonly closeReason: string;
}

export type ConnectionAuditSink = (record: ConnectionAuditRecord) => void;

export interface ExecutionAudit {
  readonly requestId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly agentSessionId?: string;
}

export interface ForwardTarget {
  readonly id: string;
  readonly host: string;
  readonly port: number;
}

/** 进程内每个数据源的在途连接计数，跨执行共享。 */
export class SourceConnectionCounter {
  private readonly active = new Map<string, number>();

  tryAcquire(id: string, max: number): boolean {
    const current = this.active.get(id) ?? 0;
    if (current >= max) return false;
    this.active.set(id, current + 1);
    return true;
  }

  release(id: string): void {
    const current = this.active.get(id) ?? 0;
    if (current <= 1) this.active.delete(id);
    else this.active.set(id, current - 1);
  }

  count(id: string): number {
    return this.active.get(id) ?? 0;
  }
}

/** 一次执行的转发状态：若干个监听 socket + 在途连接。 */
export class ExecutionForwarder {
  private readonly servers: net.Server[] = [];
  private readonly sockets = new Set<net.Socket>();
  private open = 0;
  private closed = false;

  constructor(
    private readonly limits: ForwarderLimits,
    private readonly counter: SourceConnectionCounter,
    private readonly audit: ExecutionAudit,
    private readonly sink: ConnectionAuditSink,
    private readonly connect: (target: ForwardTarget) => net.Socket = (t) =>
      net.connect({ host: t.host, port: t.port }),
  ) {}

  /** 在 `socketPath` 上监听，把每个连接转发到 `target`。 */
  async listen(socketPath: string, target: ForwardTarget): Promise<void> {
    if (this.closed) throw new Error('forwarder is closed');
    const server = net.createServer((client) => this.accept(client, target));
    this.servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  }

  /** 停止监听并断开全部在途连接。幂等。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    await Promise.all(
      this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  }

  private accept(client: net.Socket, target: ForwardTarget): void {
    const startedAt = Date.now();
    if (this.closed || this.open >= this.limits.maxConnectionsPerExecution) {
      this.record(target, startedAt, 0, 0, 'rejected_execution_limit');
      client.destroy();
      return;
    }
    if (!this.counter.tryAcquire(target.id, this.limits.maxConnectionsPerSource)) {
      this.record(target, startedAt, 0, 0, 'rejected_source_limit');
      client.destroy();
      return;
    }
    this.open += 1;

    const upstream = this.connect(target);
    this.sockets.add(client);
    this.sockets.add(upstream);
    let toDatabase = 0;
    let fromDatabase = 0;
    let reason = 'closed';
    let finished = false;

    const finish = (why: string): void => {
      if (finished) return;
      finished = true;
      reason = why;
      clearTimeout(connectTimer);
      client.destroy();
      upstream.destroy();
      this.sockets.delete(client);
      this.sockets.delete(upstream);
      this.open -= 1;
      this.counter.release(target.id);
      this.record(target, startedAt, toDatabase, fromDatabase, reason);
    };

    const connectTimer = setTimeout(() => finish('connect_timeout'), this.limits.connectTimeoutMs);
    upstream.once('connect', () => {
      clearTimeout(connectTimer);
      upstream.setTimeout(this.limits.idleTimeoutMs, () => finish('idle_timeout'));
      client.setTimeout(this.limits.idleTimeoutMs, () => finish('idle_timeout'));
    });
    client.on('data', (chunk: Buffer) => {
      toDatabase += chunk.length;
    });
    upstream.on('data', (chunk: Buffer) => {
      fromDatabase += chunk.length;
    });
    client.pipe(upstream);
    upstream.pipe(client);
    // 错误只记类别：业务库的报错原文可能带内网地址，这里不外泄也不需要。
    upstream.on('error', (err: NodeJS.ErrnoException) => finish(`upstream_error:${err.code ?? 'unknown'}`));
    client.on('error', () => finish('client_error'));
    upstream.on('close', () => finish(reason === 'closed' ? 'upstream_closed' : reason));
    client.on('close', () => finish(reason === 'closed' ? 'client_closed' : reason));
  }

  private record(
    target: ForwardTarget,
    startedAt: number,
    bytesToDatabase: number,
    bytesFromDatabase: number,
    closeReason: string,
  ): void {
    try {
      this.sink({
        event: 'data_source_connection',
        dataSourceId: target.id,
        ...this.audit,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        bytesToDatabase,
        bytesFromDatabase,
        closeReason,
      });
    } catch {
      // 审计写失败不能拖垮转发本身。
    }
  }
}
