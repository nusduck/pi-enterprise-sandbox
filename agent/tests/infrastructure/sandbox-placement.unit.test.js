/**
 * Sandbox placement routing: where a workspace-bound request is sent, and what
 * happens when that answer turns out to be stale.
 *
 * The Sandbox is sharded rather than load balanced, so these are correctness
 * tests, not performance ones. Sending a process read to the wrong replica does
 * not fail — it returns an empty slice with a 200. The routing layer is what
 * keeps that from happening.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  addressToBaseUrl,
  createSandboxPlacementResolver,
  readPlacementMismatch,
} from '../../src/infrastructure/sandbox/placement-resolver.js';
import {
  createBaseUrlSelector,
  sendWithPlacementRetry,
} from '../../src/infrastructure/sandbox/placement-routing.js';

const DISCOVERY = 'http://sandbox:8081';
const OWNER_ADDRESS = 'sandbox-2.sandbox-headless.pi.svc.cluster.local:8081';
const OWNER_URL = `http://${OWNER_ADDRESS}`;

const IDENTITY = Object.freeze({
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN54',
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN51',
});

/**
 * Minimal knex stand-in. Returns a `knexFactory`, so the shape is
 * `knexFactory()(table).leftJoin(...).where(...).first(...)`.
 */
function fakeKnex(row, { onQuery } = {}) {
  const builder = {
    leftJoin: () => builder,
    where: () => builder,
    andWhere: () => builder,
    first: async () => {
      onQuery?.();
      return row;
    },
  };
  const knex = () => builder;
  return () => knex;
}

// ── address handling ────────────────────────────────────────────────────

describe('addressToBaseUrl', () => {
  it('turns the published bare authority into a URL', () => {
    assert.equal(addressToBaseUrl('sandbox-0:8081'), 'http://sandbox-0:8081');
  });

  it('leaves an already-qualified URL alone rather than double-prefixing', () => {
    assert.equal(
      addressToBaseUrl('https://sandbox-0:8443'),
      'https://sandbox-0:8443',
    );
  });

  it('treats a blank address as no answer', () => {
    assert.equal(addressToBaseUrl(''), null);
    assert.equal(addressToBaseUrl(undefined), null);
  });
});

// ── resolution ──────────────────────────────────────────────────────────

