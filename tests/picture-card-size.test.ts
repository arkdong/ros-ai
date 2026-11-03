import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARD_MIN_WIDTH, PICTURE_MIN_HEIGHT, PICTURE_MIN_WIDTH, cardWidth, pictureCardHeight, pictureMinWidth } from '../src/shared/card-size';

const banner = { width: 3168, height: 792 }; // a 4:1 LinkedIn banner

test('a small wide picture card is exactly as tall as its picture, with no strip below it', () => {
  for (const width of [320, 260, 200]) assert.equal(pictureCardHeight(width, banner), Math.round((width - 2) / 4) + 2);
});

test('a picture card can be narrower than a text card, down to a picture still PICTURE_MIN_HEIGHT tall', () => {
  const picture = { kind: 'topic', blockType: 'file', file: { path: 'files/banner.png' } };
  assert.equal(cardWidth({ ...picture, width: 200 }), 200);
  assert.equal(cardWidth({ kind: 'topic', blockType: 'file', file: { path: 'files/paper.pdf' }, width: 200 }), CARD_MIN_WIDTH);
  assert.equal(cardWidth({ ...picture, width: 10 }), PICTURE_MIN_WIDTH);
  const narrowest = pictureMinWidth(banner);
  assert.ok(pictureCardHeight(narrowest, banner) >= PICTURE_MIN_HEIGHT);
  assert.equal(pictureMinWidth({ width: 600, height: 800 }), PICTURE_MIN_WIDTH);
});
