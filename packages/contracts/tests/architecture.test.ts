/**
 * Architecture boundary tests: static imports of target-layout contracts.
 * Does not assert filesystem placeholders (avoids self-proving skeleton tests).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_EXTENSIONS,
  AGENT_TARGET_LAYOUT,
  API_SERVER_TARGET_LAYOUT,
  FRONTEND_TARGET_LAYOUT,
  SANDBOX_TARGET_LAYOUT,
  TARGET_LAYOUTS,
} from '../src/architecture/index.ts';
import {
  LAYERS as AGENT_LAYERS,
  EXTENSIONS as AGENT_LOCAL_EXTENSIONS,
  SERVICE as AGENT_SERVICE,
  TARGET_ROOT as AGENT_ROOT,
} from '../../../agent/src/ARCHITECTURE.ts';
import {
  LAYERS as API_LAYERS,
  NON_RESPONSIBILITIES,
  SERVICE as API_SERVICE,
  TARGET_ROOT as API_ROOT,
} from '../../../api-server/src/ARCHITECTURE.ts';
import {
  LAYERS as FE_LAYERS,
  SERVICE as FE_SERVICE,
  TARGET_ROOT as FE_ROOT,
} from '../../../frontend/src/ARCHITECTURE.ts';

describe('target layout catalog (static import)', () => {
  it('covers four services with unique roots', () => {
    assert.equal(TARGET_LAYOUTS.length, 4);
    const services = TARGET_LAYOUTS.map((l) => l.service);
    assert.deepEqual(services, ['agent', 'api-server', 'sandbox', 'frontend']);
    const roots = new Set(TARGET_LAYOUTS.map((l) => l.root));
    assert.equal(roots.size, 4);
  });

  it('agent layers and extensions match plan §12.1 / §2.2', () => {
    assert.deepEqual([...AGENT_TARGET_LAYOUT.layers], [
      'bootstrap',
      'domain',
      'application',
      'runtime',
      'extensions',
      'infrastructure',
      'presentation',
    ]);
    assert.deepEqual([...AGENT_EXTENSIONS], [
      'sandbox-bridge',
      'enterprise-policy',
      'observability',
    ]);
    assert.equal(AGENT_EXTENSIONS.length, 3);
  });

  it('api-server layers match plan §18.2 and ban runtime ownership', () => {
    assert.deepEqual([...API_SERVER_TARGET_LAYOUT.layers], [
      'middleware',
      'routes',
      'clients',
      'services',
    ]);
    const constraints = API_SERVER_TARGET_LAYOUT.constraints ?? [];
    assert.ok(constraints.some((c) => c.includes('run state machine')));
    assert.ok(constraints.some((c) => c.includes('agent loop')));
  });

  it('sandbox layers match plan §16.1', () => {
    assert.deepEqual([...SANDBOX_TARGET_LAYOUT.layers], [
      'api',
      'domain',
      'services',
      'isolation',
      'persistence',
      'security',
      'observability',
    ]);
  });

  it('frontend top-level slices match plan §19.1 (no nested package list)', () => {
    assert.deepEqual([...FRONTEND_TARGET_LAYOUT.layers], [
      'app',
      'entities',
      'features',
      'widgets',
      'pages',
      'shared',
    ]);
    // Guard against regressing into per-feature package catalogs in the layout contract.
    for (const layer of FRONTEND_TARGET_LAYOUT.layers) {
      assert.equal(layer.includes('/'), false);
    }
  });
});

describe('service ARCHITECTURE markers stay aligned with contracts', () => {
  it('agent marker mirrors AGENT_TARGET_LAYOUT', () => {
    assert.equal(AGENT_SERVICE, AGENT_TARGET_LAYOUT.service);
    assert.equal(AGENT_ROOT, AGENT_TARGET_LAYOUT.root);
    assert.deepEqual([...AGENT_LAYERS], [...AGENT_TARGET_LAYOUT.layers]);
    assert.deepEqual([...AGENT_LOCAL_EXTENSIONS], [...AGENT_EXTENSIONS]);
  });

  it('api-server marker mirrors API_SERVER_TARGET_LAYOUT', () => {
    assert.equal(API_SERVICE, API_SERVER_TARGET_LAYOUT.service);
    assert.equal(API_ROOT, API_SERVER_TARGET_LAYOUT.root);
    assert.deepEqual([...API_LAYERS], [...API_SERVER_TARGET_LAYOUT.layers]);
    assert.ok(NON_RESPONSIBILITIES.includes('run-state-machine'));
    assert.ok(NON_RESPONSIBILITIES.includes('agent-loop'));
  });

  it('frontend marker mirrors FRONTEND_TARGET_LAYOUT', () => {
    assert.equal(FE_SERVICE, FRONTEND_TARGET_LAYOUT.service);
    assert.equal(FE_ROOT, FRONTEND_TARGET_LAYOUT.root);
    assert.deepEqual([...FE_LAYERS], [...FRONTEND_TARGET_LAYOUT.layers]);
  });
});
