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

  it('mentions paginated capability inventory in platform/runtime guidance', () => {
    const promptSrc = readFileSync(
      join(__dirname, '../../agent/packages/enterprise-agent-kit/extensions/prompt/index.js'),
      'utf8',
    );
    const introSrc = readFileSync(
      join(
        __dirname,
        '../../agent/packages/enterprise-agent-kit/extensions/capability-introspection/index.js',
      ),
      'utf8',
    );
    assert.match(promptSrc, /next_cursor/);
    assert.match(introSrc, /paginated/);
    assert.match(introSrc, /next_cursor/);
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