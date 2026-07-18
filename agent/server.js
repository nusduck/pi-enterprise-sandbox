/**
 * Agent Service HTTP entry (PR-04 T4).
 *
 * Production Run authority: MySQL Create/Get/Cancel services via composition root.
 * Does **not** import the legacy process-local Run manager.
 *
 * Listen only when executed as main (`node server.js`). Import is side-effect free
 * for tests (re-exports factory helpers).
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

export { createAgentHttpServer } from './src/bootstrap/create-http-server.js';
export {
  createServiceContainer,
  ServiceContainer,
} from './src/bootstrap/container.js';
export { startHttpMain } from './src/bootstrap/http-main.js';

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  const { startHttpMain } = await import('./src/bootstrap/http-main.js');
  startHttpMain().catch((err) => {
    console.error(
      '[agent-server] fatal:',
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
}
