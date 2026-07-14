/**
 * Route: GET /api/status — aggregated health check.
 */
import { checkHealth } from '../services/sandbox-client.js';
import { checkAgentHealth } from '../services/agent-client.js';
import { sendJson } from '../http/response.js';

async function dependencyHealth() {
  let sandboxStatus = 'unknown';
  let sandboxInfo = {};
  let agentStatus = 'unknown';
  let agentInfo = {};

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
    /** Chat orchestration is always the independent Node Agent service. */
    agent_runtime: 'node-agent',
    agent: { status: agentStatus, ...agentInfo },
    sandbox: { status: sandboxStatus, ...sandboxInfo },
  };
}

export function handleLiveness(res) {
  sendJson(res, 200, { status: 'ok', service: 'api-server' });
}

export async function handleReadiness(res) {
  const body = await dependencyHealth();
  sendJson(res, body.status === 'ok' ? 200 : 503, body);
}

/** Compatibility endpoint for clients that still display dependency status. */
export async function handleStatus(res) {
  sendJson(res, 200, await dependencyHealth());
}
