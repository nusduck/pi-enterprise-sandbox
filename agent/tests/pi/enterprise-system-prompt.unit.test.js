/**
 * Enterprise system prompt: identity, and the `## Tools` section being
 * *derived* from the tools bound to a run rather than hand-written.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyToolSurface,
  buildEnterpriseSystemPrompt,
  renderToolSurface,
  resolveEnterpriseSystemPrompt,
  TOOL_SURFACE_HEADING,
} from '../../src/infrastructure/pi/enterprise-system-prompt.js';
import {
  createSandboxBridgeToolDefinitions,
  SANDBOX_TOOL_NAMES,
} from '../../src/extensions/index.js';

const RUN = Object.freeze({
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN5F',
  traceId: 'b'.repeat(32),
  executionFenceToken: 7,
});

/** Pi's own aggregation step, reproduced over real tool definitions. */
function aggregate(definitions) {
  const selectedTools = [];
  /** @type {Record<string, string>} */
  const toolSnippets = {};
  /** @type {string[]} */
  const promptGuidelines = [];
  for (const def of definitions) {
    selectedTools.push(def.name);
    if (def.promptSnippet) toolSnippets[def.name] = def.promptSnippet;
    if (Array.isArray(def.promptGuidelines)) {
      promptGuidelines.push(...def.promptGuidelines);
    }
  }
  return { selectedTools, toolSnippets, promptGuidelines };
}

