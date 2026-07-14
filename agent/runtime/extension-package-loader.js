import {
  DefaultResourceLoader,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';

import { validatePackageGovernance } from '../application/package-governance-service.js';
import { createEnterpriseAgentKit } from '../packages/enterprise-agent-kit/index.js';

/** Validate the immutable package and Extension allowlist selected by a profile. */
export function inspectExtensionPackage(profile) {
  return validatePackageGovernance(profile);
}

/**
 * Create the Pi ResourceLoader for the internal enterprise package.
 * Package installation is deliberately absent: production images install from
 * the committed lockfile and runtime loading is allowlist-only.
 */
export async function createExtensionPackageLoader(options) {
  const diagnostics = options.diagnostics || inspectExtensionPackage(options.profile);
  const extensionFactories = createEnterpriseAgentKit({
    ...options.kitOptions,
    profile: options.profile,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir || getAgentDir(),
    settingsManager: options.settingsManager,
    extensionFactories,
  });
  await resourceLoader.reload();
  return { diagnostics, extensionFactories, resourceLoader };
}
