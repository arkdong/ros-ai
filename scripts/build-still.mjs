// Builds the still canvas page a canvas file carries (src/still) into dist/still: still.js and still.css, one file each,
// so the server can put both inside a single .html file. `npm run build` and the Mac app's build run it; a checkout's
// server runs it on first use when it is missing or older than its sources, so `npm start` and `npm run try` need no step.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hashOf = (path) => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16) : 'missing';

/** Whether every file the last build read is unchanged. */
function fresh(root, outdir) {
  try {
    const inputs = JSON.parse(readFileSync(join(outdir, 'inputs.json'), 'utf8'));
    return existsSync(join(outdir, 'still.js')) && Object.entries(inputs).every(([path, hash]) => hashOf(resolve(root, path)) === hash);
  } catch { return false; }
}

/** Builds the page unless onlyIfStale finds it built from the same files. Returns whether it built. */
export async function buildStill({ root = defaultRoot, outdir = resolve(root, 'dist/still'), onlyIfStale = false } = {}) {
  if (onlyIfStale && fresh(root, outdir)) return false;
  const { build } = await import('esbuild');
  const next = `${outdir}.next-${process.pid}`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true });
  const result = await build({
    entryPoints: { still: resolve(root, 'src/still/main.tsx') }, outdir: next, bundle: true, format: 'iife', platform: 'browser', target: 'es2020',
    minify: true, legalComments: 'none', logLevel: 'warning', jsx: 'automatic', metafile: true, absWorkingDir: root,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  // Which files it was built from, by content, for onlyIfStale. Packages count by their package.json.
  const inputs = {};
  for (const path of Object.keys(result.metafile.inputs)) {
    const at = path.indexOf('node_modules/');
    const file = at >= 0 ? (() => { const rest = path.slice(at + 13).split('/'); return `${path.slice(0, at)}node_modules/${rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]}/package.json`; })() : path;
    inputs[file] = hashOf(resolve(root, file));
  }
  writeFileSync(join(next, 'inputs.json'), `${JSON.stringify(inputs, null, 1)}\n`);
  rmSync(outdir, { recursive: true, force: true });
  renameSync(next, outdir);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildStill();
  console.log('Built dist/still');
}
