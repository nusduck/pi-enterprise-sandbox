/**
 * AgentVersion reasoning depth reaches the SDK.
 *
 * The registry already declared `supports_reasoning` and `thinking_levels` per
 * model, but `toPiModel` dropped the level list and nothing ever passed
 * `thinkingLevel` to `createAgentSessionFromServices` — so every reasoning
 * model ran at the SDK default and pi-ai believed all five levels were on
 * offer.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuthStorage,
  SessionManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from '@earendil-works/pi-coding-agent';
import {
  bindAgentVersionConfig,
  normalizeThinkingLevel,
  resolveAgentVersionBindings,
} from '../../src/infrastructure/pi/pi-runtime-factory.js';
import {
  resolveModel,
  supportedThinkingLevels,
  toPiModel,
  toThinkingLevelMap,
} from '../../src/infrastructure/model-registry.js';

const VER = '01K0G2PAV8FPMVC9QHJG7JPN5E';

/** @param {object} configJson */
function bind(configJson) {
  return bindAgentVersionConfig({
    agentVersionId: VER,
    piSdkVersion: '0.80.3',
    configJson,
  });
}

describe('AgentVersion thinkingLevel', () => {
  it('is read from modelPolicy or the flat config', () => {
    assert.equal(bind({ modelPolicy: { thinkingLevel: 'high' } }).thinkingLevel, 'high');
    assert.equal(bind({ thinkingLevel: 'low' }).thinkingLevel, 'low');
    assert.equal(bind({}).thinkingLevel, null, 'absent stays unset');
  });

  it('modelPolicy wins over the flat config', () => {
    assert.equal(
      bind({ thinkingLevel: 'low', modelPolicy: { thinkingLevel: 'high' } })
        .thinkingLevel,
      'high',
    );
  });

  it('fails closed on a typo rather than silently downgrading', () => {
    assert.throws(
      () => bind({ thinkingLevel: 'hgih' }),
      (err) => err.code === 'PI_THINKING_LEVEL_INVALID',
    );
    assert.equal(normalizeThinkingLevel('  HIGH '), 'high');
    assert.equal(normalizeThinkingLevel(''), null);
  });

  it('reaches the runtime bindings and is omitted when unset', () => {
    assert.equal(
      resolveAgentVersionBindings(bind({ thinkingLevel: 'medium' }), {})
        .thinkingLevel,
      'medium',
    );
    assert.equal(
      resolveAgentVersionBindings(bind({}), {}).thinkingLevel,
      null,
      'unset must stay null so the SDK resolves it',
    );
  });
});

describe('registry thinking_levels project into the pi-ai model', () => {
  it('marks undeclared levels unsupported for a reasoning model', () => {
    const map = toThinkingLevelMap({
      supports_reasoning: true,
      thinking_levels: ['low', 'medium', 'high'],
    });
    assert.equal(map.minimal, null);
    assert.equal(map.xhigh, null);
    assert.ok(!('low' in map), 'declared levels stay on the provider default');
    assert.deepEqual(
      supportedThinkingLevels({
        supports_reasoning: true,
        thinking_levels: ['low', 'medium', 'high'],
      }),
      ['low', 'medium', 'high'],
    );
  });

  it('leaves non-reasoning and unconstrained models untouched', () => {
    assert.equal(
      toThinkingLevelMap({ supports_reasoning: false, thinking_levels: ['high'] }),
      undefined,
    );
    assert.equal(
      toThinkingLevelMap({ supports_reasoning: true, thinking_levels: [] }),
      undefined,
      'an empty declaration means unconstrained, not "no levels"',
    );
    assert.deepEqual(supportedThinkingLevels({ supports_reasoning: false }), []);
  });

  it('gives an explicitly declared xhigh the value pi-ai requires', () => {
    // pi-ai treats an unmapped xhigh as unsupported, unlike every other level.
    const map = toThinkingLevelMap({
      supports_reasoning: true,
      thinking_levels: ['high', 'xhigh'],
    });
    assert.equal(map.xhigh, 'xhigh');
  });

  it('carries the map onto the real registry entries', () => {
    const pro = toPiModel(resolveModel('deepseek-v4-pro', { env: {} }));
    assert.equal(pro.reasoning, true);
    assert.equal(pro.thinkingLevelMap.minimal, null, 'pro declares low/medium/high');
    assert.equal(pro.thinkingLevelMap.xhigh, null);

    const flash = toPiModel(resolveModel('deepseek-v4-flash', { env: {} }));
    assert.equal(flash.reasoning, false);
    assert.ok(
      !('thinkingLevelMap' in flash),
      'a non-reasoning model must not carry a level map',
    );
  });
});

describe('the SDK honours the level end to end', () => {
  /** @type {string} */ let cwd;
  /** @type {string} */ let agentDir;
  /** @type {object[]} */ const sessions = [];

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pi-think-cwd-'));
    agentDir = mkdtempSync(join(tmpdir(), 'pi-think-agent-'));
  });

  after(() => {
    for (const session of sessions) {
      try {
        session.dispose();
      } catch {
        /* best-effort */
      }
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  /**
   * @param {object} model
   * @param {string} [thinkingLevel]
   */
  async function buildSession(model, thinkingLevel) {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      authStorage: AuthStorage.inMemory({
        llmio: { type: 'api_key', key: 'not-used' },
      }),
      resourceLoaderOptions: { systemPrompt: 'test', noExtensions: true },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      model,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });
    sessions.push(session);
    return session;
  }

  it('applies the configured level to a reasoning model', async () => {
    const model = toPiModel(resolveModel('deepseek-v4-pro', { env: {} }), {
      baseUrl: 'http://localhost',
    });
    const session = await buildSession(model, 'high');
    assert.equal(session.thinkingLevel, 'high');
    assert.deepEqual(
      session.getAvailableThinkingLevels().sort(),
      // 'off' is always offered; the rest is exactly the registry allowlist.
      ['high', 'low', 'medium', 'off'],
      'the registry allowlist is what the SDK reports as available',
    );
  });

  it('clamps a level the model does not offer instead of failing the Run', async () => {
    const model = toPiModel(resolveModel('deepseek-v4-pro', { env: {} }), {
      baseUrl: 'http://localhost',
    });
    const session = await buildSession(model, 'xhigh');
    assert.equal(
      session.thinkingLevel,
      'high',
      'xhigh is not declared, so it clamps down to the strongest offered',
    );
  });

  it('forces off for a non-reasoning model whatever the AgentVersion asks', async () => {
    const model = toPiModel(resolveModel('deepseek-v4-flash', { env: {} }), {
      baseUrl: 'http://localhost',
    });
    const session = await buildSession(model, 'high');
    assert.equal(session.supportsThinking(), false);
    assert.equal(session.thinkingLevel, 'off');
  });
});
