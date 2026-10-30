import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/server/store.js';
import { PluginTokens, localPlugins } from '../src/server/plugins.js';
import { Papers, zoteroApp } from '../src/server/papers.js';

// GitHub through the GitHub CLI's sign-in and Zotero through the Zotero app, with stand-ins: a gh script, GitHub's
// /user and the Zotero app's local API answered in-process. Nothing here reaches GitHub or Zotero.

const GH_TOKEN = 'gho_fixture0123456789abcdefABCDEF';
const ENVIRONMENT = ['ROS_GH_BINARY', 'GH_CONFIG_DIR', 'ROS_ZOTERO_LOCAL_URL', 'FIXTURE_GH'] as const;
function environment(t: TestContext, values: Partial<Record<typeof ENVIRONMENT[number], string>>) {
  const saved = ENVIRONMENT.map(name => [name, process.env[name]] as const);
  for (const name of ENVIRONMENT) { if (values[name] === undefined) delete process.env[name]; else process.env[name] = values[name]; }
  t.after(() => { for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
}
/** A gh that prints its token while FIXTURE_GH is signed-in, and fails like a signed-out gh otherwise. */
function fakeGh(dir: string) {
  const binary = join(dir, 'gh'), config = join(dir, 'gh-config');
  writeFileSync(binary, `#!/bin/sh\nif [ "$1 $2 $3 $4" = "auth token --hostname github.com" ] && [ "$FIXTURE_GH" = "signed-in" ]; then echo ${GH_TOKEN}; exit 0; fi\necho "no oauth token found for github.com" >&2\nexit 1\n`);
  chmodSync(binary, 0o755);
  rmSync(config, { recursive: true, force: true });
  return { binary, config };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
type Seen = { url: URL; headers: Headers };

test('GitHub connects through the GitHub CLI’s sign-in, kept in memory only, and a token saved later takes over', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-plugin-ways-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gh = fakeGh(dir);
  environment(t, { ROS_GH_BINARY: gh.binary, GH_CONFIG_DIR: gh.config, FIXTURE_GH: 'signed-in' });
  let github: 'up' | 'refuses' | 'down' = 'up';
  const seen: Seen[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers);
    seen.push({ url, headers });
    if (url.href !== 'https://api.github.com/user') return new Response('not here', { status: 404 });
    if (github === 'down') throw new TypeError('fetch failed');
    return github === 'refuses' || headers.get('authorization') !== `Bearer ${GH_TOKEN}` ? json({ message: 'Bad credentials' }, 401) : json({ login: 'octo' });
  }) as typeof fetch;

  // Installed but never signed in: no hosts file, so it is not offered.
  assert.equal((await localPlugins(fetcher)).github, false);
  mkdirSync(gh.config, { recursive: true }); writeFileSync(join(gh.config, 'hosts.yml'), 'github.com:\n    user: octo\n');
  assert.equal((await localPlugins(fetcher)).github, true);

  const data = join(dir, 'data'); mkdirSync(data);
  const plugins = new PluginTokens(data, fetcher);
  assert.deepEqual([plugins.status('github').configured, plugins.status('github').via], [false, null]);
  const used = await plugins.useLocal('github');
  assert.deepEqual([used.configured, used.via, used.verified, used.checkMessage], [true, 'github-cli', true, 'Connected through the GitHub CLI as octo.']);
  assert.equal(plugins.token('github'), GH_TOKEN);
  // Only the choice is written down, owner-only; the token never is.
  const ways = join(data, 'plugin-ways.json');
  assert.deepEqual(JSON.parse(readFileSync(ways, 'utf8')), { version: 1, ways: { github: 'github-cli' } });
  assert.equal(statSync(ways).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(ways, 'utf8'), new RegExp(GH_TOKEN, 'u'));
  assert.deepEqual(plugins.saved(), ['github']);

  // After a restart the CLI's token is read again, in the background.
  const again = new PluginTokens(data, fetcher);
  for (let tries = 0; !again.token('github') && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual([again.token('github'), again.status('github').via], [GH_TOKEN, 'github-cli']);

  // A token saved later takes over; using the CLI again sets it aside; Disconnect forgets both.
  again.save('github', { token: 'ghp_saved0123456789' });
  assert.deepEqual([again.token('github'), again.status('github').via], ['ghp_saved0123456789', null]);
  await again.useLocal('github');
  assert.deepEqual([again.token('github'), again.status('github').via], [GH_TOKEN, 'github-cli']);
  again.disconnect('github');
  assert.deepEqual([again.token('github'), again.status('github').configured, again.saved()], [undefined, false, []]);
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'plugin-tokens.json'), 'utf8')).tokens, {});

  // GitHub refusing the sign-in keeps it unused; GitHub out of reach keeps the choice, unchecked.
  github = 'refuses';
  await assert.rejects(again.useLocal('github'), /GitHub did not accept the GitHub CLI’s sign-in\. Run gh auth login in Terminal/u);
  assert.equal(again.status('github').via, null);
  github = 'down';
  const offline = await again.useLocal('github');
  assert.deepEqual([offline.via, offline.configured, offline.verified, offline.checkMessage], ['github-cli', true, null, 'Connected through the GitHub CLI. GitHub could not be reached to check its sign-in.']);
  again.disconnect('github');

  // A signed-out GitHub CLI says what to do.
  process.env.FIXTURE_GH = 'signed-out';
  await assert.rejects(again.useLocal('github'), /The GitHub CLI is not signed in to github\.com\. Run gh auth login in Terminal/u);
  assert.ok(seen.filter(request => request.headers.get('authorization')).every(request => request.url.hostname === 'api.github.com'), 'The sign-in went to GitHub only');
});

