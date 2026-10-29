import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Express } from 'express';
import { z } from 'zod';
import type { LocalRosStatus } from '../shared/local-ros.js';
import type { InferenceConnections } from './inference-connections.js';
import { StoreError } from './store.js';

const run = promisify(execFile);
// ros-nemotron: Nemotron 3 Nano 4B fine-tuned on ros.ai's own agent turns (training/ros-nemotron). A computer that already
// downloaded NVIDIA's GGUF keeps it until ROS is removed and downloaded again.
const MODEL_REPO = process.env.ROS_LOCAL_MODEL_REPO || 'arkdong/ros-nemotron-4b-GGUF';
const ENGINE_REPO = 'ggml-org/llama.cpp';
/** llama.cpp's server, pinned to b11960: the build behind llama.cpp's stable release v0.8.0 (28 October 2026). Since
 * v0.7.0 a stable release holds no programs, only nightly-tag.txt naming the build that does, so asking GitHub for the
 * latest release found no build for any computer. A pinned build with its published size and SHA-256 needs no call to
 * GitHub's API (60 an hour from one address, often used up on a shared network) and runs what ros.ai was tested with.
 * ROS_LOCAL_ENGINE_TAG asks GitHub for another build instead; "latest" follows the stable release to its build. */
const ENGINE_TAG = 'b11960';
const pinned: Partial<Record<string, { name: string; bytes: number; sha256: string }>> = {
  'darwin-arm64': { name: 'llama-b11960-bin-macos-arm64.tar.gz', bytes: 16_465_074, sha256: '58e5a5e1d7c2bf66cedd9c29e0323f3e570660a70a1e2156d32eed08f4cc1e3c' },
  'darwin-x64': { name: 'llama-b11960-bin-macos-x64.tar.gz', bytes: 12_205_764, sha256: 'd1e6c9ddcaed9a3b1bb8f3d946bdb3481c7b919357a4029dcb747762397f1da5' },
  'linux-x64': { name: 'llama-b11960-bin-ubuntu-x64.tar.gz', bytes: 22_686_210, sha256: '31cc3a6bc638ac6c48dc4b1b74888f1eaadf3d14227c1e5f67daf9a49541d97a' },
};
const PREFERRED_PORT = 4319, CONTEXT_TOKENS = 32_768;
const assetPattern: Partial<Record<string, RegExp>> = {
  'darwin-arm64': /-bin-macos-arm64\.(zip|tar\.gz)$/u,
  'darwin-x64': /-bin-macos-x64\.(zip|tar\.gz)$/u,
  'linux-x64': /-bin-ubuntu-x64\.(zip|tar\.gz)$/u,
};
/** The waits between tries after a dropped connection or a server error, in seconds; the last one repeats. A laptop
 * that is offline for a while (asleep, between networks) finds the download going on when it is back. */
const RETRY_WAITS = [3, 10, 30, 60];
/** Tries in a row without getting any further before the download gives up: about half an hour with RETRY_WAITS. */
const MAX_TRIES = 30;
/** Room left on the disk past the download: the engine unpacked, and some to spare. */
const DISK_SPARE = 400e6;
const installedSchema = z.object({ engineTag: z.string(), server: z.string(), model: z.string(), modelFile: z.string(), apiKey: z.string().min(32), connectionId: z.string().optional() }).strict();
type Installed = z.infer<typeof installedSchema>;
type Download = { url: string; file: string; bytes: number; sha256?: string };
type Release = { tag_name: string; assets: { name: string; size: number; browser_download_url: string; digest?: string | null }[] };
type Job = { stop: AbortController; done: number; total: number; model: string; samples: [number, number][]; note?: string };

/** A download that failed in a way trying again can fix: a dropped or stalled connection, a server error, a short file. */
export class DownloadError extends Error {
  constructor(message: string, readonly retry: boolean) { super(message); this.name = 'DownloadError'; }
}
const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
/** fetch reports a dropped or refused connection as a TypeError, and a request that ran out of time as a TimeoutError. */
const transient = (error: unknown) => error instanceof DownloadError ? error.retry : error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError');
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(new DOMException('Stopped', 'AbortError')); };
  signal.addEventListener('abort', stop, { once: true });
});

/** ROS on this computer: ros.ai downloads llama.cpp's server and a Nemotron GGUF, runs them on
 * loopback with a random key, and registers the result as an ordinary local model connection,
 * so ROS, the assistant and the agent loop use it like any other model. A download the person
 * started carries on by itself: through dropped connections, and after ros.ai restarts. */
