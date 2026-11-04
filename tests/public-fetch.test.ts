import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Papers, type Paper } from '../src/server/papers.js';
import { publicFetch, type AddressLookup } from '../src/server/public-fetch.js';
import { Store } from '../src/server/store.js';
import { WebFileFetcher } from '../src/server/web-files.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

/** A service on this computer, the kind a rebinding name would lead to: it counts what reaches it. */
async function localService() {
  const reached: string[] = [];
  const server = createServer((req, res) => {
    reached.push(`${req.headers.host}${req.url}`);
    if (req.url === '/moved') return void res.writeHead(302, { location: '/picture.png' }).end();
    if (req.url === '/zipped') return void res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }).end(gzipSync('unzipped text'));
    if (req.url === '/paper.pdf') return void res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF-1.7 secret');
    res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return { port: (server.address() as AddressInfo).port, reached, close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }) };
}
const answers = (...addresses: string[]): AddressLookup => (_host, callback) => callback(null, addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 })));

test('the public fetch connects only to the public address it checks, so a name that turns private reaches nothing', async () => {
  const service = await localService();
  try {
    // A name that looks this computer up, a mixed answer, and an address written as numbers are all refused.
    await assert.rejects(publicFetch()(`http://localhost:${service.port}/picture.png`), /not on the public internet/u);
    await assert.rejects(publicFetch({ lookup: answers('93.184.216.34', '127.0.0.1') })(`http://mixed.test:${service.port}/`), /not on the public internet/u);
    await assert.rejects(publicFetch()(`http://127.0.0.1:${service.port}/`), /not on the public internet/u);
    await assert.rejects(publicFetch()(`http://[::ffff:7f00:1]:${service.port}/`), /not on the public internet/u);
    await assert.rejects(publicFetch()('file:///etc/passwd'), /Only http and https/u);
    assert.deepEqual(service.reached, []);

    // Where the lookup's answer counts as public, the request goes out by name, redirects come back as they are and
    // compressed bodies arrive unpacked.
    const open = publicFetch({ lookup: answers('127.0.0.1'), isPublic: () => true });
    const moved = await open(`http://site.test:${service.port}/moved`, { redirect: 'manual' });
    assert.deepEqual([moved.status, moved.headers.get('location')], [302, '/picture.png']);
    assert.equal(await (await open(`http://site.test:${service.port}/zipped`)).text(), 'unzipped text');
    assert.deepEqual(Buffer.from(await (await open(`http://site.test:${service.port}/picture.png`)).arrayBuffer()), PNG);
    assert.deepEqual(service.reached, [`site.test:${service.port}/moved`, `site.test:${service.port}/zipped`, `site.test:${service.port}/picture.png`]);
  } finally { await service.close(); }
});

test('a picture or PDF whose name answers public for the check and private for the download is not saved', async () => {
  const service = await localService(), dir = mkdtempSync(join(tmpdir(), 'ros-public-fetch-')), store = new Store(join(dir, 'store'));
  // ros.ai's own check hears a public address; the download's lookup is the computer's, which says localhost.
  const firstAnswer = async () => [{ address: '93.184.216.34' }];
  try {
    await assert.rejects(new WebFileFetcher({ lookup: firstAnswer }).file(`http://localhost:${service.port}/picture.png`), /not on the public internet/u);
    const papers = new Papers(store, { openalex: () => undefined, zotero: () => undefined }, { lookup: firstAnswer });
    const paper = { source: 'openalex', doi: null, zoteroFile: null, pdfs: [`http://localhost:${service.port}/paper.pdf`] } as unknown as Paper;
    const saved = await papers.pdf(paper, ['openalex']);
    assert.ok('problem' in saved, 'the PDF was saved');
    assert.deepEqual(service.reached, []);
  } finally { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
