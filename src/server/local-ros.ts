import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Express } from 'express';
import { z } from 'zod';
import type { LocalRosStatus } from '../shared/local-ros.js';
import type { InferenceConnections } from './inference-connections.js';
import { StoreError } from './store.js';

const run = promisify(execFile);
// NVIDIA's own GGUF of Nemotron 3 Nano 4B until ros-nemotron replaces it.
const MODEL_REPO = process.env.ROS_LOCAL_MODEL_REPO || 'nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF';
const ENGINE_REPO = 'ggml-org/llama.cpp';
const PREFERRED_PORT = 4319, CONTEXT_TOKENS = 32_768;
const assetPattern: Partial<Record<string, RegExp>> = {
  'darwin-arm64': /-bin-macos-arm64\.(zip|tar\.gz)$/u,
  'darwin-x64': /-bin-macos-x64\.(zip|tar\.gz)$/u,
  'linux-x64': /-bin-ubuntu-x64\.(zip|tar\.gz)$/u,
};
const installedSchema = z.object({ engineTag: z.string(), server: z.string(), model: z.string(), modelFile: z.string(), apiKey: z.string().min(32), connectionId: z.string().optional() }).strict();
type Installed = z.infer<typeof installedSchema>;
type Download = { url: string; file: string; bytes: number; sha256?: string };

/** Ros on this computer: ros.ai downloads llama.cpp's server and a Nemotron GGUF, runs them on
 * loopback with a random key, and registers the result as an ordinary local model connection,
 * so Ros, the assistant and the agent loop use it like any other model. */
export class LocalRos {
  private readonly dir: string;
  private child?: ChildProcess;
  private job?: { stop: AbortController; done: number; total: number; model: string };
  private starting?: Promise<void>;
  private lastError = '';
  constructor(dataDir: string, private readonly connections: InferenceConnections) {
    this.dir = join(dataDir, 'local-ros');
  }
  private get platform() { return `${process.platform}-${process.arch}`; }
  private installed(): Installed | undefined {
    try { return installedSchema.parse(JSON.parse(readFileSync(join(this.dir, 'installed.json'), 'utf8'))); } catch { return undefined; }
  }
  private save(value: Installed) { mkdirSync(this.dir, { recursive: true }); writeFileSync(join(this.dir, 'installed.json'), JSON.stringify(value), { mode: 0o600 }); }

  status(): LocalRosStatus {
    const supported = Boolean(assetPattern[this.platform]);
    if (this.job) return { supported, state: 'downloading', model: this.job.model, doneBytes: this.job.done, totalBytes: this.job.total };
    const installed = this.installed();
    if (!installed) return { supported, state: this.lastError ? 'failed' : 'not-downloaded', ...(this.lastError ? { error: this.lastError } : {}) };
    const size = existsSync(installed.modelFile) ? statSync(installed.modelFile).size : undefined;
    const base = { supported, model: installed.model, ...(size ? { totalBytes: size } : {}), ...(installed.connectionId ? { connectionId: installed.connectionId } : {}) };
    if (this.lastError) return { ...base, state: 'failed', error: this.lastError };
    return { ...base, state: this.child && !this.starting ? 'ready' : 'starting' };
  }

  /** Fetches the engine and the model in the background; the page polls status for progress. */
  download(): LocalRosStatus {
    const pattern = assetPattern[this.platform];
    if (!pattern) throw new StoreError('Ros on this computer needs a Mac or a Linux x64 computer for now.', 400);
    if (this.job) return this.status();
    const stop = new AbortController();
    this.job = { stop, done: 0, total: 0, model: '' };
    this.lastError = '';
    void this.install(pattern, stop.signal).then(() => this.start()).catch(error => {
      this.lastError = stop.signal.aborted ? '' : error instanceof Error ? error.message : 'The download failed.';
    }).finally(() => { if (this.job?.stop === stop) this.job = undefined; });
    return this.status();
  }
  cancel(): LocalRosStatus { this.job?.stop.abort(); this.job = undefined; return this.status(); }

