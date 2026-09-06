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
/**
 * 用户侧 skill 的草稿根（ADR 0009 D7 / 计划 H6.12）。与 skills/paths.ts 的
 * `DRAFT_SKILL_ROOT` 一致。
 *
 * 提示词里的默认值不直接用这个常量，而是从调用方给的 `skillRoot` 派生
 * （`${skillRoot}-draft`）——见 `enterpriseClauses()` 里的理由。
 */
export interface EnterpriseClauseRoots {
  /** 可读写的用户工作区。相对路径在它下面解析。 */
  workspaceRoot?: string;
  /** 只读的 skill 安装根目录。 */
  skillRoot?: string;
  /**
   * 可写的 skill 草稿根。省略时用默认值。
   *
   * 必须写进提示词：模型现在没有 `skill_create` / `skill_install` 这类工具了
   * （ADR 0009 D7 取消了整套），它**只能靠这段话知道包该建在哪**。
   * 不说的话，最可能的失败是它去写只读的 skill 根然后报错。
   */
  draftSkillRoot?: string;
}

/**
 * 提示词里那段「路径硬规则」的标题。
 *
 * 2026-09-06 之前它兼任幂等判据：`assembleSystemPrompt` 见到自定义 lead 里
 * 出现这行就整段跳过企业条款。那是一个**用正文内容判断安全边界**的做法——
 * 管理员在 persona 里写一句 `## Paths (hard rules)`（讲解、引用、甚至抄一段
 * 我们自己的文档）就能把整份企业条款删掉。现在它只是一个标题。
 */
export const PATHS_HEADING = '## Paths (hard rules)';

export function enterpriseClauses(roots: EnterpriseClauseRoots = {}): string {
  const workspaceRoot = (roots.workspaceRoot || '').trim() || DEFAULT_WORKSPACE_ROOT;
  const skillRoot = (roots.skillRoot || '').trim() || DEFAULT_SKILL_ROOT;
  // 默认值**从 skillRoot 派生**，不是写死的常量：调用方一旦给了自定义根
  // （测试、非标准部署），草稿根必须跟着走。回落到写死的 /home/sandbox/skill-draft
  // 会让提示词同时出现两套根——模型照着写会扑空，而且那种不一致没人会报错。
  const draftSkillRoot = (roots.draftSkillRoot || '').trim() || `${skillRoot}-draft`;
  return `${PATHS_HEADING}
- **User project / workspace**: \`${workspaceRoot}\` — read and write here. Relative paths resolve under this root.
- **Skills (read-only)**: \`${skillRoot}\` and \`${skillRoot}-user\` — available skill packages. Never write here.
- **Skill drafts (writable)**: \`${draftSkillRoot}\` — build new skill packages here with ordinary \`write\`/\`bash\`. A draft is not available to you until a human enables it; you cannot enable one yourself.
- Do **not** search or read host install trees such as \`/app\`, \`node_modules\`, or agent home.

## Policy
- High-risk actions may wait on approval. Do not try to bypass policy.
- External systems appear as \`mcp__<server>__<tool>\`. Call those directly.
- Do not invent an API for a capability no bound tool provides — say it is unavailable instead.
`.trim();
}

/** 默认根目录下的条款文本。保留具名导出，既有引用不必改。 */
export const ENTERPRISE_CLAUSES = enterpriseClauses();

/**
 * 企业条款始终追加在自定义 lead 之后，lead 不能覆盖或删除它们。
 *
 * **没有任何基于正文的幂等分支**：企业条款恰好出现一份，与 lead 里写了什么无关。
 */
export function assembleSystemPrompt(
  lead?: string,
  roots: EnterpriseClauseRoots = {},
): string {
  const clauses = enterpriseClauses(roots);
  const custom = (lead ?? '').trim();
  if (!custom) return clauses;
  return `${custom}\n\n${clauses}`;
}

/**
 * DSH 变量名：承载 persona 原文。命名必须匹配 `[a-z][a-z0-9_]*`。
 *
 * persona 走变量而不是直接进 section 正文，是因为 `renderPrompt` 对
 * `{{name}}` 是**严格**的：未知或格式不对的引用直接抛错。管理员写的
 * `{{customer_name}}`、JSON 片段、代码块都会因此让整个 Run 起不来。
 * 而「替换进去的值不会被再次扫描」——所以把原文作为变量值注入，
 * 就是 DSH 提供的字面量安全路径。
 */
export const PERSONA_VARIABLE = 'agent_version_persona';

/** DSH 的 persona 槽位名/顺序（`@deepseek-ai/dsh-system-prompt` 的约定）。 */
export const PERSONA_SECTION_NAME = 'deployment:persona';
export const PERSONA_SECTION_ORDER = 0;

/** 企业条款 section 名/顺序：harness 身份(-100) 之后、persona(0) 之前。 */
export const ENTERPRISE_SECTION_NAME = 'enterprise-contract';
export const ENTERPRISE_SECTION_ORDER = -50;

export interface PromptSectionPlan {
  readonly name: string;
  readonly order: number;
  readonly text: string;
}

export interface PromptPlan {
  /** 只由部署约束与逻辑路径生成，永不含用户文本。 */
  readonly enterprise: PromptSectionPlan;
  /** persona 为空时不注册这一节。 */
  readonly persona: PromptSectionPlan | null;
  /** 变量名 → 字面量值。persona 原文在这里，不在 section 正文里。 */
  readonly variables: Readonly<Record<string, string>>;
}

/**
 * 把系统提示词拆成两节：企业条款与 persona。
 *
 * 顺序只表示渲染顺序，**不是安全权限层**——真正的授权在 guard 上。这里保证的
 * 是「企业条款恰好一份」和「persona 原文不被当模板插值」。
 */
export function buildPromptPlan(
  lead?: string,
  roots: EnterpriseClauseRoots = {},
): PromptPlan {
  const persona = (lead ?? '').trim();
  return Object.freeze({
    enterprise: Object.freeze({
      name: ENTERPRISE_SECTION_NAME,
      order: ENTERPRISE_SECTION_ORDER,
      text: enterpriseClauses(roots),
    }),
    persona: persona
      ? Object.freeze({
          name: PERSONA_SECTION_NAME,
          order: PERSONA_SECTION_ORDER,
          text: `{{${PERSONA_VARIABLE}}}`,
        })
      : null,
    variables: Object.freeze(
      (persona ? { [PERSONA_VARIABLE]: persona } : {}) as Record<string, string>,
    ),
  });
}