describe('createSandboxPlacementResolver', () => {
  it('requires a discovery URL', () => {
    assert.throws(() => createSandboxPlacementResolver({}), /discoveryUrl/);
  });

  it('routes to the owning replica read from MySQL', async () => {
    const resolver = createSandboxPlacementResolver({
      discoveryUrl: DISCOVERY,
      knexFactory: fakeKnex({ nodeId: 'sandbox-2', address: OWNER_ADDRESS }),
    });

    assert.equal(await resolver.resolve(IDENTITY), OWNER_URL);
  });

  it('caches so a hot session does not re-query per tool call', async () => {
    let queries = 0;
    const resolver = createSandboxPlacementResolver({
      discoveryUrl: DISCOVERY,
      knexFactory: fakeKnex(
        { nodeId: 'sandbox-2', address: OWNER_ADDRESS },
        { onQuery: () => (queries += 1) },
      ),
    });

    await resolver.resolve(IDENTITY);
    await resolver.resolve(IDENTITY);
    await resolver.resolve(IDENTITY);

    assert.equal(queries, 1);
  });

  it('expires the cache so a re-placed session is not pinned forever', async () => {
    let now = 1_000;
    let queries = 0;
    const resolver = createSandboxPlacementResolver({
      discoveryUrl: DISCOVERY,
      ttlMs: 100,
      clock: () => now,
      knexFactory: fakeKnex(
        { nodeId: 'sandbox-2', address: OWNER_ADDRESS },
        { onQuery: () => (queries += 1) },
      ),
    });

    await resolver.resolve(IDENTITY);
    now += 101;
    await resolver.resolve(IDENTITY);

    assert.equal(queries, 2);
  });

  it('falls back to discovery for a session with no placement yet', async () => {
    const resolver = createSandboxPlacementResolver({
      discoveryUrl: DISCOVERY,
      knexFactory: fakeKnex({ nodeId: null, address: null }),
    });

    // Unplaced is normal on first use: ensure has not run, and answering
    // ensure is what assigns an owner.
    assert.equal(await resolver.resolve(IDENTITY), DISCOVERY);
  });

  it('falls back to discovery when the lookup fails', async () => {
    const resolver = createSandboxPlacementResolver({
      discoveryUrl: DISCOVERY,
      knexFactory: () => {
        throw new Error('mysql down');
      },
    });

    // A routing lookup must never fail the tool call: a wrong guess is refused
    // with 409 rather than silently served.
    assert.equal(await resolver.resolve(IDENTITY), DISCOVERY);
  });

  it('does not cache the discovery fallback', async () => {
    let queries = 0;
    const resolver = createSandboxPlacementResolver({
      discoveryUrl: DISCOVERY,
      knexFactory: fakeKnex(
        { nodeId: null, address: null },
        { onQuery: () => (queries += 1) },
      ),
    });

    await resolver.resolve(IDENTITY);
    await resolver.resolve(IDENTITY);

    assert.equal(queries, 2, 'an unplaced session must be re-checked');
    assert.equal(resolver.size(), 0);
  });

  it('routes artifacts by where the bytes are stored, not by workspace', async () => {
    const resolver = createSandboxPlacementResolver({
      discoveryUrl: DISCOVERY,
      knexFactory: fakeKnex({ nodeId: 'sandbox-4', address: 'sandbox-4:8081' }),
    });

    // A snapshot is immutable and outlives its session, so the producing
    // workspace may be long closed by the time someone downloads it.
    assert.equal(
      await resolver.resolveArtifact('01K0G2PAV8FPMVC9QHJG7JPN70', IDENTITY),
      'http://sandbox-4:8081',
    );
  });

  it('adopts the owner named by a mismatch', async () => {
    const resolver = createSandboxPlacementResolver({
      discoveryUrl: DISCOVERY,
      knexFactory: fakeKnex({ nodeId: 'sandbox-1', address: 'sandbox-1:8081' }),
    });
    await resolver.resolve(IDENTITY);

    const adopted = resolver.onMismatch(IDENTITY.sandboxSessionId, OWNER_ADDRESS);

    assert.equal(adopted, OWNER_URL);
    assert.equal(await resolver.resolve(IDENTITY), OWNER_URL);
  });

  it('drops the stale entry when a mismatch names no address', async () => {
    const resolver = createSandboxPlacementResolver({
      discoveryUrl: DISCOVERY,
      knexFactory: fakeKnex({ nodeId: 'sandbox-1', address: 'sandbox-1:8081' }),
    });
    await resolver.resolve(IDENTITY);

    assert.equal(resolver.onMismatch(IDENTITY.sandboxSessionId, null), null);
    assert.equal(resolver.size(), 0, 'next call re-reads MySQL');
  });
});

// ── mismatch decoding ───────────────────────────────────────────────────

describe('readPlacementMismatch', () => {
  it('recognises the routing instruction', () => {
    const mismatch = readPlacementMismatch(409, {
      detail: {
        code: 'PLACEMENT_MISMATCH',
        ownerNodeId: 'sandbox-2',
        ownerAddress: OWNER_ADDRESS,
      },
    });
    assert.deepEqual(mismatch, {
      ownerNodeId: 'sandbox-2',
      ownerAddress: OWNER_ADDRESS,
    });
  });

  it('ignores other 409s, which are real conflicts', () => {
    // Retrying a binding conflict elsewhere would be wrong: the conflict is a
    // fact about the session, not about which replica answered.
    assert.equal(
      readPlacementMismatch(409, { detail: { code: 'SESSION_BINDING_CONFLICT' } }),
      null,
    );
    assert.equal(readPlacementMismatch(409, { detail: {} }), null);
  });

  it('ignores non-409 statuses', () => {
    assert.equal(
      readPlacementMismatch(500, { detail: { code: 'PLACEMENT_MISMATCH' } }),
      null,
    );
  });
});

// ── retry behaviour ─────────────────────────────────────────────────────