export class LocalRos {
  private readonly dir: string;
  private child?: ChildProcess;
  private job?: Job;
  private starting?: Promise<void>;
  private lastError = '';
  /** waits: the pauses between tries, in seconds (tests shorten them). */
  constructor(dataDir: string, private readonly connections: InferenceConnections, private readonly waits = RETRY_WAITS) {
    this.dir = join(dataDir, 'local-ros');
  }
  private get platform() { return `${process.platform}-${process.arch}`; }
  private get wantFile() { return join(this.dir, 'wanted'); }
  private installed(): Installed | undefined {
    try { return installedSchema.parse(JSON.parse(readFileSync(join(this.dir, 'installed.json'), 'utf8'))); } catch { return undefined; }
  }
  private save(value: Installed) { mkdirSync(this.dir, { recursive: true }); writeFileSync(join(this.dir, 'installed.json'), JSON.stringify(value), { mode: 0o600 }); }
  /** The person asked for ROS on this computer and the files are not all here yet: the download picks up at the next start. */
  private want(on: boolean) {
    if (on) { mkdirSync(this.dir, { recursive: true }); writeFileSync(this.wantFile, new Date().toISOString()); } else rmSync(this.wantFile, { force: true });
  }

  status(): LocalRosStatus {
    const supported = Boolean(assetPattern[this.platform]);
    if (this.job) {
      const { samples } = this.job, first = samples[0], last = samples[samples.length - 1];
      const rate = first && last && last[0] - first[0] >= 2000 ? Math.round(((last[1] - first[1]) / (last[0] - first[0])) * 1000) : undefined;
      return { supported, state: 'downloading', model: this.job.model, doneBytes: this.job.done, totalBytes: this.job.total, ...(rate ? { bytesPerSecond: rate } : {}), ...(this.job.note ? { note: this.job.note } : {}) };
    }
    const installed = this.installed();
    if (!installed) return { supported, state: this.lastError ? 'failed' : 'not-downloaded', ...(this.lastError ? { error: this.lastError } : {}) };
    const size = existsSync(installed.modelFile) ? statSync(installed.modelFile).size : undefined;
    const base = { supported, model: installed.model, ...(size ? { totalBytes: size } : {}), ...(installed.connectionId ? { connectionId: installed.connectionId } : {}) };
    if (this.lastError) return { ...base, state: 'failed', error: this.lastError };
    return { ...base, state: this.child && !this.starting ? 'ready' : 'starting' };
  }

  /** At launch: runs ROS when it is downloaded, or carries on with a download the person started that did not finish. */
  resume(): Promise<void> {
    if (this.installed()) return this.start();
    if (existsSync(this.wantFile) && assetPattern[this.platform]) this.download();
    return Promise.resolve();
  }

  /** Fetches the engine and the model in the background, then starts ROS; the page polls status for progress. */
  download(): LocalRosStatus {
    if (!assetPattern[this.platform]) throw new StoreError('ROS on this computer needs a Mac or a Linux x64 computer for now.', 400);
    if (this.job) return this.status();
    const stop = new AbortController();
    this.job = { stop, done: 0, total: 0, model: '', samples: [] };
    this.lastError = '';
    this.want(true);
    void this.install(stop.signal).then(() => {
      if (this.job?.stop === stop) this.job = undefined;
      this.want(false);
      return this.start();
    }).catch(error => {
      this.lastError = stop.signal.aborted ? '' : error instanceof Error ? error.message : 'The download failed.';
    }).finally(() => { if (this.job?.stop === stop) this.job = undefined; });
    return this.status();
  }
  cancel(): LocalRosStatus { this.job?.stop.abort(); this.job = undefined; this.want(false); return this.status(); }

