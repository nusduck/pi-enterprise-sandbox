/**
 * 审核面内部端点（`/internal/v1/review/*`，design `agent-output-review.md` §6.2）。
 *
 * 这组用例补的是一个**实测过的缺口**：P2 交付了四个端点，但 `HTU_BINDINGS` 里没有
 * `review/` 这一族，于是任何合法令牌打过来都是 401 `AUTH_FAILED route has no scope
 * binding`——端点存在但不可达。这里从 HTTP 面走真实路由 + 真实 HMAC 令牌证明可达，
 * 并逐条钉住「无 Run 路线」的两个 claim 必须同时为 null。
 *
 * 离线跑：内存产物仓储 + 临时工作区，不需要 MySQL。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context as CordisContext } from '@deepseek-ai/cordis';

import { createInternalRouter } from '../src/http/router.js';
import { internalBindingForHtu, issueInternalToken } from '@dsh/contract/hmac.js';
import { ArtifactService } from '../src/artifact/service.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { WorkspaceFileSystem } from '../src/fs/workspace-fs.js';
import { InMemoryWorkspacePolicyStore } from '../src/db/repositories/workspace-policies.js';
import { MySqlJobRegistry } from '../src/shell/job-registry.js';
import { InMemoryJobStore } from '../src/shell/job-store-memory.js';
import type { WorkspaceContext } from '../src/types.js';

const TEST_KID = 'test-kid-1';
const KEYRING = { [TEST_KID]: Buffer.from('0'.repeat(32), 'utf8').toString('base64url') };
const TEST_ALLOW_CIDR = ['127.0.0.1/32'];
const PEER_LOOPBACK = { 'x-exec-peer-ip': '127.0.0.1' };
const ORG = 'org_test';
const USER = 'user_test';

function sha256Hex(data: Uint8Array | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 签一枚**审核面**令牌：`run_id` 与 `execution_fence_token` 同时为 null（审核动作
 * 发生在 Run 之外）。scope / tool_name 按绑定表取，不写死——写死的话，绑定表变了
 * 测试会跟着一起错。
 */
function makeReviewToken(opts: { path: string; body: string; orgId?: string; scope?: string; toolName?: string }) {
  const binding = internalBindingForHtu(opts.path);
  const bodySha = sha256Hex(opts.body);
  return issueInternalToken({
    keyring: KEYRING,
    activeKid: TEST_KID,
    claims: {
      org_id: opts.orgId ?? ORG,
      user_id: USER,
      conversation_id: 'conv_test',
      agent_session_id: 'as_test',
      sandbox_session_id: 'ss_test',
      run_id: null,
      tool_execution_id: 'te_test',
      tool_call_id: 'tc_test',
      tool_name: opts.toolName ?? binding?.toolName ?? 'review',
      scope: [opts.scope ?? binding?.scope ?? 'sandbox.review'],
      request_hash: bodySha,
      execution_fence_token: null,
      trace_id: 'c'.repeat(32),
      htm: 'POST',
      htu: opts.path,
      body_sha256: bodySha,
    },
  });
}

async function makeApp(opts: { transferMaxBytes?: number } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-review-internal-')));
  const workspaceManager = new WorkspaceManager({
    workspacesBaseRoot: join(base, 'workspaces'),
    tempBaseRoot: join(base, 'tmp'),
  });
  const artifactService = new ArtifactService(
    (ws: WorkspaceContext) => new WorkspaceFileSystem(new CordisContext() as never, ws),
    undefined,
    {
      roots: {
        artifactsRoot: join(base, 'control', 'artifacts'),
        controlRoot: join(base, 'control', 'root'),
      },
      workspacePolicies: new InMemoryWorkspacePolicyStore(),
    },
  );
  const app = createInternalRouter({
    workspaceManager,
    systemSkillRoot: join(base, 'skills'),
    enabledSkillPackagesFor: () => [],
    systemSkillPackagesFor: () => [],
    bwrapExecutable: '/usr/bin/bwrap',
    modeFor: () => 'workspace-write',
    jobRegistry: new MySqlJobRegistry(new InMemoryJobStore() as never),
    keyring: KEYRING,
    allowCidr: TEST_ALLOW_CIDR,
    artifactService,
    workspacePolicies: new InMemoryWorkspacePolicyStore(),
    ...(opts.transferMaxBytes !== undefined ? { reviewTransferMaxBytes: opts.transferMaxBytes } : {}),
  } as never);
  await mkdir(join(base, 'skills'), { recursive: true });
  const workspaceId = 'ws-review-1';
  await workspaceManager.initWorkspace(workspaceId);
  await mkdir(join(workspaceManager.physicalWorkspacePath(workspaceId), 'uploads'), { recursive: true });
  await writeFile(join(workspaceManager.physicalWorkspacePath(workspaceId), 'uploads', '材料.txt'), '材料内容', 'utf8');
  return {
    app,
    workspaceManager,
    workspaceId,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

function envelope(workspaceId: string, orgId = ORG) {
  return { requestId: 'r1', workspaceId, orgId, userId: USER, fenceToken: 0, sessionId: workspaceId };
}

async function post(app: any, path: string, bodyObj: unknown, opts: { scope?: string; toolName?: string; orgId?: string } = {}) {
  const body = JSON.stringify(bodyObj);
  const token = makeReviewToken({ path, body, ...opts });
  return await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...PEER_LOOPBACK },
    body,
  });
}

