import test from 'node:test';
import assert from 'node:assert/strict';
import { lineMarkdown, parseLine } from '../src/shared/notion-inline.js';
import { NotionViews } from '../src/server/notion-view.js';
import type { RemoteApps } from '../src/server/remote-apps.js';
import type { NotionPage } from '../src/shared/types.js';

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
    accountsOf: () => [],
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

test('a saved line keeps the escapes Notion needs, so underscores, dollars and emoji names stay text', () => {
  const runs = [{ text: 'Run __init__.py for $5 :tada: at 10:30', marks: [] }];
  const markdown = lineMarkdown({ kind: 'p', checked: false, indent: '', tail: '', runs });
  assert.equal(markdown, 'Run \\_\\_init\\_\\_.py for \\$5 \\:tada: at 10:30');
  assert.deepEqual(parseLine(markdown).runs, runs);
});

test('a line with an escaped tag saves, a repeated line is refused before anything is sent, and a row’s title goes to its title column', async () => {
  const url = 'https://www.notion.so/Megan-Li-3f0122069fec813999fbe0bd1235f178';
  let content = 'Vec\\<String> holds the names\n- [ ] Call Megan\n- [ ] Call Megan';
  // A text column listed before the title holds the same words as the title.
  const properties: Record<string, string> = { Notes: 'Megan Li', Name: 'Megan Li' };
  const calls: { name: string; args: Record<string, any> }[] = [];
  const apps = {
    connected: () => ['notion'],
    accountsOf: () => [],
    async call(_id: string, name: string, args: Record<string, any>) {
      calls.push({ name, args });
      if (name === 'notion-update-page' && args.command === 'update_content') for (const change of args.content_updates) content = content.replace(change.old_str, change.new_str);
      if (name === 'notion-update-page' && args.command === 'update_properties') Object.assign(properties, args.properties);
      const text = `<page url="${url}">\n<properties>\n${JSON.stringify(properties)}\n</properties>\n<sqlite-table>CREATE TABLE IF NOT EXISTS "collection://a" (\n"Notes" TEXT,\n"Name" TEXT, -- title\n)</sqlite-table>\n<content>\n${content}\n</content>\n</page>`;
      return { text: JSON.stringify({ metadata: { type: 'page' }, title: properties.Name, url, text }), isError: false };
    },
  } as unknown as RemoteApps;
  const views = new NotionViews(apps);
  const page = await views.read({ url, kind: 'page' }) as NotionPage;
  assert.equal(page.titleProperty, 'Name');
  const escaped = page.units.find(unit => unit.markdown.startsWith('Vec'))!;
  assert.deepEqual([escaped.markdown, escaped.source], ['Vec<String> holds the names', 'Vec\\<String> holds the names']);
  const edited = lineMarkdown({ ...parseLine(escaped.source!), runs: [{ text: 'Vec<String> holds every name', marks: [] }] });
  await views.save({ url, kind: 'page' }, { text: [{ old: escaped.source!, new: edited }], title: 'Megan Li-Smith' });
  assert.match(content, /^Vec\\<String> holds every name$/mu);
  assert.deepEqual(properties, { Notes: 'Megan Li', Name: 'Megan Li-Smith' });

  const sent = calls.filter(call => call.name === 'notion-update-page').length;
  await assert.rejects(views.save({ url, kind: 'page' }, { text: [{ old: '- [ ] Call Megan', new: '- [x] Call Megan' }] }), /“- \[ \] Call Megan” is on the page more than once/u);
  assert.equal(calls.filter(call => call.name === 'notion-update-page').length, sent);
});

test('changing the day of a Notion date keeps its time of day, and an end is never sent without a start', async () => {
  const url = 'https://www.notion.so/Interview-3f0122069fec813999fbe0bd1235f179';
  const properties: Record<string, unknown> = { Name: 'Interview', 'date:When:start': '2026-11-12T09:30:00.000+01:00', 'date:When:end': '2026-11-12T10:15:00.000+01:00', 'date:When:is_datetime': 1, 'date:Due:start': '2026-11-20', 'date:Due:is_datetime': 0 };
  const sent: Record<string, unknown>[] = [];
  const apps = {
    connected: () => ['notion'],
    accountsOf: () => [],
    async call(_id: string, name: string, args: Record<string, any>) {
      if (name === 'notion-update-page' && args.command === 'update_properties') { sent.push(args.properties); Object.assign(properties, args.properties); }
      const text = `<page url="${url}">\n<properties>\n${JSON.stringify(properties)}\n</properties>\n<sqlite-table>CREATE TABLE IF NOT EXISTS "collection://a" (\n"Name" TEXT, -- title\n"date:When:start" TEXT,\n"date:Due:start" TEXT,\n)</sqlite-table>\n<content>\nNotes\n</content>\n</page>`;
      return { text: JSON.stringify({ metadata: { type: 'page' }, title: 'Interview', url, text }), isError: false };
    },
  } as unknown as RemoteApps;
  const views = new NotionViews(apps);
  const page = await views.read({ url, kind: 'page' }) as NotionPage;
  assert.deepEqual(page.properties.find(property => property.name === 'When')?.date, { start: '2026-11-12', end: '2026-11-12', startAt: '2026-11-12T09:30:00.000+01:00', endAt: '2026-11-12T10:15:00.000+01:00' });
  await views.save({ url, kind: 'page' }, { properties: [{ name: 'When', value: '2026-11-13', end: '2026-11-13' }, { name: 'Due', value: '2026-11-21' }] });
  assert.deepEqual(sent.at(-1), { 'date:When:start': '2026-11-13T09:30:00.000+01:00', 'date:When:end': '2026-11-13T10:15:00.000+01:00', 'date:When:is_datetime': 1, 'date:Due:start': '2026-11-21', 'date:Due:end': null, 'date:Due:is_datetime': 0 });
  await views.save({ url, kind: 'page' }, { properties: [{ name: 'Due', value: null, end: '2026-11-25' }] });
  assert.deepEqual(sent.at(-1), { 'date:Due:start': null, 'date:Due:end': null, 'date:Due:is_datetime': 0 });
});