describe('sendWithPlacementRetry', () => {
  const placementStub = (adopted) => ({ onMismatch: () => adopted });

  it('sends once when the first replica accepts', async () => {
    const targets = [];
    const result = await sendWithPlacementRetry({
      send: async (baseUrl) => {
        targets.push(baseUrl);
        return { status: 200, ok: true, parsed: {} };
      },
      selectBaseUrl: async () => DISCOVERY,
      placement: placementStub(OWNER_URL),
      identity: IDENTITY,
    });

    assert.deepEqual(targets, [DISCOVERY]);
    assert.equal(result.status, 200);
  });

  it('re-sends to the owner named by a mismatch', async () => {
    const targets = [];
    const result = await sendWithPlacementRetry({
      send: async (baseUrl) => {
        targets.push(baseUrl);
        if (baseUrl !== OWNER_URL) {
          return {
            status: 409,
            ok: false,
            parsed: {
              detail: {
                code: 'PLACEMENT_MISMATCH',
                ownerNodeId: 'sandbox-2',
                ownerAddress: OWNER_ADDRESS,
              },
            },
          };
        }
        return { status: 200, ok: true, parsed: { ran: true } };
      },
      selectBaseUrl: async () => DISCOVERY,
      placement: placementStub(OWNER_URL),
      identity: IDENTITY,
    });

    assert.deepEqual(targets, [DISCOVERY, OWNER_URL]);
    assert.equal(result.parsed.ran, true);
  });

  it('retries at most once', async () => {
    let calls = 0;
    const mismatch = {
      status: 409,
      ok: false,
      parsed: {
        detail: {
          code: 'PLACEMENT_MISMATCH',
          ownerNodeId: 'sandbox-2',
          ownerAddress: OWNER_ADDRESS,
        },
      },
    };
    const result = await sendWithPlacementRetry({
      send: async () => {
        calls += 1;
        return mismatch;
      },
      selectBaseUrl: async () => DISCOVERY,
      placement: placementStub(OWNER_URL),
      identity: IDENTITY,
    });

    // A second mismatch means placement is genuinely unstable; re-routing
    // harder would spread one confused request across the fleet.
    assert.equal(calls, 2);
    assert.equal(result.status, 409);
  });

  it('does not retry when the mismatch names nowhere to go', async () => {
    let calls = 0;
    const result = await sendWithPlacementRetry({
      send: async () => {
        calls += 1;
        return {
          status: 409,
          ok: false,
          parsed: { detail: { code: 'PLACEMENT_MISMATCH', ownerAddress: null } },
        };
      },
      selectBaseUrl: async () => DISCOVERY,
      placement: placementStub(null),
      identity: IDENTITY,
    });

    assert.equal(calls, 1);
    assert.equal(result.status, 409);
  });

  it('does not treat a normal error as a routing problem', async () => {
    let calls = 0;
    const result = await sendWithPlacementRetry({
      send: async () => {
        calls += 1;
        return { status: 500, ok: false, parsed: { detail: { code: 'BOOM' } } };
      },
      selectBaseUrl: async () => DISCOVERY,
      placement: placementStub(OWNER_URL),
      identity: IDENTITY,
    });

    assert.equal(calls, 1);
    assert.equal(result.status, 500);
  });
});

describe('createBaseUrlSelector', () => {
  it('uses the static base URL when no placement is configured', async () => {
    const select = createBaseUrlSelector({ baseUrl: DISCOVERY });
    assert.equal(await select(IDENTITY), DISCOVERY);
  });

  it('prefers the resolved owner', async () => {
    const select = createBaseUrlSelector({
      baseUrl: DISCOVERY,
      placement: { resolve: async () => OWNER_URL },
    });
    assert.equal(await select(IDENTITY), OWNER_URL);
  });

  it('falls back to the static base URL when resolution throws', async () => {
    const select = createBaseUrlSelector({
      baseUrl: DISCOVERY,
      placement: {
        resolve: async () => {
          throw new Error('nope');
        },
      },
    });
    assert.equal(await select(IDENTITY), DISCOVERY);
  });
});