  /** One step of the download, tried again after a dropped connection or a server error, while the status says so. */
  private async again<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let tries = 0; ; tries++) {
      const before = this.job?.done ?? 0;
      try {
        const value = await work();
        if (this.job) this.job.note = undefined;
        return value;
      } catch (error) {
        // A try that got further than the one before starts the count again.
        if ((this.job?.done ?? 0) > before) tries = 0;
        const wait = tries < MAX_TRIES ? this.waits[Math.min(tries, this.waits.length - 1)] : undefined;
        if (signal.aborted || !transient(error) || wait === undefined) throw error;
        if (this.job) { this.job.note = `The connection dropped. Trying again in ${wait} s.`; this.job.samples = []; }
        await sleep(wait * 1000, signal);
        if (this.job) this.job.note = 'Trying again…';
      }
    }
  }

  /** The llama.cpp build to download: the pinned one, or the one ROS_LOCAL_ENGINE_TAG names, looked up on GitHub. */
  private async engine(signal: AbortSignal): Promise<{ tag: string; download: Download }> {
    const wanted = process.env.ROS_LOCAL_ENGINE_TAG?.trim(), file = (name: string) => join(this.dir, name);
    const fixed = pinned[this.platform];
    if (!wanted && fixed) return { tag: ENGINE_TAG, download: { url: `https://github.com/${ENGINE_REPO}/releases/download/${ENGINE_TAG}/${fixed.name}`, file: file(fixed.name), bytes: fixed.bytes, sha256: fixed.sha256 } };
    const pattern = assetPattern[this.platform]!, releases = `https://api.github.com/repos/${ENGINE_REPO}/releases`;
    let release = await json(`${releases}/${wanted && wanted !== 'latest' ? `tags/${encodeURIComponent(wanted)}` : 'latest'}`, signal) as Release;
    // A stable release names the build that holds its programs in nightly-tag.txt.
    const pointer = release.assets.find(item => item.name === 'nightly-tag.txt');
    if (!release.assets.some(item => pattern.test(item.name)) && pointer) {
      const tag = (await text(pointer.browser_download_url, signal)).trim();
      if (/^b\d+$/u.test(tag)) release = await json(`${releases}/tags/${tag}`, signal) as Release;
    }
    const asset = release.assets.find(item => pattern.test(item.name));
    if (!asset) throw new Error(`llama.cpp ${release.tag_name} has no build for this computer.`);
    return { tag: release.tag_name, download: { url: asset.browser_download_url, file: file(asset.name), bytes: asset.size, ...(asset.digest?.startsWith('sha256:') ? { sha256: asset.digest.slice(7) } : {}) } };
  }

  private async install(signal: AbortSignal) {
    mkdirSync(this.dir, { recursive: true });
    // Which files to fetch: the engine for this computer, and the model's 4-bit file. Both sources state each file's
    // SHA-256, checked after the download.
    const { tag, download: engine } = await this.again(() => this.engine(signal), signal);
    const tree = await this.again(() => json(`https://huggingface.co/api/models/${MODEL_REPO}/tree/main`, signal), signal) as { type: string; path: string; size: number; lfs?: { oid: string; size: number } }[];
    const ggufs = tree.filter(item => item.type === 'file' && item.path.endsWith('.gguf'));
    const chosen = ggufs.find(item => item.path === process.env.ROS_LOCAL_MODEL_FILE) ?? ggufs.find(item => /q4_k_m/iu.test(item.path)) ?? [...ggufs].sort((a, b) => (a.lfs?.size ?? a.size) - (b.lfs?.size ?? b.size))[0];
    if (!chosen) throw new Error(`${MODEL_REPO} has no GGUF file.`);
    const model: Download = { url: `https://huggingface.co/${MODEL_REPO}/resolve/main/${chosen.path}`, file: join(this.dir, 'models', chosen.path.split('/').pop()!), bytes: chosen.lfs?.size ?? chosen.size, ...(chosen.lfs?.oid ? { sha256: chosen.lfs.oid } : {}) };
    const job = this.job;
    if (!job || signal.aborted) throw new DOMException('Stopped', 'AbortError');
    job.model = chosen.path.split('/').pop()!; job.total = engine.bytes + model.bytes;
    // Enough room for what is still to come, before any of it is fetched.
    const left = [engine, model].reduce((sum, item) => sum + item.bytes - have(item), 0);
    const free = freeBytes(this.dir);
    if (free !== null && free < left + DISK_SPARE) throw new Error(`ROS needs ${gigabytes(left + DISK_SPARE)} free on this computer and ${gigabytes(free)} is free. Make room, then try again.`);
    const progress = (offset: number) => (done: number) => {
      job.done = offset + done;
      const now = Date.now(), last = job.samples[job.samples.length - 1];
      if (!last || now - last[0] >= 500) { job.samples.push([now, job.done]); while (job.samples.length > 2 && now - job.samples[0]![0] > 10_000) job.samples.shift(); }
    };
    await this.again(() => fetchFile(engine, signal, progress(0)), signal);
    await this.again(() => fetchFile(model, signal, progress(engine.bytes)), signal);

    const engineDir = join(this.dir, 'engine', tag);
    rmSync(engineDir, { recursive: true, force: true }); mkdirSync(engineDir, { recursive: true });
    if (engine.file.endsWith('.zip')) await run('unzip', ['-o', '-q', engine.file, '-d', engineDir]);
    else await run('tar', ['-xzf', engine.file, '-C', engineDir]);
    // Files this app writes carry no quarantine, but one that did would stop macOS from running the engine.
    if (process.platform === 'darwin') await run('xattr', ['-dr', 'com.apple.quarantine', engineDir]).catch(() => undefined);
    rmSync(engine.file, { force: true });
    const server = findFile(engineDir, 'llama-server');
    if (!server) throw new Error(`llama.cpp ${tag} came without llama-server.`);
    const prior = this.installed();
    this.save({ engineTag: tag, server, model: job.model, modelFile: model.file, apiKey: prior?.apiKey ?? randomBytes(24).toString('hex'), ...(prior?.connectionId ? { connectionId: prior.connectionId } : {}) });
  }

  /** Starts the engine when the model is on disk (at launch, and after a download). */
  start(): Promise<void> {
    const installed = this.installed();
    if (!installed || this.child) return Promise.resolve();
    this.lastError = '';
    this.starting = this.launch(installed).catch(error => { this.lastError = error instanceof Error ? error.message : 'ROS could not start.'; this.stop(); }).finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async launch(installed: Installed) {
    const port = await freePort(PREFERRED_PORT);
    // Reasoning is off, as for hosted Nano: the agent loop needs answers within its output cap.
    const child = spawn(installed.server, ['-m', installed.modelFile, '--host', '127.0.0.1', '--port', String(port), '--api-key', installed.apiKey, '--jinja', '--reasoning-budget', '0', '-c', String(CONTEXT_TOKENS), '--alias', 'ros-local', '--no-webui'], { stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    let log = '';
    child.stderr?.on('data', (chunk: Buffer) => { log = (log + chunk.toString()).slice(-2000); });
    // A server that cannot start at all (a missing file, a library it cannot load) reports it here, not as an exit.
    child.on('error', error => { if (this.child === child) { this.child = undefined; this.lastError = `ROS could not start: ${error.message}`; } });
    child.on('exit', code => { if (this.child === child) { this.child = undefined; if (code) this.lastError = `ROS stopped (llama.cpp exit ${code}). ${log.split('\n').filter(Boolean).slice(-1)[0] ?? ''}`.trim(); } });
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (this.child !== child) throw new Error(this.lastError || 'ROS stopped while loading.');
      const ok = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }).then(response => response.ok, () => false);
      if (ok) break;
      if (Date.now() > deadline) throw new Error('ROS took longer than two minutes to load.');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    this.register(installed, port);
  }
  /** One local connection, kept across starts; only its port can change. */
  private register(installed: Installed, port: number) {
    const existing = installed.connectionId && this.connections.statuses().find(item => item.id === installed.connectionId && !item.deleted);
    const fields = {
      name: 'ROS on this computer', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: installed.apiKey, enabled: true,
      models: [{ id: 'ros-local', label: 'ROS', contextTokens: CONTEXT_TOKENS, inputUsdPerMillion: 0, outputUsdPerMillion: 0, maker: { id: 'nvidia' as const, label: 'NVIDIA Nemotron', monogram: 'N' } }],
      caps: { maxInputBytes: 64000, maxOutputTokens: 8000, timeoutMs: 300000, maxConcurrent: 1, maxResponseBytes: 256000 },
    };
    const connection = existing ? this.connections.update(existing.id, fields) : this.connections.create(fields);
    const status = this.connections.status(connection.id);
    this.connections.saveAllowance(connection.id, { requestCeiling: Math.max(10000, status.usedRequests), usdCeiling: status.usdCeiling, enabled: true, acknowledged: true });
    if (connection.id !== installed.connectionId) this.save({ ...installed, connectionId: connection.id });
  }

  remove(): LocalRosStatus {
    this.cancel(); this.stop();
    const installed = this.installed();
    if (installed?.connectionId && this.connections.statuses().some(item => item.id === installed.connectionId && !item.deleted)) this.connections.remove(installed.connectionId);
    rmSync(this.dir, { recursive: true, force: true });
    this.lastError = '';
    return this.status();
  }
  private stop() { const child = this.child; this.child = undefined; child?.kill(); }
  shutdown() { this.job?.stop.abort(); this.stop(); }
}

