import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { Store } from '../src/server/store.js';
import type { ExecutionService } from '../src/server/execution.js';
import type { ExperimentService } from '../src/server/experiments.js';
import { AgentWorkspaceTools } from '../src/server/agent-tools.js';
import { RemoteApps } from '../src/server/remote-apps.js';
import { ProjectFolders } from '../src/server/project-folders.js';
import { apiErrorHandler } from '../src/server/app.js';
import { arxivIdOf, arxivPapers, attachPaperRoutes, citation, doiOf, paperBlock, Papers, PapersApp } from '../src/server/papers.js';
import type { PaperSearch, PapersStatus } from '../src/shared/papers.js';

// Stand-ins for OpenAlex, arXiv and Zotero's web API, and for the sites that serve open PDFs.

/** A one-page PDF with a text layer, written by hand so the test needs no PDF library. */
function pdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => { const at = body.length; body += `${index + 1} 0 obj\n${object}\nendobj\n`; return at; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(at => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const OPEN = { id: 'https://openalex.org/W2741809807', doi: 'https://doi.org/10.7717/peerj.4375', display_name: 'The state of OA: a large-scale analysis of the prevalence and impact of Open Access articles', publication_year: 2018, publication_date: '2018-02-13', type: 'article', cited_by_count: 1234,
  authorships: [{ author: { display_name: 'Heather Piwowar' } }, { author: { display_name: 'Jason Priem' } }, { raw_author_name: 'Vincent Larivière' }], primary_location: { source: { display_name: 'PeerJ' }, landing_page_url: 'https://peerj.com/articles/4375' },
  best_oa_location: { is_oa: true, pdf_url: 'https://peerj.example/articles/4375.pdf' }, locations: [{ is_oa: true, pdf_url: 'https://peerj.example/articles/4375.pdf' }, { is_oa: false, pdf_url: 'https://paywall.example/4375.pdf' }, { is_oa: true, pdf_url: 'javascript:alert(1)' }],
  abstract_inverted_index: { Despite: [0], growing: [1], interest: [2], in: [3], 'Open': [4], Access: [5] } };
const CLOSED = { id: 'https://openalex.org/W2', doi: null, display_name: 'A closed paper', publication_year: 2020, type: 'article', cited_by_count: 3, authorships: [], primary_location: { landing_page_url: 'https://publisher.example/closed' }, best_oa_location: null, locations: [] };
const PLANTED = { ...OPEN, id: 'https://openalex.org/W3', doi: 'https://doi.org/10.5555/planted', display_name: 'A planted link', best_oa_location: { is_oa: true, pdf_url: 'https://evil.example/secret.pdf' }, locations: [{ is_oa: true, pdf_url: 'https://peerj.example/redirect.pdf' }, { is_oa: true, pdf_url: 'https://html.example/landing' }] };
const works: Record<string, unknown> = { W2741809807: OPEN, W2: CLOSED, W3: PLANTED, 'doi:10.7717/peerj.4375': OPEN, 'doi:10.5555/zot.1': { ...OPEN, id: 'https://openalex.org/W4', doi: 'https://doi.org/10.5555/zot.1', display_name: 'Reading with machines' } };

const ATTENTION = `<entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <updated>2023-08-02T00:41:18Z</updated>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All You
  Need</title>
    <summary>  The dominant sequence transduction models are based on complex recurrent or
convolutional neural networks &amp; more &#x2014; &lt;b&gt;fast&lt;/b&gt;.
</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name><arxiv:affiliation>Google</arxiv:affiliation></author>
    <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
  </entry>`;
const OLD_STYLE = `<entry><id>http://arxiv.org/abs/hep-th/9711200v3</id><published>1997-11-27T00:00:00Z</published><title>The Large N Limit of Superconformal Field Theories and Supergravity</title><summary>We show that…</summary><author><name>Juan M. Maldacena</name></author><arxiv:doi>10.1023/A:1026654312961</arxiv:doi><arxiv:journal_ref>Adv.Theor.Math.Phys.2:231-252,1998</arxiv:journal_ref></entry>`;
const feed = (entries: string[], total = entries.length) => `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">\n  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">${total}</opensearch:totalResults>\n  ${entries.join('\n  ')}\n</feed>\n`;
const ARXIV_ERROR = '<entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_1234</id><title>Error</title><summary>incorrect id format for 1234</summary></entry>';

const ITEM = { key: 'ABCD2345', version: 3, meta: { parsedDate: '2021-03-01' }, links: { attachment: { href: 'https://api.zotero.org/users/12345/items/PDF00001', type: 'application/json', attachmentType: 'application/pdf' }, alternate: { href: 'https://www.zotero.org/ada/items/ABCD2345' } },
  data: { key: 'ABCD2345', itemType: 'journalArticle', title: 'Reading with machines', creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }, { creatorType: 'editor', name: 'Ed Itor' }], date: 'March 2021', publicationTitle: 'Journal of Tests', DOI: 'https://doi.org/10.5555/zot.1', abstractNote: 'An abstract.', url: '' } };
