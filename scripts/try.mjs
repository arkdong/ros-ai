#!/usr/bin/env node
/**
 * Starts a pull request or branch of ros.ai on localhost without touching your own checkout.
 *
 *   npm run try -- 4                  pull request #4
 *   npm run try -- some-branch        a branch on origin
 *   npm run try -- 4 --port 4320 --no-open
 *
 * The code goes into a git worktree next to this checkout (../ros-ai-try/pr-4) with its own
 * packages and its own empty data folder. Your branch, projects and keys stay as they are, and
 * the copy gets no AI keys or spending allowances, so it cannot spend anything.
 * Running the same command again updates the copy to the latest push and keeps its test projects.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';

const usage = 'Usage: npm run try -- <pull request number | branch> [--port 4311] [--no-open]';
function fail(message) { console.error(message); process.exit(1); }
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) fail(`git is not available: ${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
}

let target, firstPort = 4311, open = true;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--port') firstPort = Number(args[++index]);
  else if (args[index] === '--no-open') open = false;
  else if (!target && !args[index].startsWith('-')) target = args[index];
  else fail(`Unknown option ${args[index]}.\n${usage}`);
}
if (!target) fail(usage);
if (!Number.isInteger(firstPort) || firstPort < 1024 || firstPort > 65515) fail('--port must be a number between 1024 and 65515.');

let commonDir;
try { commonDir = git(process.cwd(), 'rev-parse', '--path-format=absolute', '--git-common-dir'); } catch {}
const main = commonDir && dirname(commonDir);
let name;
try { name = JSON.parse(readFileSync(join(main, 'package.json'), 'utf8')).name; } catch {}
if (name !== 'ros-ai') fail('Run this inside your ros-ai folder.');

const pr = /^#?\d+$/.test(target) ? target.replace('#', '') : undefined;
if (!pr) try { git(main, 'check-ref-format', '--branch', target); } catch { fail(`${target} is not a pull request number or a branch name.\n${usage}`); }
const what = pr ? `pull request #${pr}` : `branch ${target}`, What = what[0].toUpperCase() + what.slice(1);
console.log(`Fetching ${what}…`);
try { git(main, 'fetch', '--quiet', 'origin', pr ? `pull/${pr}/head` : `refs/heads/${target}`); }
catch (error) { fail(`Could not fetch ${what} from origin.\n${error.message}`); }
const commit = git(main, 'rev-parse', 'FETCH_HEAD');

const dir = join(dirname(main), 'ros-ai-try', pr ? `pr-${pr}` : target.replace(/[^\w.-]+/g, '-'));
const dataDir = join(dir, '.ros-ai');
if (existsSync(dir)) {
  let owner;
  try { owner = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'); } catch {}
  if (owner !== commonDir) fail(`${dir} already exists and is not a ros-ai try copy. Move or remove it, then try again.`);
  // The server holds this lock while it runs, so a running copy never has its code swapped underneath it.
  if (existsSync(join(dataDir, 'process-lock.sqlite'))) {
    const { DatabaseSync } = await import('node:sqlite');
    const lock = new DatabaseSync(join(dataDir, 'process-lock.sqlite'), { timeout: 0 });
    let running = false;
    try { lock.exec('BEGIN EXCLUSIVE'); lock.exec('ROLLBACK'); } catch { running = true; } finally { lock.close(); }
    if (running) fail(`${What} is already running from ${dir}. Stop it with Ctrl+C in its terminal first.`);
  }
  if (git(dir, 'status', '--porcelain', '--untracked-files=no')) fail(`Files in ${dir} were edited. Save those edits elsewhere or remove the folder, then try again.`);
  git(dir, 'checkout', '--quiet', '--detach', commit);
} else {
  git(main, 'worktree', 'prune');
  mkdirSync(dirname(dir), { recursive: true });
  git(main, 'worktree', 'add', '--quiet', '--detach', dir, commit);
}

const lockHash = createHash('sha256').update(readFileSync(join(dir, 'package-lock.json'))).digest('hex');
const stamp = join(dir, 'node_modules', '.ros-ai-try');
if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== lockHash) {
  console.log('Installing packages for this copy. This happens again only when they change.');
  const windows = process.platform === 'win32';
  const install = spawnSync(windows ? 'npm.cmd' : 'npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit', shell: windows });
  if (install.status !== 0) fail('Installing packages failed. See the messages above.');
  writeFileSync(stamp, lockHash);
}

const image = readFileSync(join(dir, 'src/server/sandbox.ts'), 'utf8').match(/SANDBOX_IMAGE = '([^']+)'/)?.[1];
const docker = image && spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
const sandboxHint = docker && !docker.error && docker.status !== 0
  ? `\n  Code and Notebook blocks need the Python sandbox image. Build it once with:\n    docker build -t ${image} "${join(dir, 'src/server/sandbox')}"\n` : '';

const free = port => new Promise(done => {
  const probe = createServer();
  probe.once('error', () => done(false));
  probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
});
let port = firstPort;
while (!(await free(port))) if (++port > firstPort + 20) fail(`No free port between ${firstPort} and ${firstPort + 20}.`);
const url = `http://127.0.0.1:${port}`;

// Leave out keys and spending settings from this shell: the copy keeps its own usage records,
// so an allowance passed in here could be spent a second time.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ROS_|NEBIUS_|OPENAI_|ANTHROPIC_|TAVILY_|CONTREE_)/.test(key) && !/(API_KEY|SECRET|TOKEN)$/.test(key)));
const server = spawn(process.execPath, [join(dir, 'node_modules/tsx/dist/cli.mjs'), 'src/server/index.ts'], {
  cwd: dir, stdio: 'inherit', detached: process.platform !== 'win32',
  env: { ...env, ROS_DEV: '1', ROS_PORT: String(port), ROS_DATA_DIR: dataDir },
});
let stopping = false;
const stop = signal => { if (!stopping) { stopping = true; server.kill(signal); } };
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(signal === 'SIGHUP' ? 'SIGTERM' : signal));
let ready = false;
server.on('exit', code => {
  if (!ready && !stopping) fail(`${What} stopped before it was ready. See the messages above.`);
  process.exit(code ?? 0);
});

for (const deadline = Date.now() + 120_000; !ready; await new Promise(done => setTimeout(done, 500))) {
  if (Date.now() > deadline) { stop('SIGTERM'); fail(`${What} did not start within two minutes.`); }
  try { ready = (await fetch(`${url}/api/health`)).ok; } catch {}
}
console.log(`\n  ${What} (${commit.slice(0, 7)}) is running at ${url}\n  Your own checkout and projects are untouched. Press Ctrl+C to stop.\n${sandboxHint}\n  Remove this copy when you are done with:\n    git worktree remove --force "${dir}"\n`);
if (open) {
  const [command, ...rest] = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
  spawn(command, rest, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}
