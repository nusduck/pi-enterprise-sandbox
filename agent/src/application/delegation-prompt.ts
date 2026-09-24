/**
 * 系统提示里的「Delegation」段（docs/design/agent-delegation.md D4）。
 *
 * 工具在 boot 时注册一次，描述不能按 Run 变；模型要知道「可以交给谁、各自擅长什么」，
 * 就在本 Run 的租户段（persona）后面追加这一段。企业条款仍由 `assembleSystemPrompt`
 * 追加在最后，不受影响。
 *
 * 只列**当下** active 的目标：白名单里停用或删掉的 Agent 不进提示，免得模型去调一个
 * 注定被 spawn 拒绝的名字。
 */

import { parseRemoteAgentRegistry } from '../runtime/providers/a2a-remote-registry.js';

type Loose = any;

/** 单个描述进提示前的上限；描述是管理员文本，与 persona 同级，但不该淹没它。 */
const DESCRIPTION_MAX_CHARS = 300;

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_MAX_CHARS);
}

function bullet(t: { name: string; description: string | null }): string {
  const description = t.description ? oneLine(t.description) : '';
  return description ? `- ${t.name} — ${description}` : `- ${t.name}`;
}

export function formatDelegationSection(
  targets: ReadonlyArray<{ name: string; description: string | null }>,
  remote: ReadonlyArray<{ name: string; description: string | null }> = [],
): string {
  if (targets.length === 0 && remote.length === 0) return '';
  const out = ['## Delegation'];
  if (targets.length > 0) {
    out.push(
      'You can hand a self-contained task to another agent with `delegate_to_agent`. ' +
        'It does not see this conversation or your workspace, so include everything it needs. ' +
        'Available agents:',
      ...targets.map(bullet),
    );
  }
  if (remote.length > 0) {
    out.push(
      'You can send a self-contained task to a remote agent outside this organization with ' +
        '`delegate_to_remote_agent` (it may need a human approval first). ' +
        'Share only what the task needs. Available remote agents (use the id):',
      ...remote.map(bullet),
    );
  }
  return out.join('\n');
}

/** 进程内缓存：清单在进程生命周期里不变（改清单要重启，与 MCP_SERVERS_JSON 一致）。 */
let registryCache: ReturnType<typeof parseRemoteAgentRegistry> | null = null;
function remoteRegistry(env: Record<string, string | undefined>) {
  registryCache ??= parseRemoteAgentRegistry(env);
  return registryCache;
}

/**
 * 返回本 Run 传给 runtime 的租户段：原 persona，加上（如有）Delegation 段。
 */
export async function withDelegationSection(input: {
  lead: string;
  delegation: { agents: readonly string[]; remoteAgents: readonly string[] };
  orgId: string;
  transactionManager: { run: (fn: (trx: Loose) => Promise<Loose>) => Promise<Loose> };
  createRepositories: (db: Loose) => Loose;
  /** 测试注入；缺省读进程环境的 `A2A_REMOTE_AGENTS_JSON`。 */
  remoteRegistry?: ReadonlyArray<{ id: string; description: string }>;
}): Promise<string> {
  const { agents, remoteAgents } = input.delegation;
  if (agents.length === 0 && remoteAgents.length === 0) return input.lead;
  const registry = input.remoteRegistry ?? remoteRegistry(process.env);
  // 名单里有、但清单里已没有的远端不进提示：工具会拒，列出来只会误导模型。
  const remote = remoteAgents
    .map((id) => registry.find((entry) => entry.id === id))
    .filter((entry): entry is { id: string; description: string } => entry !== undefined)
    .map((entry) => ({ name: entry.id, description: entry.description || null }));
  const targets = agents.length === 0 ? [] : await input.transactionManager.run(async (trx) => {
    const repos = input.createRepositories(trx);
    const out: Array<{ name: string; description: string | null }> = [];
    for (const name of agents) {
      const definition = await repos.catalog.getDefinitionByOrgAndName(input.orgId, name);
      if (
        definition &&
        String(definition.status).toLowerCase() === 'active' &&
        definition.activeVersionId
      ) {
        out.push({ name: definition.name, description: definition.description ?? null });
      }
    }
    return out;
  });
  const section = formatDelegationSection(targets, remote);
  if (!section) return input.lead;
  return input.lead.trim() ? `${input.lead}\n\n${section}` : section;
}
