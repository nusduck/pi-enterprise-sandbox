/**
 * Agent Worker process entry (PR-04 T4).
 * Independent of HTTP server. `node worker.js` only.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

export { startWorkerMain } from './src/bootstrap/worker-main.js';

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  const { startWorkerMain } = await import('./src/bootstrap/worker-main.js');
  startWorkerMain().catch((err) => {
    console.error(
      '[agent-worker] fatal:',
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
}
