/**
 * Route: GET /api/status — aggregated health check.
 */
import { checkHealth } from '../services/sandbox-client.js';
import { config } from '../config.js';

export async function handleStatus(res) {
  let sandboxStatus = 'unknown';
  let sandboxInfo = {};

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

  const body = JSON.stringify({
    status: sandboxStatus === 'ok' ? 'ok' : 'degraded',
    version: '4.0.0',
    /** Active chat orchestration path: `node` | `python` (no secrets). */
    agent_runtime: config.AGENT_RUNTIME || 'node',
    sandbox: { status: sandboxStatus, ...sandboxInfo },
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}
