import { execFile, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Express } from 'express';
import { z } from 'zod';
import type { UpdateInstallMessage, UpdateStatus } from '../shared/updates.js';
import { fetchFile } from './local-ros.js';
import { StoreError, type Store } from './store.js';

const run = promisify(execFile);
// The newest ros.ai release. ROS_UPDATE_URL names another feed of the same shape, or =off stops every check.
const FEED = process.env.ROS_UPDATE_URL ?? 'https://api.github.com/repos/arkdong/ros-ai/releases/latest';
const EVERY = 6 * 60 * 60 * 1000;
const COMMANDS = 'git pull && npm ci && npm run build';
// git must never wait for a password or passphrase nobody will type.
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' };

type Release = { version: string; url: string; publishedAt?: string; assets: { name: string; size: number; url: string; sha256?: string }[] };
type Saved = { checkedAt?: string; etag?: string; release?: Release };
type SourceCheck = { ok: true; commit: string; packages: boolean } | { ok: false; note: string };

const releaseSchema = z.object({
  tag_name: z.string(), html_url: z.string().url(), published_at: z.string().nullish(), draft: z.boolean().optional(), prerelease: z.boolean().optional(),
  assets: z.array(z.object({ name: z.string(), size: z.number(), browser_download_url: z.string().url(), digest: z.string().nullish(), state: z.string().optional() })).default([]),
});
const numbers = (version: string) => /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(version.trim())?.slice(1).map(Number);
/** True when a is a later release than b ("0.10.0" after "0.9.1"). Anything that isn't x.y.z never is. */
function isNewer(a: string, b: string) {
  const x = numbers(a), y = numbers(b);
  if (!x || !y) return false;
  for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index] > y[index];
  return false;
}
/** True when two package-lock.json files differ in more than ros.ai's own version, which every release changes:
 * only then does an update need npm ci. */
function packagesChanged(before: string, after: string) {
  const packages = (text: string) => {
    const value = JSON.parse(text);
    delete value.version; delete value.packages?.['']?.version;
    return JSON.stringify(value);
  };
  return packages(before) !== packages(after);
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0];
// What the release workflow attaches for each Mac (electron-builder's artifactName).
const zipName = (version: string) => `ros.ai-${version}-${process.arch}.zip`;

/** Looks for a newer ros.ai on GitHub and gets it ready in the background, the way Codex does, so updating
 * is one click. The Mac app downloads the new ros.ai.app and checks it; the window process
 * (desktop/src/main.ts) swaps it in after quitting and opens it again. A git checkout on main pulls,
 * installs packages when they changed, rebuilds the page and restarts in the same terminal. Any other
 * copy is told the steps. GitHub sees one request for the public release list: nothing about the person,
 * the computer or how ros.ai is used. */
export class Updates {
  readonly version: string;
  readonly install: UpdateStatus['install'];
  // Set by the Mac app: its ros.ai.app and the folder downloads wait in.
  private readonly bundle = process.env.ROS_APP_BUNDLE;
  private readonly dir = process.env.ROS_APP_UPDATES;
  private saved: Saved;
  private checking?: Promise<void>;
  private job?: { stop: AbortController; done: number; total: number };
  private staged?: { version: string; app: string };
  private source?: { version: string; result: SourceCheck };
  private installing = false;
  // A failed check or download; cleared by the next check that works.
  private error = '';
  // Why the last update could not finish, said after the restart until the next try.
  private failed = process.env.ROS_UPDATE_FAILED ?? '';
  private timer?: NodeJS.Timeout;

  constructor(private readonly store: Store, private readonly root: string, private readonly stop: () => Promise<void>) {
    delete process.env.ROS_UPDATE_FAILED;
    this.version = String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
    this.install = this.bundle && this.dir && process.send ? 'app'
      : existsSync(join(root, '.git')) && !process.env.ROS_DESKTOP && process.platform !== 'win32' && typeof process.execve === 'function' ? 'source' : 'manual';
    this.saved = store.globalRecord<Saved>('updates', 'last-check') ?? {};
    if (this.install === 'app') this.tidy();
  }

  get enabled() { return FEED !== 'off'; }
  get auto() { return this.enabled && this.store.globalRecord<{ auto: boolean }>('updates', 'settings')?.auto !== false; }

  /** Looks shortly after start, then every six hours while ros.ai runs. */
  start() { this.schedule(10_000); }
  private schedule(delay = EVERY) {
    clearTimeout(this.timer);
    this.timer = this.auto ? setTimeout(() => void this.check().finally(() => this.schedule()), delay) : undefined;
    this.timer?.unref();
  }
  setAuto(auto: boolean): UpdateStatus {
    this.store.saveGlobalRecord('updates', 'settings', { auto });
    this.schedule(10_000);
    return this.status();
  }

