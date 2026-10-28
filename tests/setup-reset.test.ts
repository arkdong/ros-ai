import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Setup } from '../src/server/setup.js';

/** Reset onboarding undoes only what the person ticked, says what it could not undo, and shows the first run again.
 * Nothing on this computer is read: detection is off, and every dependency is a double. */
test('reset onboarding undoes the chosen parts and forgets that the first run was seen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-setup-reset-'));
  const saved = process.env.ROS_NO_DETECT;
  process.env.ROS_NO_DETECT = '1';
  const calls: string[] = [];
  let signedIn = true, downloaded = true;
  const deps = {
    dataDir: dir,
    outside: { bridge: 'bridge', seen: () => null },
    inference: { statuses: () => [] },
    credentials: { statuses: () => [] },
    plugins: { statuses: () => [], saved: () => ['slack', 'notion'], disconnect: (id: string) => { if (id === 'notion') throw new Error('This token comes from NOTION_TOKEN in your environment.'); calls.push(`token:${id}`); } },
    cloud: { status: async () => ({ available: true, state: signedIn ? 'signed-in' : 'signed-out' }), get signedIn() { return signedIn; }, signOut: async () => { signedIn = false; calls.push('cloud'); } },
    localRos: { status: () => ({ supported: true, state: downloaded ? 'ready' : 'not-downloaded' }), remove: () => { downloaded = false; calls.push('local'); } },
  };
  try {
    const setup = new Setup(deps as unknown as ConstructorParameters<typeof Setup>[0]);
    setup.seen(true);
    assert.equal(typeof (await setup.status()).seenAt, 'string');
    assert.deepEqual(setup.resetPlan(), { links: [], tokens: ['Slack', 'Notion'], cloud: true, localRos: true });

    // Only the ticked options run; the token the environment holds cannot be forgotten, and the reset says so.
    const answer = await setup.reset({ tokens: true, localRos: true });
    assert.deepEqual(calls, ['token:slack', 'local']);
    assert.deepEqual(answer.done, ['Forgot the Slack token.', 'Removed the Ros download.']);
    assert.deepEqual(answer.failed, ['This token comes from NOTION_TOKEN in your environment.']);
    assert.equal(signedIn, true, 'the sign-in stays when its box is not ticked');
    assert.equal((await setup.status()).seenAt, null, 'the first run shows again');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'setup.json'), 'utf8')), { seenAt: null });

    const again = await setup.reset({ cloud: true });
    assert.deepEqual(again, { done: ['Signed out of hosted Ros.'], failed: [] });
    assert.deepEqual(setup.resetPlan(), { links: [], tokens: ['Slack', 'Notion'], cloud: false, localRos: false });
    await assert.rejects(setup.reset({ apps: true }), 'unknown options are refused');
  } finally {
    if (saved === undefined) delete process.env.ROS_NO_DETECT; else process.env.ROS_NO_DETECT = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
