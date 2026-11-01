import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricViews } from '../src/server/metric-view.js';

const SITE = '11111111-2222-4333-8444-555555555555';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const views = (channels: boolean) => new MetricViews(undefined, { umamiKey: () => 'key', fetch: (async (input: string | URL) => {
  const url = String(input);
  if (url.endsWith(`/websites/${SITE}`)) return json({ name: 'ros.ai', domain: 'ros-ai.io' });
  if (url.includes('/stats?')) return json({ visitors: 80, pageviews: 300, visits: 99 });
  if (url.endsWith('/active')) return json({ visitors: 2 });
  if (url.includes('type=event')) return json([{ x: 'download', y: 7 }]);
  if (url.includes('type=referrer')) return json([{ x: 'news.ycombinator.com', y: 4 }, { x: null, y: 30 }, { x: 'linkedin.com', y: 9 }]);
  if (url.includes('type=channel')) return channels ? json([{ x: 'organicSocial', y: 12 }, { x: 'direct', y: 30 }]) : json({ error: 'unknown type' }, 400);
  return json({}, 404);
}) as typeof fetch });

test('An Umami block says where visitors came from: the kind of source and the top sites, largest first', async () => {
  const read = await views(true).read({ source: 'umami', website: SITE });
  const shown = read.values.filter(item => item.key.startsWith('channel:') || item.key.startsWith('referrer:')).map(item => [item.key, item.label, item.value]);
  assert.deepEqual(shown, [
    ['channel:direct', 'Direct visits, 7 days', 30], ['channel:organicSocial', 'Visits from social media, 7 days', 12],
    ['referrer:no site (direct)', 'From no site (direct), 7 days', 30], ['referrer:linkedin.com', 'From linkedin.com, 7 days', 9], ['referrer:news.ycombinator.com', 'From news.ycombinator.com, 7 days', 4],
  ]);
  const older = await views(false).read({ source: 'umami', website: SITE });
  assert(!older.values.some(item => item.key.startsWith('channel:')), 'an Umami without channels leaves them out');
  assert(older.values.some(item => item.key === 'referrer:linkedin.com'));
});
