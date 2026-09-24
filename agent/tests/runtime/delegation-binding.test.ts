/**
 * `configJson.delegation` 在 bind 时 fail-closed（agent-delegation.md D2）。
 * 这是保存（agent-catalog-service #validateConfig）与 Run 启动共用的那一道。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bindAgentVersionConfig } from '../../src/infrastructure/dsh/agent-version-bindings.js';

describe('bindAgentVersionConfig delegation', () => {
  it('projects the allowlist; absent means no delegation', () => {
    const bound = bindAgentVersionConfig({
      agentVersionId: 'v1',
      configJson: { delegation: { agents: ['data-analyst'] } },
    });
    assert.deepEqual([...bound.delegation.agents], ['data-analyst']);
    assert.ok(Object.isFrozen(bound.delegation.agents));

    const none = bindAgentVersionConfig({ agentVersionId: 'v2', configJson: {} });
    assert.deepEqual([...none.delegation.agents], []);
  });

  it('refuses a malformed allowlist instead of running with part of it', () => {
    assert.throws(
      () =>
        bindAgentVersionConfig({
          agentVersionId: 'v1',
          configJson: { delegation: { agents: ['ok', ''] } },
        }),
      (err: { code?: string; message?: string }) =>
        err.code === 'DSH_DELEGATION_INVALID' && /delegation\.agents\[1\]/.test(String(err.message)),
    );
  });
});
