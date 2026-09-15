// 在 release 目录里写 SHA256SUMS 与 release-manifest.json（design §9.1、§10 release manifest）。
//
// 只在构建容器里运行。SHA256SUMS 覆盖除这两个文件以外的每个普通文件，供
// exec-preflight.sh / install-release.sh 用 `sha256sum -c` 核对；符号链接不参与
// 哈希，但记录在 manifest 里（exec/node_modules/@pi/contract → ../../contract）。
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing --${name}`);
  return process.argv[index + 1];
}

const dir = arg('dir');
const releaseId = arg('release-id');
const OWN = new Set(['SHA256SUMS', 'release-manifest.json']);

const files = [];
const symlinks = [];
const nativeModules = [];
let totalBytes = 0;

function walk(current) {
  for (const entry of readdirSync(current).sort()) {
    const full = join(current, entry);
    const rel = relative(dir, full);
    const info = lstatSync(full);
    if (info.isSymbolicLink()) {
      symlinks.push({ path: rel, target: readlinkSync(full) });
    } else if (info.isDirectory()) {
      walk(full);
    } else if (info.isFile() && !OWN.has(rel)) {
      const digest = createHash('sha256').update(readFileSync(full)).digest('hex');
      files.push([digest, rel]);
      totalBytes += info.size;
      if (rel.endsWith('.node')) nativeModules.push(rel);
    }
  }
}
walk(dir);

writeFileSync(join(dir, 'SHA256SUMS'), files.map(([d, p]) => `${d}  ${p}\n`).join(''));

const pins = JSON.parse(readFileSync(join(dir, 'vm', 'runtime-versions.json'), 'utf8'));
const schemaManifest = readFileSync(join(dir, 'contract', 'schema', 'schema-manifest.json'));
const report = process.report?.getReport?.();

const manifest = {
  schema: 1,
  component: 'exec',
  release_id: releaseId,
  git_sha: arg('git-sha'),
  git_dirty: arg('git-dirty') === 'true',
  built_at: arg('built-at'),
  platform: process.platform,
  arch: process.arch,
  builder: {
    node_version: process.versions.node,
    glibc_runtime: report?.header?.glibcVersionRuntime ?? null,
  },
  runtime: {
    node_engines: pins.node.engines,
    node_bin: '/usr/local/bin/node',
  },
  entry: 'exec/dist/main.js',
  systemd_unit: 'vm/pi-exec.service',
  schema_manifest_sha256: createHash('sha256').update(schemaManifest).digest('hex'),
  native_modules: nativeModules,
  symlinks,
  file_count: files.length,
  total_bytes: totalBytes,
};
writeFileSync(join(dir, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`release ${releaseId}: ${files.length} files, ${totalBytes} bytes, native=${nativeModules.length}`);
