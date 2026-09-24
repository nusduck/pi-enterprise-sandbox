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

type Loose = any;

/** 单个描述进提示前的上限；描述是管理员文本，与 persona 同级，但不该淹没它。 */
const DESCRIPTION_MAX_CHARS = 300;

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_MAX_CHARS);
}

export function formatDelegationSection(
  targets: ReadonlyArray<{ name: string; description: string | null }>,
): string {
  if (targets.length === 0) return '';
  const lines = targets.map((t) => {
    const description = t.description ? oneLine(t.description) : '';
    return description ? `- ${t.name} — ${description}` : `- ${t.name}`;
  });
  return [
    '## Delegation',
    'You can hand a self-contained task to another agent with `delegate_to_agent`. ' +
      'It does not see this conversation or your workspace, so include everything it needs. ' +
      'Available agents:',
    ...lines,
  ].join('\n');
}

/**
 * 返回本 Run 传给 runtime 的租户段：原 persona，加上（如有）Delegation 段。
 */
export async function withDelegationSection(input: {
  lead: string;
  agents: readonly string[];
  orgId: string;
  transactionManager: { run: (fn: (trx: Loose) => Promise<Loose>) => Promise<Loose> };
  createRepositories: (db: Loose) => Loose;
}): Promise<string> {
  if (input.agents.length === 0) return input.lead;
  const targets = await input.transactionManager.run(async (trx) => {
    const repos = input.createRepositories(trx);
    const out: Array<{ name: string; description: string | null }> = [];
    for (const name of input.agents) {
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
  const section = formatDelegationSection(targets);
  if (!section) return input.lead;
  return input.lead.trim() ? `${input.lead}\n\n${section}` : section;
}
