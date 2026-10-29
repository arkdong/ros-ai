import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRos } from '../src/server/local-ros.js';
import type { LocalRosStatus } from '../src/shared/local-ros.js';

/** A stand-in llama-server: answers /health on the port it is given, the way llama.cpp's does once the model is loaded. */
const SERVER = `#!/usr/bin/env node
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
require('node:http').createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404); res.end('{}'); }).listen(port, '127.0.0.1');
`;

/** An engine archive the way llama.cpp packs one: every program in a llama-<tag> folder. */
function engineArchive(dir: string, tag: string) {
  const root = join(dir, 'pack'), folder = join(root, `llama-${tag}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'llama-server'), SERVER);
  chmodSync(join(folder, 'llama-server'), 0o755);
  const file = join(dir, `llama-${tag}-bin-ubuntu-x64.tar.gz`);
  execFileSync('tar', ['-czf', file, '-C', root, `llama-${tag}`]);
  return readFileSync(file);
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const until = async (check: () => boolean, what: string) => {
  for (let tries = 0; tries < 200; tries++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail(`timed out waiting for ${what}`);
};

/** The download follows llama.cpp's stable release to the build that holds its programs, carries on through a dropped
 * connection, checks both files, starts the engine and registers it as a local model. Nothing leaves this computer:
 * GitHub and Hugging Face are stand-ins and the engine is a small Node script. */
test('ROS on this computer downloads through a dropped connection, then starts and registers itself', { skip: process.platform !== 'linux' || process.arch !== 'x64' ? 'needs the Linux x64 build name' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-local-'));
  const env = { tag: process.env.ROS_LOCAL_ENGINE_TAG, repo: process.env.ROS_LOCAL_MODEL_REPO };
  process.env.ROS_LOCAL_ENGINE_TAG = 'latest';
  const engine = engineArchive(dir, 'b42'), model = Buffer.alloc(300_000, 7);
  const asset = { name: 'llama-b42-bin-ubuntu-x64.tar.gz', size: engine.length, browser_download_url: 'https://github.test/b42/engine.tar.gz', digest: `sha256:${sha(engine)}` };
  const seen: string[] = [];
  let dropped = false;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('http://127.0.0.1')) return real(input, init);
    const range = new Headers(init?.headers).get('Range');
    seen.push(range ? `${url} ${range}` : url);
    if (url.endsWith('/releases/latest')) return Response.json({ tag_name: 'v9.9.9', assets: [{ name: 'nightly-tag.txt', size: 4, browser_download_url: 'https://github.test/v9.9.9/nightly-tag.txt' }] });
    if (url.endsWith('nightly-tag.txt')) return new Response('b42\n');
    if (url.endsWith('/releases/tags/b42')) return Response.json({ tag_name: 'b42', assets: [asset] });
    if (url === asset.browser_download_url) return new Response(engine);
    if (url.includes('/api/models/')) return Response.json([{ type: 'file', path: 'ros-q4_k_m.gguf', size: 140, lfs: { oid: sha(model), size: model.length } }, { type: 'file', path: 'README.md', size: 10 }]);
    if (url.includes('/resolve/main/ros-q4_k_m.gguf')) {
      const from = range ? Number(/bytes=(\d+)-/u.exec(range)![1]) : 0;
      if (!dropped) {
        // The first answer breaks off half way, as a dropped connection does; the next asks for the rest.
        dropped = true;
        const half = model.subarray(0, 120_000);
        let sent = false;
        const body = new ReadableStream({ pull(controller) { if (sent) controller.error(new TypeError('fetch failed')); else { sent = true; controller.enqueue(new Uint8Array(half)); } } });
        return new Response(body, { status: 200 });
      }
      return new Response(model.subarray(from), { status: from ? 206 : 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const created: { endpoint: string; name: string }[] = [];
  const connections = {
    statuses: () => [],
    create: (fields: { endpoint: string; name: string }) => { created.push(fields); return { id: 'local-1' }; },
    update: () => { throw new Error('nothing to update'); },
    status: () => ({ usedRequests: 0, usdCeiling: 0 }),
    saveAllowance: () => undefined,
    remove: () => undefined,
  };
  const local = new LocalRos(dir, connections as unknown as ConstructorParameters<typeof LocalRos>[1], [0.05, 0.05]);
  try {
    let status: LocalRosStatus = local.download();
    assert.equal(status.state, 'downloading');
    assert.ok(existsSync(join(dir, 'local-ros', 'wanted')), 'the wish to have ROS outlives a restart until the files are in');
    await until(() => local.status().state === 'ready', 'ROS to be ready');
    status = local.status();
    assert.equal(status.model, 'ros-q4_k_m.gguf');
    assert.equal(status.totalBytes, model.length);
    assert.equal(created.length, 1);
    assert.match(created[0]!.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
    assert.ok(seen.some(line => line.includes('/resolve/main/ros-q4_k_m.gguf bytes=120000-')), 'the second try resumed where the first stopped');
    assert.ok(!existsSync(join(dir, 'local-ros', 'wanted')), 'nothing left to resume once ROS is on disk');
    const installed = JSON.parse(readFileSync(join(dir, 'local-ros', 'installed.json'), 'utf8')) as { engineTag: string; server: string };
    assert.equal(installed.engineTag, 'b42', 'the stable release led to the build that holds the programs');
    assert.ok(installed.server.endsWith(join('llama-b42', 'llama-server')));
  } finally {
    local.shutdown();
    globalThis.fetch = real;
    if (env.tag === undefined) delete process.env.ROS_LOCAL_ENGINE_TAG; else process.env.ROS_LOCAL_ENGINE_TAG = env.tag;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a download the person started picks up again when ros.ai starts, and stops for good when cancelled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-local-'));
  const real = globalThis.fetch;
  let lookups = 0;
  // Hugging Face never answers here, so each download waits at its first step until it is cancelled.
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => { lookups++; return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')))); }) as typeof fetch;
  const connections = { statuses: () => [] };
  try {
    mkdirSync(join(dir, 'local-ros'), { recursive: true });
    writeFileSync(join(dir, 'local-ros', 'wanted'), new Date().toISOString());
    const local = new LocalRos(dir, connections as unknown as ConstructorParameters<typeof LocalRos>[1], [0.05]);
    const supported = local.status().supported;
    await local.resume();
    if (!supported) { assert.equal(local.status().state, 'not-downloaded'); return; }
    assert.equal(local.status().state, 'downloading', 'the download the person started before a restart carries on');
    await until(() => lookups > 0, 'the download to ask for its files');
    assert.equal(local.cancel().state, 'not-downloaded');
    assert.ok(!existsSync(join(dir, 'local-ros', 'wanted')), 'a cancelled download does not come back at the next start');
    const later = new LocalRos(dir, connections as unknown as ConstructorParameters<typeof LocalRos>[1]);
    await later.resume();
    assert.equal(later.status().state, 'not-downloaded');
  } finally {
    globalThis.fetch = real;
    rmSync(dir, { recursive: true, force: true });
  }
});
