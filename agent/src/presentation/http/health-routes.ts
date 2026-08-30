/**
 * `/health` 与 `/ready` 两条诊断路由。
 *
 * 和 cron-routes 同一约定：返回 `true` 表示"这个请求归我处理了"，`false` 表示
 * "不是我的路由"，调用方据此继续往下匹配。抽出来是因为它们和业务路由无关——
 * 只读若干探针、拼一份运维快照——却占了 create-http-server 六十多行。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json } from './request-response.js';

/** /ready 里回给运维的 MCP 快照形状。 */
export interface McpReadiness {
  ready?: boolean;
  serverCount?: number;
  toolCount?: number;
  servers?: McpServerReadiness[];
}

/** /ready 逐条展开的单个 MCP server。原 JSDoc 只写了 `object[]`，读不到这四个字段。 */
export interface McpServerReadiness {
  serverId?: string;
  status?: string;
  toolCount?: number;
  error?: unknown;
}

export interface HealthRouteInput {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly path: string;
  readonly activeRunHint?: (() => number) | undefined;
  readonly dataPlaneReady?: boolean | (() => boolean | Promise<boolean>) | undefined;
  readonly sandboxHealthCheck?: (() => Promise<{ status?: string } | null>) | undefined;
  readonly mcpReadiness?: (() => McpReadiness) | undefined;
}

export async function handleHealthRoute(input: HealthRouteInput): Promise<boolean> {
  const { req, res, path } = input;

  if (req.method === 'GET' && path === '/health') {
    json(res, 200, {
      status: 'ok',
      service: 'pi-enterprise-agent',
      version: '4.0.0',
      active_runs: input.activeRunHint ? input.activeRunHint() : 0,
      authority: 'mysql',
    });
    return true;
  }

  if (req.method === 'GET' && path === '/ready') {
    let dataPlaneOk = true;
    if (input.dataPlaneReady === false) {
      dataPlaneOk = false;
    } else if (typeof input.dataPlaneReady === 'function') {
      try {
        dataPlaneOk = Boolean(await input.dataPlaneReady());
      } catch {
        dataPlaneOk = false;
      }
    } else if (input.dataPlaneReady === undefined) {
      // Default: require explicit data plane when not injected as ready.
      dataPlaneOk = true;
    }

    let sandboxOk = true;
    if (input.sandboxHealthCheck) {
      try {
        const h = await input.sandboxHealthCheck();
        sandboxOk = h?.status === 'ok';
      } catch {
        sandboxOk = false;
      }
    }

    let mcp: McpReadiness = { ready: true, serverCount: 0, toolCount: 0, servers: [] };
    if (typeof input.mcpReadiness === 'function') {
      try {
        mcp = input.mcpReadiness() || mcp;
      } catch {
        mcp = { ...mcp, ready: false };
      }
    }
    const mcpOk = mcp.ready !== false;

    const ready = dataPlaneOk && sandboxOk && mcpOk;
    json(res, ready ? 200 : 503, {
      status: ready ? 'ready' : 'not_ready',
      data_plane: dataPlaneOk ? 'ok' : 'unavailable',
      sandbox: sandboxOk ? 'ok' : 'unreachable',
      mcp: {
        status: mcpOk ? 'ok' : 'unreachable',
        server_count: Number(mcp.serverCount) || 0,
        tool_count: Number(mcp.toolCount) || 0,
        servers: Array.isArray(mcp.servers)
          ? mcp.servers.map((server) => ({
              id: server.serverId,
              status: server.status,
              tool_count: Number(server.toolCount) || 0,
              ...(server.error ? { error: String(server.error) } : {}),
            }))
          : [],
      },
    });
    return true;
  }

  return false;
}
