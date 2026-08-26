import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEnterpriseSystemPrompt,
  formatEnterpriseToolsSection,
  resolveEnterpriseSystemPrompt,
} from '../../src/infrastructure/pi/enterprise-system-prompt.js';

describe('enterprise system prompt', () => {
  it('identifies as a risk-control agent and does not speak as pi', () => {
    const prompt = buildEnterpriseSystemPrompt();
    assert.match(prompt, /^You are a 风控通用智能体/);
    assert.doesNotMatch(prompt, /\*\*pi\*\*/);
    assert.doesNotMatch(prompt, /coding assistant/);
    assert.doesNotMatch(prompt, /pi-enterprise-sandbox/);
    assert.doesNotMatch(prompt, /sandbox-bridge|enterprise-policy|observability/);
    assert.doesNotMatch(prompt, /## Available tools/);
    assert.doesNotMatch(prompt, /## Runtime extensions/);
  });

  it('treats this-turn tool schemas as authoritative instead of a closed catalog', () => {
    const prompt = buildEnterpriseSystemPrompt();
    assert.match(prompt, /## Tools/);
    assert.match(prompt, /authoritative/);
    assert.match(prompt, /mcp__<server>__<tool>/);
    assert.match(prompt, /ask_user/);
    assert.match(prompt, /skill_list/);
    assert.match(prompt, /todo_write/);
    assert.match(prompt, /## Skills \(progressive disclosure\)/);
    assert.match(prompt, /\/home\/sandbox\/workspace/);
    assert.match(prompt, /\/home\/sandbox\/skill/);
  });

  it('keeps sandbox snippets for ls/find/grep when formatting a catalog', () => {
    const section = formatEnterpriseToolsSection();
    assert.match(section, /^- ls: /m);
    assert.match(section, /^- find: /m);
    assert.match(section, /^- grep: /m);
  });

  it('omits the default identity when a lead voice is set', () => {
    const prompt = resolveEnterpriseSystemPrompt('Version-owned voice', {
      productSystemPrompt: 'Env product voice must not lead',
    });
    assert.match(prompt, /^Version-owned voice\n\n---\n\n## Paths/);
    assert.doesNotMatch(prompt, /风控通用智能体/);
    assert.doesNotMatch(prompt, /Env product voice must not lead/);
  });
});
