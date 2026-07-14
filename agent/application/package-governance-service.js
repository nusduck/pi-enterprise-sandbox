import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = dirname(
  fileURLToPath(new URL('../packages/enterprise-agent-kit/index.js', import.meta.url)),
);

function readJson(name) {
  return JSON.parse(readFileSync(join(KIT_ROOT, name), 'utf8'));
}

export function validatePackageGovernance(profile) {
  const governance = readJson('governance.json');
  const allowed = new Set(governance.extensions || []);
  const denied = (profile.extensions || []).filter((name) => !allowed.has(name));
  if (denied.length) {
    throw new Error(`Extension allowlist denied: ${denied.join(', ')}`);
  }
  if (governance.runtime_install_allowed !== false) {
    throw new Error('Runtime extension installation must be disabled');
  }
  return {
    package: governance.package,
    version: governance.version,
    profile_id: profile.id,
    extensions: [...profile.extensions],
    audit: governance.audit,
    sbom: join(KIT_ROOT, 'sbom.cdx.json'),
  };
}
