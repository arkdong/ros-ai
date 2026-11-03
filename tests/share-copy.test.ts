import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { ShareCopies, canvasFileHtml, shareChoicesSchema } from '../src/server/share-copy.js';
import { DEFAULT_SHARE_CHOICES, readShareBundle, scanText, shareFileName } from '../src/shared/share.js';
import type { CanvasNode } from '../src/shared/types.js';

const node = (id: string, patch: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, description: '', x: 0, y: 0, ...patch });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ros-share-'));
  const store = new Store(join(dir, 'store'));
  const project = store.createProject('Four-day week study');
  const picture = join(dir, 'chart.png');
  // A 1×1 PNG.
  writeFileSync(picture, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  store.mutate(project.id, [
    node('sources', { kind: 'group', title: 'Sources', description: 'What we read', x: 0, y: 0 }),
    node('iceland', { parentId: 'sources', title: 'Iceland trials', description: 'Hours cut from 40 to 35. Ask jane.doe@example.org for the data, or call +31 6 1234 5678.' }),
    node('fetch', { blockType: 'code', title: 'fetch.py', x: 500, code: { language: 'python', source: 'API_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwx"\npath = "/Users/adamdong/code/data.csv"\nprint(2026-10-30)', parameters: {} } }),
    node('notion', { blockType: 'notion', title: 'Interview notes', x: 1000, notion: { url: 'https://www.notion.so/private-123', account: 'work' } }),
    node('photo', { blockType: 'file', title: 'Chart', x: 0, y: 600, file: { path: 'files/chart.png' } }),
    node('agent', { blockType: 'agent', title: 'Second opinion', x: 500, y: 600, description: 'Gains hold where work is measurable.', agent: { runtime: 'claude', turnId: 't1' } }),
  ].map(item => ({ type: 'addNode' as const, node: item })), 'Set up');
  store.mutate(project.id, [{ type: 'addConnection', connection: { id: 'l1', source: 'iceland', target: 'agent', label: 'supports' } }, { type: 'addConnection', connection: { id: 'l2', source: 'fetch', target: 'notion', label: 'reads' } }], 'Link');
  store.addMessage(project.id, null, 'user', 'Compare the trials. My number is +44 20 7946 0958.');
  const copies = new ShareCopies(store, { files: () => ({ fileOf: (_projectId, nodeId) => { if (nodeId !== 'photo') throw new Error('no file'); return { absolute: picture, name: 'chart.png', mediaType: 'image/png', size: 70 }; } }) });
  return { dir, store, project, copies };
}

test('the scanner finds emails, phones, keys, home paths and private addresses, and leaves dates and numbers alone', () => {
  const kinds = (text: string) => scanText(text).map(match => `${match.kind}:${match.text}`);
  assert.deepEqual(kinds('Mail jane.doe@example.org'), ['email:jane.doe@example.org']);
  assert.deepEqual(kinds('Call +31 6 1234 5678 or (020) 555-0199'), ['phone:+31 6 1234 5678', 'phone:(020) 555-0199']);
  assert.deepEqual(kinds('key sk-proj-abcdefghijklmnopqrstu and ghp_abcdefghijklmnopqrstuvwxyz12'), ['key:sk-proj-abcdefghijklmnopqrstu', 'key:ghp_abcdefghijklmnopqrstuvwxyz12']);
  assert.deepEqual(kinds('password = "hunter2hunter2"'), ['key:hunter2hunter2']);
  assert.deepEqual(kinds('token = process.env.TOKEN'), []);
  assert.deepEqual(kinds('Saved in /Users/adamdong/code and C:\\Users\\adam\\x'), ['path:/Users/adamdong', 'path:C:\\Users\\adam']);
  assert.deepEqual(kinds('Router 192.168.1.20, public 8.8.8.8'), ['address:192.168.1.20']);
  assert.deepEqual(kinds('On 2026-10-30 we had 412 rows, 1234567890 ids, version 1.2.3 and 40 to 35 hours'), []);
});

