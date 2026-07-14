import { getAgentExtensionDiagnostics } from '../services/agent-client.js';

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

export async function handleExtensionDiagnostics(parsedUrl, res) {
  try {
    const profileId = parsedUrl.searchParams.get('profile_id') || 'coding-agent';
    json(res, 200, await getAgentExtensionDiagnostics(profileId));
  } catch (error) {
    json(res, error.status || 502, { error: error.message });
  }
}

export async function handleCapabilityRegistry(kind, parsedUrl, res) {
  try {
    const profileId = parsedUrl.searchParams.get('profile_id') || 'coding-agent';
    const diagnostics = await getAgentExtensionDiagnostics(profileId);
    if (kind === 'skills') json(res, 200, { skills: diagnostics.skills || [] });
    else if (kind === 'mcp') json(res, 200, { servers: diagnostics.mcp_servers || [] });
    else if (kind === 'tools') json(res, 200, { tools: diagnostics.tools || [] });
    else if (kind === 'models') json(res, 200, { models: diagnostics.models || [] });
    else json(res, 404, { error: 'unknown capability registry' });
  } catch (error) {
    json(res, error.status || 502, { error: error.message });
  }
}
