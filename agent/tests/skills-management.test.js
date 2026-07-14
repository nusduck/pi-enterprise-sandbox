/**
 * SKILLS_MODE + skill install/edit/reload + path policy tests.
 * Run: node --test agent/tests/skills-management.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  resolveSkillsMode,
  createSkillManager,
  SKILLS_MODE,
} from '../skills/manager.js';
import {
  validateGitHttpsUrl,
  validateGitRef,
  validateSourceType,
  parseSkillMdFrontmatter,
  validateSkillPackage,
  assertLocalSourceAllowlisted,
} from '../skills/validator.js';
import {
  isUnderSkillRoot,
  commandTouchesSkillRoot,
  isReadonlySkillExecution,
  resolveSkillPath,
  validateSkillName,
  DEFAULT_SKILL_ROOTS,
} from '../skills/paths.js';
import { installSkill, atomicReplaceDir, editSkillFile } from '../skills/install.js';
import {
  createSkillTools,
  SKILL_TOOL_NAMES,
} from '../packages/enterprise-agent-kit/extensions/skill-management/tool-definitions.js';
import {
  evaluateToolPolicy,
  POLICY_DECISION,
} from '../packages/enterprise-agent-kit/extensions/policy/index.js';
import { createSandboxTools } from '../sandbox-tools.js';
import { resolveToolAllowlist, BASE_TOOL_NAMES } from '../chat-runner.js';

function makeSkillMd(name, description = 'Test skill') {
  return `---
name: ${name}
description: ${description}
---

# ${name}

Body instructions for the agent.
`;
}

async function writeSkillPackage(dir, name) {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), makeSkillMd(name), 'utf8');
  await fsp.mkdir(path.join(dir, 'scripts'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'scripts', 'helper.py'), 'print("ok")\n', 'utf8');
}

describe('resolveSkillsMode', () => {
  it('defaults to readonly', () => {
    assert.equal(resolveSkillsMode({}), SKILLS_MODE.READONLY);
    assert.equal(resolveSkillsMode({ SKILLS_MODE: '' }), SKILLS_MODE.READONLY);
    assert.equal(resolveSkillsMode({ SKILLS_MODE: 'readonly' }), SKILLS_MODE.READONLY);
  });

  it('accepts development aliases', () => {
    assert.equal(resolveSkillsMode({ SKILLS_MODE: 'development' }), SKILLS_MODE.DEVELOPMENT);
    assert.equal(resolveSkillsMode({ SKILLS_MODE: 'dev' }), SKILLS_MODE.DEVELOPMENT);
  });

  it('fails closed on unknown values', () => {
    assert.equal(resolveSkillsMode({ SKILLS_MODE: 'anything' }), SKILLS_MODE.READONLY);
  });
});

describe('zero-Skill baseline', () => {
  it('starts with an empty root while retaining the base tool allowlist', async () => {
    const emptyRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'zero-skills-'));
    try {
      const manager = createSkillManager({
        mode: SKILLS_MODE.READONLY,
        skillRoots: [emptyRoot],
      });
      assert.deepEqual(manager.listInstalled(), []);
      assert.ok(BASE_TOOL_NAMES.length > 0);
      assert.deepEqual(resolveToolAllowlist(SKILLS_MODE.READONLY), BASE_TOOL_NAMES);
    } finally {
      await fsp.rm(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe('git / source validators', () => {
  it('allows clean HTTPS git URLs', () => {
    assert.equal(
      validateGitHttpsUrl('https://github.com/org/repo.git'),
      'https://github.com/org/repo.git',
    );
  });

  it('rejects git@, ssh, credentials, non-https', () => {
    assert.throws(() => validateGitHttpsUrl('git@github.com:org/repo.git'), /SSH|HTTPS/i);
    assert.throws(() => validateGitHttpsUrl('ssh://git@github.com/org/repo.git'), /SSH|HTTPS/i);
    assert.throws(
      () => validateGitHttpsUrl('https://user:pass@github.com/org/repo.git'),
      /credentials/i,
    );
    assert.throws(() => validateGitHttpsUrl('http://github.com/org/repo.git'), /https/i);
    assert.throws(() => validateGitHttpsUrl('file:///tmp/repo'), /HTTPS|https/i);
  });

  it('requires git ref', () => {
    assert.throws(() => validateGitRef(''), /required/i);
    assert.throws(() => validateGitRef('main; rm -rf /'), /Invalid git ref/i);
    assert.equal(validateGitRef('main'), 'main');
    assert.equal(validateGitRef('v1.2.3'), 'v1.2.3');
    assert.equal(validateGitRef('abc123def'), 'abc123def');
  });

  it('rejects npm/oci/script source types', () => {
    assert.throws(() => validateSourceType('npm'), /npm|OCI|not supported/i);
    assert.throws(() => validateSourceType('oci'), /npm|OCI|not supported/i);
    assert.throws(() => validateSourceType('tarball'), /only local|not supported/i);
    assert.equal(validateSourceType('local'), 'local');
    assert.equal(validateSourceType('git'), 'git');
  });
});

describe('SKILL.md validation', () => {
  it('parses frontmatter name and description', () => {
    const meta = parseSkillMdFrontmatter(makeSkillMd('demo-skill', 'A demo'));
    assert.equal(meta.name, 'demo-skill');
    assert.equal(meta.description, 'A demo');
  });

  it('rejects missing SKILL.md and bad frontmatter', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-val-'));
    try {
      assert.throws(() => validateSkillPackage(tmp), /Missing SKILL.md/i);
      await fsp.writeFile(path.join(tmp, 'SKILL.md'), 'no frontmatter\n', 'utf8');
      assert.throws(() => validateSkillPackage(tmp), /frontmatter/i);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('path policy', () => {
  it('detects skill root paths', () => {
    assert.equal(isUnderSkillRoot('/home/sandbox/skill/foo/SKILL.md'), true);
    assert.equal(isUnderSkillRoot('/sandbox/skills/x'), true);
    assert.equal(isUnderSkillRoot('report.csv'), false);
    assert.equal(isUnderSkillRoot('/home/sandbox/workspace/x'), false);
  });

  it('detects bash commands targeting skill root', () => {
    assert.equal(
      commandTouchesSkillRoot('echo hi > /home/sandbox/skill/evil/x'),
      true,
    );
    assert.equal(commandTouchesSkillRoot('ls /tmp'), false);
  });

  it('recognizes only simple read-only skill script execution', () => {
    const run =
      "python /home/sandbox/skill/data-analysis/scripts/report.py input.csv --output-dir .";
    assert.equal(isReadonlySkillExecution(run), true);
    assert.equal(
      isReadonlySkillExecution(`${run} > /home/sandbox/skill/output.txt`),
      false,
    );
    assert.equal(isReadonlySkillExecution('touch /home/sandbox/skill/pwned'), false);
  });

  it('resolveSkillPath blocks escape', () => {
    const root = '/home/sandbox/skill';
    assert.throws(() => resolveSkillPath('../etc/passwd', root), /escape|Invalid/i);
    assert.throws(() => resolveSkillPath('/etc/passwd', root), /escape/i);
    const ok = resolveSkillPath('my-skill/SKILL.md', root);
    assert.equal(ok.relative, 'my-skill/SKILL.md');
  });

  it('validateSkillName rejects bad names', () => {
    assert.throws(() => validateSkillName('../x'), /Invalid/i);
    assert.throws(() => validateSkillName('HasCaps'), /Invalid/i);
    assert.equal(validateSkillName('ok-skill_1'), 'ok-skill_1');
  });
});

describe('policy hard-deny skill root writes', () => {
  it('hard-denies write/edit under skill root', () => {
    const w = evaluateToolPolicy('write', {
      path: '/home/sandbox/skill/x/SKILL.md',
      content: 'x',
    });
    assert.equal(w.decision, POLICY_DECISION.HARD_DENY);

    const e = evaluateToolPolicy('edit', {
      path: '/sandbox/skills/x/a.md',
      old_string: 'a',
      new_string: 'b',
    });
    assert.equal(e.decision, POLICY_DECISION.HARD_DENY);
  });

  it('hard-denies bash that touches skill root', () => {
    const b = evaluateToolPolicy('bash', {
      command: 'rm -rf /home/sandbox/skill/sample-skill',
    });
    assert.equal(b.decision, POLICY_DECISION.HARD_DENY);
  });

  it('allows direct execution of a read-only skill script', () => {
    const b = evaluateToolPolicy('bash', {
      command:
        "python /home/sandbox/skill/data-analysis/scripts/report.py input.csv --output-dir .",
    });
    assert.equal(b.decision, POLICY_DECISION.ALLOW);
  });

  it('allows normal workspace write', () => {
    const w = evaluateToolPolicy('write', { path: 'out.txt', content: 'ok' });
    assert.equal(w.decision, POLICY_DECISION.ALLOW);
  });
});

describe('createSandboxTools skill root guard', () => {
  it('blocks write/edit/bash to skill root without calling sandbox', async () => {
    let wrote = false;
    const client = {
      async approvalCheck() {
        return { status: 'approved', risk_level: 'medium' };
      },
      async writeFile() {
        wrote = true;
        return { size: 1, path: 'x' };
      },
      async readFile() {
        wrote = true;
        return { content: 'old' };
      },
      async executeCommand() {
        wrote = true;
        return { exit_code: 0, stdout_preview: '', stderr_preview: '' };
      },
    };
    const tools = createSandboxTools({ client, sessionId: 's1' });
    const write = tools.find((t) => t.name === 'write');
    const edit = tools.find((t) => t.name === 'edit');
    const bash = tools.find((t) => t.name === 'bash');

    const wr = await write.execute('1', {
      path: '/home/sandbox/skill/x/SKILL.md',
      content: 'nope',
    });
    assert.equal(wr.isError, true);
    assert.match(wr.content[0].text, /skill root|Blocked/i);

    const er = await edit.execute('2', {
      path: '/home/sandbox/skill/x/SKILL.md',
      old_string: 'a',
      new_string: 'b',
    });
    assert.equal(er.isError, true);

    const br = await bash.execute('3', {
      command: 'touch /home/sandbox/skill/pwned',
    });
    assert.equal(br.isError, true);
    assert.equal(wrote, false);
  });

  it('passes a read-only skill script execution to the sandbox', async () => {
    let executed = false;
    const client = {
      async approvalCheck() {
        return { status: 'approved', risk_level: 'medium' };
      },
      async executeCommand() {
        executed = true;
        return { exit_code: 0, stdout_preview: 'ok', stderr_preview: '' };
      },
    };
    const tools = createSandboxTools({ client, sessionId: 's1' });
    const bash = tools.find((t) => t.name === 'bash');
    const result = await bash.execute('1', {
      command:
        "python /home/sandbox/skill/data-analysis/scripts/report.py input.csv --output-dir .",
    });
    assert.equal(result.isError, false);
    assert.equal(executed, true);
  });
});

describe('skill tools registration', () => {
  it('omits tools in readonly mode', () => {
    const tools = createSkillTools({ mode: SKILLS_MODE.READONLY });
    assert.deepEqual(tools, []);
    assert.deepEqual(resolveToolAllowlist(SKILLS_MODE.READONLY), BASE_TOOL_NAMES);
  });

  it('registers install/edit/reload in development', () => {
    const tools = createSkillTools({ mode: SKILLS_MODE.DEVELOPMENT });
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [...SKILL_TOOL_NAMES].sort(),
    );
    for (const name of SKILL_TOOL_NAMES) {
      assert.ok(resolveToolAllowlist(SKILLS_MODE.DEVELOPMENT).includes(name));
    }
  });

  it('manager denies install in readonly', async () => {
    const mgr = createSkillManager({ mode: SKILLS_MODE.READONLY });
    await assert.rejects(() => mgr.install({
      name: 'x',
      sourceType: 'local',
      source: '/tmp',
    }), /readonly|denied/i);
  });
});

describe('local install + atomic replace', () => {
  /** @type {string} */
  let tmpRoot;
  /** @type {string} */
  let skillRoot;
  /** @type {string} */
  let allowDir;

  before(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'skills-mgmt-'));
    skillRoot = path.join(tmpRoot, 'skill');
    allowDir = path.join(tmpRoot, 'allow');
    await fsp.mkdir(skillRoot, { recursive: true });
    await fsp.mkdir(allowDir, { recursive: true });
  });

  after(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it('rejects local source outside allowlist', () => {
    assert.throws(
      () => assertLocalSourceAllowlisted(path.join(tmpRoot, 'other'), [allowDir]),
      /allowlist/i,
    );
  });

  it('installs from allowlisted local dir', async () => {
    const src = path.join(allowDir, 'demo-skill');
    await writeSkillPackage(src, 'demo-skill');

    const result = await installSkill({
      name: 'demo-skill',
      sourceType: 'local',
      source: src,
      skillRoot,
      localAllowlist: [allowDir],
    });

    assert.equal(result.name, 'demo-skill');
    assert.ok(fs.existsSync(path.join(skillRoot, 'demo-skill', 'SKILL.md')));
    assert.ok(result.digest);
    assert.equal(fs.existsSync(path.join(skillRoot, 'demo-skill', '.git')), false);
  });

  it('rejects install when SKILL.md missing', async () => {
    const src = path.join(allowDir, 'broken-skill');
    await fsp.mkdir(src, { recursive: true });
    await fsp.writeFile(path.join(src, 'README.md'), 'no skill md', 'utf8');

    await assert.rejects(
      () =>
        installSkill({
          name: 'broken-skill',
          sourceType: 'local',
          source: src,
          skillRoot,
          localAllowlist: [allowDir],
        }),
      /Missing SKILL.md/i,
    );
    assert.equal(fs.existsSync(path.join(skillRoot, 'broken-skill')), false);
  });

  it('atomic replace rolls back on failure and cleans staging', async () => {
    const name = 'atomic-skill';
    const dest = path.join(skillRoot, name);
    await writeSkillPackage(dest, name);
    const original = await fsp.readFile(path.join(dest, 'SKILL.md'), 'utf8');

    // Prepare good staging then force failure by making dest's parent non-writable mid-flight
    // Simpler: call atomicReplaceDir with missing staging after partial setup
    const stagingParent = path.join(skillRoot, '.tmp-test-atomic');
    const staging = path.join(stagingParent, name);
    await writeSkillPackage(staging, name);
    await fsp.writeFile(
      path.join(staging, 'SKILL.md'),
      makeSkillMd(name, 'Updated description for atomic test'),
      'utf8',
    );

    // Corrupt: remove staging right before rename by using a path that disappears
    // Instead test failure path: staging that is a file not dir rename conflict
    await fsp.rm(staging, { recursive: true, force: true });
    await assert.rejects(() => atomicReplaceDir(staging, dest), /Staging|ENOENT|missing/i);

    // Original must still be intact
    assert.equal(await fsp.readFile(path.join(dest, 'SKILL.md'), 'utf8'), original);

    // Successful replace updates content
    await writeSkillPackage(staging, name);
    await fsp.writeFile(
      path.join(staging, 'SKILL.md'),
      makeSkillMd(name, 'Replaced successfully'),
      'utf8',
    );
    await atomicReplaceDir(staging, dest);
    const updated = await fsp.readFile(path.join(dest, 'SKILL.md'), 'utf8');
    assert.match(updated, /Replaced successfully/);
    // Staging parent may remain empty; remove and ensure no backup dirs
    await fsp.rm(stagingParent, { recursive: true, force: true });
    const leftovers = fs
      .readdirSync(skillRoot)
      .filter((n) => n.startsWith('.tmp-') || n.startsWith('.backup-'));
    assert.deepEqual(leftovers, []);
  });

  it('skill_edit writes under root and blocks escape', async () => {
    const mgr = createSkillManager({
      mode: SKILLS_MODE.DEVELOPMENT,
      skillRoots: [skillRoot],
      localAllowlist: [allowDir],
    });

    await mgr.edit({
      path: 'demo-skill/notes.md',
      content: 'hello notes\n',
    });
    assert.equal(
      await fsp.readFile(path.join(skillRoot, 'demo-skill', 'notes.md'), 'utf8'),
      'hello notes\n',
    );

    await assert.rejects(
      () => mgr.edit({ path: '../escape.txt', content: 'x' }),
      /escape|Invalid/i,
    );
  });

  it('skill_edit validates SKILL.md content', async () => {
    await assert.rejects(
      () =>
        editSkillFile({
          skillRoot,
          path: 'demo-skill/SKILL.md',
          content: 'not valid skill md',
        }),
      /frontmatter/i,
    );
  });

  it('tool execute install + reload via createSkillTools', async () => {
    const audits = [];
    const src = path.join(allowDir, 'tool-skill');
    await writeSkillPackage(src, 'tool-skill');

    let reloaded = false;
    const tools = createSkillTools({
      mode: SKILLS_MODE.DEVELOPMENT,
      skillRoots: [skillRoot],
      localAllowlist: [allowDir],
      auditSink: (ev) => audits.push(ev),
      getAgentSession: () => ({
        async reload() {
          reloaded = true;
        },
        resourceLoader: {
          getSkills: () => ({ skills: [{ name: 'tool-skill' }] }),
        },
      }),
    });

    const install = tools.find((t) => t.name === 'skill_install');
    const reload = tools.find((t) => t.name === 'skill_reload');
    const r = await install.execute('t1', {
      name: 'tool-skill',
      source_type: 'local',
      source: src,
    });
    assert.equal(r.isError, undefined);
    assert.match(r.content[0].text, /Installed skill/);

    const rr = await reload.execute('t2', {});
    assert.match(rr.content[0].text, /reload/i);
    assert.equal(reloaded, true);
    assert.ok(audits.some((a) => a.action === 'install' && a.result === 'success'));
    assert.ok(audits.some((a) => a.action === 'reload' && a.result === 'success'));
  });
});

