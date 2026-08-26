/**
 * ls / find / grep: the sandbox-routed replacements for the SDK's local
 * filesystem tools, which stay permanently excluded because they would read the
 * Agent container rather than the user's workspace.
 *
 * These assert what the model actually experiences: bounded defaults, paths
 * normalised to the logical workspace before anything is signed, truncation
 * that stays visible, and no route out of the workspace.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSandboxBridgeToolDefinitions,
  SANDBOX_TOOL_NAMES,
} from '../../src/extensions/sandbox-bridge/tools/index.js';
import {
  FIND_DEFAULT_LIMIT,
  FIND_MAX_LIMIT,
  GREP_DEFAULT_LIMIT,
  GREP_MAX_CONTEXT,
  LS_DEFAULT_DEPTH,
  LS_MAX_DEPTH,
  PARALLEL_TOOLS,
} from '../../src/extensions/sandbox-bridge/constants.js';
import { LOCAL_FILESYSTEM_TOOL_NAMES } from '../../src/infrastructure/pi/pi-runtime-constants.js';

const RUN = Object.freeze({
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN5F',
  traceId: 'b'.repeat(32),
  executionFenceToken: 7,
});

function createTransport(calls, responses = {}) {
  const listPayload = {
    items: [{ path: 'src/app.js', name: 'app.js', type: 'file', size: 42 }],
    skipped: [],
    stats: { scanned: 1, matched: 1 },
    truncated: false,
    stop_reason: null,
  };
  const grepPayload = {
    matches: [{ path: 'src/app.js', line: 7, column: 3, text: 'const needle = 1;' }],
    skipped: [],
    stats: { scanned: 4, matched: 1 },
    truncated: false,
    stop_reason: null,
  };
  const make = (method, fallback) => async (payload) => {
    calls.push({ method, payload });
    return responses[method] ?? fallback;
  };
  return {
    lsFiles: make('lsFiles', listPayload),
    findFiles: make('findFiles', listPayload),
    grepFiles: make('grepFiles', grepPayload),
  };
}

function createBinder(binds = []) {
  return {
    async bindSandboxRequest(input) {
      binds.push(input);
      return {
        toolExecutionId: '01K0G2PAV8FPMVC9QHJG7PJN70',
        requestHash: input.requestHash,
        requestHashVersion: input.requestHashVersion ?? 1,
      };
    },
  };
}

function defsFor(calls, responses) {
  return createSandboxBridgeToolDefinitions(RUN, createTransport(calls, responses), {
    sandboxRequestBinder: createBinder(),
  });
}

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

describe('search tools close the gap left by the excluded SDK tools', () => {
  it('registers a sandbox-routed tool for every excluded local filesystem tool', () => {
    for (const name of LOCAL_FILESYSTEM_TOOL_NAMES) {
      assert.ok(
        SANDBOX_TOOL_NAMES.includes(name),
        `${name} is excluded from the SDK but has no sandbox replacement`,
      );
    }
  });

  it('is read-only, so it may run in parallel with read', () => {
    for (const name of ['ls', 'find', 'grep']) {
      assert.ok(PARALLEL_TOOLS.has(name), name);
    }
    for (const name of ['write', 'edit', 'bash', 'python']) {
      assert.equal(PARALLEL_TOOLS.has(name), false, name);
    }
  });
});

describe('ls', () => {
  it('defaults to the workspace root with the shallow depth', async () => {
    const calls = [];
    const ls = defsFor(calls).find((t) => t.name === 'ls');
    const result = await ls.execute('tc-ls');
    assert.equal(result.content[0].text.includes('Error'), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.path, '/home/sandbox/workspace');
    assert.equal(calls[0].payload.depth, LS_DEFAULT_DEPTH);
    assert.equal(calls[0].payload.includeHidden, false);
  });

  it('clamps a depth above the ceiling instead of refusing the call', async () => {
    const calls = [];
    const ls = defsFor(calls).find((t) => t.name === 'ls');
    await ls.execute('tc-ls', { depth: 99 });
    assert.equal(calls[0].payload.depth, LS_MAX_DEPTH);
  });

  it('normalises a relative path to the logical workspace before signing', async () => {
    const calls = [];
    const ls = defsFor(calls).find((t) => t.name === 'ls');
    await ls.execute('tc-ls', { path: 'src/lib' });
    assert.equal(calls[0].payload.path, '/home/sandbox/workspace/src/lib');
  });

  it('refuses to escape the workspace', async () => {
    const calls = [];
    const ls = defsFor(calls).find((t) => t.name === 'ls');
    for (const path of ['../../etc', '/etc/passwd', 'C:\\Windows']) {
      const result = await ls.execute('tc-ls', { path });
      assert.match(result.content[0].text, /Error/, path);
    }
    assert.equal(calls.length, 0, 'no transport call may be made for an escape');
  });
});

describe('find', () => {
  it('requires a pattern and applies the default budget', async () => {
    const calls = [];
    const find = defsFor(calls).find((t) => t.name === 'find');
    const missing = await find.execute('tc-find', {});
    assert.match(missing.content[0].text, /PATTERN_REQUIRED/);
    assert.equal(calls.length, 0);

    await find.execute('tc-find', { pattern: '*.ts' });
    assert.equal(calls[0].payload.limit, FIND_DEFAULT_LIMIT);
    assert.equal(calls[0].payload.type, null);
  });

  it('clamps an oversized limit', async () => {
    const calls = [];
    const find = defsFor(calls).find((t) => t.name === 'find');
    await find.execute('tc-find', { pattern: '*', limit: 100_000 });
    assert.equal(calls[0].payload.limit, FIND_MAX_LIMIT);
  });
});

describe('grep', () => {
  it('is literal and case-sensitive unless asked otherwise', async () => {
    const calls = [];
    const grep = defsFor(calls).find((t) => t.name === 'grep');
    await grep.execute('tc-grep', { query: 'needle' });
    assert.equal(calls[0].payload.regex, false);
    assert.equal(calls[0].payload.caseSensitive, true);
    assert.equal(calls[0].payload.context, 0);
    assert.equal(calls[0].payload.limit, GREP_DEFAULT_LIMIT);
    assert.equal(calls[0].payload.glob, null);
  });

  it('honours regex, case and context when the model asks', async () => {
    const calls = [];
    const grep = defsFor(calls).find((t) => t.name === 'grep');
    await grep.execute('tc-grep', {
      query: 'ne+dle',
      regex: true,
      caseSensitive: false,
      context: 99,
      glob: '*.js',
    });
    assert.equal(calls[0].payload.regex, true);
    assert.equal(calls[0].payload.caseSensitive, false);
    assert.equal(calls[0].payload.context, GREP_MAX_CONTEXT);
    assert.equal(calls[0].payload.glob, '*.js');
  });

  it('rejects a blank query and a blank glob without calling transport', async () => {
    const calls = [];
    const grep = defsFor(calls).find((t) => t.name === 'grep');
    assert.match(
      (await grep.execute('tc-grep', { query: '   ' })).content[0].text,
      /QUERY_REQUIRED/,
    );
    assert.match(
      (await grep.execute('tc-grep', { query: 'x', glob: '  ' })).content[0].text,
      /GLOB_INVALID/,
    );
    assert.equal(calls.length, 0);
  });

  it('reports matches with the file and line the model needs', async () => {
    const result = await defsFor([])
      .find((t) => t.name === 'grep')
      .execute('tc-grep', { query: 'needle' });
    const payload = parseResult(result);
    assert.equal(payload.tool, 'grep');
    assert.equal(payload.count, 1);
    assert.equal(payload.matches[0].path, 'src/app.js');
    assert.equal(payload.matches[0].line, 7);
    assert.equal(payload.filesMatched, 1);
  });
});

describe('truncation stays visible', () => {
  it('surfaces truncated plus an actionable hint rather than a short list', async () => {
    const defs = defsFor([], {
      grepFiles: {
        matches: [{ path: 'a.js', line: 1, column: 1, text: 'x' }],
        skipped: [],
        stats: { scanned: 900, matched: 900 },
        truncated: true,
        stop_reason: 'match_limit',
      },
    });
    const payload = parseResult(
      await defs.find((t) => t.name === 'grep').execute('tc-grep', { query: 'x' }),
    );
    assert.equal(payload.truncated, true);
    assert.equal(payload.stopReason, 'match_limit');
    assert.match(payload.hint, /more specific|glob/i);
  });

  it('reports skipped directories so "not found" is distinguishable from "never looked"', async () => {
    const defs = defsFor([], {
      lsFiles: {
        items: [],
        skipped: [{ path: 'vendor', reason: 'depth_limit' }],
        stats: { scanned: 1, matched: 0 },
        truncated: false,
        stop_reason: null,
      },
    });
    const payload = parseResult(
      await defs.find((t) => t.name === 'ls').execute('tc-ls', {}),
    );
    assert.deepEqual(payload.skipped, [{ path: 'vendor', reason: 'depth_limit' }]);
  });

  it('tells the model what to try when a search found nothing', async () => {
    const defs = defsFor([], {
      findFiles: {
        items: [],
        skipped: [],
        stats: { scanned: 12, matched: 0 },
        truncated: false,
        stop_reason: null,
      },
    });
    const payload = parseResult(
      await defs.find((t) => t.name === 'find').execute('tc-find', { pattern: '*.rs' }),
    );
    assert.equal(payload.count, 0);
    assert.match(payload.hint, /broader pattern|different root/i);
  });
});

describe('ledger binding', () => {
  it('binds every search before any transport call', async () => {
    const calls = [];
    const binds = [];
    const defs = createSandboxBridgeToolDefinitions(RUN, createTransport(calls), {
      sandboxRequestBinder: createBinder(binds),
    });
    await defs.find((t) => t.name === 'ls').execute('tc-ls', {});
    await defs.find((t) => t.name === 'find').execute('tc-find', { pattern: '*' });
    await defs.find((t) => t.name === 'grep').execute('tc-grep', { query: 'q' });
    assert.deepEqual(
      binds.map((b) => b.toolName),
      ['ls', 'find', 'grep'],
    );
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.payload.identity.orgId, RUN.orgId);
      assert.equal(call.payload.identity.runId, RUN.runId);
      assert.equal(call.payload.identity.executionFenceToken, 7);
    }
  });

  it('makes zero transport calls when the binder is missing', async () => {
    const calls = [];
    const defs = createSandboxBridgeToolDefinitions(RUN, createTransport(calls), {});
    for (const [name, params] of [
      ['ls', {}],
      ['find', { pattern: '*' }],
      ['grep', { query: 'q' }],
    ]) {
      const result = await defs.find((t) => t.name === name).execute(`tc-${name}`, params);
      assert.match(result.content[0].text, /SANDBOX_REQUEST_BINDER_UNAVAILABLE/, name);
    }
    assert.equal(calls.length, 0);
  });
});

describe('skill paths: listable, not searchable', () => {
  const skillPaths = [
    '/home/sandbox/skill',
    '/home/sandbox/skill/docx',
    '/home/sandbox/skill/docx/SKILL.md',
    '/home/sandbox/skill-user',
    '/home/sandbox/skill-user/01K0G2PAV8FPMVC9QHJG7JPN4Z/01K0G2PAV8FPMVC9QHJG7JPN50/pkg',
  ];

  const searchInvocations = {
    find: (path) => ({ path, pattern: '*.md' }),
    grep: (path) => ({ path, query: 'needle' }),
  };

  for (const [name, buildParams] of Object.entries(searchInvocations)) {
    for (const path of skillPaths) {
      it(`${name} refuses ${path} without calling the Sandbox`, async () => {
        const calls = [];
        const defs = defsFor(calls);
        const tool = defs.find((d) => d.name === name);
        const out = await tool.execute(`tc-${name}`, buildParams(path));
        assert.equal(out.details.code, 'PATH_SKILL_SEARCH_UNSUPPORTED');
        // The message must send the model somewhere that works, and ls now does.
        assert.match(out.content[0].text, /Use ls/, out.content[0].text);
        assert.equal(
          calls.length,
          0,
          'must not forward a path the Sandbox will reject',
        );
      });
    }
  }

  for (const path of skillPaths) {
    it(`ls forwards ${path} to the Sandbox`, async () => {
      const calls = [];
      const defs = defsFor(calls);
      const tool = defs.find((d) => d.name === 'ls');
      const out = await tool.execute('tc-ls', { path });
      assert.equal(out.details?.code, undefined, out.content[0].text);
      assert.equal(calls.length, 1, 'ls must reach the Sandbox for skill paths');
      assert.equal(calls[0].method, 'lsFiles');
      assert.equal(calls[0].payload.path, path);
    });
  }

  it('ls still rejects a path outside every root', async () => {
    const calls = [];
    const defs = defsFor(calls);
    const tool = defs.find((d) => d.name === 'ls');
    const out = await tool.execute('tc-ls', { path: '/etc' });
    assert.equal(out.details.code, 'PATH_OUTSIDE_WORKSPACE');
    assert.equal(calls.length, 0);
  });

  it('still searches the workspace and /tmp', async () => {
    for (const path of ['/home/sandbox/workspace/src', '/tmp', 'src']) {
      const calls = [];
      const defs = defsFor(calls);
      const tool = defs.find((d) => d.name === 'ls');
      const out = await tool.execute('tc-ls', { path });
      assert.equal(out.details?.code, undefined, `${path} should be searchable`);
      assert.equal(calls.length, 1);
    }
  });
});
