import { z } from 'zod';
import { parseApi } from '../schemas/api';
import { authHeaders } from './client';

const A2aAgentSchema = z
  .object({
    agentId: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    activeVersionId: z.string().nullable().optional(),
    agentCardUrl: z.string().nullable().optional(),
    endpoint: z.string().nullable().optional(),
  })
  .passthrough();

const A2aCredentialSchema = z
  .object({
    credentialId: z.string(),
    agentId: z.string(),
    clientId: z.string(),
    keyId: z.string(),
    scopes: z.array(z.string()),
    status: z.string(),
    expiresAt: z.string().nullable().optional(),
    lastUsedAt: z.string().nullable().optional(),
    createdAt: z.string().nullable().optional(),
  })
  .passthrough();

const A2aConfigSchema = z
  .object({
    publicBaseUrl: z.string().nullable().optional(),
    streaming: z.boolean(),
    authentication: z.string(),
    agents: z.array(A2aAgentSchema),
    selectedAgentId: z.string().nullable().optional(),
    credentials: z.array(A2aCredentialSchema),
    recentTasks: z.array(z.record(z.string(), z.unknown())),
    audit: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

const CredentialMutationSchema = z
  .object({
    credential: A2aCredentialSchema,
    token: z.string().optional(),
    bearerToken: z.string().optional(),
  })
  .passthrough();

export type A2aAgent = z.infer<typeof A2aAgentSchema>;
export type A2aCredential = z.infer<typeof A2aCredentialSchema>;
export type A2aConfig = z.infer<typeof A2aConfigSchema>;
export type A2aCredentialMutation = z.infer<typeof CredentialMutationSchema>;

async function jsonRequest(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`/api/a2a/${path}`, {
    ...init,
    headers: authHeaders({
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...((init?.headers as Record<string, string> | undefined) || {}),
    }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(payload.error || `A2A request failed: ${response.status}`);
  }
  return response.json();
}

export async function getA2aConfig(
  agentId?: string | null,
): Promise<A2aConfig> {
  const query = agentId
    ? `config?agent_id=${encodeURIComponent(agentId)}`
    : 'config';
  return parseApi(A2aConfigSchema, await jsonRequest(query), 'getA2aConfig');
}

export async function issueA2aCredential(input: {
  agentId: string;
  clientId: string;
  scopes: string[];
  expiresAt?: string | null;
}): Promise<A2aCredentialMutation> {
  return parseApi(
    CredentialMutationSchema,
    await jsonRequest('credentials', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
    'issueA2aCredential',
  );
}

export async function rotateA2aCredential(
  credentialId: string,
): Promise<A2aCredentialMutation> {
  return parseApi(
    CredentialMutationSchema,
    await jsonRequest(
      `credentials/${encodeURIComponent(credentialId)}/rotate`,
      { method: 'POST', body: '{}' },
    ),
    'rotateA2aCredential',
  );
}

export async function revokeA2aCredential(
  credentialId: string,
): Promise<void> {
  await jsonRequest(
    `credentials/${encodeURIComponent(credentialId)}/revoke`,
    { method: 'POST' },
  );
}
