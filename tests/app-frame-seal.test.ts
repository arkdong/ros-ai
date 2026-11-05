import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FRAME_TAG, appFlags, appFrameLine } from '../src/shared/apps.js';
import { AppFrames } from '../src/server/app-frames.js';
import { AppKit } from '../src/server/app-kit.js';
import { BrowserService } from '../src/server/browser.js';
import { Store } from '../src/server/store.js';

const ENGINE = new BrowserService(null as unknown as Store, tmpdir()).engine();

test('a frame tag is found however HTML or XML writes it, and nothing else is taken for one', () => {
  for (const html of ['<iframe>', '<IFRAME srcdoc="x">', '<iFrAmE/>', '<frame>', '<frameset>', '<object data="x">', '<embed>', '<fencedframe>', '<portal>', '<html:iframe xmlns:html="http://www.w3.org/1999/xhtml"/>', 'text <iframe', '<iframe\tsrcdoc=x>'])
    assert.equal(APP_FRAME_TAG.test(html), true, html);
  for (const html of ['<iframes>', '<frame-list>', '< iframe>', '&lt;iframe&gt;', '<p>iframe</p>', '</iframe>', '<objects>', '<embedded-chart>', '<iframe\0>'])
    assert.equal(APP_FRAME_TAG.test(html), false, html);
  assert.equal(appFrameLine('<p>one</p>\n<div>\n  <iframe srcdoc="x"></iframe>'), 3);
  assert.equal(appFrameLine('<p>none</p>'), 0);
  assert.deepEqual(appFlags('<p>one</p>\n<IFRAME>'), [{ line: 2, reason: 'holds a frame, so ros.ai will not open the page' }]);
  // Linear on any text: a page of "<a" pieces is read at once.
  const started = Date.now();
  assert.equal(APP_FRAME_TAG.test('<a'.repeat(50_000)), false);
  assert.ok(Date.now() - started < 1_000);
});

/** A page source without a frame tag in it, so ros.ai opens it: tags are spelled with tag('iframe'). */
const page = (script: string, body = '') => `<!doctype html><html><head><title>Seal</title></head><body><div id="host"></div>${body}<script>
const tag = name => '<' + name;
const results = window.results = {};
function attempt(name, run) {
  let threw = null;
  try { run(); } catch (error) { threw = (error && error.name) || String(error); }
  let rtc = 'none';
  if (window.length > 0) { try { rtc = typeof window[0].RTCPeerConnection; } catch { rtc = 'unreachable'; } }
  results[name] = { threw, frames: window.length, rtc };
}
${script}
</script></body></html>`;

