import type { Context } from '@deepseek-ai/cordis';
import type { PromptPlan } from './enterprise-clauses.js';
import { ARTIFACT_DELIVERY_SECTION, TASK_CONTRACT_SECTION } from './task-contract.js';

/** A grouped upstream section advises both job tools; either missing hides it. */
const GROUPED_GUIDANCE: Readonly<Record<string, readonly string[]>> = {
  'tool:jobs': ['job_output', 'job_kill'],
  // Upstream write guidance names both read and edit; edit guidance names read.
  'tool:write': ['write', 'read', 'edit'],
  'tool:edit': ['edit', 'read'],
};

/**
 * Register platform behavior and literal persona in the unpublished Agent scope.
 * Filter structured tool sections against the post-waterfall request schemas on
 * every assembly. Never inspect or rewrite prose, persona, or runtime context.
 * Visibility is model guidance; the enterprise execution guards still authorize.
 */
export async function installPromptContract(ctx: Context, plan: PromptPlan): Promise<() => void> {
  const disposers: Array<() => void> = [];
  try {
    const fiber = ctx.inject(['systemPrompt'], (scoped) => {
      scoped.systemPrompt.section(plan.enterprise);
      scoped.systemPrompt.section(TASK_CONTRACT_SECTION);
      scoped.systemPrompt.section(ARTIFACT_DELIVERY_SECTION);
      for (const [name, value] of Object.entries(plan.variables)) {
        scoped.systemPrompt.variable(name, () => value);
      }
      if (plan.persona) scoped.systemPrompt.section(plan.persona);
    });
    disposers.push(() => fiber.dispose());
    await fiber;
    disposers.push(ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next();
      const visible = new Set(assembled.tools.map((tool) => tool.name));
      return {
        ...assembled,
        sections: assembled.sections.filter((section) => {
          if (!section.name.startsWith('tool:')) return true;
          const required = GROUPED_GUIDANCE[section.name] ?? [section.name.slice('tool:'.length)];
          return required.every((name) => visible.has(name));
        }),
      };
    }));
    return () => { for (const dispose of disposers.reverse()) dispose(); };
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
}