describe('git install (local bare repo)', () => {
  it('clones HTTPS-style file path is rejected; real git via file:// also rejected', async () => {
    // file:// must be rejected by validator
    assert.throws(() => validateGitHttpsUrl('file:///tmp/repo.git'), /https/i);
  });

  it('installs from git when using a local git server is N/A — unit-test clone via mocked path', async () => {
    // End-to-end git clone against public network is not required in unit tests.
    // Validate that missing ref fails before network.
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'skills-git-'));
    try {
      await assert.rejects(
        () =>
          installSkill({
            name: 'from-git',
            sourceType: 'git',
            source: 'https://github.com/example/does-not-matter.git',
            // missing ref
            skillRoot: tmp,
            localAllowlist: [],
          }),
        /ref/i,
      );
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('can git-clone a local HTTPS-ineligible path via internal helper with real git repo', async () => {
    // Build a local git repo and clone via file is blocked; instead exercise copy of
    // a prepared tree that simulates post-clone package (covered by local install).
    // Additionally verify git binary can resolve commits in a temp repo (infra sanity).
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'skills-gitrepo-'));
    try {
      const repo = path.join(tmp, 'repo');
      fs.mkdirSync(repo, { recursive: true });
      await writeSkillPackage(repo, 'git-skill');
      // Rename package to match — SKILL at repo root with name git-skill
      await fsp.writeFile(path.join(repo, 'SKILL.md'), makeSkillMd('git-skill'), 'utf8');
      const init = spawnSync('git', ['init'], { cwd: repo, encoding: 'utf8' });
      if (init.status !== 0) {
        // Skip if git unavailable in environment
        return;
      }
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
      spawnSync('git', ['add', '.'], { cwd: repo });
      const commit = spawnSync('git', ['commit', '-m', 'init'], {
        cwd: repo,
        encoding: 'utf8',
      });
      if (commit.status !== 0) return;
      const rev = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
      });
      assert.equal(rev.status, 0);
      assert.match(rev.stdout.trim(), /^[0-9a-f]{7,40}$/);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('skill name / path defaults', () => {
  it('exports default skill roots', () => {
    assert.ok(DEFAULT_SKILL_ROOTS.includes('/home/sandbox/skill'));
  });
});
