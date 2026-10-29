#!/usr/bin/env node
/**
 * The ros-ai command for a checkout: `ros-ai` starts the workspace and opens it in the browser,
 * `ros-ai update` pulls, installs and rebuilds, `ros-ai app` opens it in its own window (Mac).
 * The install script links this file into ~/.local/bin; from a clone, `npm link` does the same.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const windows = process.platform === 'win32';
const npm = windows ? 'npm.cmd' : 'npm';
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const [command = 'start', ...rest] = process.argv.slice(2);

const help = `ros.ai ${version}

  ros-ai                 start the workspace and open it in the browser
  ros-ai start --port N  another port (default 4310); --no-open keeps the browser closed
  ros-ai update          pull the latest release, install packages and rebuild
  ros-ai app             open the workspace in its own window (Mac)
  ros-ai --version       print the version

Checkout: ${root}`;

/** Runs a step in the checkout and stops with its exit code when it fails. */
const step = (label, file, args) => {
  console.log(`\n  ${label}`);
  const result = spawnSync(file, args, { cwd: root, stdio: 'inherit', shell: windows });
  if (result.error) { console.error(`  ${file} could not start: ${result.error.message}`); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
};

/** Opens the address in the default browser, when this machine has one. */
const openBrowser = (url) => {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  const opener = process.platform === 'darwin' ? ['open', [url]] : windows ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
};

if (command === '--version' || command === '-v' || command === 'version') { console.log(version); process.exit(0); }
if (command === '--help' || command === '-h' || command === 'help') { console.log(help); process.exit(0); }
if (!existsSync(join(root, 'node_modules', 'tsx'))) { console.error(`ros.ai is not installed in ${root}. Run: npm ci && npm run build`); process.exit(1); }

if (command === 'update') {
  step('Pulling the latest release…', 'git', ['pull', '--ff-only']);
  step('Installing packages…', npm, ['ci', '--no-audit', '--no-fund']);
  step('Building…', npm, ['run', 'build']);
  console.log('\n  ros.ai is up to date. Start it with: ros-ai\n');
  process.exit(0);
}

if (command === 'app') {
  step('Opening ros.ai…', process.execPath, [join(root, 'desktop', 'run.mjs'), ...rest]);
  process.exit(0);
}

if (command !== 'start') { console.error(`Unknown command "${command}".\n\n${help}`); process.exit(1); }

// start: the server is a child so this process can open the browser once it answers; signals and the exit code pass through.
let port = process.env.ROS_PORT || '4310', open = true;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--port' && rest[i + 1]) port = rest[++i];
  else if (rest[i].startsWith('--port=')) port = rest[i].slice(7);
  else if (rest[i] === '--no-open') open = false;
  else { console.error(`Unknown option "${rest[i]}".\n\n${help}`); process.exit(1); }
}
const child = spawn(process.execPath, [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(root, 'src', 'server', 'index.ts')],
  { cwd: root, stdio: 'inherit', env: { ...process.env, ROS_PORT: port } });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));

if (open) {
  const url = `http://127.0.0.1:${port}`;
  const started = Date.now();
  const poll = async () => {
    if (child.exitCode !== null) return;
    const up = await fetch(`${url}/api/health`).then(response => response.ok, () => false);
    if (up) openBrowser(url);
    else if (Date.now() - started < 120_000) setTimeout(poll, 500).unref();
  };
  setTimeout(poll, 1000).unref();
}
