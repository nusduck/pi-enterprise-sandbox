/** User-uploaded and Agent-generated Skill lifecycle tests. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  createGeneratedSkill,
  describeInstalledSkills,
  editSkillFile,
  installSkillArchive,
  uninstallSkill,
} from '../src/skills/install.js';
import { createSkillManager, skillRootsForIdentity } from '../src/skills/manager.js';
import { extractSkillArchive } from '../src/skills/archive.js';
import { createStoredZip } from './support/stored-zip.js';

const tempDirs = [];
async function tmpdir(prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

test.after(async () => {
  for (const dir of tempDirs) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

function skillMd(name, description = 'Test Skill package.') {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nInstructions for ${name}.\n`;
}

function writeSkillPackage(dir, name, description = 'Test Skill package.') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd(name, description));
}

test('installs one Skill from a current-turn ZIP archive', async () => {
  const userRoot = await tmpdir('skill-user');
  const zip = createStoredZip([
    { name: 'uploaded-skill/SKILL.md', content: skillMd('uploaded-skill', 'Uploaded.') },
    { name: 'uploaded-skill/references/guide.md', content: '# Guide\n' },
  ]);
  const result = await installSkillArchive({
    archiveBytes: zip,
    archiveName: 'uploaded-skill.zip',
    attachmentId: 'dataset-1',
    skillRoot: userRoot,
  });

  assert.equal(result.name, 'uploaded-skill');
  assert.equal(result.source_type, 'upload');
  assert.equal(result.attachment_id, 'dataset-1');
  assert.equal(result.package_subpath, 'uploaded-skill');
  assert.ok(fs.existsSync(path.join(userRoot, 'uploaded-skill', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(userRoot, 'uploaded-skill', 'references', 'guide.md')));
});

test('reinstalling identical archive content is an explicit no-op', async () => {
  const userRoot = await tmpdir('skill-user');
  const zip = createStoredZip([{ name: 'SKILL.md', content: skillMd('idem') }]);
  const input = {
    archiveBytes: zip,
    archiveName: 'idem.zip',
    attachmentId: 'dataset-idem',
    skillRoot: userRoot,
  };
  const first = await installSkillArchive(input);
  const second = await installSkillArchive(input);
  assert.notEqual(first.idempotent, true);
  assert.equal(second.idempotent, true);
  assert.equal(second.digest, first.digest);
});

test('archive must contain exactly one Skill package', async () => {
  const userRoot = await tmpdir('skill-user');
  const zip = createStoredZip([
    { name: 'one/SKILL.md', content: skillMd('one') },
    { name: 'two/SKILL.md', content: skillMd('two') },
  ]);
  await assert.rejects(
    installSkillArchive({
      archiveBytes: zip,
      archiveName: 'many.zip',
      attachmentId: 'dataset-many',
      skillRoot: userRoot,
    }),
    /exactly one package/,
  );

  const rootAndNested = createStoredZip([
    { name: 'SKILL.md', content: skillMd('root-skill') },
    { name: 'nested/SKILL.md', content: skillMd('nested-skill') },
  ]);
  await assert.rejects(
    installSkillArchive({
      archiveBytes: rootAndNested,
      archiveName: 'root-and-nested.zip',
      attachmentId: 'dataset-root-and-nested',
      skillRoot: userRoot,
    }),
    /exactly one package.*archive-root.*nested/,
  );
});

test('archive extraction rejects traversal, links and VCS metadata', async () => {
  const traversalRoot = path.join(await tmpdir('skill-archive'), 'out');
  await assert.rejects(
    extractSkillArchive(
      createStoredZip([{ name: '../escape.txt', content: 'no' }]),
      traversalRoot,
    ),
    /invalid relative path|unsafe path|escape/i,
  );

  const linkRoot = path.join(await tmpdir('skill-archive-link'), 'out');
  await assert.rejects(
    extractSkillArchive(
      createStoredZip([{ name: 'link', content: '/etc/passwd', mode: 0o120777 }]),
      linkRoot,
    ),
    /symbolic links/i,
  );

  const vcsRoot = path.join(await tmpdir('skill-archive-vcs'), 'out');
  await assert.rejects(
    extractSkillArchive(
      createStoredZip([{ name: 'package/.GIT/config', content: 'no' }]),
      vcsRoot,
    ),
    /VCS metadata/i,
  );
});

test('uploaded and generated Skills cannot shadow bundled Skills', async () => {
  const userRoot = await tmpdir('skill-user');
  const zip = createStoredZip([{ name: 'SKILL.md', content: skillMd('pdf') }]);
  await assert.rejects(
    installSkillArchive({
      archiveBytes: zip,
      archiveName: 'pdf.zip',
      attachmentId: 'dataset-pdf',
      skillRoot: userRoot,
      systemSkillNames: ['pdf'],
    }),
    /bundled system Skill/,
  );
  await assert.rejects(
    createGeneratedSkill({
      name: 'pdf',
      description: 'Generated.',
      instructions: 'Do a thing.',
      skillRoot: userRoot,
      systemSkillNames: ['pdf'],
    }),
    /bundled system Skill/,
  );
});

test('creates an Agent-generated Skill atomically with optional files', async () => {
  const userRoot = await tmpdir('skill-user');
  const result = await createGeneratedSkill({
    name: 'generated-skill',
    description: 'Generated through conversation.',
    instructions: '# Workflow\n\nAsk for the target, then execute.',
    files: [{ path: 'references/checklist.md', content: '# Checklist\n' }],
    skillRoot: userRoot,
  });
  assert.equal(result.name, 'generated-skill');
  assert.equal(result.source_type, 'agent_generated');
  assert.equal(result.generated_files, 2);
  assert.match(
    fs.readFileSync(path.join(userRoot, 'generated-skill', 'SKILL.md'), 'utf8'),
    /Generated through conversation/,
  );
});

test('generated package rejects unsafe or duplicate file paths', async () => {
  const userRoot = await tmpdir('skill-user');
  const base = {
    name: 'generated-skill',
    description: 'Generated.',
    instructions: 'Instructions.',
    skillRoot: userRoot,
  };
  await assert.rejects(
    createGeneratedSkill({ ...base, files: [{ path: '../escape', content: 'x' }] }),
    /unsafe/,
  );
  await assert.rejects(
    createGeneratedSkill({
      ...base,
      files: [
        { path: 'notes.md', content: 'a' },
        { path: 'NOTES.md', content: 'b' },
      ],
    }),
    /duplicate/,
  );
  await assert.rejects(
    createGeneratedSkill({ ...base, files: [{ path: 'SKILL.md', content: 'x' }] }),
    /generated from name/,
  );
  await assert.rejects(
    createGeneratedSkill({ ...base, files: [{ path: '.GIT/config', content: 'x' }] }),
    /must not contain \.git/i,
  );
});

test('skill_edit only changes an existing user package and cannot install one', async () => {
  const userRoot = await tmpdir('skill-user');
  await assert.rejects(
    editSkillFile({
      skillRoot: userRoot,
      path: 'new-skill/SKILL.md',
      content: skillMd('new-skill'),
    }),
    /not found|not a directory/,
  );

  writeSkillPackage(path.join(userRoot, 'existing'), 'existing');
  await editSkillFile({
    skillRoot: userRoot,
    path: 'existing/notes.md',
    content: '# Updated\n',
  });
  assert.equal(
    fs.readFileSync(path.join(userRoot, 'existing', 'notes.md'), 'utf8'),
    '# Updated\n',
  );
  await assert.rejects(
    editSkillFile({
      skillRoot: userRoot,
      path: 'existing/SKILL.md',
      content: skillMd('renamed'),
    }),
    /must match installed package/,
  );
  await assert.rejects(
    editSkillFile({
      skillRoot: userRoot,
      path: 'existing/.GIT/config',
      content: 'no',
    }),
    /cannot write VCS metadata/,
  );
});

test('uninstall and two-tier listing remain user-scoped', async () => {
  const systemRoot = await tmpdir('skill-system');
  const userRoot = await tmpdir('skill-user');
  writeSkillPackage(path.join(systemRoot, 'bundled'), 'bundled', 'System.');
  writeSkillPackage(path.join(userRoot, 'installed'), 'installed', 'User.');
  const listed = describeInstalledSkills([systemRoot, userRoot], {
    writableRoot: userRoot,
  });
  assert.equal(listed.find((skill) => skill.name === 'bundled')?.tier, 'system');
  assert.equal(listed.find((skill) => skill.name === 'installed')?.tier, 'user');

  await uninstallSkill({ name: 'installed', skillRoot: userRoot });
  assert.equal(fs.existsSync(path.join(userRoot, 'installed')), false);
  assert.ok(fs.existsSync(path.join(systemRoot, 'bundled')));
});

test('SkillManager downloads only the requested attachment id and isolates users', async () => {
  const systemRoot = await tmpdir('skill-system');
  const userBase = await tmpdir('skill-user-base');
  const alice = {
    orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
    userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  };
  const bob = {
    orgId: alice.orgId,
    userId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  };
  const zip = createStoredZip([{ name: 'SKILL.md', content: skillMd('mine') }]);
  const sha256 = createHash('sha256').update(zip).digest('hex');
  const seen = [];
  const auditEvents = [];
  const managerFor = (identity, withDownload = false) =>
    createSkillManager({
      identity,
      skillRoots: skillRootsForIdentity(identity, { systemRoot, userRootBase: userBase }),
      auditSink: (event) => auditEvents.push(event),
      getMeta: () => ({ runId: 'run-skill-test', sessionId: 'session-skill-test' }),
      ...(withDownload
        ? {
            downloadArchive: async ({ attachmentId, signal }) => {
              seen.push(attachmentId);
              assert.equal(signal instanceof AbortSignal, true);
              return new Response(zip, {
                headers: {
                  'content-type': 'application/zip',
                  'content-length': String(zip.length),
                  'x-dataset-sha256': sha256,
                },
              });
            },
          }
        : {}),
    });

  const aliceManager = managerFor(alice, true);
  await aliceManager.install({
    attachmentId: 'dataset-mine',
    archiveName: 'mine.zip',
    declaredSize: zip.length,
  });
  assert.deepEqual(seen, ['dataset-mine']);
  assert.deepEqual(aliceManager.listInstalled(), ['mine']);
  assert.deepEqual(managerFor(bob).listInstalled(), []);
  assert.equal(auditEvents[0].meta.organization_id, alice.orgId);
  assert.equal(auditEvents[0].meta.user_id, alice.userId);
  assert.equal(auditEvents[0].meta.run_id, 'run-skill-test');
  assert.equal(auditEvents[0].meta.session_id, 'session-skill-test');
});

test('SkillManager installs a package the model built in the sandbox', async () => {
  const userRoot = await tmpdir('skill-user');
  const zip = createStoredZip([
    { name: 'built-skill/SKILL.md', content: skillMd('built-skill', 'Built in the sandbox.') },
    { name: 'built-skill/reference.md', content: '# notes\n' },
  ]);
  const auditEvents = [];
  const requested = [];
  const manager = createSkillManager({
    identity: { orgId: 'org-1', userId: 'user-1' },
    skillRoots: ['/system-skills', userRoot],
    userSkillRoot: userRoot,
    auditSink: (event) => auditEvents.push(event),
    downloadArchive: async () => assert.fail('attachment path must not be used'),
    downloadWorkspaceArchive: async ({ path: sourcePath }) => {
      requested.push(sourcePath);
      return {
        ok: true,
        headers: new Map([
          ['content-type', 'application/octet-stream'],
          ['content-length', String(zip.length)],
        ]),
        arrayBuffer: async () => zip,
      };
    },
  });

  const result = await manager.install({
    source: 'sandbox',
    sourcePath: '/tmp/built-skill.skill',
    archiveName: 'built-skill.skill',
  });

  assert.deepEqual(requested, ['/tmp/built-skill.skill']);
  assert.equal(result.name, 'built-skill');
  assert.equal(result.source_type, 'sandbox_build');
  assert.equal(result.source_path, '/tmp/built-skill.skill');
  assert.equal(result.attachment_id, undefined);
  assert.equal(
    result.archive_sha256,
    createHash('sha256').update(zip).digest('hex'),
  );
  assert.deepEqual(manager.listInstalled(), ['built-skill']);
  assert.equal(
    fs.readFileSync(path.join(userRoot, 'built-skill', 'reference.md'), 'utf8'),
    '# notes\n',
  );

  const installAudit = auditEvents.find((event) => event.action === 'install');
  assert.equal(installAudit.result, 'success');
  assert.equal(installAudit.source_type, 'sandbox_build');
  assert.equal(installAudit.source, 'sandbox:/tmp/built-skill.skill');
});

test('SkillManager rejects malformed sandbox install inputs before downloading bytes', async () => {
  const userRoot = await tmpdir('skill-user');
  let downloads = 0;
  const manager = createSkillManager({
    identity: { orgId: 'org-1', userId: 'user-1' },
    skillRoots: ['/system-skills', userRoot],
    userSkillRoot: userRoot,
    downloadWorkspaceArchive: async () => {
      downloads += 1;
      throw new Error('must not run');
    },
  });
  await assert.rejects(
    manager.install({ source: 'sandbox', archiveName: 'built.zip' }),
    /sandbox path is required/,
  );
  await assert.rejects(
    manager.install({
      source: 'sandbox',
      sourcePath: '/tmp/built.tar.gz',
      archiveName: 'built.tar.gz',
    }),
    /\.zip or \.skill archives/,
  );
  assert.equal(downloads, 0);

  // An attachment install must still fail closed when only the sandbox fetcher
  // is configured, rather than silently reaching for the wrong source.
  await assert.rejects(
    manager.install({ attachmentId: 'dataset-1', archiveName: 'skill.zip' }),
    /archive download is not configured/,
  );
});

test('SkillManager rejects malformed install inputs before downloading bytes', async () => {
  const userRoot = await tmpdir('skill-user');
  let downloads = 0;
  const manager = createSkillManager({
    identity: { orgId: 'org-1', userId: 'user-1' },
    skillRoots: ['/system-skills', userRoot],
    userSkillRoot: userRoot,
    downloadArchive: async () => {
      downloads += 1;
      throw new Error('must not run');
    },
  });
  await assert.rejects(
    manager.install({ attachmentId: '', archiveName: 'skill.zip' }),
    /attachment_id is required/,
  );
  await assert.rejects(
    manager.install({ attachmentId: 'dataset-1', archiveName: 'skill.tar.gz' }),
    /ZIP attachments only/,
  );
  assert.equal(downloads, 0);
});

/**
 * The identity directories on the Bubblewrap bind path must stay traversable.
 *
 * `<base>/<org>/<user>` is the source of the per-user skill `--ro-bind-try`.
 * The Agent creates it as `node` (uid 1000); the Sandbox resolves it as uid
 * 10001. Installing used to create it as a side effect of
 * `mkdir(stagingRoot, { recursive: true, mode: 0o700 })` — `fs.mkdir` applies
 * `mode` to *every* directory it creates — so `<org>` and `<user>` came out
 * 0700. `realpath()` from the Sandbox then failed with EACCES, and
 * `--ro-bind-try` only forgives ENOENT, so bwrap died with
 * "Can't find source path /home/sandbox/skill-user/<org>/<user>" and every
 * bash/python launch failed for that user right after their first upload.
 */

