/** User-uploaded and Agent-generated Skill lifecycle tests. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  describeInstalledSkills,
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
  // 2026-08-31（ADR 0009 D7 / 计划 H6.10）：`createGeneratedSkill` 退役了，
  // 「模型造的包不得遮蔽系统 skill」这条不变量搬到了**启用**那一刻
  // （`inspectDraftPackage`）。检查搬得更靠后是对的：草稿叫什么名字无所谓，
  // 它不进任何人的上下文；危险的是同名包被挂进 skill-user/ 之后盖住平台背书的那个。
  // 用例见 tests/skills-enablement.test.ts。
});





// 2026-08-31（ADR 0009 D7 / 计划 H6.10）：以下四条随 `skill_create` / `skill_edit`
// 一起删除，因为它们测的工具已经不存在了：
//   - creates an Agent-generated Skill atomically with optional files
//   - generated package rejects unsafe or duplicate file paths
//   - skill_edit only changes an existing user package and cannot install one
//   - skill_edit applies a multi-file batch as one all-or-nothing change
//   - generating a Skill leaves the bwrap bind path traversable
//
// **它们守的东西没有丢，只是搬了地方**：路径安全 / 符号链接 / VCS 元数据 /
// 大小与文件数上限，现在由**启用**时的 `inspectDraftPackage()` 守，用例在
// `tests/skills-enablement.test.ts`。那一刻才是真正重要的时刻——包进入只读挂载
// 与 system prompt 之前。写草稿本身不再校验，因为草稿不进任何人的上下文。

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
    sourceDigest: createHash('sha256').update(zip).digest('hex'),
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
  const anyDigest = 'a'.repeat(64);
  await assert.rejects(
    manager.install({ source: 'sandbox', archiveName: 'built.zip' }),
    /sandbox path is required/,
  );
  await assert.rejects(
    manager.install({
      source: 'sandbox',
      sourcePath: '/tmp/built.tar.gz',
      sourceDigest: anyDigest,
      archiveName: 'built.tar.gz',
    }),
    /\.zip or \.skill archives/,
  );
  // A sandbox install with no digest, or a digest that is not a sha256, must
  // not reach the wire: an unpinned sandbox install has to be impossible on the
  // manager API too, not only through the tool.
  for (const sourceDigest of [undefined, '', 'not-a-digest', 'A'.repeat(63), 'z'.repeat(64)]) {
    await assert.rejects(
      manager.install({
        source: 'sandbox',
        sourcePath: '/tmp/built.zip',
        sourceDigest,
        archiveName: 'built.zip',
      }),
      /sourceDigest must be a sha256/,
      String(sourceDigest),
    );
  }
  assert.equal(downloads, 0);

  // An attachment install must still fail closed when only the sandbox fetcher
  // is configured, rather than silently reaching for the wrong source.
  await assert.rejects(
    manager.install({ attachmentId: 'dataset-1', archiveName: 'skill.zip' }),
    /archive download is not configured/,
  );
});

test('SkillManager refuses a sandbox archive whose bytes changed after approval', async () => {
  const userRoot = await tmpdir('skill-user');
  const approved = createStoredZip([
    { name: 'built-skill/SKILL.md', content: skillMd('built-skill', 'The package the user approved.') },
  ]);
  // What the path holds by the time the approved call replays.
  const swapped = createStoredZip([
    { name: 'built-skill/SKILL.md', content: skillMd('built-skill', 'Something else entirely.') },
    { name: 'built-skill/exfil.py', content: 'print("not approved")\n' },
  ]);
  const auditEvents = [];
  const manager = createSkillManager({
    identity: { orgId: 'org-1', userId: 'user-1' },
    skillRoots: ['/system-skills', userRoot],
    userSkillRoot: userRoot,
    auditSink: (event) => auditEvents.push(event),
    downloadWorkspaceArchive: async () => ({
      ok: true,
      headers: new Map([
        ['content-type', 'application/octet-stream'],
        ['content-length', String(swapped.length)],
      ]),
      arrayBuffer: async () => swapped,
    }),
  });

  const approvedDigest = createHash('sha256').update(approved).digest('hex');
  const swappedDigest = createHash('sha256').update(swapped).digest('hex');
  await assert.rejects(
    manager.install({
      source: 'sandbox',
      sourcePath: '/tmp/built-skill.skill',
      sourceDigest: approvedDigest,
      archiveName: 'built-skill.skill',
    }),
    (error) => {
      // Both digests are named so the failure is diagnosable, and the message
      // says plainly that nothing landed.
      assert.match(error.message, new RegExp(approvedDigest));
      assert.match(error.message, new RegExp(swappedDigest));
      assert.match(error.message, /nothing was installed/);
      return true;
    },
  );

  // The swapped package must not be on disk, and the refusal must be audited.
  assert.deepEqual(manager.listInstalled(), []);
  assert.equal(fs.existsSync(path.join(userRoot, 'built-skill')), false);
  const failure = auditEvents.find((event) => event.action === 'install');
  assert.equal(failure.result, 'failure');
  assert.equal(failure.source_type, 'sandbox_build');
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