test('Zotero connects through the Zotero app: its library and the PDFs it keeps, with no key', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ros-zotero-app-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  environment(t, { ROS_ZOTERO_LOCAL_URL: 'http://127.0.0.1:23119/api' });
  const stored = join(dir, 'storage', 'PDF00001'), paper = join(stored, 'Lovelace 2021.pdf');
  mkdirSync(stored, { recursive: true });
  writeFileSync(paper, Buffer.from('%PDF-1.4\n% a stand-in PDF the Zotero app keeps\n%%EOF\n', 'latin1'));
  let app: 'closed' | 'locked' | 'ready' = 'closed';
  const seen: Seen[] = [];
  const ITEM = { key: 'ABCD2345', version: 3, meta: { parsedDate: '2021-03-01' }, links: { attachment: { href: 'http://localhost:23119/api/users/0/items/PDF00001', attachmentType: 'application/pdf' } },
    data: { key: 'ABCD2345', itemType: 'journalArticle', title: 'Reading with machines', creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }], date: '2021', DOI: '10.5555/zot.1' } };
  const NOTE = { key: 'NOTE0001', data: { key: 'NOTE0001', itemType: 'note', note: 'A standalone note' } };
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers);
    seen.push({ url, headers });
    if (url.host !== '127.0.0.1:23119') return new Response('not here', { status: 404 });
    if (app === 'closed') throw new TypeError('fetch failed');
    if (app === 'locked') return new Response('Local API is not enabled', { status: 403 });
    if (url.pathname === '/api/users/0/items/top') return json([ITEM, NOTE]);
    if (url.pathname === '/api/users/0/items/ABCD2345') return json(ITEM);
    if (url.pathname === '/api/users/0/items/PDF00001/file/view/url') return new Response(pathToFileURL(paper).href, { status: 200, headers: { 'content-type': 'text/plain' } });
    return new Response('No endpoint found', { status: 404 });
  }) as typeof fetch;

  assert.equal(await zoteroApp(fetcher), 'closed');
  const data = join(dir, 'data'); mkdirSync(data);
  const plugins = new PluginTokens(data, fetcher), store = new Store(join(dir, 'store')); t.after(() => store.close());
  const papers = new Papers(store, { openalex: () => undefined, zotero: () => plugins.token('zotero'), zoteroApp: () => plugins.way('zotero') === 'zotero-app' }, { fetcher, spacing: 0 });
  await assert.rejects(plugins.useLocal('zotero'), /Zotero is not open on this computer/u);
  app = 'locked';
  assert.equal((await localPlugins(fetcher)).zotero, 'locked');
  await assert.rejects(plugins.useLocal('zotero'), /tick “Allow other applications on this computer to communicate with Zotero”/u);
  assert.deepEqual(papers.personSources(), ['openalex', 'arxiv']);

  app = 'ready';
  const used = await plugins.useLocal('zotero');
  assert.deepEqual([used.configured, used.via, used.verified], [true, 'zotero-app', true]);
  assert.equal(plugins.token('zotero'), undefined, 'The app needs no key');
  assert.deepEqual(papers.personSources(), ['openalex', 'arxiv', 'zotero']);
  assert.deepEqual(papers.status().sources.find(source => source.id === 'zotero'), { id: 'zotero', name: 'Zotero', available: true, agents: true, key: false, account: null });

  const library = await papers.search('zotero', 'lovelace', { limit: 10 }, ['zotero']);
  assert.deepEqual(library.papers.map(item => [item.id, item.pdf, item.year]), [['zotero:ABCD2345', true, 2021]]);
  const listed = seen.find(request => request.url.pathname === '/api/users/0/items/top' && request.url.searchParams.get('q'))!;
  assert.deepEqual([listed.url.searchParams.get('q'), listed.url.searchParams.get('qmode'), listed.url.searchParams.get('itemType'), listed.headers.get('zotero-api-key')], ['lovelace', 'titleCreatorYear', null, null]);
  const found = await papers.paper('zotero:ABCD2345', ['zotero']);
  const pdf = await papers.pdf(found, ['zotero']);
  assert.ok('bytes' in pdf && pdf.bytes.subarray(0, 5).toString('latin1') === '%PDF-' && pdf.place === 'your Zotero library');

  // Zotero closed again: searching says so; the check says so too.
  app = 'closed';
  await assert.rejects(papers.search('zotero', 'babbage', { limit: 10 }, ['zotero']), /Zotero is not open on this computer/u);
  const checked = await plugins.check('zotero');
  assert.deepEqual([checked.verified, checked.checkMessage], [false, 'Zotero is not open on this computer. Open Zotero, then try again.']);
  // A key saved later takes over from the app.
  plugins.save('zotero', { token: 'zotero-key-123' });
  assert.deepEqual([plugins.way('zotero'), plugins.token('zotero')], [undefined, 'zotero-key-123']);
});
