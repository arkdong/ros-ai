// Builds the ros.ai kit that App pages load from their frame's own address (/kit/...) into dist/app-kit:
// ros.js and ros.css (the bridge to ros.ai and the ready parts), plot.js (d3 and Observable Plot), preact.js
// (Preact with htm), katex.js and katex.css (formulas, with KaTeX's woff2 fonts in fonts/).
// `npm run build` and the Mac app's build run it; a checkout's server runs it on first use when the kit is
// missing or older than its sources, so `npm start` and `npm run try` need no extra step.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES = ['ros', 'plot', 'preact', 'katex'];
const LIBRARIES = ['d3', '@observablehq/plot', 'htm', 'katex'];

/** What the kit is built from; the stamp in dist/app-kit says which of these it was built with. */
export function kitStamp(root = defaultRoot) {
  const hash = createHash('sha256');
  const kit = resolve(root, 'src/app-kit');
  for (const name of readdirSync(kit).sort()) hash.update(name).update(readFileSync(join(kit, name)));
  hash.update(readFileSync(resolve(root, 'src/shared/apps.ts')));
  for (const library of LIBRARIES) {
    const file = resolve(root, 'node_modules', library, 'package.json');
    hash.update(library).update(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).version : 'missing');
  }
  return hash.digest('hex').slice(0, 16);
}

/** Builds the kit unless onlyIfStale finds it already built from the same sources. Returns whether it built. */
export async function buildAppKit({ root = defaultRoot, outdir = resolve(root, 'dist/app-kit'), onlyIfStale = false } = {}) {
  const stamp = kitStamp(root);
  if (onlyIfStale && existsSync(join(outdir, 'stamp.txt')) && readFileSync(join(outdir, 'stamp.txt'), 'utf8').trim() === stamp) return false;
  const { build } = await import('esbuild');
  // Built beside the old kit and swapped in whole, so a server reading it never sees half a kit.
  const next = `${outdir}.next-${process.pid}`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(join(next, 'fonts'), { recursive: true });
  await build({
    entryPoints: Object.fromEntries(ENTRIES.map(name => [name, resolve(root, 'src/app-kit', `${name}.ts`)])),
    outdir: next, bundle: true, format: 'iife', platform: 'browser', target: 'es2020', minify: true, legalComments: 'none', logLevel: 'warning',
  });
  cpSync(resolve(root, 'src/app-kit/ros.css'), join(next, 'ros.css'));
  // KaTeX's fonts as woff2 only: every browser that runs ros.ai reads it, and the frame serves nothing else.
  const katex = resolve(root, 'node_modules/katex/dist');
  writeFileSync(join(next, 'katex.css'), readFileSync(join(katex, 'katex.min.css'), 'utf8').replace(/,url\(fonts\/[^)]+\.(woff|ttf)\) format\("(woff|truetype)"\)/gu, ''));
  for (const font of readdirSync(join(katex, 'fonts'))) if (font.endsWith('.woff2')) cpSync(join(katex, 'fonts', font), join(next, 'fonts', font));
  writeFileSync(join(next, 'stamp.txt'), `${stamp}\n`);
  rmSync(outdir, { recursive: true, force: true });
  renameSync(next, outdir);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildAppKit();
  console.log('Built dist/app-kit');
}