async function json(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), headers: { Accept: 'application/json', 'User-Agent': 'ros.ai' } });
  if (!response.ok) throw new DownloadError(`${new URL(url).host} answered ${response.status}.`, response.status >= 500 || response.status === 429 || response.status === 408);
  return response.json();
}
async function text(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), headers: { 'User-Agent': 'ros.ai' } });
  if (!response.ok) throw new DownloadError(`${new URL(url).host} answered ${response.status}.`, response.status >= 500 || response.status === 429);
  return response.text();
}
/** What of a download is on disk already: the whole file, or the part a stopped download left. */
function have(item: Download) {
  try { if (existsSync(item.file) && statSync(item.file).size === item.bytes) return item.bytes; return existsSync(`${item.file}.part`) ? Math.min(item.bytes, statSync(`${item.file}.part`).size) : 0; } catch { return 0; }
}
/** Free space where the files go, or null where the system does not say. */
function freeBytes(dir: string) {
  try { const disk = statfsSync(dir); return disk.bavail * disk.bsize; } catch { return null; }
}

/** How long a download may go without receiving anything before it counts as stalled and starts again where it was. */
const STALL_MS = 45_000;

/** Downloads into a .part file that a later attempt resumes, then checks size and SHA-256. ros.ai updates use it too.
 * A connection that drops, stalls or ends early throws a DownloadError that trying again can fix. */
