/** Real boot + real DSH tools.execute regression for AgentVersion authorization. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('P1 factory installs AgentVersion deny and MCP allowlist before tool body', () => {
  const fixture = join(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures/agent-version-tool-execute-probe.ts',
  );
  const output = execFileSync('npx', ['tsx', fixture], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
    encoding: 'utf8',
    env: { ...process.env, MCP_SERVERS_JSON: '[]' },
  });
  type Outcome = {
    isError?: boolean;
    threw?: string;
    value?: unknown;
    error?: { message?: string };
  };
  const result = JSON.parse(output.trim().split('\n').at(-1) ?? '{}') as {
    bodyCalls: number;
    denied: Outcome;
    selected: Outcome;
    unbound: Outcome;
    scopedToolCount: number | null;
  };

  // Positive control first. A guard that rejects everything satisfies every
  // rejection assertion below, so the referenced-and-platform-allowed tool has
  // to actually run its body — exactly once.
  assert.equal(result.selected.isError, false, result.selected.error?.message ?? 'selected tool was rejected');
  assert.equal(result.selected.value, 'fixture');
  assert.equal(result.bodyCalls, 1, 'only the authorized MCP tool body may run');

  assert.equal(result.denied.isError, true);
  assert.equal(result.unbound.isError, true);
  // Distinct, stable reasons: an explicit AgentVersion deny and an unreferenced
  // MCP server are different facts, and neither may be a park-guard rejection
  // wearing an authorization label.
  assert.match(result.denied.error?.message ?? result.denied.threw ?? '', /AgentVersion decision of deny/);
  assert.match(result.unbound.error?.message ?? result.unbound.threw ?? '', /not bound to this AgentVersion/);
  assert.equal(typeof result.scopedToolCount, 'number');
});
