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
