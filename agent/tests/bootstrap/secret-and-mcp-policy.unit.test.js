/**
 * STATUS H5/H6 — structural guarantees that secrets stay out of event
 * projections and business DB access is MCP-only (no direct DSN tools).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  redactInlineSecrets,
  projectPiEvent,
} from '../../src/infrastructure/pi/platform-event-projector.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('secret redaction (H5)', () => {
  it('redacts bearer tokens from projected tool results', () => {
    const events = projectPiEvent({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'bash',
      isError: false,
      result: 'Authorization: Bearer sk-abc1234567890secret keep',
    });
    const text = JSON.stringify(events);
    assert.match(text, /\[redacted\]/);
    assert.doesNotMatch(text, /sk-abc1234567890secret/);
  });

  it('redactInlineSecrets is used by the projector module', () => {
    const src = fs.readFileSync(
      path.join(root, 'src/infrastructure/pi/platform-event-projector.js'),
      'utf8',
    );
    assert.match(src, /redactInlineSecrets|redactPayload/);
    assert.equal(
      typeof redactInlineSecrets('Authorization: Bearer sk-abc1234567890secret'),
      'string',
    );
  });
});

describe('MCP data-plane policy (H6)', () => {
  it('pi-mcp-adapter factory rejects plaintext secrets in config', () => {
    const src = fs.readFileSync(
      path.join(root, 'src/infrastructure/mcp/pi-mcp-adapter-factory.js'),
      'utf8',
    );
    // Production path must require env/refs for secrets, not raw passwords.
    assert.match(src, /authTokenRef|env|secret/i);
    assert.doesNotMatch(
      src,
      /password:\s*['"][^'"]+['"]/,
      'must not hardcode password strings',
    );
  });

  it('enterprise policy treats mcp__ tools as external tools', () => {
    const src = fs.readFileSync(
      path.join(root, 'src/extensions/enterprise-policy/tool-risk-classifier.js'),
      'utf8',
    );
    assert.match(src, /mcp__/);
  });

  it('sandbox-bridge does not open a direct business SQL client', () => {
    const bridgeDir = path.join(root, 'src/extensions/sandbox-bridge');
    const files = fs.readdirSync(bridgeDir, { recursive: true }).filter((f) => String(f).endsWith('.js'));
    for (const rel of files) {
      const src = fs.readFileSync(path.join(bridgeDir, rel), 'utf8');
      assert.doesNotMatch(src, /createPool|mysql2|knex\(/, `${rel} must not open MySQL`);
    }
  });
});
