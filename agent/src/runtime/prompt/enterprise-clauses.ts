/**
 * 不可覆盖的企业条款——叠进系统提示，AgentVersion lead 不能删掉这些硬规则。
 *
 * 路径由调用方传入，**不写死**：容器实际挂载的 workspace 与 skill 根目录来自
 * 环境（AGENT_SESSION_WORKSPACE_CWD / SKILLS_ROOT），写死意味着提示词随时可能
 * 和真实挂载对不上——DSH 重建后就一直如此：条款里写的是
 * `/home/sandbox/skills`，而实际挂载点是 `/home/sandbox/skill`（单数）。
 */

/** 默认根目录。与 skills/paths.ts 的 SYSTEM_SKILL_ROOT、compose 的挂载一致。 */
export const DEFAULT_WORKSPACE_ROOT = '/home/sandbox/workspace';
export const DEFAULT_SKILL_ROOT = '/home/sandbox/skill';

export interface EnterpriseClauseRoots {
  /** 可读写的用户工作区。相对路径在它下面解析。 */
  workspaceRoot?: string;
  /** 只读的 skill 安装根目录。 */
  skillRoot?: string;
}

/** 提示词里那段「路径硬规则」。标题行用于幂等判断，不要改。 */
export const PATHS_HEADING = '## Paths (hard rules)';

export function enterpriseClauses(roots: EnterpriseClauseRoots = {}): string {
  const workspaceRoot = (roots.workspaceRoot || '').trim() || DEFAULT_WORKSPACE_ROOT;
  const skillRoot = (roots.skillRoot || '').trim() || DEFAULT_SKILL_ROOT;
  return `${PATHS_HEADING}
- **User project / workspace**: \`${workspaceRoot}\` — read and write here. Relative paths resolve under this root.
- **Skills (read-only)**: \`${skillRoot}\` — installed skill packages. Never write here.
- Do **not** search or read host install trees such as \`/app\`, \`node_modules\`, or agent home.

## Policy
- High-risk actions may wait on approval. Do not try to bypass policy.
- External systems appear as \`mcp__<server>__<tool>\`. Call those directly.
- Do not invent an API for a capability no bound tool provides — say it is unavailable instead.
`.trim();
}

/** 默认根目录下的条款文本。保留具名导出，既有引用不必改。 */
export const ENTERPRISE_CLAUSES = enterpriseClauses();

/** 企业条款始终追加在自定义 lead 之后，lead 不能覆盖或删除它们。 */
export function assembleSystemPrompt(
  lead?: string,
  roots: EnterpriseClauseRoots = {},
): string {
  const clauses = enterpriseClauses(roots);
  const custom = (lead ?? '').trim();
  if (!custom) return clauses;
  if (custom.includes(PATHS_HEADING)) return custom;
  return `${custom}\n\n${clauses}`;
}