test('review: 未登记的审核路径现在可达（此前一律 401 route has no scope binding）', async () => {
  const { app, workspaceId, cleanup } = await makeApp();
  try {
    const res = await post(app, '/internal/v1/review/artifacts/snapshot', {
      envelope: envelope(workspaceId),
      payload: { sourcePath: 'uploads/材料.txt' },
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.ok, true);
    assert.ok(json.data.artifactId);
    assert.equal(json.data.sha256, sha256Hex('材料内容'));
  } finally {
    await cleanup();
  }
});

test('review: 审核路径不接受别的 scope，也不能用旧版"带 Run"的形状签出来', async () => {
  const { app, workspaceId, cleanup } = await makeApp();
  try {
    // 签发侧就是第一道闸：fs 那一族不允许空 Run，而审核动作发生在 Run 之外，
    // 所以「fs 令牌打审核面」这枚令牌根本签不出来（`isPreRunProfile` 表驱动判定）。
    assert.throws(
      () => makeReviewToken({
        path: '/internal/v1/review/artifacts/get',
        body: '{}',
        scope: 'sandbox.fs',
        toolName: 'fs',
      }),
      (err: unknown) => (err as { code?: string }).code === 'INTERNAL_TOKEN_CLAIM_INVALID',
    );

    // 反向：审核令牌打文件面同样签不出来（文件面要求非空 Run/fence）。
    assert.throws(
      () => makeReviewToken({ path: '/internal/v1/fs/read', body: '{}' }),
      (err: unknown) => (err as { code?: string }).code === 'INTERNAL_TOKEN_CLAIM_INVALID',
    );

    // 而合法的审核令牌真的能过（否则上面的"拒绝"只是"全都拒绝"的假通过）。
    const ok = await post(app, '/internal/v1/review/artifacts/get', {
      envelope: envelope(workspaceId),
      payload: { artifactId: 'art_missing' },
    });
    assert.equal(ok.status, 404);
    assert.equal(((await ok.json()) as any).error.code, 'artifact_not_found');
  } finally {
    await cleanup();
  }
});

test('review: 快照恒 withdrawn，且跨 org 读取同一个 404', async () => {
  const { app, workspaceId, cleanup } = await makeApp();
  try {
    const snap = await post(app, '/internal/v1/review/artifacts/snapshot', {
      envelope: envelope(workspaceId),
      payload: { sourcePath: 'uploads/材料.txt', name: '材料快照.txt' },
    });
    const snapJson = (await snap.json()) as any;
    assert.equal(snap.status, 200, JSON.stringify(snapJson));
    const artifactId = snapJson.data.artifactId as string;

    const mine = await post(app, '/internal/v1/review/artifacts/get', {
      envelope: envelope(workspaceId),
      payload: { artifactId },
    });
    assert.equal(mine.status, 200);
    const mineJson = (await mine.json()) as any;
    assert.equal(mineJson.data.visibility, 'withdrawn');
    assert.equal(Buffer.from(mineJson.data.bytes, 'base64').toString('utf8'), '材料内容');

    const otherOrg = await post(
      app,
      '/internal/v1/review/artifacts/get',
      { envelope: envelope(workspaceId, 'org_other'), payload: { artifactId } },
      { orgId: 'org_other' },
    );
    const otherJson = (await otherOrg.json()) as any;
    assert.equal(otherOrg.status, 404, JSON.stringify(otherJson));
    assert.equal(otherJson.error.code, 'artifact_not_found');
  } finally {
    await cleanup();
  }
});

test('review: 修订上传新建一版 held 产物，revision_of 指向原件；状态变更幂等', async () => {
  const { app, workspaceId, cleanup } = await makeApp();
  try {
    const snap = await post(app, '/internal/v1/review/artifacts/snapshot', {
      envelope: envelope(workspaceId),
      payload: { sourcePath: 'uploads/材料.txt', name: '报告.md' },
    });
    const originalId = ((await snap.json()) as any).data.artifactId as string;

    const revision = await post(app, '/internal/v1/review/artifacts/revision', {
      envelope: envelope(workspaceId),
      payload: {
        originalArtifactId: originalId,
        name: '报告.md',
        bytesBase64: Buffer.from('修订后的报告', 'utf8').toString('base64'),
      },
    });
    assert.equal(revision.status, 200);
    const revised = ((await revision.json()) as any).data;
    assert.equal(revised.revisionOf, originalId);
    assert.notEqual(revised.artifactId, originalId);

    const first = await post(app, '/internal/v1/review/artifacts/visibility', {
      envelope: envelope(workspaceId),
      payload: { updates: [{ artifactId: revised.artifactId, visibility: 'released' }] },
    });
    const firstJson = (await first.json()) as any;
    assert.equal(first.status, 200, JSON.stringify(firstJson));
    assert.equal(firstJson.data.changed, 1, JSON.stringify(firstJson));

    // outbox 至少一次投递：重复放行不会把已撤回的历史版本再放出来。
    // 原件本来就是 `withdrawn`（快照恒 withdrawn），所以这一发一行都不改。
    const second = await post(app, '/internal/v1/review/artifacts/visibility', {
      envelope: envelope(workspaceId),
      payload: {
        updates: [
          { artifactId: revised.artifactId, visibility: 'released' },
          { artifactId: originalId, visibility: 'withdrawn' },
        ],
      },
    });
    assert.equal(((await second.json()) as any).data.changed, 0);

    // 终态不可再变：`withdrawn` 的原件不能被"重新放行"。
    const revive = await post(app, '/internal/v1/review/artifacts/visibility', {
      envelope: envelope(workspaceId),
      payload: { updates: [{ artifactId: originalId, visibility: 'released' }] },
    });
    assert.equal(((await revive.json()) as any).data.changed, 0);

    // `held` 不是能被外部设置的目标值（否则等于给了撤销放行的口子）。
    const bad = await post(app, '/internal/v1/review/artifacts/visibility', {
      envelope: envelope(workspaceId),
      payload: { updates: [{ artifactId: revised.artifactId, visibility: 'held' }] },
    });
    assert.equal(bad.status, 400);
  } finally {
    await cleanup();
  }
});

test('review: 修订版导入工作区 审核版/（含建子目录），越界路径被围栏拒绝', async () => {
  const { app, workspaceManager, workspaceId, cleanup } = await makeApp();
  try {
    const snap = await post(app, '/internal/v1/review/artifacts/snapshot', {
      envelope: envelope(workspaceId),
      payload: { sourcePath: 'uploads/材料.txt', name: '报告.md' },
    });
    const originalId = ((await snap.json()) as any).data.artifactId as string;
    const revision = await post(app, '/internal/v1/review/artifacts/revision', {
      envelope: envelope(workspaceId),
      payload: { originalArtifactId: originalId, bytesBase64: Buffer.from('审核版内容', 'utf8').toString('base64') },
    });
    const revisedId = ((await revision.json()) as any).data.artifactId as string;

    const imported = await post(app, '/internal/v1/review/artifacts/import', {
      envelope: envelope(workspaceId),
      payload: { artifactId: revisedId, targetPath: '审核版/报告.md' },
    });
    assert.equal(imported.status, 200);
    assert.equal(((await imported.json()) as any).data.path, '审核版/报告.md');
    const written = await readFile(
      join(workspaceManager.physicalWorkspacePath(workspaceId), '审核版', '报告.md'),
      'utf8',
    );
    assert.equal(written, '审核版内容');

    // `..` 由 fs 围栏判（一处判定），不能落进工作区根之外。
    const escaped = await post(app, '/internal/v1/review/artifacts/import', {
      envelope: envelope(workspaceId),
      payload: { artifactId: revisedId, targetPath: '../outside.md' },
    });
    assert.notEqual(escaped.status, 200);
  } finally {
    await cleanup();
  }
});

test('review: 超过审核传输上限的读取与修订 → 413 review_transfer_too_large，不读全文件', async () => {
  // 上限压到 4 字节，免得测试真的造 100 MiB：判定按记录的 size，与上限的取值无关。
  const { app, workspaceId, cleanup } = await makeApp({ transferMaxBytes: 4 });
  try {
    const snap = await post(app, '/internal/v1/review/artifacts/snapshot', {
      envelope: envelope(workspaceId),
      payload: { sourcePath: 'uploads/材料.txt' },
    });
    assert.equal(snap.status, 200);
    const artifactId = ((await snap.json()) as any).data.artifactId;

    const get = await post(app, '/internal/v1/review/artifacts/get', {
      envelope: envelope(workspaceId),
      payload: { artifactId },
    });
    assert.equal(get.status, 413);
    assert.equal(((await get.json()) as any).error.code, 'review_transfer_too_large');

    const revision = await post(app, '/internal/v1/review/artifacts/revision', {
      envelope: envelope(workspaceId),
      payload: { originalArtifactId: artifactId, bytesBase64: Buffer.from('12345').toString('base64') },
    });
    assert.equal(revision.status, 413);
    assert.equal(((await revision.json()) as any).error.code, 'review_transfer_too_large');
  } finally {
    await cleanup();
  }
});
