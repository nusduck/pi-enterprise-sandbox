/**
 * STATUS B3 — prove production Agent sources do not keep an authoritative
 * in-process Run Map. Transient Maps for inflight dedupe, local materialize
 * helpers, and config parsing are allowed only when whitelisted by path +
 * purpose. Any new residual `new Map(` under agent/src must be inventoried
 * here (or the test fails).
 *
 * Scope: real filesystem walk of shipped agent/src (not tests).
 * MySQL remains sole fact authority; Redis is runtime-only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC_ROOT = path.join(root, 'src');

/**
 * Residual transient Maps inventoried under agent/src.
 * Each entry is matched against a single `new Map(` occurrence (file-relative
 * path + source substring). purpose is evidence for STATUS B3 closeout.
 *
 * Classification: all of these are transient-OK (instance field or function-
 * local). None survive process restart as Run / RunEvent authority.
 *
 * @type {ReadonlyArray<{ rel: string, match: RegExp, purpose: string, scope: 'instance'|'local'|'literal' }>}
 */
const TRANSIENT_MAP_WHITELIST = Object.freeze([
  {
    rel: 'bootstrap/http-main.ts',
    match: /const\s+sessionByAgentId\s*=\s*new\s+Map\s*\(/,
    purpose:
      'Function-local AgentSession batch lookup while presenting one owned Run list; MySQL remains authoritative',
    scope: 'local',
  },
  {
    rel: 'application/fenced-run-event-recorder.ts',
    match: /this\._pendingDedupe\s*=\s*new\s+Map\s*\(/,
    purpose:
      'Per-recorder in-flight event dedupe CAS; committed keys are MySQL-backed; lost on restart',
    scope: 'instance',
  },
  {
    rel: 'application/fenced-tool-governance-recorder.ts',
    match: /this\._inflight\s*=\s*new\s+Map\s*\(/,
    purpose:
      'Same-instance concurrent claim coalescing for tool governance writes; not restart authority',
    scope: 'instance',
  },
  {
    rel: 'application/durable-steer-controller.ts',
    match: /this\.pending\s*=\s*new\s+Map\s*\(/,
    purpose:
      'Per-run steer poll working set derived from MySQL run_events; controller is run-scoped',
    scope: 'instance',
  },
  {
    rel: 'application/extension-diagnostics-service.ts',
    match: /const\s+discovered\s*=\s*new\s+Map\s*\(/,
    purpose:
      'Function-local skill name de-dupe while projecting operator diagnostics; not Run state',
    scope: 'local',
  },
  {
    rel: 'application/extension-diagnostics-service.ts',
    match: /const\s+discovered\s*=\s*new\s+Map\s*</,
    purpose:
      'Function-local MCP discovery projection index; derived diagnostics, not Run state',
    scope: 'local',
  },
  {
    rel: 'skills/install.ts',
    match: /const\s+byName\s*=\s*new\s+Map\s*\(/,
    purpose:
      'Function-local skill-name de-dupe while projecting the two-tier skill inventory from disk; disk is the authority',
    scope: 'local',
  },
  {
    rel: 'application/dsh-run-tool-budget.ts',
    match: /const\s+seen\s*=\s*new\s+Map\s*\(/,
    purpose:
      'Per-run tool-and-argument call counter for convergence limits; discarded with the live SDK session and not durable authority',
    scope: 'local',
  },
  {
    rel: 'application/session-json-codec.ts',
    match: /const\s+parentOf\b.*=\s*new\s+Map\s*\(/,
    purpose:
      'Function-local parent-id graph while validating JSONL entries; pure codec, not Run authority',
    scope: 'local',
  },
  {
    rel: 'infrastructure/mcp/mcp-server-registry.ts',
    match: /const\s+registry\s*=\s*new\s+Map\s*\(/,
    purpose:
      'Function-local MCP server registry parse result returned to caller; config snapshot, not Run map',
    scope: 'local',
  },
  {
    rel: 'infrastructure/mysql/repositories/trace-span-repository.ts',
    match: /const\s+artifactParentRefs\s*=\s*new\s+Map\s*\(/,
    purpose:
      'Local materialize helper while replaying MySQL run_events into trace spans',
    scope: 'local',
  },
  {
    rel: 'infrastructure/mysql/repositories/trace-span-repository.ts',
    match: /const\s+toolById\s*=\s*new\s+Map\s*\(/,
    purpose:
      'Local tool_execution_id → spanId index during MySQL-backed trace materialization',
    scope: 'local',
  },
  {
    rel: 'infrastructure/mysql/repositories/trace-span-repository.ts',
    match: /const\s+existingArtifactParents\s*=\s*new\s+Map\s*\(/,
    purpose:
      'Local existing parent span index during artifact projection; MySQL is source',
    scope: 'local',
  },
  {
    rel: 'infrastructure/dsh/tool-risk-policy.ts',
    match: /const\s+patterns\b.*=\s*new\s+Map\s*\(/,
    purpose:
      'Function-local prefix→risk index while resolving a tool name against operator policy; config snapshot, not Run state',
    scope: 'local',
  },
  {
    rel: 'infrastructure/model-registry.ts',
    match: /const\s+map\s*=\s*new\s+Map\s*\(/,
    purpose:
      'Function-local model id → entry index while building registry snapshot; not Run authority',
    scope: 'local',
  },
  {
    rel: 'infrastructure/model-registry.ts',
    match: /const\s+cache\b.*=\s*new\s+Map\s*\(/,
    purpose:
      'Closure-scoped mtime-keyed registry hot-reload cache (path → {mtimeMs, registry}); derived config view, not Run state',
    scope: 'local',
  },
  {
    rel: 'application/durable-subagent-port.ts',
    match: /readonly\s+jobToRun\s*=\s*new\s+Map/,
    purpose:
      'Instance-local job-to-run correlation used by the durable subagent queue; durable state remains in the repository',
    scope: 'instance',
  },
  {
    rel: 'runtime/providers/remote-jobs.ts',
    match: /private\s+readonly\s+entries\s*=\s*new\s+Map/,
    purpose:
      'Instance-local remote job registry mirrored from the execution service; it is not the Run ledger',
    scope: 'instance',
  },
  {
    rel: 'runtime/policy/pre-execute.ts',
    match: /readonly\s+records\s*=\s*new\s+Map/,
    purpose:
      'In-memory approval test double scoped to one policy instance; production approval authority is durable',
    scope: 'instance',
  },
  {
    rel: 'runtime/providers/memory.ts',
    match: /private\s+readonly\s+buckets\s*=\s*new\s+Map/,
    purpose:
      'Explicit in-memory provider implementation keyed by owner; selected only where the memory provider is configured',
    scope: 'instance',
  },
  {
    rel: 'runtime/providers/enabled-skills.ts',
    match: /private\s+readonly\s+map\s*=\s*new\s+Map/,
    purpose:
      'In-memory enabled-skill provider state keyed by owner; MySQL-backed provider is used for durable state',
    scope: 'instance',
  },
  {
    rel: 'runtime/providers/durable-subagent.ts',
    match: /private\s+readonly\s+map\s*=\s*new\s+Map/,
    purpose:
      'In-memory durable-subagent test provider keyed by job; production queue state is persisted separately',
    scope: 'instance',
  },
  {
    rel: 'runtime/providers/mysql-session-store.ts',
    match: /private\s+readonly\s+sessions\s*=\s*new\s+Map/,
    purpose:
      'Bounded in-process session materialization cache; MySQL remains the session source of truth',
    scope: 'instance',
  },
  {
    rel: 'runtime/providers/mysql-session-persistence.ts',
    match: /private\s+readonly\s+owners\s*=\s*new\s+Map/,
    purpose:
      'Instance-local session owner bindings used during persistence; durable session ownership is repository-backed',
    scope: 'instance',
  },
  {
    rel: 'application/conversation-service.ts',
    match: /const\s+map\s*=\s*new\s+Map/,
    purpose:
      'Function-local journal-entry lookup while projecting conversation messages; database rows remain authoritative',
    scope: 'local',
  },
  {
    rel: 'runtime/boot.ts',
    match: /const\s+byServer\s*=\s*new\s+Map/,
    purpose:
      'Function-local MCP tool grouping while bootstrapping the runtime tool surface; not Run state',
    scope: 'local',
  },
  {
    rel: 'application/governance-approval-store.ts',
    match: /private\s+readonly\s+local\s*=\s*new\s+Map/,
    purpose:
      'Per-Run lookup cache for governance approval records; durable approval state remains repository-backed',
    scope: 'instance',
  },
]);

function walkSource(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'tests') continue;
      walkSource(p, acc);
    } else if (
      ent.isFile() &&
      (ent.name.endsWith('.js') || ent.name.endsWith('.ts'))
    ) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * Locate every `new Map(` in source with 1-based line number and the line text.
 * @param {string} src
 * @returns {{ line: number, text: string, index: number }[]}
 */
function findNewMapOccurrences(src) {
  const out = [];
  const re = /new\s+Map(?:\s*<[^;\n(){}]*>)?\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const before = src.slice(0, m.index);
    const line = before.split('\n').length;
    const lineStart = before.lastIndexOf('\n') + 1;
    const lineEnd = src.indexOf('\n', m.index);
    const text = src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd);
    out.push({ line, text, index: m.index });
  }
  return out;
}

/**
 * Heuristic: module-scope Map assignment (top-level const/let/var or export).
 * Function/class bodies indent or sit after `{`; we treat unindented module
 * declarations and `export const x = new Map` as module-level.
 * @param {string} src
 * @param {{ index: number, text: string }} occ
 */
function isModuleLevelMap(src, occ) {
  // Walk backward from occurrence to start of statement, ignoring blank/comment noise
  // only for the immediate line classification.
  const line = occ.text;
  const trimmed = line.trimStart();
  // Nested / instance assignments are never bare module decls on the same line.
  const mapConstructor = /new\s+Map(?:\s*<[^;\n(){}]*>)?\s*\(/;
  if (/this\.\w+\s*=\s*/.test(line) && mapConstructor.test(line)) return false;
  if (/:\s*/.test(line) && mapConstructor.test(line)) return false; // object literal property
  if (/return\s+/.test(line) && mapConstructor.test(line)) return false;
  // Indented line inside a block → not module scope (agent sources use 2-space indent).
  if (/^\s+/.test(line) && !/^\s*export\s+/.test(line)) return false;

  if (
    /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*new\s+Map(?:\s*<[^;\n(){}]*>)?\s*\(/.test(trimmed)
  ) {
    return true;
  }
  // Assignment to a free identifier at column 0 is also module-level risk.
  if (/^\w+\s*=\s*new\s+Map(?:\s*<[^;\n(){}]*>)?\s*\(/.test(trimmed)) return true;
  return false;
}

function relFromSrc(absPath) {
  return path.relative(SRC_ROOT, absPath).split(path.sep).join('/');
}

describe('no authoritative in-process Run Map (B3)', () => {
  it('does not define a process-global runs Map authority in agent/src', () => {
    const files = walkSource(SRC_ROOT);
    assert.ok(files.length > 0, 'expected agent/src source files');
    const offenders = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const rel = relFromSrc(file);
      // Patterns that would reintroduce plan-forbidden process-local Run authority.
      if (/\bthis\.runs\s*=\s*new\s+Map\s*\(/.test(src)) {
        offenders.push(`${rel}: this.runs = new Map`);
      }
      if (
        /\b(?:const|let|var)\s+runs\s*=\s*new\s+Map\s*\(/.test(src) &&
        /RunManager|runAuthority|authoritative/i.test(src)
      ) {
        offenders.push(`${rel}: const runs = new Map with authority markers`);
      }
      if (/class\s+RunManager\b/.test(src)) {
        offenders.push(`${rel}: class RunManager`);
      }
      // Process / global hooks for a runs registry.
      if (
        /\b(?:globalThis|global)\s*\.\s*(?:runs|runMap|runManager|activeRuns)\b/i.test(
          src,
        )
      ) {
        offenders.push(`${rel}: global runs/runMap binding`);
      }
      if (
        /\b(?:const|let|var)\s+(?:activeRuns|runsById|runById|runCache|pendingRuns|inFlightRuns|runningRuns)\s*=\s*new\s+Map\s*\(/.test(
          src,
        )
      ) {
        offenders.push(`${rel}: named run-cache Map`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `authoritative Run Map patterns found:\n${offenders.join('\n')}`,
    );
  });

  it('inventories every residual new Map under agent/src as transient-OK whitelist', () => {
    const files = walkSource(SRC_ROOT);
    /** @type {string[]} */
    const unknown = [];
    /** @type {string[]} */
    const moduleLevel = [];
    /** @type {Map<string, number>} */
    const whitelistHits = new Map(
      TRANSIENT_MAP_WHITELIST.map((w, i) => [`${w.rel}#${i}`, 0]),
    );

    for (const file of files) {
      const rel = relFromSrc(file);
      const src = fs.readFileSync(file, 'utf8');
      const occs = findNewMapOccurrences(src);
      if (occs.length === 0) continue;

      const fileWhitelist = TRANSIENT_MAP_WHITELIST.map((w, i) => ({
        ...w,
        key: `${w.rel}#${i}`,
      })).filter((w) => w.rel === rel);

      for (const occ of occs) {
        // Allow multi-line: also pass a window of ~3 lines for literal matches.
        const windowStart = Math.max(0, occ.index - 80);
        const window = src.slice(windowStart, occ.index + 120);
        const hit = fileWhitelist.find(
          (w) => w.match.test(occ.text) || w.match.test(window),
        );
        if (!hit) {
          unknown.push(
            `${rel}:${occ.line}: unwhitelisted Map — ${occ.text.trim()}`,
          );
          continue;
        }
        whitelistHits.set(hit.key, (whitelistHits.get(hit.key) || 0) + 1);

        if (isModuleLevelMap(src, occ)) {
          // No module-level Map is currently approved; fail closed.
          moduleLevel.push(
            `${rel}:${occ.line}: module-level Map (not allowed) — ${occ.text.trim()}`,
          );
        }
      }
    }

    // Every whitelist entry must still exist in source (prevents stale inventory).
    const stale = [];
    for (const [key, count] of whitelistHits) {
      if (count === 0) {
        const rel = key.split('#')[0];
        if (!fs.existsSync(path.join(SRC_ROOT, rel))) continue;
        stale.push(key);
      }
    }

    assert.deepEqual(
      unknown,
      [],
      `new residual Maps under agent/src must be classified in TRANSIENT_MAP_WHITELIST:\n${unknown.join('\n')}`,
    );
    assert.deepEqual(
      moduleLevel,
      [],
      `module-level Maps reintroduce process-global state risk:\n${moduleLevel.join('\n')}`,
    );
    assert.deepEqual(
      stale,
      [],
      `stale whitelist entries (Map removed/renamed — update inventory):\n${stale.join('\n')}`,
    );

    // Inventory size sanity: every residual Map is explicitly classified.
    // The inventory follows the current TypeScript source tree; obsolete
    // JavaScript-era entries are intentionally not kept as evidence.
    // 2026-09-04: 28 → 27，`infrastructure/sandbox/internal-hmac.ts` 随 HMAC
    // 实现收口到 `@pi/contract/hmac.js` 一起删除，它那条 keyring 解码的
    // function-local Map 也就不在 agent/src 里了。
    assert.equal(
      TRANSIENT_MAP_WHITELIST.length,
      27,
      'whitelist size drift — update STATUS B3 inventory evidence if intentional',
    );
  });

  it('whitelist entries are only instance, local, or literal scope (never module)', () => {
    for (const entry of TRANSIENT_MAP_WHITELIST) {
      assert.ok(
        entry.scope === 'instance' ||
          entry.scope === 'local' ||
          entry.scope === 'literal',
        `${entry.rel}: invalid scope ${entry.scope}`,
      );
      assert.ok(
        entry.purpose && entry.purpose.length > 20,
        `${entry.rel}: purpose comment required for residual audit`,
      );
    }
  });

  it('does not import legacy approval-waiter as production authority', () => {
    const files = walkSource(SRC_ROOT);
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      assert.equal(
        /approval-waiter|createApprovalPending/.test(src),
        false,
        `${path.relative(root, file)} must not use process-local approval waiters`,
      );
    }
  });

  it('does not retain the obsolete approval-waiter module', () => {
    assert.equal(fs.existsSync(path.join(root, 'legacy')), false);
    assert.equal(fs.existsSync(path.join(root, 'services/approval-waiter.js')), false);
  });
});
