/**
 * Pinned SDK package identity + exports required by agent service.
 * Run: node --test agent/tests/sdk-compat/sdk-surface.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VERSION,
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  SettingsManager,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, '../../package.json');
const installedPkgPath = join(
  __dirname,
  '../../node_modules/@earendil-works/pi-coding-agent/package.json',
);

describe('exact version pin', () => {
  const pinsPath = join(__dirname, '../../../runtime-versions.json');

  it('package.json pins @earendil-works/pi-coding-agent without range operators', () => {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const spec = pkg.dependencies['@earendil-works/pi-coding-agent'];
    assert.ok(spec, 'dependency missing');
    assert.equal(
      /^\d+\.\d+\.\d+/.test(spec) && !spec.startsWith('^') && !spec.startsWith('~'),
      true,
      `expected exact version, got ${spec}`,
    );
  });

  it('package.json SDK pins match runtime-versions.json SSOT', () => {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const pins = JSON.parse(readFileSync(pinsPath, 'utf8'));
    assert.equal(
      pkg.dependencies['@earendil-works/pi-coding-agent'],
      pins.pi_sdk.pi_coding_agent,
    );
    assert.equal(pkg.dependencies['@earendil-works/pi-ai'], pins.pi_sdk.pi_ai);
    assert.equal(pkg.engines?.node, pins.node.engines);
  });

  it('installed package VERSION matches package.json pin', () => {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const pin = pkg.dependencies['@earendil-works/pi-coding-agent'];
    assert.equal(VERSION, pin);
    const installed = JSON.parse(readFileSync(installedPkgPath, 'utf8'));
    assert.equal(installed.version, pin);
    assert.equal(installed.license, 'MIT');
  });
});

describe('required named exports', () => {
  it('exports symbols used by the Agent Run Host', () => {
    const required = {
      createAgentSession,
      SessionManager,
      AuthStorage,
      ModelRegistry,
      DefaultResourceLoader,
      SettingsManager,
      getAgentDir,
    };
    for (const [name, value] of Object.entries(required)) {
      assert.ok(value != null, `missing export ${name}`);
    }
    assert.equal(typeof createAgentSession, 'function');
    assert.equal(typeof DefaultResourceLoader, 'function');
  });
});
