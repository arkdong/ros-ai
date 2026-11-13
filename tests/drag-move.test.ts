import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampOffset } from '../src/client/drag-move';

const area = { left: 0, top: 0, right: 1000, bottom: 700 };
const home = { left: 400, top: 20, right: 800, bottom: 620 };

test('a moved window keeps its place when it fits', () => {
  assert.deepEqual(clampOffset({ x: -300, y: 40 }, home, area, 56), { x: -300, y: 40 });
});

test('a window cannot leave the area: its header and half its width stay in view', () => {
  // Far right: the left half stays in.
  assert.deepEqual(clampOffset({ x: 5000, y: 0 }, home, area, 56), { x: 1000 - 400 - 200, y: 0 });
  // Far left: the right half stays in.
  assert.deepEqual(clampOffset({ x: -5000, y: 0 }, home, area, 56), { x: -400 - 200, y: 0 });
  // Not above the top, and the header stays above the bottom.
  assert.deepEqual(clampOffset({ x: 0, y: -500 }, home, area, 56), { x: 0, y: -20 });
  assert.deepEqual(clampOffset({ x: 0, y: 5000 }, home, area, 56), { x: 0, y: 700 - 20 - 56 });
});

test('a saved place from a larger window comes back inside a smaller one', () => {
  const small = { left: 0, top: 0, right: 700, bottom: 500 };
  const sheet = { left: 50, top: 16, right: 650, bottom: 400 };
  assert.deepEqual(clampOffset({ x: 900, y: 900 }, sheet, small, 56), { x: 700 - 50 - 300, y: 500 - 16 - 56 });
});