  /** Asks GitHub for the newest release, then gets it ready. The ETag keeps repeat questions outside GitHub's rate limit. */
  check(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.checking ??= this.fetchRelease()
      .then(() => { this.error = ''; }, error => { this.error = `Could not check for updates: ${message(error)}`; })
      .then(() => this.prepare())
      .catch(error => { this.error = `Could not get the update ready: ${message(error)}`; })
      .finally(() => { this.checking = undefined; });
    return this.checking;
  }
  private async fetchRelease() {
    const response = await fetch(FEED, { signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ros.ai', ...(this.saved.etag && this.saved.release ? { 'If-None-Match': this.saved.etag } : {}) } });
    const checkedAt = new Date().toISOString();
    if (response.status === 304) this.saved = { ...this.saved, checkedAt };
    // No release yet.
    else if (response.status === 404) this.saved = { checkedAt };
    else if (!response.ok) throw new Error(`${new URL(FEED).host} answered ${response.status}`);
    else {
      const value = releaseSchema.parse(await response.json()), etag = response.headers.get('etag');
      const release: Release | undefined = value.draft || value.prerelease || !numbers(value.tag_name) ? undefined : {
        version: value.tag_name.replace(/^v/u, ''), url: value.html_url, ...(value.published_at ? { publishedAt: value.published_at } : {}),
        // A file still uploading is not there yet.
        assets: value.assets.filter(asset => !asset.state || asset.state === 'uploaded').map(asset => ({ name: asset.name, size: asset.size, url: asset.browser_download_url, ...(asset.digest?.startsWith('sha256:') ? { sha256: asset.digest.slice(7) } : {}) })),
      };
      this.saved = { checkedAt, ...(etag && release ? { etag } : {}), ...(release ? { release } : {}) };
    }
    this.store.saveGlobalRecord('updates', 'last-check', this.saved);
  }
  /** The newest release when it is newer than this copy. The Mac app waits until the release has its zip for this Mac. */
  private newer() {
    const release = this.saved.release;
    if (!release || !isNewer(release.version, this.version)) return undefined;
    return this.install !== 'app' || release.assets.some(asset => asset.name === zipName(release.version)) ? release : undefined;
  }

  /** Gets a newer release ready: the Mac app starts downloading it, a checkout fetches main to see whether it can pull. */
  private async prepare() {
    const release = this.newer();
    if (!release || this.installing) return;
    if (this.install === 'source') { this.source = { version: release.version, result: await this.checkSource(release) }; return; }
    if (this.install !== 'app' || this.appNote() || this.job || this.staged?.version === release.version) return;
    void this.download(release).catch(error => { this.error = `The update could not download: ${message(error)}`; });
  }

  /** Downloads the release's zip for this Mac, checks it against GitHub's checksum, unpacks it and checks the app inside. */
  private async download(release: Release) {
    const name = zipName(release.version), asset = release.assets.find(item => item.name === name)!;
    const stop = new AbortController();
    this.job = { stop, done: 0, total: asset.size };
    try {
      const zip = join(this.dir!, name), target = join(this.dir!, release.version);
      await fetchFile({ url: asset.url, file: zip, bytes: asset.size, ...(asset.sha256 ? { sha256: asset.sha256 } : {}) }, stop.signal, done => { if (this.job?.stop === stop) this.job.done = done; });
      rmSync(target, { recursive: true, force: true }); mkdirSync(target, { recursive: true });
      // ditto keeps the app's symlinks and signature the way Finder and Squirrel unpack it.
      await run('ditto', ['-x', '-k', zip, target]);
      rmSync(zip, { force: true });
      const app = readdirSync(target).find(entry => entry.endsWith('.app'));
      if (!app) throw new Error('the download held no app');
      await verifyApp(join(target, app), release.version, this.bundle!);
      writeFileSync(join(target, 'verified'), release.version);
      this.staged = { version: release.version, app: join(target, app) };
    } finally { if (this.job?.stop === stop) this.job = undefined; }
  }
  /** At start: says why the last swap failed, forgets downloads this copy no longer needs and remembers one that is ready. */
  private tidy() {
    const wanted = this.newer()?.version;
    try { this.failed = readFileSync(join(this.dir!, 'failed'), 'utf8').trim(); } catch { /* the last update went in */ }
    let entries: string[] = [];
    try { entries = readdirSync(this.dir!); } catch { return; }
    for (const entry of entries) if (!wanted || (entry !== wanted && !entry.startsWith(`ros.ai-${wanted}-`))) rmSync(join(this.dir!, entry), { recursive: true, force: true });
    if (!wanted) return;
    try {
      const app = readdirSync(join(this.dir!, wanted)).find(entry => entry.endsWith('.app'));
      if (app && readFileSync(join(this.dir!, wanted, 'verified'), 'utf8') === wanted) this.staged = { version: wanted, app: join(this.dir!, wanted, app) };
    } catch { /* not downloaded yet */ }
  }
  /** Why the Mac app can't replace itself where it is, if it can't. */
  private appNote(): string | undefined {
    const bundle = this.bundle!;
    try { accessSync(dirname(bundle), constants.W_OK); accessSync(bundle, constants.W_OK); return undefined; }
    catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EROFS' || bundle.includes('/AppTranslocation/')
        ? 'ros.ai is running from its disk image or the Downloads folder, so it can\'t replace itself. Drag it to Applications and open it from there.'
        : `ros.ai can't write to ${dirname(bundle)}, so it can't replace itself. Download the new version instead.`;
    }
  }

  /** A checkout updates itself only from main with nothing uncommitted, when main on origin has the release. */
  private async checkSource(release: Release): Promise<SourceCheck> {
    const git = async (...args: string[]) => (await run('git', args, { cwd: this.root, timeout: 60_000, env: gitEnv, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
    try {
      const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
      if (branch !== 'main') return { ok: false, note: branch === 'HEAD' ? 'This copy is not on a branch, so ros.ai won\'t pull by itself.' : `This checkout is on ${branch}, not main, so ros.ai won't pull by itself.` };
      if (await git('status', '--porcelain', '--untracked-files=no')) return { ok: false, note: 'This checkout has changes that aren\'t committed, so ros.ai won\'t pull by itself.' };
      await git('fetch', '--quiet', 'origin', 'main');
      const head = await git('rev-parse', 'HEAD'), commit = await git('rev-parse', 'FETCH_HEAD');
      if (!await git('merge-base', '--is-ancestor', head, commit).then(() => true, () => false)) return { ok: false, note: 'This checkout has commits that aren\'t on main, so ros.ai won\'t pull by itself.' };
      const next = String(JSON.parse(await git('show', `${commit}:package.json`)).version);
      if (isNewer(release.version, next)) return { ok: false, note: `main on origin is still at ${next}, so there is nothing to pull yet.` };
      return { ok: true, commit, packages: packagesChanged(await git('show', `${head}:package-lock.json`), await git('show', `${commit}:package-lock.json`)) };
    } catch (error) { return { ok: false, note: `git could not check this checkout: ${message(error)}` }; }
  }

  /** One click. The Mac app hands its checked download to the window process, which quits, swaps and reopens;
   * a checkout pulls, installs, builds and restarts itself. The page waits for ros.ai to come back. */
  async installNow(): Promise<UpdateStatus> {
    const release = this.newer();
    if (!release) throw new StoreError('ros.ai is up to date.', 409);
    if (this.installing) return this.status();
    this.failed = '';
    if (this.install === 'app') {
      if (this.staged?.version !== release.version) throw new StoreError('The new version is still downloading.', 409);
      process.send!({ type: 'ros-update-install', version: release.version, app: this.staged.app } satisfies UpdateInstallMessage);
      this.installing = true;
      return this.status();
    }
    if (this.install !== 'source') throw new StoreError('This copy of ros.ai updates by hand.', 409);
    const result = await this.checkSource(release);
    this.source = { version: release.version, result };
    if (!result.ok) throw new StoreError(result.note, 409);
    this.installing = true;
    // Answer the page first; it shows the update and reloads when ros.ai is back.
    setTimeout(() => void this.restart(release.version, result.commit, result.packages), 300);
    return this.status();
  }
  /** Stops every service, pulls, installs packages when the lock file changed, builds the page, then runs
   * the new code in this same process: same terminal, same Ctrl+C. */
  private async restart(version: string, commit: string, packages: boolean) {
    console.log(`\n  Updating ros.ai to ${version}…`);
    await this.stop().catch(error => console.error(`  ${message(error)}`));
    const step = (label: string, command: string, args: string[]) => {
      console.log(`  ${label}`);
      const result = spawnSync(command, args, { cwd: this.root, stdio: 'inherit', env: gitEnv });
      if (result.signal) process.exit(1);
      return !result.error && result.status === 0;
    };
    const again = (failed?: string) => process.execve!(process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], { ...process.env, ...(failed ? { ROS_UPDATE_FAILED: failed } : {}) });
    const stuck = (what: string) => { console.error(`\n  ros.ai pulled ${version}, but ${what} failed (see above). In ${this.root} run:\n    npm ci && npm run build && npm start\n`); process.exit(1); };
    if (!step('Pulling main…', 'git', ['merge', '--ff-only', '--quiet', commit])) return again(`git could not pull ${version} into this checkout (see the terminal), so ros.ai started again as it was.`);
    if (packages && !step('Installing packages…', 'npm', ['ci', '--no-audit', '--no-fund'])) return stuck('npm ci');
    // npm run dev serves the page from source and needs no build.
    if (process.env.ROS_DEV !== '1' && !step('Building the page…', process.execPath, [join(this.root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'error'])) return stuck('the build');
    console.log(`  Starting ros.ai ${version}…\n`);
    again();
  }

  status(): UpdateStatus {
    const base: UpdateStatus = { version: this.version, install: this.install, enabled: this.enabled, auto: this.auto, checking: Boolean(this.checking), state: 'current', ...(this.saved.checkedAt ? { checkedAt: this.saved.checkedAt } : {}), ...(this.failed || this.error ? { error: this.failed || this.error } : {}) };
    const release = this.newer();
    if (!release) return base;
    const latest = { version: release.version, url: release.url, ...(release.publishedAt ? { publishedAt: release.publishedAt } : {}) };
    const steps = (note: string, commands?: string): UpdateStatus => ({ ...base, latest, state: 'available', action: 'steps', note, ...(commands ? { commands } : {}) });
    if (this.installing) return { ...base, latest, state: 'installing' };
    if (this.install === 'app') {
      const note = this.appNote();
      if (note) return steps(note);
      if (this.job) return { ...base, latest, state: 'downloading', doneBytes: this.job.done, totalBytes: this.job.total };
      return this.staged?.version === release.version ? { ...base, latest, state: 'ready', action: 'restart' } : { ...base, latest, state: 'available' };
    }
    if (this.install === 'source') {
      const result = this.source?.version === release.version ? this.source.result : undefined;
      return !result ? { ...base, latest, state: 'available' } : result.ok ? { ...base, latest, state: 'available', action: 'update' } : steps(result.note, COMMANDS);
    }
    // npm run app on a checkout, Windows, or a copy without git.
    if (!existsSync(join(this.root, '.git'))) return steps('Download the new version from GitHub.');
    return process.env.ROS_DESKTOP ? steps('Quit ros.ai, update this checkout, then open it again with npm run app.', 'git pull && npm ci') : steps('Update this checkout, then start ros.ai again.', COMMANDS);
  }

  shutdown() { clearTimeout(this.timer); this.job?.stop.abort(); }
}

/** The download must be the release it says it is and, when this ros.ai is signed, signed by the same developer. */
async function verifyApp(app: string, version: string, current: string) {
  const found = String(JSON.parse(readFileSync(join(app, 'Contents', 'Resources', 'app', 'package.json'), 'utf8')).version);
  if (found !== version) throw new Error(`the download says it is ${found}, not ${version}`);
  const valid = (path: string) => run('codesign', ['--verify', '--deep', '--strict', path]).then(() => true, () => false);
  // codesign describes a signature on stderr; an unsigned or ad-hoc app says "TeamIdentifier=not set".
  const team = async (path: string) => {
    const result: { stderr?: string } = await run('codesign', ['-dv', path]).catch(error => error);
    const id = /TeamIdentifier=(\S+)/u.exec(result.stderr ?? '')?.[1];
    return id === 'not' ? undefined : id;
  };
  if (await valid(current) && !await valid(app)) throw new Error('the download\'s signature is broken');
  const signer = await team(current);
  if (signer && await team(app) !== signer) throw new Error('the download is not signed by the same developer as this ros.ai');
}

export function attachUpdateRoutes(app: Express, updates: Updates) {
  app.get('/api/updates', (_req, res) => { res.json(updates.status()); });
  app.post('/api/updates/check', async (_req, res) => { await updates.check(); res.json(updates.status()); });
  app.put('/api/updates/settings', (req, res) => { const { auto } = z.object({ auto: z.boolean() }).strict().parse(req.body); res.json(updates.setAuto(auto)); });
  app.post('/api/updates/install', async (_req, res) => { res.status(202).json(await updates.installNow()); });
}
