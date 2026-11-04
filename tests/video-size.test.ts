import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoInfo } from '../src/server/video-size.js';
import { movie } from './video-fixture.js';

const reader = (bytes: Buffer) => (position: number, length: number) => bytes.subarray(position, position + length);

test('A video\'s size and length come from its header, wherever it sits, turned upright when the file asks', () => {
  const end = movie({ width: 1920, height: 1080, seconds: 42.5, moovFirst: false, mdat: 300_000 });
  assert.deepEqual(videoInfo(reader(end), end.length), { width: 1920, height: 1080, seconds: 42.5 });
  const front = movie({ width: 640, height: 480, seconds: 3, moovFirst: true });
  assert.deepEqual(videoInfo(reader(front), front.length), { width: 640, height: 480, seconds: 3 });
  // A phone recording kept on its side with a 90° turn in its matrix shows upright, so taller than wide.
  const phone = movie({ width: 1920, height: 1080, seconds: 9, rotate: true, version1: true });
  assert.deepEqual(videoInfo(reader(phone), phone.length), { width: 1080, height: 1920, seconds: 9 });
  // Only box headers are read on the way to the header: never the video itself.
  const reads: [number, number][] = [];
  videoInfo((position, length) => { reads.push([position, length]); return end.subarray(position, position + length); }, end.length);
  assert(reads.every(([, length]) => length < 10_000), 'the video data is skipped');
  assert.equal(videoInfo(reader(Buffer.from('not a movie at all')), 18), undefined);
});