describe('enterprise system prompt identity', () => {
  it('leads as a general-purpose agent and does not speak as pi', () => {
    const prompt = buildEnterpriseSystemPrompt();
    assert.match(prompt, /^You are 风控通用智能体 — a general-purpose enterprise agent/);
    assert.match(prompt, /Reply in the language the user writes in\./);
    assert.doesNotMatch(prompt, /\*\*pi\*\*/);
    assert.doesNotMatch(prompt, /coding assistant/);
    assert.doesNotMatch(prompt, /pi-enterprise-sandbox/);
    assert.doesNotMatch(prompt, /sandbox-bridge|enterprise-policy|observability/);
  });

  it('applies the evidence discipline unconditionally, not only to risk work', () => {
    const prompt = buildEnterpriseSystemPrompt();
    assert.match(
      prompt,
      /^- Say what you checked, what you did not, and how confident the conclusion is; separate observed fact from inference$/m,
    );
    assert.doesNotMatch(prompt, /For risk work:/);
  });

  it('ships a tool-agnostic Doing work contract', () => {
    const prompt = buildEnterpriseSystemPrompt();
    assert.match(prompt, /^## Doing work$/m);
    assert.match(prompt, /Finish the actual request in this turn: inspect, act, and verify/);
    assert.match(prompt, /A plan or an analysis is not delivery/);
    assert.match(prompt, /Do not silently narrow, widen, or transform the requested scope/);
    assert.match(prompt, /Write progress in the user-visible reply/);
    assert.match(prompt, /Never print API keys, tokens, passwords, or full connection strings/);
    assert.match(prompt, /bound delivery tool when one exists/);
    assert.match(
      prompt,
      /When a bound tool exists for a durable plan, long-lived notes, asking the user, or publishing a file/,
    );
    assert.doesNotMatch(prompt, /Platform security \(non-overridable\)/);
    // Tools that are only on the request when bound must not be named here —
    // a run that did not bind them would otherwise be told to call a missing tool.
    for (const name of [
      'todo_write',
      'todo_read',
      'memory_write',
      'memory_search',
      'ask_user',
      'spawn_subagent',
      'check_subagent',
      'skill_list',
      'skill_install',
      'submit_artifact',
    ]) {
      assert.doesNotMatch(
        prompt,
        new RegExp(`\`${name}\``),
        `base prompt must not name optional/bound-only tool ${name}`,
      );
    }
  });

  it('omits the default identity when a lead voice is set, keeping the contract', () => {
    const prompt = resolveEnterpriseSystemPrompt('Version-owned voice', {
      productSystemPrompt: 'Env product voice must not lead',
    });
    assert.match(prompt, /^Version-owned voice\n\n---\n\n## Paths/);
    assert.match(prompt, /## Tools/);
    assert.match(prompt, /## Doing work/);
    assert.doesNotMatch(prompt, /风控通用智能体/);
    assert.doesNotMatch(prompt, /Env product voice must not lead/);
    assert.doesNotMatch(prompt, /Platform security \(non-overridable\)/);
  });
});

describe('enterprise system prompt tool surface', () => {
  it('ships no hand-written inventory — the base section defers to tool schemas', () => {
    const prompt = buildEnterpriseSystemPrompt();
    assert.match(prompt, /## Tools\nEach bound tool's own schema is authoritative/);
    assert.match(prompt, /mcp__<server>__<tool>/);
    // Tools may appear inside cross-tool rules ("`ls` a directory before
    // guessing paths"), but never as an inventory entry, so nothing can go
    // stale against the schemas actually sent on the request.
    for (const name of SANDBOX_TOOL_NAMES) {
      assert.doesNotMatch(
        prompt,
        new RegExp(`^- \`${name}\`:`, 'm'),
        `base prompt must not hard-code an inventory line for ${name}`,
      );
    }
  });

  it('names exactly the tools bound to the run, in registration order', () => {
    const definitions = createSandboxBridgeToolDefinitions(RUN, {}, {});
    const surface = renderToolSurface(aggregate(definitions));

    const named = [...surface.matchAll(/^- `([a-z_]+)`/gm)].map((m) => m[1]);
    assert.deepEqual(named, [...SANDBOX_TOOL_NAMES]);
  });

  it('carries every bound tool one-liner and its cross-call usage rules', () => {
    const definitions = createSandboxBridgeToolDefinitions(RUN, {}, {});
    const aggregated = aggregate(definitions);
    const surface = renderToolSurface(aggregated);

    // Guards the data source: a tool with no promptSnippet would silently
    // degrade to a bare name, so require every sandbox tool to declare one.
    for (const name of SANDBOX_TOOL_NAMES) {
      const snippet = aggregated.toolSnippets[name];
      assert.ok(snippet, `${name} must declare a promptSnippet`);
      assert.ok(
        surface.includes(`- \`${name}\`: ${snippet}`),
        `${name} snippet must reach the prompt`,
      );
    }
    assert.match(surface, /^Tool usage rules:$/m);
    assert.ok(aggregated.promptGuidelines.length > 0);
    for (const guideline of new Set(aggregated.promptGuidelines)) {
      assert.ok(surface.includes(`- ${guideline}`), `missing guideline: ${guideline}`);
    }
  });

  it('renders MCP wrappers and optional-extension tools the same way', () => {
    const surface = renderToolSurface({
      selectedTools: ['read', 'skill_list', 'mcp__github__create_pr'],
      toolSnippets: {
        read: 'Read files',
        skill_list: 'Inspect Skills',
        mcp__github__create_pr: 'Open a pull request',
      },
      promptGuidelines: [],
    });
    assert.match(surface, /^- `mcp__github__create_pr`: Open a pull request$/m);
    assert.match(surface, /^- `skill_list`: Inspect Skills$/m);
    assert.doesNotMatch(surface, /^Tool usage rules:$/m);
  });

  it('de-duplicates and tolerates missing snippets without dropping a tool', () => {
    const surface = renderToolSurface({
      selectedTools: ['read', 'read', '  ', 'quiet_tool'],
      toolSnippets: { read: 'Read files' },
      promptGuidelines: ['Same rule', 'Same rule', '   '],
    });
    assert.equal(surface.match(/^- `read`/gm).length, 1);
    assert.match(surface, /^- `quiet_tool`$/m);
    assert.equal(surface.match(/^- Same rule$/gm).length, 1);
  });
});

describe('applyToolSurface', () => {
  const bound = {
    selectedTools: ['read'],
    toolSnippets: { read: 'Read files' },
    promptGuidelines: [],
  };

  it('splices the surface directly under the Tools heading', () => {
    const base = buildEnterpriseSystemPrompt();
    const applied = applyToolSurface(base, bound);
    assert.match(applied, /## Tools\nBound to this run:\n- `read`: Read files\n\nEach bound tool's own schema/);
    // Everything else survives untouched.
    assert.ok(applied.startsWith('You are 风控通用智能体'));
    assert.ok(applied.includes('## Skills (progressive disclosure)'));
    assert.ok(applied.includes('## Doing work'));
  });

  it('degrades to the base prompt when nothing is bound or no heading exists', () => {
    const base = buildEnterpriseSystemPrompt();
    assert.equal(applyToolSurface(base, { selectedTools: [] }), base);
    assert.equal(applyToolSurface(base, undefined), base);
    assert.equal(applyToolSurface('no heading here', bound), 'no heading here');
    assert.equal(applyToolSurface('', bound), '');
  });

  it('does not compound when the caller re-applies to an already-spliced prompt', () => {
    // Pi always hands back the *base* prompt, but a second splice must still
    // not stack two inventories under one heading.
    const once = applyToolSurface(buildEnterpriseSystemPrompt(), bound);
    const twice = applyToolSurface(once, bound);
    assert.equal(twice.match(/^Bound to this run:$/gm).length, 1);
    assert.equal(twice, once);
  });

  it('exposes the heading it splices under so the prompt and hook cannot drift', () => {
    assert.equal(TOOL_SURFACE_HEADING, '## Tools');
    assert.ok(buildEnterpriseSystemPrompt().includes(`\n${TOOL_SURFACE_HEADING}\n`));
  });
});
