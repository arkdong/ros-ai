import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricViews, metricViewKey } from '../src/server/metric-view.js';
import { metricViewSchema } from '../src/server/store.js';

const stats = { users: 40, signups_week: 6, funnel_workspace: 30, funnel_source: 22, funnel_report: 9, researchers_week: 14, retention_week4: null, workspaces_week: 11 };
const views = () => new MetricViews(undefined, { cloud: { url: 'https://cloud.example', stats: async () => stats } });

test('A ros.ai cloud block narrowed by its Show chip reads only that area, in its order, and keeps its own place', async () => {
  const activation = await views().read({ source: 'cloud', show: 'activation' });
  assert.equal(activation.title, 'ros.ai cloud · Activation');
  assert.deepEqual(activation.values.map(item => [item.key, item.value]), [['users', 40], ['funnel_workspace', 30], ['funnel_source', 22], ['funnel_report', 9]]);
  const retention = await views().read({ source: 'cloud', show: 'retention' });
  assert.deepEqual(retention.values.map(item => item.key), ['retention_week1', 'retention_week4']);
  assert.match(retention.values[1].note ?? '', /28 to 34 days/u);
  const all = await views().read({ source: 'cloud' });
  assert(all.values.length > 15);
  assert.equal(metricViewKey({ source: 'cloud' }), 'cloud');
  assert.notEqual(metricViewKey({ source: 'cloud', show: 'usage' }), metricViewKey({ source: 'cloud', show: 'activation' }));
  assert.deepEqual(await views().find({ source: 'cloud', show: 'usage' }), { source: 'cloud', show: 'usage' });
  assert.throws(() => metricViewSchema.parse({ source: 'cloud', show: 'revenue' }));
});

test('Acquisition lists where new accounts heard about ros.ai, most first, and how many skipped', async () => {
  const withSources = { ...stats, signup_sources: { sources: [{ key: 'friend', label: 'A friend or colleague', count: 4 }, { key: 'github', label: 'GitHub', count: 2 }], skipped: 3, unanswered: 10 } };
  const read = await new MetricViews(undefined, { cloud: { url: 'https://cloud.example', stats: async () => withSources } }).read({ source: 'cloud', show: 'acquisition' });
  assert.deepEqual(read.values.slice(-3).map(item => [item.key, item.label, item.value]), [
    ['heard:friend', 'Heard from a friend or colleague', 4], ['heard:github', 'Heard from GitHub', 2], ['heard:skipped', 'Skipped the question', 3]]);
  const none = await new MetricViews(undefined, { cloud: { url: 'https://cloud.example', stats: async () => ({ ...stats, signup_sources: { sources: [], skipped: 0, unanswered: 1 } }) } }).read({ source: 'cloud', show: 'acquisition' });
  assert.match(none.values.find(item => item.key === 'heard')?.note ?? '', /No new account/u);
  const old = await views().read({ source: 'cloud', show: 'acquisition' });
  assert(!old.values.some(item => item.key.startsWith('heard')));
});

test('ros.ai cloud spend a day fills the block history at once, with quiet days as zero, and the block\'s own reads win', async () => {
  const { costDays, addPast } = await import('../src/server/metric-view.js');
  const now = new Date('2026-11-02T11:00:00Z');
  const days = costDays([{ day: '2026-10-29', cost: 1.5, requests: 30 }, { day: '2026-10-31', cost: 0.25, requests: 5 }, { day: '2026-11-02', cost: 9, requests: 9 }], now);
  assert.deepEqual(days.map(point => [point.at.slice(0, 10), point.values.cost_today]), [['2026-10-29', 1.5], ['2026-10-30', 0], ['2026-10-31', 0.25], ['2026-11-01', 0]]);
  const own = [{ at: '2026-11-01T20:00:00.000Z', values: { cost_today: 3, users: 4 } }];
  const merged = addPast(own, days);
  // 1 November: the block's own read keeps its cost; the cloud adds only the requests that read did not have.
  assert.deepEqual(merged.filter(point => point.at.startsWith('2026-11-01')).map(point => point.values), [{ cost_today: 3, users: 4 }, { requests_today: 0 }]);
  assert.deepEqual(merged.map(point => point.at.slice(0, 10)), ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-01']);
  const read = await new MetricViews(undefined, { cloud: { url: 'https://cloud.example', stats: async () => ({ ...stats, cost_today: 0.5, cost_month: 4, cost_days: [{ day: '2020-01-01', cost: 1, requests: 2 }] }) } }).read({ source: 'cloud', show: 'costs' });
  assert.deepEqual(read.values.map(item => item.key), ['cost_today', 'cost_week', 'cost_month', 'requests_today', 'requests_week']);
  assert(read.history.length >= 2 && !('past' in read));
});
