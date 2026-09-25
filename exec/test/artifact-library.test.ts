/**
 * 产物库 `GET /artifacts`：同一 owner 跨会话列产物。归属只认 acting 头；
 * 别人的产物不出现；kind / q / cursor 与 MySQL 版的 WHERE 同义（内存版同样实现）。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Hono } from 'hono';
import { registerPublicArtifactRoutes } from '../src/http/public/artifacts.js';
import { ArtifactService } from '../src/artifact/service.js';
import { InMemoryArtifactStore, mimeMatchesKind } from '../src/db/repositories/artifacts.js';

const ME = { orgId: '01ARZ3NDEKTSV4RRFFQ69G5FAW', userId: '01ARZ3NDEKTSV4RRFFQ69G5FAX' };
const OTHER = { orgId: '01ARZ3NDEKTSV4RRFFQ69G5FAW', userId: '01ARZ3NDEKTSV4RRFFQ69G5FAY' };
const acting = (o: typeof ME) => ({ 'x-acting-organization-id': o.orgId, 'x-acting-user-id': o.userId });

async function setup() {
  const store = new InMemoryArtifactStore();
  const rows: Array<[string, typeof ME, string, string, string]> = [
    ['01J00000000000000000000001', ME, 'sess_a', '销售周报.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['01J00000000000000000000002', ME, 'sess_a', 'chart.png', 'image/png'],
    ['01J00000000000000000000003', ME, 'sess_b', '合同清单.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['01J00000000000000000000004', OTHER, 'sess_c', 'secret.png', 'image/png'],
    ['01J00000000000000000000005', ME, 'sess_b', 'notes.md', 'text/markdown'],
  ];
  for (const [artifactId, owner, sessionId, name, mimeType] of rows) {
    await store.insert({
      artifactId, sessionId, workspaceId: `ws_${sessionId}`, ...owner, name, sourcePath: `out/${name}`,
      mimeType, sha256: 'a'.repeat(64), sizeBytes: 10, identity: null,
    });
  }
  const app = new Hono();
  registerPublicArtifactRoutes(app, {
    workspaceManager: {} as never,
    systemSkillRoot: '/nonexistent',
    enabledSkillPackagesFor: () => [],
    artifactService: new ArtifactService(() => { throw new Error('unused'); }, store),
  });
  const list = async (qs: string, owner = ME) => {
    const res = await app.request(`/artifacts${qs}`, { headers: acting(owner) });
    return { status: res.status, body: (await res.json()) as { artifacts: Array<{ name: string; session_id: string }>; next_cursor: string | null } };
  };
  return { app, list };
}

describe('artifact library', () => {
  test('lists only the caller’s artifacts, across sessions, newest first', async () => {
    const { list } = await setup();
    const { status, body } = await list('');
    assert.equal(status, 200);
    assert.deepEqual(body.artifacts.map((a) => a.name), ['notes.md', '合同清单.xlsx', 'chart.png', '销售周报.docx']);
    assert.deepEqual([...new Set(body.artifacts.map((a) => a.session_id))].sort(), ['sess_a', 'sess_b']);
    const other = await list('', OTHER);
    assert.deepEqual(other.body.artifacts.map((a) => a.name), ['secret.png']);
  });

  test('filters by kind and search text', async () => {
    const { list } = await setup();
    assert.deepEqual((await list('?kind=image')).body.artifacts.map((a) => a.name), ['chart.png']);
    assert.deepEqual((await list('?kind=document')).body.artifacts.map((a) => a.name), ['notes.md', '销售周报.docx']);
    assert.deepEqual((await list('?kind=data')).body.artifacts.map((a) => a.name), ['合同清单.xlsx']);
    assert.deepEqual((await list('?q=' + encodeURIComponent('周报'))).body.artifacts.map((a) => a.name), ['销售周报.docx']);
  });

  test('pages with an artifact-id cursor', async () => {
    const { list } = await setup();
    const first = await list('?limit=2');
    assert.equal(first.body.artifacts.length, 2);
    assert.ok(first.body.next_cursor);
    const second = await list(`?limit=2&cursor=${first.body.next_cursor}`);
    assert.deepEqual(second.body.artifacts.map((a) => a.name), ['chart.png', '销售周报.docx']);
    assert.equal(second.body.next_cursor, null);
  });

  test('refuses a missing owner and bad parameters', async () => {
    const { app, list } = await setup();
    assert.equal((await app.request('/artifacts')).status, 404);
    assert.equal((await list('?kind=video')).status, 400);
    assert.equal((await list('?limit=0')).status, 400);
    assert.equal((await list('?cursor=nope')).status, 400);
  });

  test('kind matching mirrors the SQL LIKE patterns', () => {
    assert.equal(mimeMatchesKind('IMAGE/JPEG', 'image'), true);
    assert.equal(mimeMatchesKind('text/csv', 'data'), true);
    assert.equal(mimeMatchesKind('text/csv', 'document'), false);
    assert.equal(mimeMatchesKind('application/zip', 'document'), false);
  });
});
