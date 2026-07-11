/**
 * Route: GET /api/status — aggregated health check.
 */
import { checkHealth } from '../services/sandbox-client.js';
import { checkAgentHealth } from '../services/agent-client.js';
import { config } from '../config.js';

export async function handleStatus(res) {
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
  const body = JSON.stringify({
    status: ok ? 'ok' : 'degraded',
    version: '4.0.0',
    /** Chat orchestration is always the independent Node Agent service. */
    agent_runtime: 'node-agent',
    agent: { status: agentStatus, base_url: config.AGENT_BASE_URL, ...agentInfo },
    sandbox: { status: sandboxStatus, ...sandboxInfo },
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}