const BOOK = { key: 'BOOK0001', meta: { parsedDate: '1999' }, links: {}, data: { itemType: 'book', title: 'A book with no file', creators: [{ creatorType: 'editor', name: 'Research Group' }], date: '1999', publisher: 'Pub', extra: 'DOI: 10.5555/book.1' } };
const NOTE = { key: 'NOTE0001', data: { itemType: 'note', note: '<p>hi</p>' } };

const FILES: Record<string, Buffer> = { 'https://peerj.example/articles/4375.pdf': pdf('Open access text'), 'https://arxiv.org/pdf/1706.03762v7': pdf('Attention text'), 'https://files.zotero.example/stored?signature=1': pdf('Zotero stored text') };

function services(options: { openalex429?: boolean } = {}) {
  const requests: { url: URL; headers: Headers }[] = [];
  const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers);
    requests.push({ url, headers });
    if (url.hostname === 'api.openalex.org') {
      if (options.openalex429) return json({ error: 'Rate limit exceeded' }, 429);
      if (url.pathname === '/works') return json({ meta: { count: 2 }, results: [OPEN, CLOSED] });
      // OpenAlex finds a DOI whatever its case.
      const id = decodeURIComponent(url.pathname.slice('/works/'.length)), work = works[id] ?? works[id.toLowerCase()];
      return work ? json(work) : json({ error: 'Not found' }, 404);
    }
    if (url.hostname === 'export.arxiv.org') {
      const ids = url.searchParams.get('id_list');
      if (ids) return new Response(feed(ids.startsWith('1706.03762') ? [ATTENTION] : ids.startsWith('hep-th/9711200') ? [OLD_STYLE] : []), { headers: { 'content-type': 'application/atom+xml' } });
      return new Response(feed([ATTENTION, OLD_STYLE], 42), { headers: { 'content-type': 'application/atom+xml' } });
    }
    if (url.hostname === 'api.zotero.org') {
      if (headers.get('zotero-api-key') !== 'zotero-key-123') return json('Forbidden', 403);
      if (url.pathname === '/keys/current') return json({ key: 'zotero-key-123', userID: 12345, username: 'ada', access: { user: { library: true, files: true } } });
      if (url.pathname === '/users/12345/items/top') return json([ITEM, BOOK, NOTE], 200, { 'Total-Results': '3' });
      if (url.pathname === '/users/12345/items/ABCD2345') return json(ITEM);
      if (url.pathname === '/users/12345/items/BOOK0001') return json(BOOK);
      if (url.pathname === '/users/12345/items/PDF00001/file') return new Response(null, { status: 302, headers: { location: 'https://files.zotero.example/stored?signature=1' } });
      return json('Not found', 404);
    }
    if (url.href === 'https://peerj.example/redirect.pdf') return new Response(null, { status: 302, headers: { location: 'http://evil.example/secret.pdf' } });
    if (url.hostname === 'html.example') return new Response('<!doctype html><title>Landing</title>', { headers: { 'content-type': 'text/html' } });
    const file = FILES[url.href];
    return file ? new Response(new Uint8Array(file), { headers: { 'content-type': 'application/pdf' } }) : new Response('missing', { status: 404 });
  };
  // evil.example points at this computer; every other name is on the public internet.
  const lookup = async (host: string) => host === 'evil.example' ? [{ address: '127.0.0.1' }] : host === 'ula.example' ? [{ address: 'fd12::1' }] : [{ address: '93.184.216.34' }];
  return { requests, fetch: fetch as typeof globalThis.fetch, lookup };
}

