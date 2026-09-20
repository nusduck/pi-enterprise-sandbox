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
 *
 * ## 2026-09-19（K8s 部署评审 K2）
 *
 * 投影改为「启用的配置清单 × 当前注册表」：连不上的服务器保留为 `unavailable`
 * 并使 `ready: false`；`/ready` 每次重读注册表，不再只看启动期快照。
 */
import { createMcpReadinessReader } from '../runtime/index.js';

type Loose = any;

/** 插件树起来后返回的同步投影函数；每次调用都重读 DSH 工具注册表。 */
type McpReadinessReader = () => Loose;

export class McpDiscoveryState {
  /** 最近一次投影（失败时是明确的失败快照）。 */
  snapshot: Loose = null;
  inFlight: Promise<object> | null = null;
  /** preflight 成功后的实时投影；有它时 `readiness()` 不再读快照。 */
  #reader: McpReadinessReader | null = null;
  readonly #createReader: () => Promise<McpReadinessReader>;

  constructor(opts: { createReader?: () => Promise<McpReadinessReader> } = {}) {
    this.#createReader = opts.createReader ?? (() => createMcpReadinessReader());
  }

  /**
   * 确保插件树起来并记下实时投影函数。
   *
   * 起插件树是幂等的（`sharedEnterpriseRuntime()` 全进程一次），所以这里
   * 「preflight」实际上就是「确保那棵树起来了，然后看注册表」。
   */
  async preflight(opts: { force?: boolean } = {}) {
    if (this.snapshot && opts.force !== true) return this.readiness();
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.#createReader()
      .then((reader) => {
        this.#reader = reader;
        const snapshot = reader();
        this.snapshot = snapshot;
        for (const server of snapshot.servers) {
          if (server.connection_status === 'connected') {
            console.log(
              `[agent-mcp] MCP Server connected id=${server.server_id} tools=${server.tools.length}`,
            );
          } else {
            console.error(
              `[agent-mcp] MCP Server unavailable id=${server.server_id} (enabled, no tools registered)`,
            );
          }
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
        return this.snapshot as object;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /**
   * 当前就绪度。preflight 成功后每次都从注册表重算（K8s 部署评审 K2）：
   * 服务器恢复、重连预算耗尽、工具变化都直接反映，不停留在启动快照上。
   */
  readiness() {
    if (this.#reader !== null) {
      try {
        this.snapshot = this.#reader();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.snapshot = { ...(this.snapshot ?? {}), ready: false, error: message };
      }
      return this.snapshot;
    }
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

  /**
   * 给 AgentVersion 校验用的工具清单。它的 `ready` 表示「清单可知」（插件树起来、
   * 注册表可读），**不是** /ready 的「全部服务器可用」：一台 MCP 不可用时，它的
   * 工具只是不在清单里（→ MCP_TOOL_UNAVAILABLE），其他服务器的引用照常校验。
   */
  inventory() {
    const current = this.readiness();
    return { ...current, ready: this.#reader !== null && current.error === undefined };
  }
}
