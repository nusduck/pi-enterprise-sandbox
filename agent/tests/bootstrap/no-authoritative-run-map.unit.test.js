/**
 * STATUS B3 — prove production Agent sources do not keep an authoritative
 * in-process Run Map. Transient Maps for inflight dedupe are allowed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'tests') continue;
      walk(p, acc);
    } else if (ent.isFile() && ent.name.endsWith('.js')) {
      acc.push(p);
    }
  }
  return acc;
}

describe('no authoritative in-process Run Map (B3)', () => {
  it('does not define a process-global runs Map authority in agent/src', () => {
    const files = walk(path.join(root, 'src'));
    const offenders = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      // Patterns that would reintroduce plan-forbidden process-local Run authority.
      if (/\bthis\.runs\s*=\s*new\s+Map\s*\(/.test(src)) offenders.push(file);
      if (/\bconst\s+runs\s*=\s*new\s+Map\s*\(/.test(src) && /RunManager|runAuthority|authoritative/i.test(src)) {
        offenders.push(file);
      }
      if (/class\s+RunManager\b/.test(src)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], `authoritative Run Map patterns found:\n${offenders.join('\n')}`);
  });

  it('does not import legacy approval-waiter as production authority', () => {
    const files = walk(path.join(root, 'src'));
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      assert.equal(
        /approval-waiter|createApprovalPending/.test(src),
        false,
        `${path.relative(root, file)} must not use process-local approval waiters`,
      );
    }
  });
});
