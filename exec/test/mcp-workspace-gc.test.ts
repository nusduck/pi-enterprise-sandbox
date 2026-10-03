/**
 * 外部 MCP 工作区闲置回收（产品 2026-10-03：闲置 3 天回收）。
 *
 * 只回收有活动标记、且标记超过 TTL 的工作区；Agent 工作区（无标记）不动；
 * MCP 窄桥的每次调用都刷新标记。
 */
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { Hono } from 'hono';
import { Context as CordisContext } from '@deepseek-ai/cordis';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { WorkspaceFileSystem } from '../src/fs/workspace-fs.js';
import { ArtifactService } from '../src/artifact/service.js';
import { registerInternalMcpRoutes } from '../src/http/internal-mcp.js';
import {
  DEFAULT_MCP_WORKSPACE_TTL_SECONDS,
  McpWorkspaceGc,
  readMcpWorkspaceTtlSeconds,
} from '../src/workspace/mcp-workspace-gc.js';

const DAY = 24 * 3600;
const DAY_MS = DAY * 1000;
const T0 = Date.parse('2026-10-03T00:00:00Z');
const MCP_OLD = '01JQ00000000000000000000A1';
const MCP_NEW = '01JQ00000000000000000000A2';
const AGENT_WS = '01JQ00000000000000000000B1';

let base: string;
let markerDir: string;
let manager: WorkspaceManager;

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);

async function markAt(id: string, ms: number): Promise<void> {
  await mkdir(markerDir, { recursive: true });
  const p = path.join(markerDir, id);
  await writeFile(p, 'x');
  await utimes(p, new Date(ms), new Date(ms));
}