  private async install(pattern: RegExp, signal: AbortSignal) {
    mkdirSync(this.dir, { recursive: true });
    // Which files to fetch: the newest llama.cpp release for this computer, and the model's
    // 4-bit file. Both sources state each file's SHA-256, checked after the download.
    const release = await json(`https://api.github.com/repos/${ENGINE_REPO}/releases/${process.env.ROS_LOCAL_ENGINE_TAG ? `tags/${process.env.ROS_LOCAL_ENGINE_TAG}` : 'latest'}`, signal) as { tag_name: string; assets: { name: string; size: number; browser_download_url: string; digest?: string | null }[] };
    const asset = release.assets.find(item => pattern.test(item.name));
    if (!asset) throw new Error(`llama.cpp ${release.tag_name} has no build for this computer.`);
    const tree = await json(`https://huggingface.co/api/models/${MODEL_REPO}/tree/main`, signal) as { type: string; path: string; size: number; lfs?: { oid: string; size: number } }[];
    const ggufs = tree.filter(item => item.type === 'file' && item.path.endsWith('.gguf'));
    const chosen = ggufs.find(item => item.path === process.env.ROS_LOCAL_MODEL_FILE) ?? ggufs.find(item => /q4_k_m/iu.test(item.path)) ?? [...ggufs].sort((a, b) => (a.lfs?.size ?? a.size) - (b.lfs?.size ?? b.size))[0];
    if (!chosen) throw new Error(`${MODEL_REPO} has no GGUF file.`);
    const engine: Download = { url: asset.browser_download_url, file: join(this.dir, asset.name), bytes: asset.size, ...(asset.digest?.startsWith('sha256:') ? { sha256: asset.digest.slice(7) } : {}) };
    const model: Download = { url: `https://huggingface.co/${MODEL_REPO}/resolve/main/${chosen.path}`, file: join(this.dir, 'models', chosen.path.split('/').pop()!), bytes: chosen.lfs?.size ?? chosen.size, ...(chosen.lfs?.oid ? { sha256: chosen.lfs.oid } : {}) };
    this.job!.model = chosen.path.split('/').pop()!; this.job!.total = engine.bytes + model.bytes;
    const progress = (offset: number) => (done: number) => { if (this.job) this.job.done = offset + done; };
    await fetchFile(engine, signal, progress(0));
    await fetchFile(model, signal, progress(engine.bytes));

    const engineDir = join(this.dir, 'engine', release.tag_name);
    rmSync(engineDir, { recursive: true, force: true }); mkdirSync(engineDir, { recursive: true });
    if (engine.file.endsWith('.zip')) await run('unzip', ['-o', '-q', engine.file, '-d', engineDir]);
    else await run('tar', ['-xzf', engine.file, '-C', engineDir]);
    rmSync(engine.file, { force: true });
    const server = findFile(engineDir, 'llama-server');
    if (!server) throw new Error(`llama.cpp ${release.tag_name} came without llama-server.`);
    const prior = this.installed();
    this.save({ engineTag: release.tag_name, server, model: this.job!.model, modelFile: model.file, apiKey: prior?.apiKey ?? randomBytes(24).toString('hex'), ...(prior?.connectionId ? { connectionId: prior.connectionId } : {}) });
  }

  /** Starts the engine when the model is on disk (at launch, and after a download). */
  start(): Promise<void> {
    const installed = this.installed();
    if (!installed || this.child) return Promise.resolve();
    this.lastError = '';
    this.starting = this.launch(installed).catch(error => { this.lastError = error instanceof Error ? error.message : 'Ros could not start.'; this.stop(); }).finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async launch(installed: Installed) {
    const port = await freePort(PREFERRED_PORT);
    // Reasoning is off, as for hosted Nano: the agent loop needs answers within its output cap.
    const child = spawn(installed.server, ['-m', installed.modelFile, '--host', '127.0.0.1', '--port', String(port), '--api-key', installed.apiKey, '--jinja', '--reasoning-budget', '0', '-c', String(CONTEXT_TOKENS), '--alias', 'ros-local', '--no-webui'], { stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    let log = '';
    child.stderr?.on('data', (chunk: Buffer) => { log = (log + chunk.toString()).slice(-2000); });
    child.on('exit', code => { if (this.child === child) { this.child = undefined; if (code) this.lastError = `Ros stopped (llama.cpp exit ${code}). ${log.split('\n').filter(Boolean).slice(-1)[0] ?? ''}`.trim(); } });
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (this.child !== child) throw new Error(this.lastError || 'Ros stopped while loading.');
      const ok = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }).then(response => response.ok, () => false);
      if (ok) break;
      if (Date.now() > deadline) throw new Error('Ros took longer than two minutes to load.');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    this.register(installed, port);
  }
  /** One local connection, kept across starts; only its port can change. */
  private register(installed: Installed, port: number) {
    const existing = installed.connectionId && this.connections.statuses().find(item => item.id === installed.connectionId && !item.deleted);
    const fields = {
      name: 'Ros on this computer', endpoint: `http://127.0.0.1:${port}/v1`, apiKey: installed.apiKey, enabled: true,
      models: [{ id: 'ros-local', label: 'Ros', contextTokens: CONTEXT_TOKENS, inputUsdPerMillion: 0, outputUsdPerMillion: 0, maker: { id: 'nvidia' as const, label: 'NVIDIA Nemotron', monogram: 'N' } }],
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
  const response = await fetch(url, { signal, headers: { Accept: 'application/json', 'User-Agent': 'ros.ai' } });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}.`);
  return response.json();
}

/** Downloads into a .part file that a later attempt resumes, then checks size and SHA-256. */
async function fetchFile(item: Download, signal: AbortSignal, progress: (done: number) => void) {
  mkdirSync(join(item.file, '..'), { recursive: true });
  if (existsSync(item.file) && statSync(item.file).size === item.bytes) { progress(item.bytes); return; }
  const part = `${item.file}.part`, have = existsSync(part) ? statSync(part).size : 0;
  const response = await fetch(item.url, { signal, headers: { 'User-Agent': 'ros.ai', ...(have ? { Range: `bytes=${have}-` } : {}) } });
  if (!response.ok || !response.body) throw new Error(`The download from ${new URL(item.url).host} failed (${response.status}).`);
  let done = response.status === 206 ? have : 0;
  const out = createWriteStream(part, { flags: response.status === 206 ? 'a' : 'w' });
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      if (!out.write(chunk)) await new Promise<void>(resolve => out.once('drain', () => resolve()));
      done += chunk.byteLength; progress(done);
    }
  } finally { await new Promise<void>(resolve => out.end(() => resolve())); }
  if (statSync(part).size !== item.bytes) throw new Error('The download ended early. Start it again to resume.');
  if (item.sha256) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer);
    if (hash.digest('hex') !== item.sha256) { rmSync(part, { force: true }); throw new Error('The downloaded file did not match its published checksum, so it was deleted.'); }
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
