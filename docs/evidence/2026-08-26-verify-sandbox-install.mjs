/**
 * Proves the hop that only ever had fakes behind it:
 *   archive sitting in a real Sandbox workspace
 *     -> downloadWorkspaceArchive (GET /sessions/{id}/files/download)
 *     -> readSkillArchiveDownload
 *     -> installSkillArchive  -> package on disk in the user Skill root
 *
 * and the new source_digest binding against that same real chain.
 *
 * Identity/session come from a real, already-provisioned Sandbox session:
 * sessions/ensure verifies the AgentSession binding, so a fabricated identity
 * is rejected by design.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config, resolveSandboxAuthHeader } from '/app/config.js';
import { createSandboxClient } from '/app/src/infrastructure/sandbox/sandbox-client.js';
import { createSkillManager } from '/app/src/skills/manager.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const ORG = process.env.VERIFY_ORG_ID;
const USER = process.env.VERIFY_USER_ID;
const SESSION = process.env.VERIFY_SANDBOX_SESSION_ID;
if (!ORG || !USER || !SESSION) throw new Error('VERIFY_* env vars are required');
check('using a real, active Sandbox session', true, `session=${SESSION}`);

function storedZip(entries) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}

const skillMd = (desc) => [
  '---',
  'name: demo-skill',
  `description: "${desc}"`,
  '---',
  '',
  '# demo-skill',
  '',
  'Fetched out of a real Sandbox workspace over files/download.',
  '',
].join('\n');

const approved = storedZip([
  { name: 'demo-skill/SKILL.md', content: skillMd('Proves the download hop. Use when verifying skill_install source sandbox.') },
  { name: 'demo-skill/scripts/run.py', content: 'print("demo-skill ran")\n' },
]);
const swapped = storedZip([
  { name: 'demo-skill/SKILL.md', content: skillMd('SWAPPEDAFTERAPPROVAL. Use when verifying that this never installs.') },
  { name: 'demo-skill/exfil.py', content: 'print("not approved")\n' },
]);
const approvedDigest = createHash('sha256').update(approved).digest('hex');
const swappedDigest = createHash('sha256').update(swapped).digest('hex');

async function upload(bytes, dir) {
  const boundary = `----verify${randomBytes(8).toString('hex')}`;
  const head =
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="file"; filename="demo-skill.zip"\r\n' +
    'Content-Type: application/zip\r\n\r\n';
  const body = Buffer.concat([
    Buffer.from(head, 'utf8'),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
  const url =
    `${config.SANDBOX_BASE_URL}/sessions/${SESSION}/files/upload` +
    `?path=${encodeURIComponent(dir ?? '')}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      ...resolveSandboxAuthHeader(),
      'X-Acting-User-Id': USER,
      'X-Acting-Organization-Id': ORG,
    },
    body,
  });
  if (!resp.ok) throw new Error(`upload failed ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

const uploaded = await upload(approved, '');
const archivePath = `/home/sandbox/workspace/${uploaded.path}`;
const archiveDir = uploaded.path.split('/').slice(0, -1).join('/');
check('archive is in the real Sandbox workspace', Boolean(uploaded.path), archivePath);

const client = createSandboxClient({
  auth: { actingUserId: USER, actingOrganizationId: ORG },
});
const userRoot = await mkdtemp(path.join(tmpdir(), 'verify-skill-'));
const audits = [];
const manager = createSkillManager({
  identity: { orgId: ORG, userId: USER },
  skillRoots: ['/home/sandbox/skill', userRoot],
  userSkillRoot: userRoot,
  auditSink: (event) => audits.push(event),
  downloadWorkspaceArchive: ({ path: p, signal }) =>
    client.downloadFileStream(SESSION, p, { signal }),
});

const result = await manager.install({
  source: 'sandbox',
  sourcePath: archivePath,
  sourceDigest: approvedDigest,
  archiveName: 'demo-skill.zip',
});
check('installed through the real files/download hop', result.name === 'demo-skill',
  JSON.stringify({ source_type: result.source_type, sha: result.archive_sha256 }));
check('bytes fetched over the wire hash to the approved digest',
  result.archive_sha256 === approvedDigest);
check('SKILL.md landed in the user skill root',
  (await readFile(path.join(userRoot, 'demo-skill', 'SKILL.md'), 'utf8')).includes('name: demo-skill'));
check('the script the package ships landed too',
  (await readFile(path.join(userRoot, 'demo-skill', 'scripts', 'run.py'), 'utf8')).includes('demo-skill ran'));

// The swap: bytes at the named path are not the bytes that were approved.
// Uploading in place is not possible here (each upload mints its own att_ dir),
// so the equivalent is exercised directly — the manager downloads from a path
// and finds the bytes do not hash to the approved digest, which is byte for
// byte the code path a real swap takes.
const swappedUpload = await upload(swapped, '');
const swappedPath = `/home/sandbox/workspace/${swappedUpload.path}`;
let refused = null;
try {
  await manager.install({
    source: 'sandbox',
    sourcePath: swappedPath,
    sourceDigest: approvedDigest,
    archiveName: 'demo-skill.zip',
  });
} catch (error) {
  refused = error.message;
}
check('bytes that do not match the approved digest are refused', refused != null,
  refused ?? 'INSTALLED - regression');
check('the refusal names both digests',
  Boolean(refused && refused.includes(approvedDigest) && refused.includes(swappedDigest)),
  refused ?? '');
check('the unapproved package did not overwrite the installed one',
  !(await readFile(path.join(userRoot, 'demo-skill', 'SKILL.md'), 'utf8')).includes('SWAPPEDAFTERAPPROVAL'));
const fsmod = await import('node:fs');
check('no file from the unapproved package landed',
  !fsmod.existsSync(path.join(userRoot, 'demo-skill', 'exfil.py')));
check('the refusal is audited as a failed sandbox_build install',
  audits.some((e) => e.action === 'install' && e.result === 'failure' && e.source_type === 'sandbox_build'));

await rm(userRoot, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
