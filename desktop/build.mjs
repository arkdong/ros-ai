// Bundles what the Mac app runs: the server (src/server/index.ts) to dist/server/index.mjs, the window code
// (desktop/src/main.ts) to dist/desktop/main.cjs and the App kit to dist/app-kit, and copies the Python helpers
// the server reads beside itself.
// Dependencies stay external, so the same node_modules serve the CLI and the app.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAppKit } from '../scripts/build-app-kit.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = (path) => resolve(root, 'dist', path);
mkdirSync(out('server'), { recursive: true });
mkdirSync(out('desktop'), { recursive: true });

await build({ entryPoints: [resolve(root, 'src/server/index.ts')], outfile: out('server/index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', sourcemap: true, logLevel: 'warning' });
// The server resolves these next to its own file (new URL('./sandbox/...', import.meta.url)).
cpSync(resolve(root, 'src/server/sandbox'), out('server/sandbox'), { recursive: true });
cpSync(resolve(root, 'src/server/experiment_worker.py'), out('server/experiment_worker.py'));

await build({ entryPoints: [resolve(root, 'desktop/src/main.ts')], outfile: out('desktop/main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], sourcemap: true, logLevel: 'warning' });
// The kit App pages load from their sealed frame; the app ships it built, without the libraries it bundles.
await buildAppKit({ root });
console.log('Bundled dist/server/index.mjs, dist/desktop/main.cjs and dist/app-kit');
