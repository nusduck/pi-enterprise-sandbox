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
  server_id?: string;
  status?: string;
  connection_status?: string;
  toolCount?: number;
  tools?: unknown[];
  error?: unknown;
}

export interface HealthRouteInput {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly path: string;
  readonly activeRunHint?: (() => number) | undefined;
  readonly dataPlaneReady?: boolean | (() => boolean | Promise<boolean>) | undefined;
  /** 执行面 `/ready` 探针；只有 `status: 'ready'` 算就绪（K8s 部署评审 K1）。 */
  readonly sandboxReadyCheck?: (() => Promise<{ status?: string } | null>) | undefined;
  readonly mcpReadiness?: (() => McpReadiness) | undefined;
}

async function checkDataPlane(dataPlaneReady: HealthRouteInput['dataPlaneReady']): Promise<boolean> {
  if (dataPlaneReady === false) return false;
  if (typeof dataPlaneReady === 'function') {
    try {
      return Boolean(await dataPlaneReady());
    } catch {
      return false;
    }
  }
  return true;
}

/** `ok` / `not_ready`（执行面答了但未就绪）/ `unreachable`（没答上）。 */
async function checkSandbox(
  sandboxReadyCheck: HealthRouteInput['sandboxReadyCheck'],
): Promise<'ok' | 'not_ready' | 'unreachable'> {
  if (!sandboxReadyCheck) return 'ok';
  try {
    const result = await sandboxReadyCheck();
    if (result?.status === 'ready') return 'ok';
    return result?.status === 'not_ready' ? 'not_ready' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

export async function handleHealthRoute(input: HealthRouteInput): Promise<boolean> {
  const { req, res, path } = input;

  if (req.method === 'GET' && path === '/health') {
    json(res, 200, {
      status: 'ok',
      service: 'dsh-enterprise-agent',
      version: '4.0.0',
      active_runs: input.activeRunHint ? input.activeRunHint() : 0,
      authority: 'mysql',
    });
    return true;
  }

  if (req.method === 'GET' && path === '/ready') {
    // data plane 与执行面并行探测：两者各自有超时，串行会把最坏耗时相加，
    // 超过 kubelet 探针的 timeoutSeconds。
    const [dataPlaneOk, sandboxStatus] = await Promise.all([
      checkDataPlane(input.dataPlaneReady),
      checkSandbox(input.sandboxReadyCheck),
    ]);
    const sandboxOk = sandboxStatus === 'ok';

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
      sandbox: sandboxStatus,
      mcp: {
        status: mcpOk ? 'ok' : 'unreachable',
        server_count: Number(mcp.serverCount) || 0,
        tool_count: Number(mcp.toolCount) || 0,
        servers: Array.isArray(mcp.servers)
          ? mcp.servers.map((server) => ({
              id: server.serverId ?? server.server_id,
              status: server.status ?? server.connection_status,
              tool_count:
                Number(server.toolCount) ||
                (Array.isArray(server.tools) ? server.tools.length : 0),
              ...(server.error ? { error: String(server.error) } : {}),
            }))
          : [],
      },
    });
    return true;
  }

  return false;
}
