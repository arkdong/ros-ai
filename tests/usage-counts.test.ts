import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import type { CloudAccount } from '../src/server/cloud-account.js';
import { UsageCounts } from '../src/server/usage-counts.js';

const today = () => new Date().toISOString().slice(0, 10);
const node = (id: string, blockType?: string) => ({ type: 'addNode', node: { id, title: id, description: '', kind: 'topic', ...(blockType ? { blockType } : {}), x: 0, y: 0 } }) as never;

test('The store counts projects, sources, reports and messages to agents per UTC day, and not blocks restored from a project folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-usage-')), store = new Store(join(dir, 'store'));
  try {
    const project = store.createProject('Counts');
    store.mutate(project.id, [node('d', 'dataset'), node('r', 'report'), node('n')], 'Add');
    store.mutate(project.id, [node('d2', 'dataset')], 'Posts from the project folder');
    store.addMessage(project.id, null, 'user', 'Find papers on four-day weeks');
    store.addMessage(project.id, null, 'assistant', 'Here they are');
    assert.deepEqual(store.usageDays(), [{ day: today(), counts: { workspaces: 1, sources: 1, reports: 1, conversations: 1 } }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Usage counts go to ros.ai cloud only while on and signed in, numbers only, repeating the last day sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-usage-')), store = new Store(join(dir, 'store'));
  const sent: { days: { day: string; counts: Record<string, number> }[]; version?: string }[] = [];
  const cloud = { available: true, signedIn: true, sendUsage: async (body: typeof sent[number]) => { sent.push(body); return true; } };
  try {
    const counts = new UsageCounts(store, cloud as unknown as CloudAccount, '0.1.5');
    store.saveGlobalRecord('usage-counts', '2020-01-01', { sources: 9 });
    store.saveGlobalRecord('usage-counts', new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10), { workspaces: 0 });
    store.createProject('One');
    assert.equal(counts.status().on, true);
    await counts.send();
    assert.deepEqual(sent, [{ days: [{ day: today(), counts: { workspaces: 1 } }], version: '0.1.5' }]);
    assert(counts.status().sentAt);
    store.createProject('Two');
    await counts.send();
    assert.deepEqual(sent[1].days, [{ day: today(), counts: { workspaces: 2 } }]);
    counts.setOn(false);
    store.createProject('Three');
    await counts.send();
    assert.equal(sent.length, 2);
    assert.equal(counts.status().on, false);
    cloud.signedIn = false;
    counts.setOn(true);
    await counts.send();
    assert.equal(sent.length, 2);
    assert.deepEqual(counts.status().today, { workspaces: 3 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
