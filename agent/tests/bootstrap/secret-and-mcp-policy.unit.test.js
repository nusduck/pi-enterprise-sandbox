/**
 * STATUS H5/H6 — structural guarantees that secrets stay out of event
 * projections / status persistence and business DB access is MCP-only
 * (no direct DSN tools on the agent tool plane).
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
import { redactSecretText } from '../../lib/text-redaction.js';
import { sanitizeStatusReason } from '../../src/application/sanitize-status-reason.js';
import { sanitizeOutboxError } from '../../src/infrastructure/outbox/sanitize-error.js';
import { SANDBOX_TOOL_NAMES } from '../../src/extensions/sandbox-bridge/constants.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Walk .js files under a directory (non-recursive if empty). */
function listJsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true })
    .filter((f) => String(f).endsWith('.js'))
    .map((f) => path.join(dir, f));
}

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
    assert.match(text, /\[redacted\]/i);
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

  it('redactSecretText does not treat match offset as a field name', () => {
    // Patterns without a capture group must not produce "8=[REDACTED]".
    const dsn = redactSecretText(
      'connect mysql://admin:SuperSecret@db/prod failed',
    );
    assert.doesNotMatch(dsn, /SuperSecret|admin:/);
    assert.doesNotMatch(dsn, /\d+=\[REDACTED\]/);
    assert.match(dsn, /\[REDACTED\]/);

    const bearer = redactSecretText(
      'Authorization: Bearer sk-abc1234567890secret keep',
    );
    assert.doesNotMatch(bearer, /sk-abc1234567890secret/);
    assert.doesNotMatch(bearer, /\d+=\[REDACTED\]/);
  });

  it('status_reason and outbox last_error redact Bearer / token= / DSN userinfo', () => {
    const samples = [
      'Authorization: Bearer sk-abc1234567890secret failed',
      'token=opaque-result-token boom',
      'mysql://user:SuperSecretPassw0rd@db:3306/prod connection refused',
      'redis://:redis-password@cache/0 down',
      'password=hunter2 in config',
    ];
    for (const sample of samples) {
      const status = sanitizeStatusReason(sample);
      const outbox = sanitizeOutboxError(sample);
      assert.ok(status, `status must not be null for: ${sample}`);
      assert.doesNotMatch(
        status,
        /sk-abc1234567890secret|opaque-result-token|SuperSecretPassw0rd|redis-password|hunter2/,
        `status_reason leaked secret for: ${sample} → ${status}`,
      );
      assert.doesNotMatch(
        outbox,
        /sk-abc1234567890secret|opaque-result-token|SuperSecretPassw0rd|redis-password|hunter2/,
        `outbox last_error leaked secret for: ${sample} → ${outbox}`,
      );
    }
    // Both paths must import shared redaction (structural).
    const statusSrc = fs.readFileSync(
      path.join(root, 'src/application/sanitize-status-reason.js'),
      'utf8',
    );
    const outboxSrc = fs.readFileSync(
      path.join(root, 'src/infrastructure/outbox/sanitize-error.js'),
      'utf8',
    );
    assert.match(statusSrc, /redactSecretText/);
    assert.match(outboxSrc, /redactSecretText/);
  });

  it('MCP factory and event recorders redact before model/persistence', () => {
    const files = [
      'src/infrastructure/mcp/pi-mcp-adapter-factory.js',
      'src/application/fenced-run-event-recorder.js',
      'src/application/fenced-tool-governance-recorder.js',
      'src/extensions/sandbox-bridge/result.js',
    ];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      assert.match(
        src,
        /redactPayload|redactInlineSecrets/,
        `${rel} must redact untrusted payloads`,
      );
    }
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
      assert.doesNotMatch(
        src,
        /createConnection|DATABASE_URL|pymysql|sqlalchemy/,
        `${rel} must not embed business DSN clients`,
      );
    }
  });

  it('sandbox-bridge tool surface is the exact 10 non-SQL tools', () => {
    assert.deepEqual(
      [...SANDBOX_TOOL_NAMES].sort(),
      [
        'bash',
        'edit',
        'process_kill',
        'process_read',
        'process_start',
        'process_status',
        'python',
        'read',
        'submit_artifact',
        'write',
      ],
    );
    for (const name of SANDBOX_TOOL_NAMES) {
      assert.doesNotMatch(name, /sql|mysql|postgres|query|dsn|database/i);
    }
  });

  it('agent MCP infrastructure is pi-mcp-adapter only (no second client stack)', () => {
    const mcpDir = path.join(root, 'src/infrastructure/mcp');
    const files = listJsFiles(mcpDir);
    assert.ok(files.length >= 2, 'expected mcp infrastructure modules');
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      // Import/require/new only — comments may mention legacy names as bans.
      assert.doesNotMatch(
        src,
        /import\s+.*McpConnectionManager|from\s+['"][^'"]*mcp-connection-manager|require\(['"][^'"]*mcp-connection-manager|new\s+McpConnectionManager|@modelcontextprotocol\/sdk|new\s+McpClient\b/,
        `${path.relative(root, file)} must not implement a second MCP client`,
      );
      assert.doesNotMatch(
        src,
        /\bfetch\s*\(/,
        `${path.relative(root, file)} must not call fetch() as an MCP transport`,
      );
    }
    const indexSrc = fs.readFileSync(path.join(mcpDir, 'index.js'), 'utf8');
    assert.match(indexSrc, /pi-mcp-adapter/);
  });

  it('extensions do not register business SQL tools or open DSN clients', () => {
    const extRoot = path.join(root, 'src/extensions');
    for (const file of listJsFiles(extRoot)) {
      const src = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(
        src,
        /createPool\s*\(|require\(['"]mysql2['"]\)|from\s+['"]mysql2['"]|from\s+['"]knex['"]/,
        `${path.relative(root, file)} must not open MySQL from extensions`,
      );
      // Tool names that would look like direct DB access.
      assert.doesNotMatch(
        src,
        /name:\s*['"](?:sql|query_sql|execute_sql|mysql_query|run_query)['"]/,
        `${path.relative(root, file)} must not register direct SQL tools`,
      );
    }
  });
});
