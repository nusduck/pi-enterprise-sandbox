/**
 * Routes: GET /health/live, GET /health/ready, GET /health/deps.
 *
 * The split matters under an orchestrator. Readiness controls whether a replica
 * stays in the Service endpoints, so it must answer a question only this
 * replica can answer: "can I serve traffic?" Fanning out to Agent and Sandbox
 * would tie every replica's readiness to a shared dependency, and a brief
 * upstream blip would pull *all* replicas out of rotation at once — turning a
 * partial degradation into a full outage while removing the very capacity that
 * would have absorbed it.
 *
 * Dependency status is still useful, just not as a probe. It lives at
 * /health/deps for dashboards, the cross-service smoke test, and humans.
 */
import { checkHealth } from '../services/sandbox-client.js';
import { checkAgentHealth } from '../services/agent-client.js';
import { sendJson } from '../http/response.js';

let acceptingTraffic = true;

/**
 * Stop reporting ready without dropping in-flight work.
 *
 * Called on SIGTERM so the orchestrator removes this replica from the Service
 * endpoints while it finishes the requests it already accepted.
 */
export function beginDraining() {
  acceptingTraffic = false;
}

export function isAcceptingTraffic() {
  return acceptingTraffic;
}

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
    agent: { status: agentStatus, ...agentInfo },
    sandbox: { status: sandboxStatus, ...sandboxInfo },
  };
}

/** Liveness — is the process running? Never fails for a dependency. */
export function handleLiveness(res) {
  sendJson(res, 200, { status: 'ok', service: 'api-server' });
}

/**
 * Readiness — should this replica receive traffic?
 *
 * Self-scoped on purpose: the BFF holds no state and every route is a proxy, so
 * a running, non-draining process can serve. Upstream health belongs to
 * /health/deps.
 */
export function handleReadiness(res) {
  if (!acceptingTraffic) {
    sendJson(res, 503, { status: 'draining', service: 'api-server' });
    return;
  }
  sendJson(res, 200, { status: 'ok', service: 'api-server' });
}

/** Dependency fan-out for dashboards and smoke tests — not a probe. */
export async function handleDependencies(res) {
  const body = await dependencyHealth();
  sendJson(res, body.status === 'ok' ? 200 : 503, body);
}
