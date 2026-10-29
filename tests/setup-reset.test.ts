import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Setup } from '../src/server/setup.js';

/** Reset all connections undoes only what the person ticked, says what it could not undo, and shows the first run again.
 * Nothing on this computer is read: detection is off, and every dependency is a double. */
test('reset all connections undoes the chosen parts and forgets that the first run was seen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-setup-reset-'));
  const saved = { detect: process.env.ROS_NO_DETECT, ollama: process.env.OLLAMA_HOST };
  process.env.ROS_NO_DETECT = '1';
  process.env.OLLAMA_HOST = '127.0.0.1:11434';
  const calls: string[] = [];
  let signedIn = true, downloaded = true, drive = true;
  let apps = [{ id: 'notion', name: 'Notion', connected: true }, { id: 'github', name: 'GitHub', connected: true }, { id: 'linear', name: 'Linear', connected: false }];
  let models = [{ id: 'm1', name: 'Ollama', endpointOrigin: 'http://127.0.0.1:11434', deleted: false }, { id: 'm2', name: 'Nebius', endpointOrigin: 'https://api.studio.nebius.com', deleted: false }];
  const deps = {
    dataDir: dir,
    outside: { bridge: 'bridge', seen: () => null },
    inference: { statuses: () => models, remove: (id: string) => { models = models.filter(item => item.id !== id); calls.push(`model:${id}`); } },
    credentials: { statuses: () => [] },
    plugins: { statuses: () => [], saved: () => ['slack', 'notion'], disconnect: (id: string) => { if (id === 'notion') throw new Error('This token comes from NOTION_TOKEN in your environment.'); calls.push(`token:${id}`); } },
    cloud: { status: async () => ({ available: true, state: signedIn ? 'signed-in' : 'signed-out' }), get signedIn() { return signedIn; }, signOut: async () => { signedIn = false; calls.push('cloud'); } },
    localRos: { status: () => ({ supported: true, state: downloaded ? 'ready' : 'not-downloaded' }), remove: () => { downloaded = false; calls.push('local'); } },
    // GitHub reads its Plugins token, so it goes with the tokens, not with the sign-ins.
    apps: { statuses: () => apps, disconnect: (id: string) => { apps = apps.map(app => app.id === id ? { ...app, connected: false } : app); calls.push(`app:${id}`); } },
    googleDrive: { status: () => ({ connected: drive }), disconnect: () => { drive = false; calls.push('drive'); } },
  };
  try {
    const setup = new Setup(deps as unknown as ConstructorParameters<typeof Setup>[0]);
    setup.seen(true);
    assert.equal(typeof (await setup.status()).seenAt, 'string');
    assert.deepEqual(await setup.resetPlan(), { links: [], tokens: ['Slack', 'Notion'], apps: ['Notion', 'Google Drive'], models: ['Ollama'], cloud: true, localRos: true });

    // Only the ticked options run; the token the environment holds cannot be forgotten, and the reset says so.
    const answer = await setup.reset({ tokens: true, localRos: true });
    assert.deepEqual(calls, ['token:slack', 'local']);
    assert.deepEqual(answer.done, ['Forgot the Slack token.', 'Removed the ROS download.']);
    assert.deepEqual(answer.failed, ['This token comes from NOTION_TOKEN in your environment.']);
    assert.equal(signedIn, true, 'the sign-in stays when its box is not ticked');
    assert.equal((await setup.status()).seenAt, null, 'the first run shows again');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'setup.json'), 'utf8')), { seenAt: null });

    const again = await setup.reset({ cloud: true, apps: true, models: true });
    assert.deepEqual(again, { done: ['Disconnected Notion.', 'Disconnected Google Drive.', 'Removed the Ollama connection.', 'Signed out of hosted ROS.'], failed: [] });
    assert.deepEqual(calls.slice(2), ['app:notion', 'drive', 'model:m1', 'cloud'], 'the Nebius connection is not a model server here, so it stays');
    assert.deepEqual(await setup.resetPlan(), { links: [], tokens: ['Slack', 'Notion'], apps: [], models: [], cloud: false, localRos: false });
    await assert.rejects(setup.reset({ everything: true }), 'unknown options are refused');
  } finally {
    for (const [key, value] of [['ROS_NO_DETECT', saved.detect], ['OLLAMA_HOST', saved.ollama]] as const) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  }
});
