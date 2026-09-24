/**
 * Routes: GET /health/live and GET /health/ready — liveness and aggregated
 * dependency readiness. Readiness answers 503 when a dependency is not ready,
 * which is what container health checks and the cross-service smoke test rely on.
 *
 * Readiness probes the Agent's and the execution plane's `/ready`, never their
 * `/health`: liveness only says the process is up (K8s deployment review K1,
 * 2026-09-19). Both probes run in parallel so the route stays within one
 * downstream deadline.
 */
import type { ServerResponse } from 'node:http';
import { checkSandboxReady } from '../services/sandbox-client.js';
import { checkAgentReady } from '../services/agent-client.js';
import type { DownstreamReadiness } from '../services/downstream-readiness.js';
import { sendJson } from '../http/response.js';

async function settle(probe: () => Promise<DownstreamReadiness>): Promise<DownstreamReadiness> {
  try {
    return await probe();
  } catch {
    return { status: 'unreachable', body: {} };
  }
}

async function dependencyHealth() {
  const [agent, sandbox] = await Promise.all([settle(checkAgentReady), settle(checkSandboxReady)]);
  const ok = agent.status === 'ready' && sandbox.status === 'ready';
  return {
    status: ok ? 'ok' : 'degraded',
    version: '4.0.0',
    // 只投影状态：本路由免鉴权，下游 body（MCP server 名、错误文本）不外泄。
    agent: { status: agent.status },
    sandbox: { status: sandbox.status },
  };
}

export function handleLiveness(res: ServerResponse): void {
  sendJson(res, 200, { status: 'ok', service: 'api-server' });
}

export async function handleReadiness(res: ServerResponse): Promise<void> {
  const body = await dependencyHealth();
  sendJson(res, body.status === 'ok' ? 200 : 503, body);
}
