/**
 * MCP 发现状态机（从 container 抽出）。
 *
 * 装在自己的类里而不是留在 ServiceContainer 上，是因为它有一组只属于它的
 * 可变状态——快照、上次尝试时间、在途 promise、后台重探定时器——四个字段
 * 只被这三个方法读写。容器保留 `preflightMcpServers()` / `getMcpReadiness()`
 * 两个转发方法，外部调用点（http-main 的 /ready）不受影响。
 */

type Loose = any;

export class McpDiscoveryState {
  readonly #env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /**
   * Latest MCP discovery snapshot (may be incomplete after a cold-start
   * failure). Refreshed by {@link preflight}; incomplete results are not
   * permanent — later force/cooldown refreshes can recover tools.
   */
  snapshot: Loose = null;
  /** epoch ms of last discovery attempt */
  attemptedAt = 0;
  inFlight: Promise<object> | null = null;
  rediscoveryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(env: NodeJS.ProcessEnv | Record<string, string | undefined>) {
    this.#env = env;
  }

  /** 停掉后台重探。容器 shutdown 时调用。 */
  stop(): void {
    if (this.rediscoveryTimer) {
      clearInterval(this.rediscoveryTimer);
      this.rediscoveryTimer = null;
    }
  }

  /**
   * Connect enabled MCP_SERVERS_JSON entries and run adapter-owned tools/list
   * discovery. Retries transient Streamable-HTTP → SSE 405 races at worker
   * boot. Incomplete snapshots are retained for /ready diagnostics but can be
   * refreshed (force or cooldown) so runs are not stuck without MCP forever.
   */
  async preflight(
    opts: { force?: boolean; maxAttempts?: number; retryCooldownMs?: number } = {},
  ) {
    const force = opts.force === true;
    const retryCooldownMs = Number.isFinite(opts.retryCooldownMs)
      ? Math.max(0, Number(opts.retryCooldownMs))
      : 30_000;
    const maxAttempts = Math.max(
      1,
      Math.min(5, Number.isFinite(opts.maxAttempts) ? Number(opts.maxAttempts) : 3),
    );

    if (this.snapshot && !force) {
      const complete =
        this.snapshot.ready === true ||
        Number(this.snapshot.serverCount ?? 0) === 0 ||
        Number(this.snapshot.toolCount ?? 0) > 0;
      if (complete) return this.snapshot;
      const age = Date.now() - (this.attemptedAt || 0);
      if (age < retryCooldownMs) return this.snapshot;
      // Incomplete and cooldown elapsed → fall through to rediscover.
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = import(
      '../infrastructure/mcp/pi-mcp-adapter-factory.js'
    )
      .then(async ({ createEnvironmentSecretResolver, discoverEnabledMcpServers }) => {
        const secretResolver = createEnvironmentSecretResolver(this.#env);
        const cwd =
          this.#env.AGENT_PI_DEFAULT_CWD ||
          this.#env.AGENT_SESSION_WORKSPACE_CWD ||
          undefined;
        const serverRegistry = this.#env.MCP_SERVERS_JSON || '[]';

        let snapshot: Loose = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          snapshot = await discoverEnabledMcpServers({
            serverRegistry,
            secretResolver,
            cwd,
          });
          if (
            snapshot.ready === true ||
            Number(snapshot.serverCount ?? 0) === 0 ||
            Number(snapshot.toolCount ?? 0) > 0
          ) {
            break;
          }
          if (attempt < maxAttempts) {
            const delayMs = 750 * attempt;
            console.warn(
              `[agent-mcp] discovery incomplete (attempt ${attempt}/${maxAttempts}); retrying in ${delayMs}ms`,
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }

        this.snapshot = snapshot;
        this.attemptedAt = Date.now();
        for (const server of snapshot?.servers ?? []) {
          if (server.status === 'connected') {
            console.log(
              `[agent-mcp] MCP Server connected id=${server.serverId} tools=${server.toolCount}`,
            );
          } else {
            console.error(
              `[agent-mcp] MCP readiness error id=${server.serverId}: ${server.error}`,
            );
          }
        }
        // Background rediscovery if still incomplete so a later run can pick
        // up tools without a process restart.
        this.#ensureRediscoveryLoop();
        return snapshot;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /**
   * When bootstrap discovery left servers unreachable, periodically re-probe
   * so worker runs can gain MCP tools without a restart.
   */
  #ensureRediscoveryLoop() {
    if (this.rediscoveryTimer) return;
    if (this.snapshot?.ready === true) return;
    if (Number(this.snapshot?.serverCount ?? 0) === 0) return;
    this.rediscoveryTimer = setInterval(() => {
      if (this.snapshot?.ready === true || Number(this.snapshot?.toolCount ?? 0) > 0) {
        if (this.rediscoveryTimer) {
          clearInterval(this.rediscoveryTimer);
          this.rediscoveryTimer = null;
        }
        return;
      }
      void this.preflight({ force: true, maxAttempts: 2 }).catch((err) => {
        console.error(
          '[agent-mcp] background rediscovery failed:',
          err instanceof Error ? err.message : err,
        );
      });
    }, 30_000);
    if (typeof this.rediscoveryTimer.unref === 'function') {
      this.rediscoveryTimer.unref();
    }
  }

  readiness() {
    return (
      this.snapshot ?? {
        ready: false,
        serverCount: 0,
        toolCount: 0,
        servers: [],
        mcpServers: [],
      }
    );
  }
}
