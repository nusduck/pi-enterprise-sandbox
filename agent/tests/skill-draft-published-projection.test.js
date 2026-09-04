/**
 * 草稿在启用之后**不会消失**——`enableDraftPackage()` 是复制字节，草稿留在
 * 原地当可编辑的源。能力面因此必须把「已经发布过的草稿」标出来，否则同一个
 * 名字在 UI 上出现两次，草稿那张卡还带着一个按了没有新效果的 Enable
 * （2026-09-04 截图）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getExtensionDiagnostics } from '../src/application/extension-diagnostics-service.js';

function writePackage(root, name, description) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    'utf8',
  );
  return dir;
}

test('已发布的草稿被标成 published，未发布的仍是 draft', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-draft-proj-'));
  try {
    const systemRoot = path.join(base, 'system');
    const userRoot = path.join(base, 'user');
    const draftRoot = path.join(base, 'draft');
    fs.mkdirSync(systemRoot, { recursive: true });
    writePackage(userRoot, 'weather-query', 'published copy');
    writePackage(draftRoot, 'weather-query', 'draft source');
    writePackage(draftRoot, 'not-yet-enabled', 'still a draft');

    const diagnostics = getExtensionDiagnostics({
      skillRoots: [systemRoot, userRoot],
      userSkillRoot: userRoot,
      draftSkillRoot: draftRoot,
    });

    const drafts = Object.fromEntries(
      diagnostics.skill_drafts.map((item) => [item.name, item]),
    );
    assert.equal(drafts['weather-query'].published, true);
    assert.equal(drafts['weather-query'].status, 'published');
    assert.equal(drafts['not-yet-enabled'].published, false);
    assert.equal(drafts['not-yet-enabled'].status, 'draft');
    // 草稿永远不是 enabled——闸门只有 UI 上那一下。
    assert.equal(drafts['weather-query'].enabled, false);
    assert.equal(
      diagnostics.skills.some((s) => s.name === 'weather-query' && s.enabled === true),
      true,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
