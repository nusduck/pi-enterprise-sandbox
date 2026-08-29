/**
 * 不可覆盖的企业条款——叠进系统提示，AgentVersion lead 不能删掉这些硬规则。
 */

export const ENTERPRISE_CLAUSES = `## Paths (hard rules)
- **User project / workspace**: \`/home/sandbox/workspace\` — read and write here. Relative paths resolve under this root.
- **Skills (read-only)**: \`/home/sandbox/skills\` — installed skill packages. Never write here.
- Do **not** search or read host install trees such as \`/app\`, \`node_modules\`, or agent home.

## Policy
- High-risk actions may wait on approval. Do not try to bypass policy.
- External systems appear as \`mcp__<server>__<tool>\`. Call those directly.
- Do not invent an API for a capability no bound tool provides — say it is unavailable instead.
`.trim();

/** 企业条款始终追加在自定义 lead 之后，lead 不能覆盖或删除它们。 */
export function assembleSystemPrompt(lead?: string): string {
  const custom = (lead ?? '').trim();
  if (!custom) return ENTERPRISE_CLAUSES;
  if (custom.includes('## Paths (hard rules)')) return custom;
  return `${custom}\n\n${ENTERPRISE_CLAUSES}`;
}