test('a share leaves conversations, live blocks off and secrets out by default, and hides what it finds', () => {
  const { dir, project, copies } = setup();
  try {
    const { copy, finds, counts } = copies.preview(project.id, { ...DEFAULT_SHARE_CHOICES, live: false });
    const json = JSON.stringify(copy);
    assert.equal(copy.title, 'Four-day week study');
    assert.equal(copy.conversation, undefined);
    assert.ok(!copy.nodes.some(item => item.id === 'notion'), 'live blocks are left out when switched off');
    assert.deepEqual(copy.links.map(link => link.id), ['l1'], 'links to left-out blocks go too');
    for (const secret of ['jane.doe@example.org', '1234 5678', 'sk-ant-api03', 'adamdong', 'private-123', 'turnId', 't1', 'files/chart.png', dir]) assert.ok(!json.includes(secret), `${secret} must not travel`);
    const iceland = copy.nodes.find(item => item.id === 'iceland')!;
    assert.equal(iceland.face.type === 'text' && iceland.face.markdown, 'Hours cut from 40 to 35. Ask [email] for the data, or call [phone].');
    const fetch = copy.nodes.find(item => item.id === 'fetch')!;
    assert.equal(fetch.face.type === 'code' && fetch.face.source, 'API_KEY = "[key]"\npath = "~/code/data.csv"\nprint(2026-10-30)');
    assert.deepEqual(finds.map(find => find.kind), ['key', 'email', 'phone', 'path']);
    assert.ok(finds.every(find => !find.revealed));
    assert.equal(copy.nodes.find(item => item.id === 'agent')!.agent, undefined, 'agent details stay home unless switched on');
    assert.deepEqual(copy.files.photo, { name: 'chart.png', mediaType: 'image/png', size: 70, width: 1, height: 1 });
    assert.equal(counts.messages, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('showing a find again puts it back, but a key can never be shown', () => {
  const { dir, project, copies } = setup();
  try {
    const first = copies.preview(project.id, DEFAULT_SHARE_CHOICES);
    const reveal = first.finds.map(find => find.id);
    const { copy, finds } = copies.preview(project.id, { ...DEFAULT_SHARE_CHOICES, reveal });
    const json = JSON.stringify(copy);
    assert.ok(json.includes('jane.doe@example.org'));
    assert.ok(!json.includes('sk-ant-api03'));
    assert.deepEqual(finds.filter(find => find.revealed).map(find => find.kind), ['email', 'phone', 'path']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('leaving out a Group takes its blocks; switches bring conversations and agent details', () => {
  const { dir, project, copies } = setup();
  try {
    const { copy } = copies.preview(project.id, { ...DEFAULT_SHARE_CHOICES, leaveOut: ['sources'], conversation: true, agentDetails: true, files: false });
    assert.ok(!copy.nodes.some(item => item.id === 'sources' || item.id === 'iceland'));
    assert.deepEqual(copy.links.map(link => link.id), ['l2']);
    assert.equal(copy.conversation?.[0].text, 'Compare the trials. My number is [phone].');
    assert.deepEqual(copy.nodes.find(item => item.id === 'agent')!.agent, { runtime: 'Claude Code' });
    assert.deepEqual(copy.nodes.find(item => item.id === 'photo')!.face, { type: 'left', note: 'Picture left out' });
    assert.deepEqual(copy.files, {});
    // A Notion block not read yet travels only as a title, with where it came from but no account or address.
    const notion = copy.nodes.find(item => item.id === 'notion')!;
    assert.deepEqual([notion.face, notion.snapshot], [{ type: 'left', note: 'Not read yet' }, { from: 'Notion' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the canvas file carries the copy and its files, and no text can close its script element', () => {
  const { dir, project, copies, store } = setup();
  try {
    store.mutate(project.id, [{ type: 'updateNode', id: 'agent', patch: { description: 'Ends here </script><script>alert(1)</script>' } }], 'Edit');
    const bundle = copies.bundle(project.id, shareChoicesSchema.parse({ layout: { agent: { x: 10, y: 20, width: 408, height: 264 } } }));
    assert.equal(bundle.data.photo.length > 0, true);
    const html = canvasFileHtml(bundle, { js: 'console.log("</script>")', css: '.a{}' });
    assert.equal(html.match(/<\/script>/gu)?.length, 2, 'only the two real script elements close');
    assert.ok(html.includes("default-src 'none'"));
    const data = html.match(/<script type="application\/json" id="ros-canvas">(.*?)<\/script>/su)![1];
    const read = readShareBundle(JSON.parse(data))!;
    assert.equal(read.nodes.find(item => item.id === 'agent')!.face.type === 'text' && (read.nodes.find(item => item.id === 'agent')!.face as { markdown: string }).markdown, 'Ends here </script><script>alert(1)</script>');
    assert.deepEqual(read.nodes.find(item => item.id === 'agent')!.box, { x: 10, y: 20, width: 408, height: 264 });
    // With a layout, blocks the canvas did not show (inside a closed Group) have no place of their own.
    assert.equal(read.nodes.find(item => item.id === 'iceland')!.box, undefined);
    assert.equal(shareFileName('Q3: plan / draft?'), 'Q3 plan draft.ros.html');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('names of keys in code are not keys', () => {
  assert.deepEqual(scanText('requests.get(URL, headers={"x-api-key": API_KEY})').map(match => match.kind), []);
  assert.deepEqual(scanText('token = settings.github_token').map(match => match.kind), []);
  assert.deepEqual(scanText('TOKEN=9f8e7d6c5b4a39281706').map(match => match.text), ['9f8e7d6c5b4a39281706']);
});
