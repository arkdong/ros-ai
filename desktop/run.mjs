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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
/**
 * On a Mac the stock Electron.app would show up as "Electron" with Electron's icon in the Dock, menu bar and ⌘-Tab.
 * Run a copy named ros.ai.app instead (an APFS clone, so no extra disk), with our name, bundle id and icon, signed
 * ad hoc again because its Info.plist changed. Made again when Electron or the icon changes.
 */
function macDevApp() {
  const source = join(desktop, 'node_modules', 'electron', 'dist', 'Electron.app'), icon = join(desktop, 'build', 'icon.png');
  const dir = join(desktop, 'node_modules', '.ros-ai-dev'), bundle = join(dir, 'ros.ai.app'), stampFile = join(dir, '.made');
  const stamp = createHash('sha256').update(readFileSync(join(source, 'Contents', 'Info.plist'))).update(readFileSync(icon)).digest('hex');
  const binary = join(bundle, 'Contents', 'MacOS', 'Electron');
  if (existsSync(binary) && existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp) return binary;
  try {
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    const quiet = (command, commandArgs) => { const result = spawnSync(command, commandArgs, { stdio: 'ignore' }); if (result.status !== 0) throw new Error(`${command} ${commandArgs[0]} failed`); };
    if (spawnSync('cp', ['-cR', source, bundle], { stdio: 'ignore' }).status !== 0) quiet('cp', ['-R', source, bundle]);
    const plist = join(bundle, 'Contents', 'Info.plist');
    for (const [key, value] of [['CFBundleName', 'ros.ai'], ['CFBundleDisplayName', 'ros.ai'], ['CFBundleIdentifier', 'io.ros-ai.app.dev']]) {
      if (spawnSync('plutil', ['-replace', key, '-string', value, plist], { stdio: 'ignore' }).status !== 0) quiet('plutil', ['-insert', key, '-string', value, plist]);
    }
    // Dock icon from build/icon.png: an .iconset made with sips, turned into electron.icns by iconutil.
    const iconset = join(dir, 'icon.iconset'); mkdirSync(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      quiet('sips', ['-z', String(size), String(size), icon, '--out', join(iconset, `icon_${size}x${size}.png`)]);
      quiet('sips', ['-z', String(size * 2), String(size * 2), icon, '--out', join(iconset, `icon_${size}x${size}@2x.png`)]);
    }
    quiet('iconutil', ['-c', 'icns', iconset, '-o', join(bundle, 'Contents', 'Resources', 'electron.icns')]);
    rmSync(iconset, { recursive: true, force: true });
    quiet('codesign', ['--force', '--deep', '--sign', '-', bundle]);
    writeFileSync(stampFile, stamp);
    return binary;
  } catch (error) {
    console.warn(`Running as Electron (could not make ros.ai.app: ${error instanceof Error ? error.message : error}).`);
    return bin('electron');
  }
}

// Keys and allowances come from the usual places (keys file, data folder), never from this shell.
const env = { ...process.env, ...(prod ? {} : { ROS_DEV: '1' }) };
const electron = process.platform === 'darwin' ? macDevApp() : bin('electron');
const child = spawn(electron, [root, ...rest], { cwd: root, stdio: 'inherit', shell: windows, env });
child.on('exit', code => process.exit(code ?? 0));
