/**
 * Routes: GET /health/live and GET /health/ready — liveness and aggregated
 * dependency readiness. Readiness answers 503 when a dependency is down, which
 * is what container health checks and the cross-service smoke test rely on.
 */
import type { ServerResponse } from 'node:http';
import { checkHealth } from '../services/sandbox-client.js';
import { checkAgentHealth } from '../services/agent-client.js';
import { sendJson } from '../http/response.js';

async function dependencyHealth() {
  let sandboxStatus = 'unknown';
  let sandboxInfo: Record<string, any> = {};
  let agentStatus = 'unknown';
  let agentInfo: Record<string, any> = {};

  try {
    const health = await checkHealth();
    if (health?.status === 'ok') {
      sandboxStatus = 'ok';
      sandboxInfo = health;
    } else {
      sandboxStatus = 'unreachable';
    }
  } catch {
    sandboxStatus = 'unreachable';
  }

  try {
    const agent = await checkAgentHealth();
    if (agent?.status === 'ok') {
      agentStatus = 'ok';
      agentInfo = agent;
    } else {
      agentStatus = 'unreachable';
    }
  } catch {
    agentStatus = 'unreachable';
  }

  const ok = sandboxStatus === 'ok' && agentStatus === 'ok';
  return {
    status: ok ? 'ok' : 'degraded',
    version: '4.0.0',
    agent: { status: agentStatus, ...agentInfo },
    sandbox: { status: sandboxStatus, ...sandboxInfo },
  };
}

export function handleLiveness(res: ServerResponse): void {
  sendJson(res, 200, { status: 'ok', service: 'api-server' });
}

export async function handleReadiness(res: ServerResponse): Promise<void> {
  const body = await dependencyHealth();
  sendJson(res, body.status === 'ok' ? 200 : 503, body);
}

