import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAgentHttpServer } from '../../src/bootstrap/create-http-server.js';
import { createSkillManager } from '../../src/skills/manager.js';
import { createStoredZip } from '../support/stored-zip.js';

describe('Skill draft upload HTTP (/internal/skills/drafts)', () => {
  let server;
  let port;
  let tempDraftRoot;
  let tempUserRoot;

  before(async () => {
    tempDraftRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-draft-test-'));
    tempUserRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-user-test-'));

    server = createAgentHttpServer({
      createRunService: { execute: async () => ({}) },
      getRunService: { execute: async () => ({}) },
      cancelRunService: { execute: async () => ({}) },
      eventQueryService: { listEvents: async () => ({ events: [] }) },
      uploadSkillDraft: async ({ auth, filename, archiveBytes }) => {
        const manager = createSkillManager({
          identity: { orgId: auth.externalOrgId, userId: auth.externalUserId },
          skillRoots: [tempUserRoot],
          draftSkillRoot: path.join(tempDraftRoot, auth.externalOrgId, auth.externalUserId),
        });
        return manager.installDraftArchive({
          archiveBytes,
          archiveName: filename,
        });
      },
      config: { ALLOW_UNAUTHENTICATED_INTERNAL: true },
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (tempDraftRoot) await fsp.rm(tempDraftRoot, { recursive: true, force: true });
    if (tempUserRoot) await fsp.rm(tempUserRoot, { recursive: true, force: true });
  });

  const headers = {
    'X-Acting-User-Id': 'external-user',
    'X-Acting-Organization-Id': 'external-org',
    'Content-Type': 'application/octet-stream',
  };

  function skillMd(name, description = 'Draft Skill for testing.') {
    return `---\nname: ${name}\ndescription: ${description}\n---\n\nInstructions for ${name}.\n`;
  }

  it('unpacks a valid .zip archive into the user draft root', async () => {
    const zip = createStoredZip([
      { name: 'test-draft/SKILL.md', content: skillMd('test-draft', 'Zip draft description') },
      { name: 'test-draft/scripts/run.py', content: 'print("hello")\n' },
    ]);

    const response = await fetch(
      `http://127.0.0.1:${port}/internal/skills/drafts`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'X-Filename': 'test-draft.zip',
        },
        body: zip,
      },
    );

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.name, 'test-draft');
    assert.equal(body.description, 'Zip draft description');

    const draftFile = path.join(
      tempDraftRoot,
      'external-org',
      'external-user',
      'test-draft',
      'SKILL.md',
    );
    const stat = await fsp.stat(draftFile);
    assert.ok(stat.isFile());
  });

  it('unpacks a valid .skill archive into the user draft root', async () => {
    const skillZip = createStoredZip([
      { name: 'my-custom-skill/SKILL.md', content: skillMd('my-custom-skill', 'Skill format draft') },
    ]);

    const response = await fetch(
      `http://127.0.0.1:${port}/internal/skills/drafts`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'X-Filename': 'my-custom-skill.skill',
        },
        body: skillZip,
      },
    );

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.name, 'my-custom-skill');
  });

  it('rejects upload without trusted identity headers', async () => {
    const zip = createStoredZip([
      { name: 'anon/SKILL.md', content: skillMd('anon') },
    ]);

    const response = await fetch(
      `http://127.0.0.1:${port}/internal/skills/drafts`,
      {
        method: 'POST',
        headers: {
          'X-Filename': 'anon.zip',
          'Content-Type': 'application/octet-stream',
        },
        body: zip,
      },
    );

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, 'AUTH_CONTEXT_REQUIRED');
  });

  it('rejects archive with unsupported extension', async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/internal/skills/drafts`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'X-Filename': 'invalid.tar.gz',
        },
        body: Buffer.from('dummy'),
      },
    );

    assert.equal(response.status, 400);
  });

  it('rejects archive missing SKILL.md', async () => {
    const zip = createStoredZip([
      { name: 'no-skill/other.txt', content: 'hello' },
    ]);

    const response = await fetch(
      `http://127.0.0.1:${port}/internal/skills/drafts`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'X-Filename': 'no-skill.zip',
        },
        body: zip,
      },
    );

    assert.equal(response.status, 400);
  });
});