beforeEach(async () => {
  base = await mkdtemp(path.join(await realpath(tmpdir()), 'dsh-mcpgc-'));
  markerDir = path.join(base, 'control', 'mcp-workspaces');
  manager = new WorkspaceManager({
    workspacesBaseRoot: path.join(base, 'workspaces'),
    tempBaseRoot: path.join(base, 'tmp'),
  });
  for (const id of [MCP_OLD, MCP_NEW, AGENT_WS]) {
    await manager.initWorkspace(id);
    await writeFile(path.join(manager.physicalWorkspacePath(id), 'f.txt'), 'data');
  }
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

test('回收闲置超过 TTL 的 MCP 工作区；未超期的与没有标记的 Agent 工作区不动', async () => {
  await markAt(MCP_OLD, T0 - 3 * DAY_MS - 60_000);
  await markAt(MCP_NEW, T0 - 2 * DAY_MS);
  const gc = new McpWorkspaceGc({ markerDir, ttlSeconds: 3 * DAY, workspaceManager: manager, now: () => T0, log: () => {} });

  assert.equal(await gc.sweep(), 1);
  assert.equal(await exists(manager.physicalWorkspacePath(MCP_OLD)), false);
  assert.equal(await exists(manager.physicalTempPath(MCP_OLD)), false);
  assert.equal(await exists(path.join(markerDir, MCP_OLD)), false);
  assert.equal(await exists(manager.physicalWorkspacePath(MCP_NEW)), true);
  assert.equal(await exists(path.join(markerDir, MCP_NEW)), true);
  assert.equal(await exists(manager.physicalWorkspacePath(AGENT_WS)), true, 'Agent 工作区没有标记，不能被回收');
});

test('touch 刷新活动时间：刚用过的工作区不会被回收', async () => {
  await markAt(MCP_OLD, T0 - 10 * DAY_MS);
  const gc = new McpWorkspaceGc({ markerDir, ttlSeconds: 3 * DAY, workspaceManager: manager, now: () => T0, log: () => {} });
  await gc.touch(MCP_OLD);
  assert.equal(await gc.sweep(), 0);
  assert.equal(await exists(manager.physicalWorkspacePath(MCP_OLD)), true);
});

test('标记目录里的非法名字被忽略，不会拿去拼路径删除', async () => {
  await mkdir(markerDir, { recursive: true });
  await writeFile(path.join(markerDir, 'not a valid id!'), 'x');
  await utimes(path.join(markerDir, 'not a valid id!'), new Date(0), new Date(0));
  const removed: string[] = [];
  const gc = new McpWorkspaceGc({
    markerDir,
    ttlSeconds: 1,
    workspaceManager: { removeWorkspace: async (id: string) => { removed.push(id); } },
    now: () => T0,
    log: () => {},
  });
  assert.equal(await gc.sweep(), 0);
  assert.deepEqual(removed, []);
});

test('删除失败时保留标记、记日志，并继续处理其他工作区', async () => {
  await markAt(MCP_OLD, T0 - 5 * DAY_MS);
  await markAt(MCP_NEW, T0 - 5 * DAY_MS);
  const logs: string[] = [];
  const gc = new McpWorkspaceGc({
    markerDir,
    ttlSeconds: 3 * DAY,
    workspaceManager: {
      removeWorkspace: async (id: string) => {
        if (id === MCP_OLD) throw new Error('disk busy');
        await manager.removeWorkspace(id);
      },
    },
    now: () => T0,
    log: (m) => logs.push(m),
  });
  assert.equal(await gc.sweep(), 1);
  assert.equal(await exists(path.join(markerDir, MCP_OLD)), true, '失败的保留标记，下一轮再试');
  assert.equal(await exists(manager.physicalWorkspacePath(MCP_NEW)), false);
  assert.ok(logs.some((m) => m.includes(MCP_OLD) && m.includes('disk busy')));
});

test('标记目录不存在时扫描返回 0', async () => {
  const gc = new McpWorkspaceGc({ markerDir, ttlSeconds: 3 * DAY, workspaceManager: manager, log: () => {} });
  assert.equal(await gc.sweep(), 0);
});

test('TTL 配置：缺省 3 天，非法值拒绝启动', () => {
  assert.equal(readMcpWorkspaceTtlSeconds({}), DEFAULT_MCP_WORKSPACE_TTL_SECONDS);
  assert.equal(DEFAULT_MCP_WORKSPACE_TTL_SECONDS, 3 * DAY);
  assert.equal(readMcpWorkspaceTtlSeconds({ SANDBOX_MCP_WORKSPACE_TTL_SECONDS: '3600' }), 3600);
  assert.throws(() => readMcpWorkspaceTtlSeconds({ SANDBOX_MCP_WORKSPACE_TTL_SECONDS: '0' }));
  assert.throws(() => readMcpWorkspaceTtlSeconds({ SANDBOX_MCP_WORKSPACE_TTL_SECONDS: '3d' }));
});

test('MCP 窄桥的调用会写活动标记；没有窄桥调用的工作区没有标记', async () => {
  const gc = new McpWorkspaceGc({ markerDir, ttlSeconds: 3 * DAY, workspaceManager: manager, log: () => {} });
  const app = new Hono();
  await mkdir(path.join(base, 'skills'), { recursive: true });
  registerInternalMcpRoutes(app, {
    workspaceManager: manager,
    systemSkillRoot: path.join(base, 'skills'),
    bwrapExecutable: '/usr/bin/bwrap',
    artifactService: new ArtifactService(
      (ws) => new WorkspaceFileSystem(new CordisContext() as never, ws),
      undefined,
      { roots: { artifactsRoot: path.join(base, 'control', 'artifacts'), controlRoot: path.join(base, 'control', 'root') } },
    ),
    internalToken: 'tok',
    workspaceActivity: gc,
  });
  const ws = '01JQ00000000000000000000C1';
  const res = await app.request('/internal/mcp/v1/context/ensure', {
    method: 'POST',
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: JSON.stringify({ sandbox_session_id: '01JQ00000000000000000000C0', workspace_id: ws }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await readdir(markerDir)).sort(), [ws]);
});

test('写标记失败只记日志，不抛错（不阻断外部调用）', async () => {
  // 标记目录的位置被一个普通文件占住，mkdir 必然失败。
  await mkdir(path.join(base, 'control'), { recursive: true });
  await writeFile(markerDir, 'not a dir');
  const logs: string[] = [];
  const gc = new McpWorkspaceGc({ markerDir, ttlSeconds: 3 * DAY, workspaceManager: manager, log: (m) => logs.push(m) });
  await gc.touch(MCP_NEW);
  assert.ok(logs.some((m) => m.includes(MCP_NEW) && m.includes('not recorded')));
});