export async function fetchFile(item: Download, signal: AbortSignal, progress: (done: number) => void) {
  mkdirSync(join(item.file, '..'), { recursive: true });
  if (existsSync(item.file) && statSync(item.file).size === item.bytes) { progress(item.bytes); return; }
  const part = `${item.file}.part`;
  let have = existsSync(part) ? statSync(part).size : 0;
  // A part as long as the file or longer cannot be resumed: it failed its check or the file changed.
  if (have >= item.bytes) { rmSync(part, { force: true }); have = 0; }
  const stalled = new AbortController();
  let timer = setTimeout(() => stalled.abort(), STALL_MS);
  const alive = () => { clearTimeout(timer); timer = setTimeout(() => stalled.abort(), STALL_MS); };
  let done = 0;
  try {
    const response = await fetch(item.url, { signal: AbortSignal.any([signal, stalled.signal]), headers: { 'User-Agent': 'ros.ai', ...(have ? { Range: `bytes=${have}-` } : {}) } });
    // A part the server cannot resume from (the file changed) starts again from the beginning on the next try.
    if (response.status === 416) rmSync(part, { force: true });
    if (!response.ok || !response.body) throw new DownloadError(`The download from ${new URL(item.url).host} failed (${response.status}).`, response.status >= 500 || response.status === 429 || response.status === 408 || response.status === 416);
    done = response.status === 206 ? have : 0;
    const out = createWriteStream(part, { flags: response.status === 206 ? 'a' : 'w' });
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        alive();
        if (!out.write(chunk)) await new Promise<void>(resolve => out.once('drain', () => resolve()));
        done += chunk.byteLength; progress(done);
      }
    } finally { await new Promise<void>(resolve => out.end(() => resolve())); }
  } catch (error) {
    if (stalled.signal.aborted && !signal.aborted) throw new DownloadError(`The download from ${new URL(item.url).host} stalled.`, true);
    throw error;
  } finally { clearTimeout(timer); }
  if (statSync(part).size !== item.bytes) throw new DownloadError('The download ended early. It picks up where it stopped.', true);
  if (item.sha256) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer);
    if (hash.digest('hex') !== item.sha256) { rmSync(part, { force: true }); throw new DownloadError('The downloaded file did not match its published checksum, so it was deleted.', true); }
  }
  renameSync(part, item.file);
}

function findFile(dir: string, name: string): string | undefined {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) { const found = findFile(path, name); if (found) return found; }
  }
  return undefined;
}

function freePort(preferred: number) {
  const tryPort = (port: number) => new Promise<number>((resolve, reject) => {
    const server = createServer().once('error', reject).listen(port, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(typeof address === 'object' && address ? address.port : port)); });
  });
  return tryPort(preferred).catch(() => tryPort(0));
}

export function attachLocalRosRoutes(app: Express, local: LocalRos) {
  app.get('/api/local-ros', (_req, res) => { res.json(local.status()); });
  app.post('/api/local-ros/download', (_req, res) => { res.json(local.download()); });
  app.post('/api/local-ros/cancel', (_req, res) => { res.json(local.cancel()); });
  app.post('/api/local-ros/remove', (_req, res) => { res.json(local.remove()); });
}
