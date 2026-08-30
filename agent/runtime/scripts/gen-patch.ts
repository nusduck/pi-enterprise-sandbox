/** 由 `src/plugins/manifest.ts` 生成 `bundle/cordis.patch.yml`。 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPatchYaml } from '../src/plugins/render.js';

const target = join(dirname(fileURLToPath(import.meta.url)), '../bundle/cordis.patch.yml');
writeFileSync(target, renderPatchYaml(), 'utf8');
process.stdout.write(`wrote ${target}\n`);
