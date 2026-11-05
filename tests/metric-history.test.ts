import test from 'node:test';
import assert from 'node:assert/strict';
import { addPoint } from '../src/server/metric-view.js';
import type { MetricPoint } from '../src/shared/types.js';

test('A Metrics block keeps one point per clock hour, so reads every 15 minutes build a history', () => {
  let history: MetricPoint[] = [];
  const start = Date.parse('2026-11-03T08:05:00Z');
  for (let read = 0; read <= 120; read++) {
    const fetchedAt = new Date(start + read * 15 * 60_000).toISOString();
    history = addPoint(history, { source: 'github', title: 'ros-ai', link: 'https://github.com/arkdong/ros-ai', values: [{ key: 'stars', label: 'Stars', value: read }], fetchedAt });
  }
  // 121 reads over 30 hours: a point for each of the 31 clock hours they fall in, holding that hour's last read.
  assert.equal(history.length, 31);
  assert.deepEqual(history.slice(0, 2).map(point => [point.at, point.values.stars]), [['2026-11-03T08:50:00.000Z', 3], ['2026-11-03T09:50:00.000Z', 7]]);
  assert.deepEqual(history.at(-1), { at: '2026-11-04T14:05:00.000Z', values: { stars: 120 } });
});
