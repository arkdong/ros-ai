import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fit } from '../src/server/tool-loop-agent.js';
import type { ChatMessage } from '../src/server/providers.js';

const result = (chars: number, tail: string) => `${'x'.repeat(chars)}${tail}`;
const base = (): ChatMessage[] => [{ role: 'system', content: 'system' }, { role: 'user', content: 'question' }];
const size = (messages: ChatMessage[]) => Buffer.byteLength(JSON.stringify(messages), 'utf8');

test('an older tool result keeps its closing instruction when it is shortened', () => {
  const messages = [...base(), { role: 'assistant', content: 'searching', toolCalls: [] }, { role: 'tool', toolCallId: '1', content: result(12_000, '"instruction":"Then read the pages."}') }, { role: 'assistant', content: 'writing', toolCalls: [] }, { role: 'tool', toolCallId: '2', content: 'saved' }, { role: 'assistant', content: 'next', toolCalls: [] }, { role: 'tool', toolCallId: '3', content: 'saved' }];
  fit(messages, 8_000);
  assert.ok(size(messages) <= 8_000);
  assert.ok(messages[3].content.endsWith('"instruction":"Then read the pages."}'), 'the tail survives');
  assert.ok(messages[3].content.includes('[result shortened'));
  assert.equal(messages[5].content, 'saved');
});

test('the newest results shrink too when the request would still overflow', () => {
  const messages = [...base(), { role: 'assistant', content: 'reading', toolCalls: [] }, { role: 'tool', toolCallId: '1', content: result(12_000, ' END1') }, { role: 'tool', toolCallId: '2', content: result(12_000, ' END2') }, { role: 'tool', toolCallId: '3', content: result(12_000, ' END3') }];
  fit(messages, 20_000);
  assert.ok(size(messages) <= 20_000, `fits: ${size(messages)}`);
  for (const index of [3, 4, 5]) assert.ok(messages[index].content.endsWith(`END${index - 2}`));
  assert.equal(messages[0].content, 'system');
  assert.equal(messages[1].content, 'question');
});

test('nothing changes under the budget', () => {
  const messages = [...base(), { role: 'assistant', content: 'done', toolCalls: [] }, { role: 'tool', toolCallId: '1', content: result(3_000, ' END') }];
  const before = JSON.stringify(messages);
  fit(messages, 44_000);
  assert.equal(JSON.stringify(messages), before);
});
