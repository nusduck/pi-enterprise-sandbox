/**
 * MCP 窄桥（`/internal/mcp/v1/*`）。
 *
 * 重点不在功能路径，而在**边界**：这条桥存在的全部理由是"facade 的凭据
 * 够不到 `/internal/v1/*`"。功能坏了是 bug，边界坏了是把唯一对外暴露的进程
 * 直接接到了完整内部面上。
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Hono } from 'hono';
import { Context as CordisContext } from '@deepseek-ai/cordis';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { WorkspaceFileSystem } from '../src/fs/workspace-fs.js';
import { ArtifactService } from '../src/artifact/service.js';
import { registerInternalMcpRoutes } from '../src/http/internal-mcp.js';

const TOKEN = 'mcp-internal-token-for-tests';
/** 26 位 Crockford，与 facade 的 newUlid() 同形。 */
const SESSION = '01JQ0000000000000000000001';
const WORKSPACE = '01JQ0000000000000000000002';
const ARTIFACT = '01JQ0000000000000000000003';

describe('internal MCP bridge', () => {
  let base: string;
  let app: Hono;
  let workspaceManager: WorkspaceManager;
  let artifactService: ArtifactService;

  before(async () => {
    base = await mkdtemp(path.join(await realpath(tmpdir()), 'pi-mcpbridge-'));
    workspaceManager = new WorkspaceManager({
      workspacesBaseRoot: path.join(base, 'workspaces'),
      tempBaseRoot: path.join(base, 'tmp'),
    });
    await mkdir(path.join(base, 'skills'), { recursive: true });
    artifactService = new ArtifactService(
      (ws) => new WorkspaceFileSystem(new CordisContext() as never, ws),
      undefined,
      {
        roots: {
          artifactsRoot: path.join(base, 'control', 'artifacts'),
          controlRoot: path.join(base, 'control', 'root'),
        },
      },
    );
    app = new Hono();
    registerInternalMcpRoutes(app, {
      workspaceManager,
      systemSkillRoot: path.join(base, 'skills'),
      bwrapExecutable: '/usr/bin/bwrap',
      artifactService,
      internalToken: TOKEN,
    });
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const identity = { sandbox_session_id: SESSION, workspace_id: WORKSPACE };

  function post(p: string, payload: object, headers: Record<string, string> = auth) {
    return app.request(`/internal/mcp/v1${p}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  }

  // ── 鉴权边界 ────────────────────────────────────────────────────────

  test('缺 Authorization → 401', async () => {
    const res = await post('/context/ensure', identity, { 'content-type': 'application/json' });
    assert.equal(res.status, 401);
  });

  test('token 不对 → 401', async () => {
    const res = await post('/context/ensure', identity, {
      authorization: 'Bearer wrong-token-wrong-token-wro',
      'content-type': 'application/json',
    });
    assert.equal(res.status, 401);
  });

  test('缺 Bearer 前缀 → 401', async () => {
    const res = await post('/context/ensure', identity, {
      authorization: TOKEN,
      'content-type': 'application/json',
    });
    assert.equal(res.status, 401);
  });

  test('多个 Authorization（合并成逗号分隔）→ 401', async () => {
    const res = await post('/context/ensure', identity, {
      authorization: `Bearer ${TOKEN}, Bearer ${TOKEN}`,
      'content-type': 'application/json',
    });
    assert.equal(res.status, 401);
  });

  test('token 未配置时整条桥 503，而不是用空 token 恒假比对', async () => {
    const bare = new Hono();
    registerInternalMcpRoutes(bare, {
      workspaceManager,
      systemSkillRoot: path.join(base, 'skills'),
      bwrapExecutable: '/usr/bin/bwrap',
      artifactService,
      internalToken: '',
    });
    const res = await bare.request('/internal/mcp/v1/context/ensure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(identity),
    });
    assert.equal(res.status, 503);
  });

  test('这条桥不提供 /internal/v1/* —— facade 的 token 够不到内部面', async () => {
    // 只挂了 MCP 桥的 app 上，HMAC 内部面的路径必须 404（没有这条路由），
    // 而不是 401（有路由但没过鉴权）——后者说明它其实被挂上了。
    const res = await app.request('/internal/v1/fs/list', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404);
  });

  // ── 功能路径 ────────────────────────────────────────────────────────

  test('context/ensure 建出工作区并回显身份', async () => {
    const res = await post('/context/ensure', identity);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      sandbox_session_id: SESSION,
      workspace_id: WORKSPACE,
    });
    // 真的建了目录，不是只回显身份。
    const ws = workspaceManager.physicalWorkspacePath(WORKSPACE);
    assert.ok((await stat(ws)).isDirectory(), `workspace not created: ${ws}`);
  });

  test('非 26 位 ULID 的身份 → 400 PATH_INVALID', async () => {
    const res = await post('/context/ensure', {
      sandbox_session_id: 'short',
      workspace_id: WORKSPACE,
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail: { code: string } };
    assert.equal(body.detail.code, 'PATH_INVALID');
  });

  test('files/write → files/read 往返，且 list 能看到', async () => {
    await post('/context/ensure', identity);
    const written = await post('/files/write', {
      ...identity,
      path: 'note.txt',
      content: 'hello mcp\n',
    });
    assert.equal(written.status, 200);
    const w = (await written.json()) as { size: number; path: string };
    assert.equal(w.size, 'hello mcp\n'.length);

    const read = await post('/files/read', { ...identity, path: 'note.txt' });
    assert.equal(read.status, 200);
    const r = (await read.json()) as { content: string };
    assert.equal(r.content, 'hello mcp\n');

    const listed = await post('/files/list', { ...identity, path: '.' });
    assert.equal(listed.status, 200);
    const l = (await listed.json()) as { items: { name: string }[] };
    assert.ok(l.items.some((i) => i.name === 'note.txt'));
  });

  test('files/write 越界路径被围栏拒绝，且不泄漏物理根', async () => {
    const res = await post('/files/write', {
      ...identity,
      path: '../../escape.txt',
      content: 'x',
    });
    assert.equal(res.status, 400);
    assert.ok(!JSON.stringify(await res.json()).includes(base));
  });

  test('files/write 超过大小上限 → 413 TOO_LARGE', async () => {
    const small = new Hono();
    registerInternalMcpRoutes(small, {
      workspaceManager,
      systemSkillRoot: path.join(base, 'skills'),
      bwrapExecutable: '/usr/bin/bwrap',
      artifactService,
      internalToken: TOKEN,
      maxFileSizeBytes: 4,
    });
    const res = await small.request('/internal/mcp/v1/files/write', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ...identity, path: 'big.txt', content: '0123456789' }),
    });
    assert.equal(res.status, 413);
    const body = (await res.json()) as { detail: { code: string } };
    assert.equal(body.detail.code, 'TOO_LARGE');
  });

  test('artifacts/submit 用 facade 给的 id，返回真实 sha256；content 可取回', async () => {
    await post('/context/ensure', identity);
    const ws = workspaceManager.physicalWorkspacePath(WORKSPACE);
    await writeFile(path.join(ws, 'out.md'), '# report\n');

    const submitted = await post('/artifacts/submit', {
      ...identity,
      artifact_id: ARTIFACT,
      source_path: 'out.md',
    });
    assert.equal(submitted.status, 200);
    const s = (await submitted.json()) as { artifact_id: string; size: number; sha256: string };
    // facade 已经把这个 id 签进下载 URL 了，exec 不能另生成一个。
    assert.equal(s.artifact_id, ARTIFACT);
    assert.equal(s.size, '# report\n'.length);
    assert.match(s.sha256, /^[0-9a-f]{64}$/);

    const content = await app.request(
      `/internal/mcp/v1/artifacts/${ARTIFACT}/content?sandbox_session_id=${SESSION}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    assert.equal(content.status, 200);
    assert.equal(await content.text(), '# report\n');
  });

  test('取别人上下文的产物 → 404（归属维度比 Python 版严）', async () => {
    const other = '01JQ0000000000000000000009';
    const res = await app.request(
      `/internal/mcp/v1/artifacts/${ARTIFACT}/content?sandbox_session_id=${other}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    assert.equal(res.status, 404);
  });
});
