import { resolveTrustedAuth } from '../application/run-access-service.js';
import { getAgentExtensionDiagnostics } from '../services/agent-client.js';
import { sendError } from '../http/response.js';

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

export async function handleExtensionDiagnostics(parsedUrl, res, req) {
  const traceId = req?.traceId || null;
  try {
    const auth = await resolveTrustedAuth(req);
    const profileId = parsedUrl.searchParams.get('profile_id') || 'coding-agent';
    json(res, 200, await getAgentExtensionDiagnostics(profileId, { auth, traceId }));
  } catch (error) {
    sendError(res, error, traceId);
  }
}

export async function handleCapabilityRegistry(kind, parsedUrl, res, req) {
  const traceId = req?.traceId || null;
  try {
    const auth = await resolveTrustedAuth(req);
    const profileId = parsedUrl.searchParams.get('profile_id') || 'coding-agent';
    const diagnostics = await getAgentExtensionDiagnostics(profileId, { auth, traceId });
    if (kind === 'skills') json(res, 200, { skills: diagnostics.skills || [] });
    else if (kind === 'mcp') json(res, 200, { servers: diagnostics.mcp_servers || [] });
    else if (kind === 'tools') json(res, 200, { tools: diagnostics.tools || [] });
    else if (kind === 'models') json(res, 200, { models: diagnostics.models || [] });
    else json(res, 404, { error: 'unknown capability registry' });
  } catch (error) {
    sendError(res, error, traceId);
  }
}
