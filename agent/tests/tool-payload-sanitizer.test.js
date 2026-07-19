import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeToolArguments } from '../src/runtime/tool-payload-sanitizer.js';

test('bounds generic tool ledger arguments without retaining content or secrets', () => {
  const summary = summarizeToolArguments('write', {
    path: 'notes.txt',
    content: 'x'.repeat(2048),
    authorization: 'Bearer secret-token',
    command: 'echo ' + 'y'.repeat(2048),
    env: { API_TOKEN: 'nested-secret' },
  });

  assert.equal(summary.path, 'notes.txt');
  assert.equal(summary.content_bytes, 2048);
  assert.equal(typeof summary.content_sha256, 'string');
  assert.equal(summary.authorization, '[redacted]');
  assert.equal(summary.command_truncated, true);
  assert.equal(summary.command_bytes, 2053);
  assert.equal(summary.env, '[omitted]');
  assert.equal('nested-secret' in summary, false);
  assert.equal('content' in summary, false);
});

test('keeps small non-sensitive fields useful and hashes skill edits', () => {
  const summary = summarizeToolArguments('skill_edit', {
    path: 'SKILL.md',
    content: 'small edit',
  });

  assert.equal(summary.path, 'SKILL.md');
  assert.equal(summary.content_bytes, 10);
  assert.equal(typeof summary.content_sha256, 'string');
  assert.equal('content' in summary, false);
});

test('redacts secrets embedded in short and long shell commands', () => {
  const summary = summarizeToolArguments('bash', {
    command: "curl -H 'Authorization: Bearer super-secret-token' https://example.test",
  });
  const envSummary = summarizeToolArguments('bash', {
    command: 'TOKEN=another-secret curl https://example.test',
  });

  assert.doesNotMatch(JSON.stringify(summary), /super-secret-token/);
  assert.doesNotMatch(JSON.stringify(envSummary), /another-secret/);
  assert.match(String(summary.command), /REDACTED/);
  assert.match(String(envSummary.command), /REDACTED/);
});
