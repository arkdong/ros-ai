#!/usr/bin/env node
/**
 * Starts or builds the ros.ai Mac app from this checkout.
 *
 *   npm run app                      open the app on this checkout (frontend live reload, like `npm run dev`)
 *   npm run app -- --prod            open it on the built frontend instead
 *   npm run app:build                build ros.ai.app and a DMG into desktop/dist (this computer's architecture)
 *   npm run app:build -- --arm64 --x64   both architectures; further arguments go to electron-builder
 *
 * The first run installs Electron and the build tools into desktop/node_modules (about 120 MB), kept apart
 * from the repository's own packages so `npm ci` and Linux users never download them.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = dirname(fileURLToPath(import.meta.url)), root = resolve(desktop, '..');
const args = process.argv.slice(2);
const building = args.includes('--build'), prod = args.includes('--prod');
const rest = args.filter(arg => arg !== '--build' && arg !== '--prod' && arg !== '--');
const windows = process.platform === 'win32', npm = windows ? 'npm.cmd' : 'npm';
const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', shell: windows, ...options });
  if (result.error) { console.error(`${command} could not start: ${result.error.message}`); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
};

if (!existsSync(join(root, 'node_modules', 'vite'))) { console.error('Run `npm ci` in the ros-ai folder first.'); process.exit(1); }
// Electron and electron-builder live in desktop/node_modules; install them once, again only when the lock file changes.
const lockHash = createHash('sha256').update(readFileSync(join(desktop, 'package-lock.json'))).digest('hex');
const stamp = join(desktop, 'node_modules', '.installed');
if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== lockHash) {
  console.log('Installing Electron and the app build tools (once; about 120 MB)…');
  run(npm, ['ci', '--no-audit', '--no-fund'], { cwd: desktop });
  writeFileSync(stamp, lockHash);
}
// npm installs with scripts off (or an interrupted download) leave the package without the binary.
if (!existsSync(join(desktop, 'node_modules', 'electron', 'dist'))) run(process.execPath, [join(desktop, 'node_modules', 'electron', 'install.js')], { cwd: join(desktop, 'node_modules', 'electron') });

run(process.execPath, [join(desktop, 'build.mjs')]);
if (building || prod) run(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: root });

const bin = (name) => join(desktop, 'node_modules', '.bin', windows ? `${name}.cmd` : name);
if (building) {
  run(bin('tsc'), ['--noEmit', '-p', desktop]);
  run(bin('electron-builder'), ['--config', join(desktop, 'electron-builder.yml'), ...rest], { cwd: desktop });
  process.exit(0);
}
// Keys and allowances come from the usual places (keys file, data folder), never from this shell.
const env = { ...process.env, ...(prod ? {} : { ROS_DEV: '1' }) };
const child = spawn(bin('electron'), [root, ...rest], { cwd: root, stdio: 'inherit', shell: windows, env });
child.on('exit', code => process.exit(code ?? 0));