function modeOf(target) {
  return fs.statSync(target).mode & 0o777;
}

/** Mirror of userSkillRootFor(): <base>/<org>/<user>. */
const ORG = '01M0VEVCKYRHKC9SR0DKPDBFCQ';
const USER = '01M0VEVCMCEECW4SPFAFEX0X35';

test('uploading a Skill leaves the bwrap bind path traversable', async () => {
  const base = await tmpdir('skill-base');
  const userRoot = path.join(base, ORG, USER);
  const zip = createStoredZip([
    { name: 'bind-path-skill/SKILL.md', content: skillMd('bind-path-skill') },
  ]);

  await installSkillArchive({
    archiveBytes: zip,
    archiveName: 'bind-path-skill.zip',
    attachmentId: 'dataset-bind',
    skillRoot: userRoot,
  });

  for (const dir of [path.join(base, ORG), userRoot]) {
    assert.equal(
      modeOf(dir) & 0o055,
      0o055,
      `${dir} must stay group/other traversable (mode ${modeOf(dir).toString(8)})`,
    );
  }
  // The package itself has to be readable from the Sandbox too.
  assert.equal(modeOf(path.join(userRoot, 'bind-path-skill')) & 0o055, 0o055);
});

test('generating a Skill leaves the bwrap bind path traversable', async () => {
  const base = await tmpdir('skill-base');
  const userRoot = path.join(base, ORG, USER);

  await createGeneratedSkill({
    name: 'generated-skill',
    description: 'Generated.',
    instructions: 'Do the thing.',
    files: [{ path: 'references/notes.md', content: '# Notes\n' }],
    skillRoot: userRoot,
  });

  for (const dir of [path.join(base, ORG), userRoot]) {
    assert.equal(
      modeOf(dir) & 0o055,
      0o055,
      `${dir} must stay group/other traversable (mode ${modeOf(dir).toString(8)})`,
    );
  }
});

