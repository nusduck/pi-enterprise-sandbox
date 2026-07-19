/**
 * Capabilities page UI contracts (F5 diagnostics + MCP status truth).
 * Run: npm test -- test/capabilities-page.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pageSrc = readFileSync(
  join(__dirname, '../src/pages/settings/CapabilitiesPage.tsx'),
  'utf8',
);

describe('CapabilitiesPage diagnostics and MCP status contracts', () => {
  it('prefers canonical MCP status over connection_status', () => {
    assert.match(
      pageSrc,
      /const status =\s*\n\s*s\.status \|\|\s*\n\s*\(s\.enabled === false \? 'disabled' : s\.connection_status \|\| 'configured'\)/,
    );
    assert.doesNotMatch(
      pageSrc,
      /s\.connection_status \|\| s\.status/,
    );
  });

  it('projects configured capabilities from the production three-extension runtime', () => {
    const diagnosticsSrc = readFileSync(
      join(__dirname, '../../agent/src/application/extension-diagnostics-service.js'),
      'utf8',
    );
    const extensionSrc = readFileSync(
      join(__dirname, '../../agent/src/extensions/constants.js'),
      'utf8',
    );
    assert.match(diagnosticsSrc, /Per-Run live authority/);
    assert.match(extensionSrc, /sandbox-bridge/);
    assert.match(extensionSrc, /enterprise-policy/);
    assert.match(extensionSrc, /observability/);
    assert.doesNotMatch(diagnosticsSrc, /packages\/enterprise-agent-kit/);
  });

  it('renders extension statuses and registry session scope on diagnostics tab', () => {
    assert.match(pageSrc, /\(diagnostics\.extensions \?\? \[\]\)\.map/);
    assert.match(pageSrc, /statusLabel\(ext\)/);
    assert.match(pageSrc, /Registry version/);
    assert.match(pageSrc, /diagnostics\.registry\?\.conversation_id/);
    assert.match(pageSrc, /diagnostics\.registry\?\.session_id/);
    assert.match(pageSrc, /diagnostics\.registry\?\.run_id/);
    assert.doesNotMatch(pageSrc, /owner_user_id/);
    assert.doesNotMatch(pageSrc, /organization_id/);
  });
});
