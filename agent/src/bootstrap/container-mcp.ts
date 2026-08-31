/**
 * MCP 就绪度（从 container 抽出）。
 *
 * ## 2026-08-31 重写（ADR 0009 D9 / 计划 H7.6）
 *
 * 以前这里是一台**自建的发现状态机**：用钉死的 `pi-mcp-adapter` 连每一台 MCP
 * 服务器、自己跑 `tools/list`、自己缓存快照、自己做冷启动重探与后台轮询
 * （约 120 行状态：快照 / 上次尝试时间 / 在途 promise / 重探定时器）。
 *
 * 换成出厂 `@deepseek-ai/dsh-mcp-client` 之后这些全都不需要了：
 * 连接、退避重连、`notifications/tools/list_changed` 重新同步、超时与 abort
 * 都由那个插件负责，而**它注册到 `ctx.tools` 上的东西就是模型看得见的东西**。
 * 所以就绪度改成**投影 DSH 的工具注册表**——一个事实源，不再有「adapter 快照说
 * 连上了，循环上却没有那些工具」的可能。
 *
 * 后台重探也一起去掉：出厂插件自己带 supervisor 与退避预算，我们再探一遍
 * 只会连出两套连接。
 */
import { readMcpReadiness } from '../runtime/index.js';

type Loose = any;

export class McpDiscoveryState {
  readonly #env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** 最近一次从注册表读到的投影。 */
  snapshot: Loose = null;
  attemptedAt = 0;
  inFlight: Promise<object> | null = null;

  constructor(env: NodeJS.ProcessEnv | Record<string, string | undefined>) {
    this.#env = env;
  }

  /** 保留给容器 shutdown 调用；现在没有后台定时器要停。 */
  stop(): void {}

  /**
   * 读一次就绪度。
   *
   * 起插件树是幂等的（`sharedEnterpriseRuntime()` 全进程一次），所以这里
   * 「preflight」实际上就是「确保那棵树起来了，然后看注册表」。
   */
  async preflight(opts: { force?: boolean } = {}) {
    if (this.snapshot && opts.force !== true) return this.snapshot;
    if (this.inFlight) return this.inFlight;

    this.inFlight = readMcpReadiness()
      .then((snapshot) => {
        this.snapshot = snapshot;
        this.attemptedAt = Date.now();
        for (const server of snapshot.servers) {
          console.log(
            `[agent-mcp] MCP Server connected id=${server.server_id} tools=${server.tools.length}`,
          );
        }
        return snapshot as unknown as object;
      })
      .catch((err) => {
        // 起不来时**不要**把它当成「没有 MCP」——那会让 /ready 报告一个
        // 看起来正常的空清单。留一条明确的失败快照。
        const message = err instanceof Error ? err.message : String(err);
        console.error('[agent-mcp] readiness projection failed:', message);
        this.snapshot = {
          ready: false,
          serverCount: 0,
          toolCount: 0,
          servers: [],
          mcpServers: [],
          error: message,
        };
        this.attemptedAt = Date.now();
        return this.snapshot as object;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
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

void 0;