const ATTEMPTS: Record<string, string> = {
  append: `attempt('append', () => document.body.appendChild(Object.assign(document.createElement('iframe'), { srcdoc: 'x' })));`,
  offPage: `attempt('offPage', () => { const caption = document.createElement('caption'); caption.appendChild(document.createElement('iframe')); document.body.appendChild(document.createElement('table')).caption = caption; });`,
  innerHTML: `attempt('innerHTML', () => { document.getElementById('host').innerHTML = tag('iframe') + '>'; });`,
  option: `attempt('option', () => { const option = document.createElement('option'); option.innerHTML = tag('iframe') + '>'; document.body.appendChild(document.createElement('select'))[0] = option; });`,
  parsed: `attempt('parsed', () => { const doc = new DOMParser().parseFromString(tag('option') + '>' + tag('iframe') + '></option>', 'text/html'); document.body.appendChild(document.createElement('select'))[0] = doc.querySelector('option'); });`,
  entity: `attempt('entity', () => { const doc = new DOMParser().parseFromString('<!DOCTYPE x [<!ENTITY e "&#60;iframe xmlns=\\'http://www.w3.org/1999/xhtml\\'/>">]><x>&e;</x>', 'application/xml'); const found = doc.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', 'iframe')[0]; window.entityParsed = Boolean(found); if (found) document.body.appendChild(document.importNode(found.parentNode, true)); });`,
  closedShadow: `attempt('closedShadow', () => document.getElementById('host').attachShadow({ mode: 'closed' }).appendChild(document.createElement('iframe')));`,
  shadowOffPage: `attempt('shadowOffPage', () => { const host = document.createElement('div'); host.attachShadow({ mode: 'closed' }).innerHTML = tag('iframe') + '>'; document.body.appendChild(host); });`,
  declarative: `attempt('declarative', () => document.getElementById('host').setHTMLUnsafe(tag('div') + '>' + tag('template') + ' shadowrootmode="closed">' + tag('iframe') + '></template></div>'));`,
  policy: `attempt('policy', () => trustedTypes.defaultPolicy.createHTML(tag('iframe') + '>'));`,
  fragment: `attempt('fragment', () => document.body.appendChild(document.createRange().createContextualFragment(tag('iframe') + '>')));`,
  adjacent: `attempt('adjacent', () => document.body.insertAdjacentHTML('beforeend', tag('iframe') + '>'));`,
  frameset: `attempt('frameset', () => { document.documentElement.innerHTML = tag('frameset') + '>' + tag('frame') + '>'; });`,
  write: `attempt('write', () => { document.write(tag('ifr')); document.write('ame>'); });`,
  insertHTML: `const editable = document.getElementById('host'); editable.contentEditable = 'true'; editable.focus();
    attempt('insertHTML', () => document.execCommand('insertHTML', false, tag('iframe') + '>'));
    // A command that names itself one way when checked and another when run is run as checked.
    attempt('twoFaced', () => { document.execCommand({ toString: (() => { let reads = 0; return () => reads++ ? 'insertHTML' : 'bold'; })() }, false, tag('iframe') + '>'); });`,
  // The page replaces the browser functions a check might lean on, then tries again; it puts them back after.
  replaced: `
    const saved = [[RegExp.prototype, 'exec'], [RegExp.prototype, 'test'], [String.prototype, 'toLowerCase'], [Element.prototype, 'matches'], [Element.prototype, 'querySelectorAll'], [NodeList.prototype, 'item']].map(([owner, name]) => [owner, name, owner[name]]);
    RegExp.prototype.exec = () => null; RegExp.prototype.test = () => false; String.prototype.toLowerCase = () => 'x';
    Object.defineProperty(Array.prototype, '0', { set() {}, configurable: true });
    Element.prototype.matches = () => false; Element.prototype.querySelectorAll = () => []; NodeList.prototype.item = () => null;
    try { Object.defineProperty(Node.prototype, 'appendChild', { value: function () { return 0; } }); } catch {}
    attempt('replaced', () => { const holder = document.createElement('div'); holder.appendChild(document.createElement('iframe')); document.body.append(holder); });
    attempt('replacedHTML', () => { document.getElementById('host').innerHTML = tag('iframe') + '>'; });
    delete Array.prototype[0];
    for (const [owner, name, value] of saved) owner[name] = value;`,
};

