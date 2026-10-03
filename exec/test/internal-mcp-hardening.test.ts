/**
 * MCP 窄桥 hardening（A1–A6 + B1–B3 的桥侧）。
 *
 * 每个用例都先按任务书的期望写：跑在未修复的代码上应当失败，
 * 修完通过。只使用内存/临时目录与桩执行器，不起 bwrap。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Hono } from 'hono';
import { Context as CordisContext } from '@deepseek-ai/cordis';
import type { ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { WorkspaceFileSystem } from '../src/fs/workspace-fs.js';
import { ArtifactService } from '../src/artifact/service.js';
import { registerInternalMcpRoutes } from '../src/http/internal-mcp.js';
import { IsolatedShellExecutor } from '../src/shell/executor.js';
import { buildIsolationProfile } from '../src/isolation/build.js';

const TOKEN = 'mcp-internal-token-for-hardening-tests';
const SESSION = '01JQ00000000000000000000A1';
const WORKSPACE = '01JQ00000000000000000000A2';
const IDENTITY = { sandbox_session_id: SESSION, workspace_id: WORKSPACE };

const MAX_READ_BYTES = 256 * 1024;

describe('internal MCP bridge hardening', () => {
  let base: string;
  let app: Hono;
  let smallReadApp: Hono;
  let smallFileApp: Hono;
  let workspaceManager: WorkspaceManager;
  let artifactService: ArtifactService;

  before(async () => {
    base = await mkdtemp(path.join(await realpath(tmpdir()), 'dsh-mcp-harden-'));
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
    const common = {
      workspaceManager,
      systemSkillRoot: path.join(base, 'skills'),
      bwrapExecutable: '/usr/bin/bwrap',
      artifactService,
      internalToken: TOKEN,
    };
    app = new Hono();
    registerInternalMcpRoutes(app, common);
    smallReadApp = new Hono();
    registerInternalMcpRoutes(smallReadApp, { ...common, maxReadBytes: 64 });
    smallFileApp = new Hono();
    registerInternalMcpRoutes(smallFileApp, { ...common, maxFileSizeBytes: 4 });
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

  async function postJson(
    target: Hono,
    p: string,
    payload: object,
  ): Promise<{ status: number; body: unknown }> {
    const res = await target.request(`/internal/mcp/v1${p}`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(payload),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  const post = (p: string, payload: object) => postJson(app, p, { ...IDENTITY, ...payload });

  function codeOf(body: unknown): string | undefined {
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      const detail = (body as Record<string, unknown>)['detail'];
      if (detail !== null && typeof detail === 'object' && !Array.isArray(detail)) {
        const code = (detail as Record<string, unknown>)['code'];
        return typeof code === 'string' ? code : undefined;
      }
    }
    return undefined;
  }

  function emptyResult(timeoutMs: number): ShellRunResult {
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
      sandbox: { mode: 'workspace-write', denied: false },
    };
  }

  type RunPythonInput = Parameters<IsolatedShellExecutor['runPython']>[0];

  async function withExecutor<T>(
    impl: {
      run?: (this: IsolatedShellExecutor, spec: ShellExecSpec) => Promise<ShellRunResult>;
      runPython?: (this: IsolatedShellExecutor, input: RunPythonInput) => Promise<ShellRunResult>;
    },
    body: () => Promise<T>,
  ): Promise<T> {
    const proto = IsolatedShellExecutor.prototype;
    const original = { run: proto.run, runPython: proto.runPython };
    proto.run = impl.run ?? (async () => assert.fail('run must not be called'));
    proto.runPython = impl.runPython ?? (async () => assert.fail('runPython must not be called'));
    try {
      return await body();
    } finally {
      proto.run = original.run;
      proto.runPython = original.runPython;
    }
  }

  // ── A1：大文件截断与分页 ──────────────────────────────────────────

  /** 3000 行 × 100 字节 = 300000 字节，超过默认 256 KiB 上限。 */
  async function writeBigFile(): Promise<string[]> {
    const lines: string[] = [];
    for (let i = 0; i < 3000; i += 1) {
      lines.push(`L${String(i).padStart(4, '0')}-` + 'x'.repeat(93));
    }
    assert.equal(Buffer.byteLength(lines.join('\n'), 'utf8'), 300000 - 1);
    const written = await post('/files/write', { path: 'big.txt', content: lines.join('\n') });
    assert.equal(written.status, 200);
    return lines;
  }

  test('A1: 不传 offset/limit 且超限 → 头部完整行 + truncated + total_lines + 分页提示', async () => {
    const lines = await writeBigFile();
    const { status, body } = await post('/files/read', { path: 'big.txt' });
    assert.equal(status, 200);
    const r = body as Record<string, unknown>;
    assert.equal(r['truncated'], true);
    assert.equal(r['total_lines'], 3000);
    const content = String(r['content']);
    assert.ok(Buffer.byteLength(content, 'utf8') <= MAX_READ_BYTES, '结果不得超过上限');
    assert.ok(content !== '', '头部应有内容');
    // 只返回完整行：每个返回行都必须是原文中的整行。
    for (const line of content.split('\n')) {
      assert.ok(lines.includes(line), `不应出现被截断的行: ${JSON.stringify(line.slice(0, 40))}`);
    }
    assert.ok(!content.includes(lines[2999] as string), '尾部不应出现');
    assert.match(String(r['hint'] ?? ''), /offset/i, '提示用 offset/limit 分段读取');
    assert.equal(typeof r['next_offset'], 'number');
  });

  test('A1: offset/limit 分页语义（1-based）+ total_lines 可继续翻页', async () => {
    const lines = await writeBigFile();
    const { status, body } = await post('/files/read', {
      path: 'big.txt',
      offset: 11,
      limit: 10,
    });
    assert.equal(status, 200);
    const r = body as Record<string, unknown>;
    assert.equal(r['content'], lines.slice(10, 20).join('\n'));
    assert.equal(r['total_lines'], 3000);
    assert.equal(r['next_offset'], 21);
  });

  test('A1: 传了 offset/limit 时结果同样不得超过上限（巨大 limit 被夹住）', async () => {
    await writeBigFile();
    const { status, body } = await post('/files/read', {
      path: 'big.txt',
      offset: 1,
      limit: 100000,
    });
    assert.equal(status, 200);
    const r = body as Record<string, unknown>;
    assert.ok(Buffer.byteLength(String(r['content']), 'utf8') <= MAX_READ_BYTES);
    assert.equal(r['truncated'], true);
    assert.equal(r['total_lines'], 3000);
  });

  test('A1: 靠后的 offset 也能读到（流式扫描，不是只切头部）', async () => {
    const lines = await writeBigFile();
    const { status, body } = await post('/files/read', {
      path: 'big.txt',
      offset: 2995,
      limit: 10,
    });
    assert.equal(status, 200);
    const r = body as Record<string, unknown>;
    assert.equal(r['content'], lines.slice(2994).join('\n'));
    assert.equal(r['total_lines'], 3000);
  });

  test('A1: 不切断 UTF-8 多字节字符（maxReadBytes=64，é 行只给完整行）', async () => {
    const line = 'é'.repeat(10);
    const ws = workspaceManager.physicalWorkspacePath(WORKSPACE);
    await post('/context/ensure', {});
    await writeFile(path.join(ws, 'utf8.txt'), Array(20).fill(line).join('\n'), 'utf8');
    const { status, body } = await postJson(smallReadApp, '/files/read', {
      ...IDENTITY,
      path: 'utf8.txt',
    });
    assert.equal(status, 200);
    const r = body as Record<string, unknown>;
    const content = String(r['content']);
    assert.ok(Buffer.byteLength(content, 'utf8') <= 64);
    assert.ok(!content.includes('�'), '不得出现被切断的字符');
    assert.equal(content, [line, line, line].join('\n'));
    assert.equal(r['truncated'], true);
    assert.equal(r['total_lines'], 20);
  });

  test('A1: exec 侧 InternalMcpDeps 接受 maxReadBytes（小上限同样截断）', async () => {
    const ws = workspaceManager.physicalWorkspacePath(WORKSPACE);
    await post('/context/ensure', {});
    const lines = Array(30).fill('012345678').join('\n');
    await writeFile(path.join(ws, 'small.txt'), lines, 'utf8');
    const { status, body } = await postJson(smallReadApp, '/files/read', {
      ...IDENTITY,
      path: 'small.txt',
    });
    assert.equal(status, 200);
    const r = body as Record<string, unknown>;
    assert.ok(Buffer.byteLength(String(r['content']), 'utf8') <= 64);
    assert.equal(r['truncated'], true);
    assert.equal(r['total_lines'], 30);
  });

  // ── A2：二进制拒绝 ────────────────────────────────────────────────

  test('A2: 含 NUL 的文件 → 400 BINARY_FILE', async () => {
    await post('/context/ensure', {});
    const ws = workspaceManager.physicalWorkspacePath(WORKSPACE);
    await writeFile(path.join(ws, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x41, 0x42, 0x43]));
    const { status, body } = await post('/files/read', { path: 'blob.bin' });
    assert.equal(status, 400);
    assert.equal(codeOf(body), 'BINARY_FILE');
  });

  test('A2: 不含 NUL 但不是合法 UTF-8 的文件（随机字节）→ 400 BINARY_FILE', async () => {
    await post('/context/ensure', {});
    const ws = workspaceManager.physicalWorkspacePath(WORKSPACE);
    // 0xC3 0x28 是非法 UTF-8 序列；全程没有 NUL，也没有大量控制字节。
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xc3, 0x28, 0xa0, 0xa1, 0x41, 0x42, 0xfe, 0xff]);
    await writeFile(path.join(ws, 'noisy.bin'), bytes);
    const { status, body } = await post('/files/read', { path: 'noisy.bin' });
    assert.equal(status, 400);
    assert.equal(codeOf(body), 'BINARY_FILE');
  });

  test('A2: 合法 UTF-8 文本在探针边界被切断多字节字符时，仍按文本读取', async () => {
    await post('/context/ensure', {});
    const ws = workspaceManager.physicalWorkspacePath(WORKSPACE);
    // 让一个 3 字节的「中」跨过 8192 字节探针边界。
    const text = 'a'.repeat(8191) + '中文内容\n';
    await writeFile(path.join(ws, 'edge.txt'), text, 'utf8');
    const { status } = await post('/files/read', { path: 'edge.txt' });
    assert.equal(status, 200);
  });

  // ── A3：不存在的路径 → 404 PATH_NOT_FOUND ─────────────────────────

  test('A3: 读不存在的文件 → 404 PATH_NOT_FOUND（不是 500）', async () => {
    const { status, body } = await post('/files/read', { path: 'nope-missing.txt' });
    assert.equal(status, 404);
    assert.equal(codeOf(body), 'PATH_NOT_FOUND');
  });

  test('A3: 列不存在的目录 → 404 PATH_NOT_FOUND', async () => {
    const { status, body } = await post('/files/list', { path: 'nope-dir', depth: 1 });
    assert.equal(status, 404);
    assert.equal(codeOf(body), 'PATH_NOT_FOUND');
  });

  test('A3: 删不存在的文件 → 404 PATH_NOT_FOUND', async () => {
    const { status, body } = await post('/files/delete', { path: 'nope-gone.txt' });
    assert.equal(status, 404);
    assert.equal(codeOf(body), 'PATH_NOT_FOUND');
  });

  // ── A4：NUL 字节输入 → 400 ───────────────────────────────────────

  test('A4: 代码含 NUL → 400（INVALID_INPUT 或 PATH_INVALID）', async () => {
    const res = await withExecutor(
      { runPython: async (input) => emptyResult(input.timeoutMs ?? 0) },
      () => post('/python/execute', { code: 'print(1)\0', timeout_seconds: 30 }),
    );
    assert.equal(res.status, 400);
    assert.ok(['INVALID_INPUT', 'PATH_INVALID'].includes(codeOf(res.body) as string));
  });

  test('A4: 命令含 NUL → 400', async () => {
    const res = await withExecutor(
      { run: async (spec) => emptyResult(spec.timeoutMs) },
      () => post('/shell/execute', { command: 'echo hi\0', timeout_seconds: 30 }),
    );
    assert.equal(res.status, 400);
    assert.ok(['INVALID_INPUT', 'PATH_INVALID'].includes(codeOf(res.body) as string));
  });

  test('A4: 写入内容含 NUL → 400', async () => {
    const { status } = await post('/files/write', { path: 'nul.txt', content: 'a\0b' });
    assert.equal(status, 400);
  });

  // ── A5：duration_ms 真实耗时，删 python_version 与 content ─────────

  test('A5: python/shell 执行返回真实 duration_ms（整数毫秒，非 null）', async () => {
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const py = await withExecutor(
      {
        async runPython(input) {
          await sleep(60);
          return emptyResult(input.timeoutMs ?? 0);
        },
      },
      () => post('/python/execute', { code: 'print(1)', timeout_seconds: 30 }),
    );
    assert.equal(py.status, 200);
    const pyBody = (await py.body) as unknown as Record<string, unknown>;
    assert.equal(typeof pyBody['duration_ms'], 'number');
    assert.ok(Number.isInteger(pyBody['duration_ms']));
    assert.ok((pyBody['duration_ms'] as number) >= 50, '应接近真实耗时 60ms');

    const sh = await withExecutor(
      {
        async run(spec) {
          await sleep(60);
          return emptyResult(spec.timeoutMs);
        },
      },
      () => post('/shell/execute', { command: 'pwd', timeout_seconds: 30 }),
    );
    assert.equal(sh.status, 200);
    const shBody = (await sh.body) as unknown as Record<string, unknown>;
    assert.equal(typeof shBody['duration_ms'], 'number');
    assert.ok((shBody['duration_ms'] as number) >= 50);
  });

  test('A5: python 响应不再带 python_version；file_write 不再带 content', async () => {
    const py = await withExecutor(
      { runPython: async (input) => emptyResult(input.timeoutMs ?? 0) },
      () => post('/python/execute', { code: 'print(1)', timeout_seconds: 30 }),
    );
    const pyBody = (await py.body) as unknown as Record<string, unknown>;
    assert.ok(!('python_version' in pyBody), 'python_version 应删除');
    assert.ok('python_mode' in pyBody, 'python_mode 保留');

    const written = await post('/files/write', { path: 'w.txt', content: 'hi' });
    assert.equal(written.status, 200);
    assert.ok(!('content' in (written.body as Record<string, unknown>)), '无意义的 content 应删除');
  });

  // ── A6：外部 MCP 不挂载系统 Skill ─────────────────────────────────

  test('A6: MCP 执行上下文 systemSkillPackages 为空，bwrap 无系统 skill 挂载', async () => {
    let captured: unknown;
    await withExecutor(
      {
        async run(spec) {
          captured = (this as unknown as { workspace: unknown }).workspace;
          return emptyResult(spec.timeoutMs);
        },
      },
      () => post('/shell/execute', { command: 'pwd', timeout_seconds: 30 }),
    );
    const ctx = captured as {
      systemSkillRoot: string;
      systemSkillPackages: unknown;
      workspaceRoot: string;
      tempRoot: string;
      workspaceId: string;
      orgId: string;
      userId: string;
      enabledSkillPackages: never[];
    };
    assert.deepEqual(ctx.systemSkillPackages, [], '外部 MCP 不带系统 Skill 名单');
    const profile = buildIsolationProfile({
      context: { ...ctx, enabledSkillPackages: [] },
      mode: 'workspace-write',
      command: ['bash', '-c', 'pwd'],
    });
    const withSource = profile.mounts.filter(
      (m): m is Extract<(typeof profile.mounts)[number], { source: string }> =>
        'source' in m && typeof (m as { source: unknown }).source === 'string',
    );
    assert.ok(
      !withSource.some((m) => m.source === ctx.systemSkillRoot),
      'bwrap 参数里不得出现系统 skill 根挂载',
    );
    assert.ok(
      !profile.mounts.some(
        (m) => 'target' in m && String((m as { target: unknown }).target).startsWith('/home/sandbox/skill'),
      ),
      '沙箱里不得出现系统 skill 目标路径',
    );
  });

  // ── B1：sandbox_file_delete ──────────────────────────────────────

  test('B1: 删除文件正常路径（删后读不到）', async () => {
    await post('/files/write', { path: 'del/me.txt', content: 'bye' });
    const { status, body } = await post('/files/delete', { path: 'del/me.txt' });
    assert.equal(status, 200);
    assert.equal((body as Record<string, unknown>)['path'], 'del/me.txt');
    const reread = await post('/files/read', { path: 'del/me.txt' });
    assert.equal(reread.status, 404);
  });

  test('B1: 目录未 recursive → 400 IS_DIRECTORY；recursive=true 可删', async () => {
    await post('/files/write', { path: 'deldir/a.txt', content: 'x' });
    const refused = await post('/files/delete', { path: 'deldir' });
    assert.equal(refused.status, 400);
    assert.equal(codeOf(refused.body), 'IS_DIRECTORY');
    // 拒绝后文件还在。
    assert.equal((await post('/files/read', { path: 'deldir/a.txt' })).status, 200);
    const removed = await post('/files/delete', { path: 'deldir', recursive: true });
    assert.equal(removed.status, 200);
    assert.equal((await post('/files/read', { path: 'deldir/a.txt' })).status, 404);
  });

  test("B1: 禁止删除工作区根（'.'/'/'/'' 均为 400）", async () => {
    for (const p of ['.', '/', '']) {
      const { status } = await post('/files/delete', { path: p });
      assert.equal(status, 400, `path=${JSON.stringify(p)}`);
    }
  });

  test('B1: 删除符号链接只删链接本身，不碰目标', async () => {
    await post('/files/write', { path: 'real.txt', content: 'keep me' });
    const ws = workspaceManager.physicalWorkspacePath(WORKSPACE);
    await symlink(path.join(ws, 'real.txt'), path.join(ws, 'link.txt'));
    const { status } = await post('/files/delete', { path: 'link.txt' });
    assert.equal(status, 200);
    assert.equal((await lstat(path.join(ws, 'link.txt')).catch(() => null)), null);
    const reread = await post('/files/read', { path: 'real.txt' });
    assert.equal(reread.status, 200);
    assert.equal((reread.body as Record<string, unknown>)['content'], 'keep me');
  });

  test('B1: 穿越路径被拒绝', async () => {
    const { status } = await post('/files/delete', { path: '../../escape.txt' });
    assert.equal(status, 400);
  });

  // ── B2：sandbox_file_upload ──────────────────────────────────────

  test('B2: 上传二进制正常路径（父目录自动创建，返回 sha256/size）', async () => {
    const bytes = Buffer.from([0x00, 0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x61]);
    const { status, body } = await post('/files/upload', {
      path: 'up/nested/deep/f.bin',
      content_base64: bytes.toString('base64'),
      overwrite: true,
    });
    assert.equal(status, 200);
    const r = body as Record<string, unknown>;
    assert.equal(r['path'], 'up/nested/deep/f.bin');
    assert.equal(r['size'], bytes.length);
    assert.equal(r['sha256'], createHash('sha256').update(bytes).digest('hex'));
    // 未知扩展名的上传是二进制，不能标成 text/plain。
    assert.equal(r['mime_type'], 'application/octet-stream');
    const png = await post('/files/upload', { path: 'img/a.png', content_base64: bytes.toString('base64') });
    assert.equal((png.body as Record<string, unknown>)['mime_type'], 'image/png');
    const ws = workspaceManager.physicalWorkspacePath(WORKSPACE);
    assert.deepEqual(await readFile(path.join(ws, 'up/nested/deep/f.bin')), bytes);
  });

  test('B2: 非法 base64 → 400', async () => {
    const { status } = await post('/files/upload', {
      path: 'up/bad.bin',
      content_base64: '!!!not-base64!!!',
    });
    assert.equal(status, 400);
  });

  test('B2: 解码后超限 → 413 TOO_LARGE（桥侧精判）', async () => {
    const { status, body } = await postJson(smallFileApp, '/files/upload', {
      ...IDENTITY,
      path: 'big.bin',
      content_base64: Buffer.from('0123456789').toString('base64'),
    });
    assert.equal(status, 413);
    assert.equal(codeOf(body), 'TOO_LARGE');
  });

  test('B2: overwrite=false 且已存在 → 409；overwrite=true 可覆盖', async () => {
    const first = Buffer.from('one').toString('base64');
    assert.equal((await post('/files/upload', { path: 'up/ow.bin', content_base64: first })).status, 200);
    const conflict = await post('/files/upload', {
      path: 'up/ow.bin',
      content_base64: first,
      overwrite: false,
    });
    assert.equal(conflict.status, 409);
    const again = await post('/files/upload', {
      path: 'up/ow.bin',
      content_base64: Buffer.from('two!').toString('base64'),
      overwrite: true,
    });
    assert.equal(again.status, 200);
    assert.equal((again.body as Record<string, unknown>)['size'], 4);
  });

  // ── B3：sandbox_file_search ──────────────────────────────────────

  async function seedSearchTree(): Promise<void> {
    await post('/files/write', { path: 'search/src/a.py', content: 'print("hello")\n' });
    await post('/files/write', { path: 'search/src/b.txt', content: 'hello world\n' });
    await post('/files/write', { path: 'search/other/c.py', content: 'x = 1\n' });
  }

  test('B3: 只给 pattern 按 glob 找文件，路径均为逻辑相对路径', async () => {
    await seedSearchTree();
    const { status, body } = await post('/files/search', {
      path: 'search',
      pattern: '**/*.py',
    });
    assert.equal(status, 200);
    const r = body as Record<string, unknown>;
    const items = r['items'] as { path: string }[];
    const paths = items.map((i) => i.path);
    assert.ok(paths.some((p) => p.endsWith('a.py')), JSON.stringify(paths));
    assert.ok(paths.some((p) => p.endsWith('c.py')), JSON.stringify(paths));
    assert.ok(!paths.some((p) => p.endsWith('b.txt')), JSON.stringify(paths));
    for (const p of paths) {
      assert.ok(!p.startsWith('/'), `不得出现物理路径: ${p}`);
    }
    assert.ok(!JSON.stringify(body).includes(base), '响应不得包含物理根');
  });

  test('B3: 只给 query 做内容搜索，不含物理路径', async () => {
    await seedSearchTree();
    const { status, body } = await post('/files/search', { path: 'search', query: 'hello' });
    assert.equal(status, 200);
    const matches = (body as Record<string, unknown>)['matches'] as { path: string }[];
    assert.ok(matches.length >= 2);
    assert.ok(!JSON.stringify(body).includes(base), '响应不得包含物理根');
  });

  test('B3: pattern + query 联合过滤', async () => {
    await seedSearchTree();
    const { status, body } = await post('/files/search', {
      path: 'search',
      pattern: '**/*.py',
      query: 'hello',
    });
    assert.equal(status, 200);
    const matches = (body as Record<string, unknown>)['matches'] as { path: string }[];
    assert.ok(matches.length >= 1);
    assert.ok(matches.every((m) => m.path.endsWith('.py')), JSON.stringify(matches));
    assert.ok(!matches.some((m) => m.path.endsWith('b.txt')));
  });

  test('B3: pattern/query 都不给 → 400；max_results 越界 → 400', async () => {
    assert.equal((await post('/files/search', { path: 'search' })).status, 400);
    assert.equal((await post('/files/search', { path: 'search', max_results: 501 })).status, 400);
    assert.equal((await post('/files/search', { path: 'search', max_results: 0 })).status, 400);
  });

  test('B3: max_results 生效且截断（对照：合法小请求成功）', async () => {
    await seedSearchTree();
    const ok = await post('/files/search', { path: 'search', query: 'hello', max_results: 100 });
    assert.equal(ok.status, 200);
    const limited = await post('/files/search', { path: 'search', query: 'hello', max_results: 1 });
    assert.equal(limited.status, 200);
    const r = limited.body as Record<string, unknown>;
    assert.ok(((r['matches'] as unknown[])?.length ?? 0) <= 1);
    assert.equal(r['truncated'], true);
  });

  test('B3: 起点不存在 → 404 PATH_NOT_FOUND', async () => {
    const { status, body } = await post('/files/search', {
      path: 'search-nope',
      pattern: '*.py',
    });
    assert.equal(status, 404);
    assert.equal(codeOf(body), 'PATH_NOT_FOUND');
  });

  test('读/列经过物理根脱敏：越界错误不泄漏物理路径', async () => {
    const res = await post('/files/read', { path: '../../escape.txt' });
    assert.equal(res.status, 400);
    assert.ok(!JSON.stringify(res.body).includes(base));
    const st = await stat(base).catch(() => null);
    assert.ok(st !== null);
  });
});
