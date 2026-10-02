import test from 'node:test';
import assert from 'node:assert/strict';
import { notePreview, textPreview } from '../src/shared/presentation.js';

test('note previews leave original research text intact', () => {
  const note = { title: 'A detailed question about rainfall, seasons and weekday travel across Amsterdam', description: 'Observed evidence.\n\n' + 'A limitation that must remain in the original. '.repeat(8) };
  const original = structuredClone(note);
  const preview = notePreview(note);
  assert.deepEqual(note, original);
  assert.equal(preview.titleTruncated, true);
  assert.equal(preview.descriptionTruncated, true);
  assert(preview.title.endsWith('…'));
  assert(Array.from(preview.description).length <= 140);
  assert.equal(note.description.includes('\n\n'), true);
});

test('preview clips only supplied text and preserves Unicode characters', () => {
  assert.deepEqual(textPreview('  Rainfall\n\tand cycling  ', 40), { text: 'Rainfall and cycling', truncated: false });
  assert.deepEqual(textPreview('🧪🧪🧪🧪🧪🧪', 4), { text: '🧪🧪🧪…', truncated: true });
  assert.deepEqual(textPreview('A short title', 13), { text: 'A short title', truncated: false });
  assert.equal(textPreview('A long original question with additional evidence', 24).text, 'A long original…');
  assert.throws(() => textPreview('question', 1), RangeError);
});