function fixture(options: { zotero?: boolean; openalexKey?: string; openalex429?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ros-papers-')), api = services(options);
  const store = new Store(join(dir, 'store'));
  const papers = new Papers(store, { openalex: () => options.openalexKey, zotero: () => options.zotero ? 'zotero-key-123' : undefined }, { fetcher: api.fetch, lookup: api.lookup, spacing: 0 });
  const folders = new ProjectFolders(store, { reserved: [join(dir, 'store')] });
  return { dir, store, papers, folders, ...api, close: () => { folders.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const toolkit = (store: Store, projectId: string) => new AgentWorkspaceTools(store, { searchService: () => ({ id: 'tavily' }), assistantProposal: (id: string, summary: string, operations: Parameters<Store['createProposal']>[3]) => store.createProposal(id, store.getProject(id).revision, summary, operations) } as unknown as ExecutionService, { authority: { policy: () => ({ stopped: false }) } } as unknown as ExperimentService, { projectId, nodeIds: [], artifactIds: [] }, 'turn-papers', 'model', 'Test model');

test('DOIs, arXiv IDs, arXiv’s Atom and citations are read the way the sources write them', () => {
  assert.equal(doiOf('https://doi.org/10.7717/peerj.4375'), '10.7717/peerj.4375');
  assert.equal(doiOf('doi: 10.1000/xyz123'), '10.1000/xyz123');
  assert.equal(doiOf('10.1000'), null);
  assert.equal(arxivIdOf('arXiv:1706.03762v7'), '1706.03762v7');
  assert.equal(arxivIdOf('https://arxiv.org/pdf/2401.01234.pdf'), '2401.01234');
  assert.equal(arxivIdOf('hep-th/9711200'), 'hep-th/9711200');
  assert.equal(arxivIdOf('not an id'), null);

  const { papers, total } = arxivPapers(feed([ATTENTION, OLD_STYLE], 42));
  assert.equal(total, 42);
  const [attention, maldacena] = papers;
  assert.equal(attention.id, 'arxiv:1706.03762v7');
  assert.equal(attention.title, 'Attention Is All You Need');
  assert.deepEqual(attention.authors, ['Ashish Vaswani', 'Noam Shazeer']);
  assert.equal(attention.abstract, 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks & more — <b>fast</b>.');
  assert.deepEqual([attention.year, attention.venue, attention.doi, attention.link, attention.pdf], [2017, 'arXiv (cs.CL)', '10.48550/arXiv.1706.03762', 'https://arxiv.org/abs/1706.03762v7', true]);
  assert.deepEqual(attention.pdfs, ['https://arxiv.org/pdf/1706.03762v7']);
  // An old-style ID, a journal reference and a publisher's DOI.
  assert.deepEqual([maldacena.id, maldacena.venue, maldacena.doi, maldacena.kind], ['arxiv:hep-th/9711200v3', 'Adv.Theor.Math.Phys.2:231-252,1998', '10.1023/A:1026654312961', 'article']);
  assert.throws(() => arxivPapers(feed([ARXIV_ERROR])), /arXiv did not accept the search: incorrect id format for 1234/u);

  assert.equal(citation({ authors: ['Ada Lovelace', 'Charles Babbage'], year: 1843, title: 'Notes on the engine', venue: 'Scientific *Memoirs*', doi: '10.5555/notes', link: 'https://example.org' }), 'Ada Lovelace, Charles Babbage (1843). Notes on the engine. *Scientific Memoirs*. https://doi.org/10.5555/notes');
  const many = Array.from({ length: 25 }, (_, index) => `Author ${index + 1}`);
  const long = citation({ authors: many, year: null, title: 'Big science?', venue: null, doi: null, link: 'https://example.org/big' });
  assert.match(long, /^Author 1, .*Author 19, … Author 25 \(n\.d\.\)\. Big science\? https:\/\/example\.org\/big$/u);
  assert(!long.includes('Author 20,'));
});

test('A search goes to the source named, finds one paper by DOI or arXiv ID, is reused for a while, and says why a source refused', async () => {
  const f = fixture({ zotero: true, openalexKey: 'oa-key-456' });
  try {
    const all = f.papers.personSources();
    assert.deepEqual(all, ['openalex', 'arxiv', 'zotero']);
    // OpenAlex: words, years, open copies only and most cited; the key goes along, and only open PDF links over http(s) are kept.
    const found = await f.papers.search('openalex', 'open access  prevalence', { limit: 5, yearFrom: 2015, yearTo: 2020, openOnly: true, sort: 'most_cited' }, all);
    const sent = f.requests.at(-1)!.url;
    assert.equal(sent.pathname, '/works');
    assert.deepEqual([sent.searchParams.get('search'), sent.searchParams.get('per-page'), sent.searchParams.get('filter'), sent.searchParams.get('sort'), sent.searchParams.get('api_key')], ['open access prevalence', '5', 'from_publication_date:2015-01-01,to_publication_date:2020-12-31,open_access.is_oa:true', 'cited_by_count:desc', 'oa-key-456']);
    assert.match(sent.searchParams.get('select')!, /abstract_inverted_index/u);
    assert.equal(f.requests.at(-1)!.headers.get('user-agent'), 'ros.ai (https://github.com/arkdong/ros-ai)');
    assert.deepEqual(found.papers.map(paper => [paper.id, paper.pdf, paper.citedBy]), [['openalex:W2741809807', true, 1234], ['openalex:W2', false, 3]]);
    assert.deepEqual(found.papers[0].authors, ['Heather Piwowar', 'Jason Priem', 'Vincent Larivière']);
    assert.equal(found.papers[0].abstract, 'Despite growing interest in Open Access');
    assert.equal(found.papers[0].link, 'https://doi.org/10.7717/peerj.4375');
    assert.equal(found.papers[1].link, 'https://publisher.example/closed');
    assert.equal(found.total, 2);
    assert(!('pdfs' in found.papers[0]), 'open PDF addresses stay on the server');
    // The same search again is answered from memory.
    const count = f.requests.length;
    await f.papers.search('openalex', 'open access prevalence', { limit: 5, yearFrom: 2015, yearTo: 2020, openOnly: true, sort: 'most_cited' }, all);
    assert.equal(f.requests.length, count);
    // A DOI is looked up as one work, with its slash.
    const single = await f.papers.search('openalex', 'https://doi.org/10.7717/peerj.4375', { limit: 5 }, all);
    assert.equal(f.requests.at(-1)!.url.pathname, '/works/doi:10.7717/peerj.4375');
    assert.deepEqual(single.papers.map(paper => paper.id), ['openalex:W2741809807']);
    assert.deepEqual((await f.papers.search('openalex', 'W999', { limit: 5 }, all)).papers, []);

    // arXiv: plain words must all appear, without small words; its own syntax and IDs pass through.
    const preprints = await f.papers.search('arxiv', 'Attention is all you need', { limit: 3, yearFrom: 2017 }, all);
    const query = f.requests.at(-1)!.url;
    assert.equal(query.hostname, 'export.arxiv.org');
    assert.equal(query.searchParams.get('search_query'), `(all:attention AND all:need) AND submittedDate:[201701010000 TO ${new Date().getUTCFullYear()}12312359]`);
    assert.deepEqual([query.searchParams.get('max_results'), query.searchParams.get('sortBy')], ['3', 'relevance']);
    assert.deepEqual([preprints.total, preprints.papers.length], [42, 2]);
    await f.papers.search('arxiv', 'ti:transformer AND au:vaswani', { limit: 3, sort: 'newest' }, all);
    assert.deepEqual([f.requests.at(-1)!.url.searchParams.get('search_query'), f.requests.at(-1)!.url.searchParams.get('sortBy')], ['ti:transformer AND au:vaswani', 'submittedDate']);
    const byId = await f.papers.search('arxiv', 'arXiv:1706.03762', { limit: 3, sort: 'most_cited' }, all);
    assert.equal(f.requests.at(-1)!.url.searchParams.get('id_list'), '1706.03762');
    assert.deepEqual(byId.papers.map(paper => paper.id), ['arxiv:1706.03762v7']);
    await assert.rejects(f.papers.paper('arxiv:1234.5678', all), /arXiv has no paper 1234\.5678/u);

    // Zotero: whose library the key reads is asked once; no words lists the library, newest change first; notes are left out.
    const library = await f.papers.search('zotero', '', { limit: 10 }, all);
    const listed = f.requests.filter(request => request.url.hostname === 'api.zotero.org');
    assert.deepEqual(listed.map(request => request.url.pathname), ['/keys/current', '/users/12345/items/top']);
    assert.equal(listed[1].url.searchParams.get('q'), null);
    assert.equal(listed[1].url.searchParams.get('itemType'), '-attachment || note');
    assert.equal(listed[1].headers.get('zotero-api-version'), '3');
    assert.deepEqual(library.papers.map(paper => [paper.id, paper.pdf, paper.year, paper.doi]), [['zotero:ABCD2345', true, 2021, '10.5555/zot.1'], ['zotero:BOOK0001', false, 1999, '10.5555/book.1']]);
    assert.deepEqual(library.papers.map(paper => paper.authors), [['Ada Lovelace'], ['Research Group']]);
    assert.equal(library.total, 3);
    await f.papers.search('zotero', 'lovelace', { limit: 10, yearFrom: 2000 }, all);
    const words = f.requests.at(-1)!.url;
    assert.deepEqual([words.searchParams.get('q'), words.searchParams.get('qmode'), words.searchParams.get('limit')], ['lovelace', 'titleCreatorYear', '100']);
    assert.equal(f.requests.filter(request => request.url.pathname === '/keys/current').length, 1);
    assert.deepEqual(f.papers.status().sources.map(source => [source.id, source.available, source.agents, source.key, source.account]), [['openalex', true, false, true, null], ['arxiv', true, false, false, null], ['zotero', true, true, true, 'ada']]);

    // A source an agent may not use is refused before anything is sent.
    const before = f.requests.length;
    await assert.rejects(f.papers.search('arxiv', 'attention', { limit: 3 }, ['openalex']), /arXiv is off for agents/u);
    await assert.rejects(f.papers.paper('10.7717/peerj.4375', ['arxiv']), /needs OpenAlex, which is off for agents/u);
    assert.equal(f.requests.length, before);
  } finally { f.close(); }

  const limited = fixture({ openalex429: true });
  try {
    await assert.rejects(limited.papers.search('openalex', 'anything', { limit: 5 }, limited.papers.personSources()), /free daily allowance without a key is used up/u);
    await assert.rejects(limited.papers.search('zotero', '', { limit: 5 }, ['zotero']), /Zotero is not connected/u);
  } finally { limited.close(); }
});

test('A paper becomes a File block with its open PDF saved into the project folder, or a Text block with its reference, and never fetches from this computer’s network', async () => {
  const f = fixture({ zotero: true });
  try {
    const project = f.store.createProject('Reading list'), all = f.papers.personSources();
    // Without a folder the PDF cannot be kept: a Text block says so.
    const unsaved = await paperBlock(f.papers, f.store, f.folders, project.id, 'openalex:W2741809807', all);
    assert.equal(unsaved.node!.blockType, 'note');
    assert.match(unsaved.note!, /this project has no folder/u);
    assert.match(unsaved.node!.description, /^Heather Piwowar, Jason Priem, Vincent Larivière \(2018\)\. The state of OA: .* \*PeerJ\*\. https:\/\/doi\.org\/10\.7717\/peerj\.4375\n\n\*\*Abstract\.\*\* Despite growing interest in Open Access\n\nFound in OpenAlex · cited by 1,234\.\n\nThe open PDF was not saved/u);

    f.folders.attach(project.id, join(f.dir, 'Reading list'));
    f.folders.shutdown();
    // OpenAlex's best open copy, saved under a reference manager's name.
    const open = await paperBlock(f.papers, f.store, f.folders, project.id, 'openalex:W2741809807', all);
    assert.equal(open.note, null);
    assert.equal(open.node!.blockType, 'file');
    assert.match(open.node!.file!.path, /^files\/Piwowar 2018 The state of OA.*\.pdf$/u);
    assert.deepEqual(readFileSync(join(f.dir, 'Reading list', open.node!.file!.path)), FILES['https://peerj.example/articles/4375.pdf']);
    assert.match(open.node!.description, /Found in OpenAlex · cited by 1,234 · PDF saved from peerj\.example on \d{4}-\d\d-\d\d\./u);
    assert.deepEqual(open.node!.paper, { source: 'openalex', id: 'openalex:W2741809807', doi: '10.7717/peerj.4375', link: 'https://doi.org/10.7717/peerj.4375' });
    f.store.mutate(project.id, [{ type: 'addNode', node: open.node! }], 'Add paper');
    // The same paper again, by its DOI, is the block already there.
    const again = await paperBlock(f.papers, f.store, f.folders, project.id, 'https://doi.org/10.7717/PEERJ.4375', all);
    assert.equal(again.existing?.id, open.node!.id);

    // arXiv's PDF, and the PDF Zotero stores, which Zotero hands over at a short-lived address.
    const preprint = await paperBlock(f.papers, f.store, f.folders, project.id, '1706.03762', all);
    assert.deepEqual(readFileSync(join(f.dir, 'Reading list', preprint.node!.file!.path)), FILES['https://arxiv.org/pdf/1706.03762v7']);
    assert.match(preprint.node!.description, /PDF saved from arxiv\.org/u);
    const stored = await paperBlock(f.papers, f.store, f.folders, project.id, 'zotero:ABCD2345', all);
    assert.deepEqual(readFileSync(join(f.dir, 'Reading list', stored.node!.file!.path)), FILES['https://files.zotero.example/stored?signature=1']);
    assert.match(stored.node!.description, /Found in Zotero · PDF saved from your Zotero library/u);
    assert.equal(f.requests.find(request => request.url.hostname === 'files.zotero.example')!.headers.get('zotero-api-key'), null, 'the key never leaves for the file host');

    // No open copy: the reference alone.
    const closed = await paperBlock(f.papers, f.store, f.folders, project.id, 'openalex:W2', all);
    assert.deepEqual([closed.node!.blockType, closed.note], ['note', null]);
    assert.match(closed.node!.description, /^Unknown authors \(2020\)\. A closed paper\. https:\/\/publisher\.example\/closed/u);

    // Links planted in a record: one names this computer, one redirects there, one is a web page. None is fetched or kept.
    const planted = await paperBlock(f.papers, f.store, f.folders, project.id, 'openalex:W3', all);
    assert.equal(planted.node!.blockType, 'note');
    assert.match(planted.note!, /The open copy at html\.example could not be saved as a PDF/u);
    assert(!f.requests.some(request => request.url.hostname === 'evil.example'), 'nothing is fetched from an address on this computer');
    assert(f.requests.some(request => request.url.href === 'https://peerj.example/redirect.pdf'));
    const saved = readdirSync(join(f.dir, 'Reading list', 'files')).sort();
    assert.equal(saved.length, 3);
  } finally { f.close(); }
});

test('Agents get the paper tools only once a source is on, search and read straight away, and add papers as proposals with the PDF', async () => {
  const f = fixture();
  const apps = new RemoteApps(join(f.dir, 'apps'), { builtIn: { papers: new PapersApp(f.papers) } });
  AgentWorkspaceTools.apps = apps; AgentWorkspaceTools.papers = f.papers; AgentWorkspaceTools.folders = f.folders;
  try {
    const project = f.store.createProject('Agent papers');
    f.folders.attach(project.id, join(f.dir, 'Agent papers'));
    f.folders.shutdown();
    // Every source off: the tools agents get are as before.
    const off = toolkit(f.store, project.id);
    assert(!off.definitions.some(tool => tool.name.startsWith('ros_app_')));

    f.papers.setAgents('arxiv', true);
    const agent = toolkit(f.store, project.id);
    assert.match(agent.definitions.find(tool => tool.name === 'ros_app_tools')!.description, /papers \(Papers\)/u);
    assert.match(agent.definitions.find(tool => tool.name === 'ros_app_call')!.description, /to put one on the canvas use its add_paper/u);
    const listing = await agent.call('ros_app_tools', { app: 'papers' }) as { tools: { name: string; approval: string }[] };
    assert.deepEqual(listing.tools.map(tool => [tool.name, tool.approval]), [['search_papers', 'runs straight away'], ['read_paper', 'runs straight away'], ['add_paper', 'adds blocks under the project approval mode']]);
    const schema = await agent.call('ros_app_tools', { app: 'papers', tool: 'search_papers' }) as { inputSchema: { properties: { source: { enum: string[] } } } };
    assert.deepEqual(schema.inputSchema.properties.source.enum, ['arxiv']);

    const found = await agent.call('ros_app_call', { app: 'papers', tool: 'search_papers', arguments: { query: 'attention' }, summary: 'Find the paper', rationale: 'The person asked about transformers.' }) as { text: string };
    const page = JSON.parse(found.text) as { source: string; papers: { id: string; openPdf: boolean }[] };
    assert.equal(page.source, 'arxiv');
    assert.deepEqual(page.papers.map(paper => [paper.id, paper.openPdf]), [['arxiv:1706.03762v7', true], ['arxiv:hep-th/9711200v3', true]]);
    const refused = await agent.call('ros_app_call', { app: 'papers', tool: 'search_papers', arguments: { query: 'attention', source: 'openalex' }, summary: 'Find it', rationale: 'Because.' }) as { text: string; isError: boolean };
    assert.equal(refused.isError, true);
    const read = JSON.parse((await agent.call('ros_app_call', { app: 'papers', tool: 'read_paper', arguments: { id: 'arxiv:1706.03762v7' }, summary: 'Read it', rationale: 'For the citation.' }) as { text: string }).text) as { citation: string; openPdf: string };
    assert.equal(read.citation, 'Ashish Vaswani, Noam Shazeer (2017). Attention Is All You Need. *arXiv (cs.CL)*. https://doi.org/10.48550/arXiv.1706.03762');
    assert.equal(read.openPdf, 'https://arxiv.org/pdf/1706.03762v7');

    // Adding a paper saves its PDF and proposes the File block; accepted, the block knows where the paper came from.
    const added = await agent.call('ros_app_call', { app: 'papers', tool: 'add_paper', arguments: { id: 'arxiv:1706.03762v7' }, summary: 'Add the transformer paper', rationale: 'It is the source the person cited.' }) as { action: { proposalId: string; status: string }; committed: boolean; block: { id: string; file: string }; instruction: string };
    assert.equal(added.committed, false);
    assert.match(added.instruction, /Wait for the person to accept/u);
    assert.match(added.block.file, /^files\/Vaswani 2017 Attention Is All You Need\.pdf$/u);
    f.store.acceptProposal(project.id, added.action.proposalId);
    const node = f.store.getProject(project.id).canvas.nodes.find(item => item.id === added.block.id)!;
    assert.deepEqual([node.blockType, node.file, node.paper?.id], ['file', { path: added.block.file }, 'arxiv:1706.03762v7']);
    const canvas = await agent.call('ros_read_canvas', {}) as { blocks: { id: string; paper?: { id: string } }[] };
    assert.equal(canvas.blocks.find(block => block.id === node.id)!.paper!.id, 'arxiv:1706.03762v7');
    const twice = await toolkit(f.store, project.id).call('ros_app_call', { app: 'papers', tool: 'add_paper', arguments: { id: '1706.03762' }, summary: 'Add it again', rationale: 'Because.' }) as { existing: { id: string } };
    assert.equal(twice.existing.id, node.id);

    // Agents cannot write a paper's source themselves.
    await assert.rejects(toolkit(f.store, project.id).call('ros_propose_canvas', { summary: 'Fake a paper', rationale: 'Because.', operations: [{ type: 'addNode', node: { id: 'fake', title: 'Fake', description: '', x: 0, y: 0, paper: { source: 'arxiv', id: 'arxiv:2401.00001', link: 'https://arxiv.org/abs/2401.00001' } } }] }));
  } finally { AgentWorkspaceTools.apps = undefined; AgentWorkspaceTools.papers = undefined; AgentWorkspaceTools.folders = undefined; f.close(); }
});

test('The routes list the sources, switch them for agents, search, and add a paper to a project once', async () => {
  const f = fixture();
  const app = express();
  app.use(express.json());
  attachPaperRoutes(app, f.store, f.papers, f.folders);
  app.use(apiErrorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (path: string, method = 'GET', body?: unknown) => { const response = await fetch(`${base}${path}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() as Record<string, unknown> }; };
  try {
    const status = (await call('/api/papers')).body as PapersStatus;
    assert.deepEqual(status.sources.map(source => [source.id, source.available, source.agents]), [['openalex', true, false], ['arxiv', true, false], ['zotero', false, false]]);
    const on = (await call('/api/papers/openalex', 'PUT', { agents: true })).body as PapersStatus;
    assert.equal(on.sources.find(source => source.id === 'openalex')!.agents, true);
    assert.equal((await call('/api/papers/zotero', 'PUT', { agents: true })).status, 400);
    const found = (await call(`/api/papers/search?${new URLSearchParams({ source: 'arxiv', q: 'attention' })}`)).body as PaperSearch;
    assert.equal(found.papers[0].id, 'arxiv:1706.03762v7');
    assert.equal((await call(`/api/papers/search?${new URLSearchParams({ source: 'zotero', q: '' })}`)).status, 409);

    const project = f.store.createProject('Routes');
    f.folders.attach(project.id, join(f.dir, 'Routes'));
    f.folders.shutdown();
    const added = await call(`/api/projects/${project.id}/papers`, 'POST', { paper: 'openalex:W2741809807', parentId: null, x: 96, y: 48 });
    assert.equal(added.status, 201);
    assert.equal(added.body.pdf, true);
    const node = f.store.getProject(project.id).canvas.nodes.find(item => item.id === added.body.nodeId)!;
    assert.deepEqual([node.blockType, node.paper?.doi, node.title], ['file', '10.7717/peerj.4375', OPEN.display_name]);
    const again = await call(`/api/projects/${project.id}/papers`, 'POST', { paper: '10.7717/peerj.4375', x: 0, y: 0 });
    assert.deepEqual([again.status, again.body], [200, { nodeId: node.id, existing: true }]);
    assert.equal((await call(`/api/projects/${project.id}/papers`, 'POST', { paper: 'openalex:W2', x: 0, y: 0, title: 'extra' })).status, 400);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); f.close(); }
});
