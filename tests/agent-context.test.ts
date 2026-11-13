import test from 'node:test';
import assert from 'node:assert/strict';
import { READ_CHARACTERS, fitRead } from '../src/server/agent-tools.js';
import { latest } from '../src/server/tool-loop-agent.js';
import { SAME_PREFERENCES, freshSessionStep, preferencesKey } from '../src/server/agent-turn.js';

// What an agent carries from step to step and turn to turn: every step sends all of it again.

test('one read of many long blocks is cut to fit, each cut saying how long the text was; one block alone is whole', () => {
  const block = (n: number) => ({ id: `b${n}`, title: `Block ${n}`, text: 'x'.repeat(20_000), page: { content: 'y'.repeat(12_000) } });
  const many = fitRead({ blocks: Array.from({ length: 10 }, (_, n) => block(n)) }, READ_CHARACTERS);
  assert.ok(JSON.stringify(many).length <= READ_CHARACTERS, 'the read fits');
  for (const item of many.blocks) {
    assert.match(item.text, /^x+ … \[shortened from 20,000 characters to fit one read; name fewer blocks to read it whole\]$/u);
    assert.ok(item.text.length > 1_000, 'every block keeps a share');
  }
  const one = fitRead({ blocks: [block(1)] }, READ_CHARACTERS);
  assert.equal(one.blocks[0]!.text.length, 20_000);
  assert.equal(one.blocks[0]!.page.content.length, 12_000);
});

test('a conversation too long for a small model keeps its first line and its latest turns', () => {
  const conversation = `Earlier in this conversation (written out by ros.ai):\n\n${Array.from({ length: 40 }, (_, n) => `Researcher: question ${n}\nAnswer: ${'answer '.repeat(30)}${n}`).join('\n\n')}`;
  assert.equal(latest(conversation, 100_000), conversation);
  const kept = latest(conversation, 2_000)!;
  assert.ok(Buffer.byteLength(kept) <= 2_000);
  assert.ok(kept.startsWith('Earlier in this conversation (written out by ros.ai):\n[…earlier turns left out]\n'));
  assert.ok(kept.endsWith('39'), 'the latest turn is kept');
  assert.ok(!kept.includes('question 0\n'));
});

test('a session that holds the same preferences is told they still apply; a new session step says why it is new', () => {
  assert.equal(preferencesKey(undefined), undefined);
  assert.equal(preferencesKey('- Write in British English'), preferencesKey('- Write in British English'));
  assert.notEqual(preferencesKey('- Write in British English'), preferencesKey('- Write in American English'));
  assert.match(SAME_PREFERENCES, /still apply unchanged/u);
  assert.match(freshSessionStep('Codex', 'long', 72_400), /^This thread’s Codex session reached about 72k tokens, so it starts a new one/u);
  assert.match(freshSessionStep('Gemini CLI', 'idle'), /^More than an hour has passed, so Gemini CLI starts a new session/u);
});