test('an App page cannot put a frame anywhere, so WebRTC stays out of reach, and an ordinary page still works', { skip: ENGINE ? false : 'There is no Chrome, Edge or Chromium on this computer.' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ros-app-seal-'));
  const store = new Store(directory);
  const frames = new AppFrames(store, new AppKit(process.cwd()), { browser: new BrowserService(store, directory) });
  const { chromium } = await import('playwright-core');
  const after: (() => Promise<void>)[] = [];
  const browser = await chromium.launch({ executablePath: ENGINE!.path, headless: true });
  try {
    // ros.ai's own page, as far as frames go: it carries the frame rules and holds an App or a map in a frame.
    const host = createServer((req, res) => {
      const framed = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('frame') ?? '';
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': frames.framePolicy() }).end(`<!doctype html><iframe src="${framed.replace(/"/gu, '&quot;')}"></iframe>`);
    });
    await new Promise<void>(done => host.listen(0, '127.0.0.1', done));
    after.push(() => new Promise<void>(done => { host.closeAllConnections(); host.close(() => done()); }));
    const hostPort = (host.address() as AddressInfo).port;
    // Before the App server runs no App page can load, so a map may frame Google's embed directly.
    assert.equal(frames.framePolicy(), 'frame-src https://www.google.com/maps https://www.google.com/maps/');
    assert.throws(() => frames.mapEmbed(null), /still starting/u);
    await frames.start(hostPort);
    const project = store.createProject('Seal');
    let count = 0;
    const open = async (source: string) => {
      const id = `app${++count}`;
      store.mutate(project.id, [{ type: 'addNode', node: { id, title: 'App', description: '', x: 0, y: 0, blockType: 'app', app: { source, inputs: [] } } }], 'Add App');
      const tab = await browser.newPage();
      const response = await tab.goto(frames.grant(project.id, id).url);
      return { tab, response };
    };

    // ros.ai does not open a page whose own HTML holds a frame, and says which line.
    const held = await open('<!doctype html>\n<p>Map</p>\n<IFRAME srcdoc="<script>new RTCPeerConnection()</script>"></IFRAME>');
    assert.equal(held.response?.status(), 422);
    assert.match(await held.response!.text(), /line 3 holds a frame/u);
    await held.tab.close();
    const checked = await frames.check(project.id, { source: '<p>x</p>\n<object data="data:text/html,x"></object>' });
    assert.equal(checked.started, false);
    assert.match(checked.note, /line 2 holds a frame/u);

    for (const [name, script] of Object.entries(ATTEMPTS)) {
      const { tab, response } = await open(page(script));
      assert.equal(response?.status(), 200, name);
      const results = await tab.evaluate(() => (window as unknown as { results: Record<string, { threw: string | null; frames: number; rtc: string }> }).results);
      for (const [attempt, result] of Object.entries(results)) {
        assert.equal(result.frames, 0, `${attempt} put a frame on the page`);
        assert.equal(result.rtc, 'none', attempt);
      }
      for (const [attempt, result] of Object.entries(results)) {
        // Run as checked: "bold", so nothing is refused and no frame appears.
        if (attempt === 'twoFaced') assert.equal(result.threw, null);
        // Chromium may leave an XML entity unexpanded; when it does expand one into a frame, the parse is refused.
        else if (attempt === 'entity') assert.equal(result.threw, await tab.evaluate(() => (window as unknown as { entityParsed?: boolean }).entityParsed === false) ? 'TypeError' : 'NotSupportedError');
        else assert.equal(result.threw, 'NotSupportedError', attempt);
      }
      assert.equal(await tab.evaluate(() => window.length), 0, name);
      await tab.close();
    }

    // Pasted HTML with a frame is refused; with none, it is left to the browser.
    const { tab: pasting } = await open(page(''));
    assert.deepEqual(await pasting.evaluate(([frameTag]) => ['<b>bold</b>', `${frameTag} srcdoc="x">`].map(html => {
      const data = new DataTransfer(); data.setData('text/html', html);
      const event = new ClipboardEvent('paste', { clipboardData: data, cancelable: true, bubbles: true });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    }), ['<iframe']), [false, true]);
    await pasting.close();

    // A javascript: address would make a new page from text, without the kit: the kit's Trusted Types policy stops it.
    for (const leave of ['location.href = address', 'location.assign(address)', "const link = document.createElement('a'); link.href = address; document.body.append(link); link.click()"]) {
      const { tab } = await open(page(`const address = "javascript:'" + tag('script') + ">document.title = typeof RTCPeerConnection</" + "script>'"; setTimeout(() => { ${leave}; }, 0);`));
      await tab.waitForTimeout(600);
      assert.equal(await tab.title(), 'Seal', leave);
      await tab.close();
    }

    // ros.ai's page frames only the App server: an App that sends its frame to Google Maps, with its inputs in the
    // address, is stopped before anything leaves. Maps show Google's embed from a page on the App server instead.
    assert.doesNotMatch(frames.framePolicy(), /google/u);
    const secret = 'secret-from-an-input';
    const id = `app${++count}`;
    store.mutate(project.id, [{ type: 'addNode', node: { id, title: 'App', description: '', x: 0, y: 0, blockType: 'app', app: { source: page(`setTimeout(() => { location.href = 'https://www.google.com/maps/search/${secret}'; }, 50);`), inputs: [] } } }], 'Add App');
    const holder = await browser.newPage(), requested: string[] = [];
    holder.on('request', request => requested.push(request.url()));
    await holder.goto(`http://127.0.0.1:${hostPort}/?frame=${encodeURIComponent(frames.grant(project.id, id, { mainHost: `127.0.0.1:${hostPort}` }).url)}`);
    await holder.waitForTimeout(800);
    assert.deepEqual(requested.filter(url => url.includes(secret)), []);
    await holder.close();
    const embed = frames.mapEmbed({ lat: 52.36, lng: 4.8852, name: 'Rijksmuseum' }, `127.0.0.1:${hostPort}`);
    assert.equal(frames.mapEmbed({ lat: 52.36, lng: 4.8852, name: 'Rijksmuseum' }, `127.0.0.1:${hostPort}`), embed);
    assert.match(embed, /^http:\/\/localhost:\d+\/map\/[A-Za-z0-9_-]{32}$/u);
    const map = await fetch(embed);
    assert.equal(map.status, 200);
    assert.match(map.headers.get('content-security-policy') ?? '', /frame-src https:\/\/www\.google\.com\/maps /u);
    assert.match(await map.text(), /src="https:\/\/www\.google\.com\/maps\?q=52\.360000%2C4\.885200\+%28Rijksmuseum%29&amp;z=16&amp;output=embed"/u);
    assert.equal((await fetch(embed.replace(/[^/]+$/u, 'x'.repeat(32)))).status, 404);

    // An ordinary page: the DOM, HTML without frames, plain document.write, parsed documents and script text all work.
    const { tab: ordinary } = await open(page(`
      document.write('Plain text');
      const host = document.getElementById('host');
      host.innerHTML = '<b>bold</b><table><tr><td>cell</td></tr></table>';
      host.appendChild(document.createElement('p')).textContent = 'paragraph';
      host.insertAdjacentHTML('beforeend', '<i>italic</i>');
      host.append(document.createRange().createContextualFragment('<span>span</span>'));
      host.append(new DOMParser().parseFromString('<u>under</u>', 'text/html').body.firstChild);
      const shadow = document.createElement('div'); shadow.attachShadow({ mode: 'open' }).innerHTML = '<em>shadow</em>'; host.append(shadow);
      const cleared = document.createElement('div'); cleared.innerHTML = '<b>x</b>'; cleared.innerHTML = null;
      const scripted = document.createElement('script'); scripted.textContent = 'window.fromScript = 1'; document.body.append(scripted);
      const button = document.createElement('button'); button.setAttribute('onclick', 'window.clicked = 1'); document.body.append(button); button.click();
      const policy = (() => { try { trustedTypes.createPolicy('mine', { createHTML: text => text }); return 'made'; } catch (error) { return error.name; } })();
      window.ordinary = { text: host.textContent, cleared: cleared.innerHTML, shadow: shadow.shadowRoot.textContent, rtc: typeof RTCPeerConnection, write: document.body.textContent.includes('Plain text'),
        code: [eval('1 + 1'), new Function('return 2')(), window.fromScript, window.clicked].join(), policy };`));
    assert.deepEqual(await ordinary.evaluate(() => (window as unknown as { ordinary: unknown }).ordinary),
      { text: 'boldcellparagraphitalicspanunder', cleared: '', shadow: 'shadow', rtc: 'undefined', write: true, code: '2,2,1,1', policy: 'TypeError' });
    await ordinary.close();
  } finally {
    for (const close of after) await close();
    await browser.close();
    frames.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
