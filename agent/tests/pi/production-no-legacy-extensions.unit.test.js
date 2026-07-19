/**
 * Static guard: new production composition paths must not import legacy
 * extension host / package loader / McpConnectionManager (PR-06).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src',
);

/** Production roots under agent/src that must stay free of legacy 12-ext wiring. */
const PRODUCTION_GLOBS = [
  'bootstrap',
  'application',
  'extensions',
  'infrastructure/pi',
  'infrastructure/mcp',
  'infrastructure/mysql',
  'infrastructure/redis',
  'infrastructure/outbox',
  'domain',
];

const FORBIDDEN = [
  /extension-package-loader/,
  /extension-host-adapter/,
  /mcp-connection-manager/,
  /McpConnectionManager/,
  /createEnterpriseAgentKit/,
  /enterprise-agent-kit\/extensions/,
  /packages\/enterprise-agent-kit/,
];

// Mentions that are documentation-only (allowed)
const ALLOW_IF = [
  /do not import McpConnectionManager/i,
  /Legacy agent\/infrastructure\/mcp-connection-manager/i,
  /legacy package/i,
  /LEGACY_EXTENSION/,
  /non-production/i,
];

function walkJs(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkJs(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('production path: no old-12 extension / legacy MCP imports', () => {
  it('agent/src production trees do not import legacy host/package/MCP client', () => {
    /** @type {string[]} */
    const offenders = [];
    for (const rel of PRODUCTION_GLOBS) {
      const dir = path.join(ROOT, rel);
      for (const file of walkJs(dir)) {
        const src = readFileSync(file, 'utf8');
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          // Skip pure comments that document forbidden paths
          if (ALLOW_IF.some((re) => re.test(line))) continue;
          if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) {
            if (!/import\s|from\s['"]/.test(line)) continue;
          }
          for (const re of FORBIDDEN) {
            if (re.test(line)) {
              offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
            }
          }
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `Forbidden legacy imports in production paths:\n${offenders.join('\n')}`,
    );
  });

  it('enterprise extensions are exactly three logical names', async () => {
    const {
      ENTERPRISE_EXTENSION_NAMES,
      LEGACY_EXTENSION_PACKAGE_NAMES,
    } = await import('../../src/extensions/index.js');
    assert.equal(ENTERPRISE_EXTENSION_NAMES.length, 3);
    assert.equal(LEGACY_EXTENSION_PACKAGE_NAMES.length, 12);
    assert.ok(!LEGACY_EXTENSION_PACKAGE_NAMES.includes('sandbox-bridge'));
    assert.ok(!LEGACY_EXTENSION_PACKAGE_NAMES.includes('enterprise-policy'));
  });

  it('legacy enterprise-agent-kit package and manifest dependency stay absent', () => {
    const agentRoot = path.resolve(ROOT, '..');
    assert.equal(
      existsSync(path.join(agentRoot, 'packages/enterprise-agent-kit')),
      false,
    );
    const manifest = JSON.parse(
      readFileSync(path.join(agentRoot, 'package.json'), 'utf8'),
    );
    assert.equal(
      Object.hasOwn(
        manifest.dependencies || {},
        '@company/pi-enterprise-agent-kit',
      ),
      false,
    );
  });
});
