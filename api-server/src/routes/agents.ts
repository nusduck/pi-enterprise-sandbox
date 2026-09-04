/** Agent 目录的 BFF 路由：auth/trace 边界而已，所有目录事实归 agent/。 */

import type { ServerResponse } from 'node:http';
import {
  createAgentDefinition,
  createAgentDefinitionVersion,
  listAgentDefinitionVersions,
  listAgentDefinitions,
  setAgentDefinitionActiveVersion,
} from '../services/agent-catalog-client.js';
import { resolveTrustedAuth, type ReqWithTrace } from '../application/run-access-service.js';
import { sendError, sendJson as json } from '../http/response.js';

/** GET /api/agents — org 内可选的智能体列表。 */
export async function handleListAgents(parsedUrl: URL, res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  try {
    const auth = await resolveTrustedAuth(req);
    const limit = parsedUrl.searchParams.get('limit') || undefined;
    json(res, 200, await listAgentDefinitions({ limit }, { auth, traceId: req?.traceId }));
  } catch (error) {
    sendError(res, error, req?.traceId);
  }
}

/** POST /api/agents — 新建一个智能体（admin；角色由 agent/ 判定）。 */
export async function handleCreateAgent(body: any, res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  try {
    const auth = await resolveTrustedAuth(req);
    json(res, 201, await createAgentDefinition(body, { auth, traceId: req?.traceId }));
  } catch (error) {
    sendError(res, error, req?.traceId);
  }
}

/** GET /api/agents/:id/versions — 版本线。 */
export async function handleListAgentVersions(
  agentId: string,
  parsedUrl: URL,
  res: ServerResponse,
  req: ReqWithTrace | null = null,
): Promise<void> {
  try {
    const auth = await resolveTrustedAuth(req);
    const limit = parsedUrl.searchParams.get('limit') || undefined;
    json(res, 200, await listAgentDefinitionVersions(
      agentId, { limit }, { auth, traceId: req?.traceId },
    ));
  } catch (error) {
    sendError(res, error, req?.traceId);
  }
}

/** POST /api/agents/:id/versions — 改配置 = 建新版本，永不原地改写。 */
export async function handleCreateAgentVersion(
  agentId: string,
  body: any,
  res: ServerResponse,
  req: ReqWithTrace | null = null,
): Promise<void> {
  try {
    const auth = await resolveTrustedAuth(req);
    json(res, 201, await createAgentDefinitionVersion(
      agentId, body, { auth, traceId: req?.traceId },
    ));
  } catch (error) {
    sendError(res, error, req?.traceId);
  }
}

/** POST /api/agents/:id/active-version — 切活跃版本（也是回滚）。 */
export async function handleSetAgentActiveVersion(
  agentId: string,
  body: any,
  res: ServerResponse,
  req: ReqWithTrace | null = null,
): Promise<void> {
  try {
    const auth = await resolveTrustedAuth(req);
    json(res, 200, await setAgentDefinitionActiveVersion(
      agentId, body, { auth, traceId: req?.traceId },
    ));
  } catch (error) {
    sendError(res, error, req?.traceId);
  }
}
