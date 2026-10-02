import test from 'node:test';
import assert from 'node:assert/strict';
import { resultPage, changeResultPageSize } from '../src/shared/result-pages.js';
test('compact result pages preserve every artifact in order and default to two', () => {
  const items = Array.from({ length: 11 }, (_, id) => ({ id }));
  assert.deepEqual(resultPage(items, null).items, items.slice(0, 2));
  const seen = Array.from({ length: 6 }, (_, page) => resultPage(items, { size: 2, page }).items).flat();
  assert.deepEqual(seen, items);
  assert.deepEqual(resultPage(items, { size: 'all', page: 9 }).items, items);
  assert.equal(resultPage(items, { size: 'all', page: 9 }).pageCount, 1);
});
test('density switches and changing result sets cannot strand a page', () => {
  const items = Array.from({ length: 11 }, (_, id) => id);
  const choice = changeResultPageSize(11, { size: 2, page: 4 }, 4);
  assert.deepEqual(resultPage(items, choice).items, [8, 9, 10]);
  assert.equal(resultPage(items.slice(0, 3), choice).page, 0);
  assert.deepEqual(resultPage([], choice).items, []);
  assert.equal(resultPage(items, { size: 4, page: -9 }).page, 0);
  assert.equal(resultPage(items, { size: 99, page: Infinity }).size, 2);
  assert.deepEqual(resultPage(items, JSON.parse(JSON.stringify(choice))).items, [8, 9, 10]);
});
