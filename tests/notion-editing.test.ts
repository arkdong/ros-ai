import test from 'node:test';
import assert from 'node:assert/strict';
import { lineMarkdown, parseLine } from '../src/shared/notion-inline.js';
import { NotionViews } from '../src/server/notion-view.js';
import type { RemoteApps } from '../src/server/remote-apps.js';

const roundTrip = (source: string) => lineMarkdown(parseLine(source));

test('a line of Notion text reads as a block kind and formatted runs, and writes back unchanged', () => {
  assert.deepEqual(parseLine('**Strong points**').runs, [{ text: 'Strong points', marks: ['b'] }]);
  assert.equal(parseLine('## Applicant').kind, 'h2');
  assert.deepEqual([parseLine('- [x] Check references').kind, parseLine('- [x] Check references').checked], ['todo', true]);
  for (const source of ['**Strong points**', 'Score in the *"**Initial score**"* field', '## Applicant', '- [ ] Check references', '1. First {color="blue"}',
    'see <mention-page url="https://x">Title</mention-page> and [a **b**](https://a.b)', 'by <mention-user url="user://abc"/> today', '<span color="red">red *it*</span> after', 'a\\*b and `co*de`'])
    assert.equal(roundTrip(source), source);
});

test('marks that cross keep their order and words that look like block marks are escaped', () => {
  assert.equal(roundTrip('*"**Initial score"*'), '*"**Initial score"***');
  assert.equal(lineMarkdown({ kind: 'p', checked: false, indent: '', tail: '', runs: [{ text: '- not a list', marks: [] }] }), '\\- not a list');
  assert.equal(lineMarkdown({ kind: 'p', checked: false, indent: '', tail: '', runs: [{ text: 'bold ', marks: ['b'] }, { text: 'word', marks: [] }] }), '**bold** word');
});

test('one save sends the text, the added text and the fields to Notion, then reads the page again', async () => {
  const url = 'https://www.notion.so/Megan-Li-3f0122069fec813999fbe0bd1235f178';
  let content = '## Evidence\n**Strong points**\npending', score = 3;
  const calls: { name: string; args: Record<string, any> }[] = [];
  const apps = {
    connected: () => ['notion'],
    async call(_id: string, name: string, args: Record<string, any>) {
      calls.push({ name, args });
      if (name === 'notion-update-page' && args.command === 'update_content') for (const change of args.content_updates) content = content.replace(change.old_str, change.new_str);
      if (name === 'notion-update-page' && args.command === 'insert_content') content += `\n${args.content}`;
      if (name === 'notion-update-page' && args.command === 'update_properties') score = args.properties['Initial score'];
      const text = `<page url="${url}">\n<properties>\n${JSON.stringify({ Name: 'Megan Li', 'Initial score': score })}\n</properties>\n<sqlite-table>CREATE TABLE IF NOT EXISTS "collection://a" (\n"Name" TEXT, -- title\n"Initial score" FLOAT\n)</sqlite-table>\n<content>\n${content}\n</content>\n</page>`;
      return { text: JSON.stringify({ metadata: { type: 'page' }, title: 'Megan Li', url, text }), isError: false };
    },
  } as unknown as RemoteApps;
  const views = new NotionViews(apps);
  await views.read({ url, kind: 'page' });
  const page = await views.save({ url, kind: 'page' }, { text: [{ old: 'pending', new: '' }, { old: '**Strong points**', new: '**Strong points and more**\n- first new bullet' }], append: 'Call her on *Friday*', properties: [{ name: 'Initial score', value: '4' }] });
  const updates = calls.filter(call => call.name === 'notion-update-page').map(call => call.args.command);
  assert.deepEqual(updates, ['update_content', 'insert_content', 'update_properties']);
  assert.equal(page.properties.find(property => property.name === 'Initial score')?.value, '4');
  assert.deepEqual(page.units.map(unit => unit.source), ['## Evidence', '**Strong points and more**', '- first new bullet', 'Call her on *Friday*']);
  await assert.rejects(views.save({ url, kind: 'page' }, { text: [{ old: 'gone', new: 'x' }] }), /changed in Notion/u);
});