test('a root already bricked by an earlier install is repaired', async () => {
  const base = await tmpdir('skill-base');
  const userRoot = path.join(base, ORG, USER);
  // Exactly the state the old code left behind.
  fs.mkdirSync(userRoot, { recursive: true, mode: 0o700 });
  assert.equal(modeOf(path.join(base, ORG)) & 0o055, 0);

  const zip = createStoredZip([
    { name: 'repair-skill/SKILL.md', content: skillMd('repair-skill') },
  ]);
  await installSkillArchive({
    archiveBytes: zip,
    archiveName: 'repair-skill.zip',
    attachmentId: 'dataset-repair',
    skillRoot: userRoot,
  });

  for (const dir of [path.join(base, ORG), userRoot]) {
    assert.equal(modeOf(dir) & 0o055, 0o055, `${dir} must be repaired`);
  }
});

test('the transient staging directory stays private', async () => {
  const base = await tmpdir('skill-base');
  const userRoot = path.join(base, ORG, USER);
  const zip = createStoredZip([
    { name: 'staging-skill/SKILL.md', content: skillMd('staging-skill') },
  ]);
  await installSkillArchive({
    archiveBytes: zip,
    archiveName: 'staging-skill.zip',
    attachmentId: 'dataset-staging',
    skillRoot: userRoot,
  });
  // Nothing transient may be left on the bind path at all.
  const leftovers = fs
    .readdirSync(userRoot)
    .filter((entry) => entry.startsWith('.tmp-') || entry.startsWith('.backup-'));
  assert.deepEqual(leftovers, []);
});
