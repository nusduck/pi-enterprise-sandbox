/**
 * MCP facade 的依赖边界与 slim 镜像（design §2.1、AGENTS.md §1）。
 *
 * facade 是对外进程，只该持有窄桥 token。它的入口 import 图里出现执行面模块
 * （db / isolation / shell / fs …）或 mysql2、dsh-*，意味着对外进程带着执行面代码
 * 与数据库驱动——2026-09-15 前 `mcp-main.ts → startup-credentials.ts → db/client.ts`
 * 就是这样。slim 镜像只复制这张图里的文件，所以这里同时核对 Dockerfile 的
 * `facade` 阶段覆盖了图里每个模块：图变了而镜像没跟上，容器会在启动时缺模块。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const EXEC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(EXEC, 'src');
const CONTRACT_SRC = resolve(EXEC, '..', 'contract', 'src');

const IMPORT_RE =
  /(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

interface Graph {
  readonly local: Set<string>;
  readonly external: Set<string>;
}

function walk(entry: string): Graph {
  const local = new Set<string>();
  const external = new Set<string>();
  const visit = (file: string): void => {
    if (local.has(file)) return;
    local.add(file);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (spec === undefined) continue;
      if (!spec.startsWith('.')) {
        external.add(spec);
        continue;
      }
      const target = resolve(dirname(file), spec).replace(/\.js$/, '.ts');
      assert.ok(existsSync(target), `unresolved import ${spec} in ${file}`);
      visit(target);
    }
  };
  visit(entry);
  return { local, external };
}

const facade = walk(join(SRC, 'mcp-main.ts'));
const facadeLocal = [...facade.local].map((f) => relative(SRC, f)).sort();

const ALLOWED_EXTERNAL = [
  /^node:/,
  /^@modelcontextprotocol\/sdk\//,
  /^hono$/,
  /^ioredis$/,
  /^zod$/,
  /^@dsh\/contract\/dbpm-config\.js$/,
];

function dockerStage(name: string): string {
  const dockerfile = readFileSync(join(EXEC, 'Dockerfile'), 'utf8');
  const stages = dockerfile.split(/^(?=FROM\s)/m);
  const stage = stages.find((s) => new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${name}\\s*$`, 'm').test(s));
  assert.ok(stage, `Dockerfile has no stage "${name}"`);
  return stage;
}

describe('MCP facade import boundary', () => {
  test('入口只触达 mcp/ 与 node-listener，不含执行面模块', () => {
    for (const rel of facadeLocal) {
      assert.ok(
        rel === 'mcp-main.ts' || rel.startsWith('mcp/') || rel === 'http/node-listener.ts',
        `facade reaches executor module: ${rel}`,
      );
    }
    assert.ok(facadeLocal.includes('mcp/startup-credentials.ts'));
  });

  test('外部依赖在允许清单内（无 mysql2 / dsh-* / 其余 contract 模块）', () => {
    for (const spec of facade.external) {
      assert.ok(
        ALLOWED_EXTERNAL.some((re) => re.test(spec)),
        `facade imports a non-allowlisted package: ${spec}`,
      );
    }
  });

  test('facade 触达的 contract 模块只依赖 node 内置模块', () => {
    const contract = walk(join(CONTRACT_SRC, 'dbpm-config.ts'));
    for (const spec of contract.external) {
      assert.match(spec, /^node:/, `contract dbpm-config reaches ${spec}`);
    }
  });
});

describe('Dockerfile facade stage matches the import graph', () => {
  const stage = dockerStage('facade');
  const deps = dockerStage('facade-deps');

  test('复制了图中每个本地模块与 contract 模块', () => {
    for (const rel of facadeLocal) {
      const js = rel.replace(/\.ts$/, '.js');
      const top = js.includes('/') ? `${js.split('/')[0]}/` : null;
      const covered =
        stage.includes(`/app/exec/dist/${js}`) ||
        (top !== null && top === 'mcp/' && stage.includes('/app/exec/dist/mcp/'));
      assert.ok(covered, `facade stage does not copy dist/${js}`);
    }
    const contract = walk(join(CONTRACT_SRC, 'dbpm-config.ts'));
    for (const file of contract.local) {
      const name = relative(CONTRACT_SRC, file).replace(/\.ts$/, '.js');
      assert.ok(stage.includes(`/app/contract/dist/${name}`), `facade stage does not copy contract dist/${name}`);
    }
  });

  test('不带执行面工具链，以 up_docker（1000:1000）运行 facade 入口', () => {
    for (const forbidden of ['apt-get', 'bubblewrap', 'dsh-python', 'bun', 'skill-runtime', 'chromium']) {
      assert.ok(!stage.includes(forbidden), `facade stage mentions ${forbidden}`);
    }
    assert.match(stage, /^USER 1000:1000$/m);
    assert.match(stage, /up_docker/);
    assert.match(stage, /^CMD \["node", "dist\/mcp-main\.js"\]$/m);
    assert.ok(!stage.includes('/app/exec/dist/main.js'));
  });

  test('依赖阶段按 lockfile 安装生产依赖并移除执行面包', () => {
    assert.match(deps, /npm ci --omit=dev/);
    for (const pkg of ['mysql2', '@deepseek-ai/dsh-fs', '@deepseek-ai/dsh-fs-local', '@deepseek-ai/dsh-shell']) {
      assert.ok(deps.includes(pkg), `facade-deps does not remove ${pkg}`);
    }
  });
});
