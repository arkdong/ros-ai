import { spawn, type ChildProcess } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Express } from 'express';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { z } from 'zod';
import type { BrowserDownload, BrowserEngine, BrowserStatus } from '../shared/browser.js';
import { openProxy } from './network-gate.js';
import { privateAddress } from './private-address.js';
import { StoreError, type Store } from './store.js';

/** The browser agents use, through Playwright: the Chrome or Edge already on this computer (or Chromium, downloaded
 * once into the data folder) without a window. Each agent turn gets a context of its own, as empty as a new profile:
 * no cookies, logins, saved passwords or history, and gone when the turn ends. Its traffic goes through a proxy that
 * reaches only public addresses, so a page (or a prompt-injected agent) cannot reach ros.ai, other programs on this
 * computer, the local network or a cloud metadata address. Downloads are refused and nothing is uploaded. */

const SETTINGS = 'browser';
const VIEWPORT = { width: 1280, height: 800 };
const NAVIGATION_MS = 30_000, ACTION_MS = 10_000, SESSION_IDLE_MS = 5 * 60_000, SESSION_MAX_MS = 30 * 60_000, BROWSER_IDLE_MS = 60_000;
const MAX_SESSIONS = 3, SNAPSHOT_SLICE = 8_000, FULL_PAGE_HEIGHT = 8_000;
/** Chromium sends WebRTC and QUIC over UDP, past an HTTP proxy; these keep every connection on the proxy. */
const FLAGS = ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp'];
/** What the browser process inherits from ros.ai's environment: never the API keys ros.ai holds. */
const INHERITED = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LANGUAGE|LC_[A-Z_]+|TZ|DISPLAY|WAYLAND_DISPLAY|XDG_[A-Z_]+|DBUS_SESSION_BUS_ADDRESS|FONTCONFIG_[A-Z_]+|SystemRoot|SYSTEMROOT|windir|WINDIR|USERPROFILE|LOCALAPPDATA|APPDATA|ProgramData|PROGRAMDATA|ProgramFiles|PROGRAMFILES|ProgramFiles\(x86\)|PROGRAMFILES\(X86\)|ProgramW6432|ComSpec|COMSPEC|PATHEXT|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE)$/u;
const environment = () => Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && INHERITED.test(name))) as Record<string, string>;

const oneLine = (value: string, limit: number) => { const text = value.replace(/\s+/gu, ' ').trim(); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };
/** Playwright's errors carry a call log and colour codes after their first line. */
const reason = (error: unknown) => oneLine((error instanceof Error ? error.message : String(error)).replace(/\u001b\[[0-9;]*m/gu, '').split('\n')[0].replace(/^[a-zA-Z.]+: /u, ''), 300);
/** A page for the step list: its title as a Markdown link. */
export const pageLink = (title: string, url: string) => `[${oneLine(title || url, 80).replace(/[[\]]/gu, '')}](${url.replace(/[()\s]/gu, char => char === '(' ? '%28' : char === ')' ? '%29' : encodeURIComponent(char))})`;

type Engine = BrowserEngine & { path: string };
type Lookup = (host: string) => Promise<{ address: string }[]>;
type Options = { lookup?: Lookup; isPublic?: (address: string) => boolean; executable?: string | null; roots?: string[] };

const playwrightRoot = () => dirname(createRequire(import.meta.url).resolve('playwright-core/package.json'));
/** The Chromium build this Playwright drives, and where Playwright keeps the builds it downloads. */
function shellRevision(): string | null {
  try { return (JSON.parse(readFileSync(join(playwrightRoot(), 'browsers.json'), 'utf8')) as { browsers: { name: string; revision: string }[] }).browsers.find(item => item.name === 'chromium-headless-shell')?.revision ?? null; }
  catch { return null; }
}
const playwrightCache = () => process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches', 'ms-playwright') : process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright') : join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ms-playwright');

/** Chrome, Edge and Chromium where their installers put them. */
function installed(): Engine[] {
  const mac = (app: string) => ['/Applications', join(homedir(), 'Applications')].map(root => join(root, `${app}.app`, 'Contents', 'MacOS', app));
  const windows = (...parts: string[]) => [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].flatMap(root => root ? [join(root, ...parts)] : []);
  const places: { kind: Engine['kind']; name: string; paths: string[] }[] = process.platform === 'darwin'
    ? [{ kind: 'chrome', name: 'Google Chrome', paths: mac('Google Chrome') }, { kind: 'edge', name: 'Microsoft Edge', paths: mac('Microsoft Edge') }, { kind: 'chromium', name: 'Chromium', paths: mac('Chromium') }]
    : process.platform === 'win32'
      ? [{ kind: 'chrome', name: 'Google Chrome', paths: windows('Google', 'Chrome', 'Application', 'chrome.exe') }, { kind: 'edge', name: 'Microsoft Edge', paths: windows('Microsoft', 'Edge', 'Application', 'msedge.exe') }]
      : [{ kind: 'chrome', name: 'Google Chrome', paths: ['/opt/google/chrome/chrome'] }, { kind: 'edge', name: 'Microsoft Edge', paths: ['/opt/microsoft/msedge/msedge'] }, { kind: 'chromium', name: 'Chromium', paths: ['/usr/lib/chromium/chromium', '/usr/lib/chromium-browser/chromium-browser'] }];
  return places.flatMap(place => place.paths.filter(path => existsSync(path)).slice(0, 1).map(path => ({ kind: place.kind, name: place.name, path })));
}
/** Playwright's own Chromium (the headless shell) under one of its download folders, when the download finished. */
function downloaded(roots: string[]): Engine | null {
  const revision = shellRevision();
  if (!revision) return null;
  for (const root of roots) {
    const folder = join(root, `chromium_headless_shell-${revision}`);
    if (!existsSync(join(folder, 'INSTALLATION_COMPLETE'))) continue;
    try {
      for (const entry of readdirSync(folder)) {
        const path = join(folder, entry, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
        if (entry.startsWith('chrome-headless-shell') && existsSync(path)) return { kind: 'chromium', name: 'Chromium', path };
      }
    } catch { /* an unreadable folder holds no browser */ }
  }
  return null;
}

export class BrowserService {
  private running: Promise<Browser> | null = null;
  private readonly sessions = new Set<BrowserSession>();
  /** App checks open now; they keep the browser running like agent sessions do. */
  private checks = 0;
  private idle?: NodeJS.Timeout;
  private download: BrowserDownload = { state: 'idle' };
  private installer?: ChildProcess;
  private checked: BrowserStatus['checked'] = null;
  private readonly lookup: Lookup;
  private readonly isPublic: (address: string) => boolean;
  /** Where ros.ai downloads Chromium; the person's own Playwright downloads count too. */
  private readonly browsers: string;
  private readonly roots: string[];
  constructor(private readonly store: Store, dataDir: string, private readonly options: Options = {}) {
    this.lookup = options.lookup ?? (host => dnsLookup(host, { all: true, verbatim: true }));
    this.isPublic = options.isPublic ?? (address => !privateAddress(address));
    this.browsers = join(dataDir, 'browsers');
    this.roots = options.roots ?? [this.browsers, ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? [process.env.PLAYWRIGHT_BROWSERS_PATH] : []), playwrightCache()];
  }

  private agentsOn() { return this.store.globalRecord<{ agents?: boolean }>(SETTINGS, 'settings')?.agents === true; }
  /** The browser that runs: ROS_BROWSER_PATH, then Chrome, Edge or Chromium on this computer, then Playwright's Chromium. */
  engine(): Engine | null {
    const path = this.options.executable !== undefined ? this.options.executable : process.env.ROS_BROWSER_PATH?.trim();
    if (path) return existsSync(path) ? { kind: 'chromium', name: 'Chromium', path } : null;
    if (this.options.executable === null) return null;
    return installed()[0] ?? downloaded(this.roots);
  }
  /** Agents get the browser tool while it is on and there is a browser to run it. */
  offered(): boolean { return this.agentsOn() && this.engine() !== null; }
  status(): BrowserStatus {
    const engine = this.engine();
    return { agents: this.agentsOn(), engine: engine ? { kind: engine.kind, name: engine.name } : null, download: this.download, open: this.sessions.size, checked: this.checked };
  }
  setAgents(on: boolean): BrowserStatus {
    if (on && !this.engine()) throw new StoreError('There is no browser to run yet. Download Chromium, or install Google Chrome or Microsoft Edge.', 409);
    this.store.saveGlobalRecord(SETTINGS, 'settings', { agents: on });
    return this.status();
  }

  /** Where one connection may go: a public address, looked up once and kept, or why not. The reason is ASCII
   * because the proxy sends it as an HTTP status line. */
  async address(host: string): Promise<{ address: string } | { reason: string }> {
    const name = host.replace(/^\[|\]$/gu, '').toLowerCase().replace(/\.$/u, '');
    if (!name || !/^[a-z0-9_.:-]+$/u.test(name)) return { reason: 'not a valid address' };
    if (name === 'localhost' || name.endsWith('.localhost')) return { reason: `${name} is on this computer` };
    const addresses = isIP(name) ? [name] : (await this.lookup(name).catch(() => [])).map(item => item.address);
    if (!addresses.length) return { reason: `${name} could not be found` };
    if (addresses.some(item => !this.isPublic(item))) return { reason: `${name} is on this computer or its local network` };
    return { address: addresses[0] };
  }
  /** Refuses an address the browser could not reach anyway, before anything opens. */
  async reachable(url: string) {
    const target = new URL(url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new StoreError('The browser opens http and https addresses only.');
    const to = await this.address(target.hostname);
    if ('reason' in to) throw new StoreError(`The browser cannot open ${target.hostname}: ${to.reason}. It reaches public websites only.`, 403);
  }

  private launch(): Promise<Browser> {
    clearTimeout(this.idle);
    return this.running ??= (async () => {
      const engine = this.engine();
      if (!engine) throw new StoreError('There is no browser to run. Open Plugins › Browser to download Chromium.', 409);
      const { chromium } = await import('playwright-core');
      // Traffic outside the agents' own contexts goes through the same check.
      const proxy = await openProxy(host => this.address(host));
      const options = { executablePath: engine.path, headless: true, proxy: { server: `http://127.0.0.1:${proxy.port}` }, args: FLAGS, env: environment(), timeout: NAVIGATION_MS };
      let browser: Browser;
      try { browser = await chromium.launch({ ...options, chromiumSandbox: true }); }
      catch (error) {
        // Chromium's own sandbox needs user namespaces, which some Linux setups (containers, root) lack.
        if (process.platform !== 'linux') { proxy.close(); throw new StoreError(`${engine.name} did not start: ${reason(error)}`, 503); }
        try { browser = await chromium.launch({ ...options, chromiumSandbox: false }); }
        catch (again) { proxy.close(); throw new StoreError(`${engine.name} did not start: ${reason(again)}`, 503); }
      }
      browser.on('disconnected', () => { proxy.close(); this.running = null; for (const session of [...this.sessions]) void session.close(); });
      return browser;
    })().catch(error => { this.running = null; throw error; });
  }
  /** Closes the browser a minute after its last session, so it holds no memory between turns. */
  private release(session?: BrowserSession) {
    if (session) this.sessions.delete(session);
    if (this.sessions.size || this.checks || !this.running) return;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => { if (!this.sessions.size && !this.checks && this.running) { const running = this.running; this.running = null; void running.then(browser => browser.close()).catch(() => undefined); } }, BROWSER_IDLE_MS);
    this.idle.unref();
  }

  /** A new empty browser context for one agent turn, behind a proxy of its own. */
  async open(): Promise<BrowserSession> {
    if (this.sessions.size >= MAX_SESSIONS) throw new StoreError(`${MAX_SESSIONS} agents are using the browser already. Try again when one finishes.`, 409);
    const browser = await this.launch();
    const refused = new Map<string, string>();
    const proxy = await openProxy(async host => { const to = await this.address(host); if ('reason' in to && refused.size < 20) refused.set(host, to.reason); return to; });
    let context: BrowserContext | undefined, page: Page;
    try {
      context = await browser.newContext({ proxy: { server: `http://127.0.0.1:${proxy.port}` }, acceptDownloads: false, serviceWorkers: 'block', viewport: VIEWPORT, deviceScaleFactor: 1 });
      context.setDefaultTimeout(ACTION_MS); context.setDefaultNavigationTimeout(NAVIGATION_MS);
      page = await context.newPage();
    } catch (error) { await context?.close().catch(() => undefined); proxy.close(); throw new StoreError(`The browser could not open a window: ${reason(error)}`, 503); }
    const session = new BrowserSession(context, page, refused, url => this.reachable(url), () => { proxy.close(); this.release(session); });
    this.sessions.add(session);
    return session;
  }
  /** A window for checking an App page (ros_check_app): an empty context that reaches only ros.ai's own local
   * servers at these origins, never the web, whether or not agents may browse. */
  async checkWindow(origins: string[]): Promise<{ page: Page; close: () => Promise<void> }> {
    const browser = await this.launch();
    this.checks++;
    const allowed = new Set(origins);
    // Playwright sends even this computer's addresses through the proxy, which lets only those through.
    const proxy = await openProxy(async host => { const name = host.replace(/^\[|\]$/gu, '').toLowerCase(); return name === 'localhost' || name === '127.0.0.1' ? { address: '127.0.0.1' } : { reason: 'An App check reaches only ros.ai' }; });
    let context: BrowserContext | undefined;
    const close = async () => { await context?.close().catch(() => undefined); proxy.close(); this.checks--; this.release(); };
    try {
      context = await browser.newContext({ proxy: { server: `http://127.0.0.1:${proxy.port}` }, acceptDownloads: false, serviceWorkers: 'block', viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 });
      context.setDefaultTimeout(ACTION_MS); context.setDefaultNavigationTimeout(NAVIGATION_MS);
      await context.route('**/*', route => { let origin = ''; try { origin = new URL(route.request().url()).origin; } catch { /* refused below */ } return allowed.has(origin) ? route.continue() : route.abort('blockedbyclient'); });
      return { page: await context.newPage(), close };
    } catch (error) { await close(); throw new StoreError(`The browser could not open a window to check the App: ${reason(error)}`, 503); }
  }
  /** Starts the browser once and opens an empty page, so the Plugins page can say it works. */
  async check(): Promise<BrowserStatus> {
    const engine = this.engine();
    if (!engine) throw new StoreError('There is no browser to check yet.', 409);
    try {
      const browser = await this.launch(), context = await browser.newContext();
      await (await context.newPage()).goto('about:blank');
      await context.close();
      this.checked = { ok: true, message: `${engine.name} ${browser.version()} works for agents.` };
      this.release();
    } catch (error) { this.checked = { ok: false, message: error instanceof StoreError ? error.message : `${engine.name} did not start: ${reason(error)}` }; }
    return this.status();
  }
  /** Downloads Playwright's Chromium (the headless shell, about 100 MB) into the data folder with Playwright's own installer. */
  startDownload(): BrowserStatus {
    if (this.installer) return this.status();
    const env = { ...environment(), PLAYWRIGHT_BROWSERS_PATH: this.browsers, ...(process.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
    const child = spawn(process.execPath, [join(playwrightRoot(), 'cli.js'), 'install', 'chromium-headless-shell'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.installer = child;
    this.download = { state: 'downloading', percent: null };
    let tail = '';
    const read = (chunk: Buffer) => {
      const text = chunk.toString('utf8'), percent = [...text.matchAll(/(\d{1,3})% of /gu)].at(-1)?.[1];
      tail = `${tail}${text}`.slice(-4000);
      if (percent) this.download = { state: 'downloading', percent: Math.min(100, Number(percent)) };
    };
    child.stdout?.on('data', read); child.stderr?.on('data', read);
    const finish = (failure?: string) => {
      if (this.installer !== child) return;
      this.installer = undefined;
      const last = tail.split('\n').map(line => line.trim()).filter(line => line && !/% of /u.test(line)).at(-1);
      this.download = !failure && downloaded([this.browsers]) ? { state: 'idle' } : { state: 'failed', message: oneLine(failure ?? last ?? 'The download stopped before it finished.', 300) };
    };
    child.on('error', error => finish(error.message));
    child.on('close', () => finish());
    return this.status();
  }
  async shutdown() {
    this.installer?.kill();
    for (const session of [...this.sessions]) await session.close();
    clearTimeout(this.idle);
    const running = this.running; this.running = null;
    await running?.then(browser => browser.close()).catch(() => undefined);
  }
}

/** The page as the agent reads it: Playwright's accessibility snapshot, whose [ref=e12] marks are what click and fill
 * take, one slice at a time. */
export type PageView = { url: string; title: string; snapshot: string; offset: number; characters: number; more: boolean; tabs: number; refused: string[]; notes: string[] };
type Field = { ref: string; value: string };
const TICKED = /^(true|on|yes|1|checked|ticked)$/iu;

/** One agent turn's browser: its tabs, the latest snapshot (refs point into it), and what happened beside the actions
 * (refused addresses, dialogs, downloads) since the agent last looked. Actions run one at a time. */
export class BrowserSession {
  private page: Page;
  private readonly tabs: Page[] = [];
  /** Set while ros.ai opens a tab itself, which is not news for the agent. */
  private opening = false;
  private snapshot = '';
  private readonly notes: string[] = [];
  /** Passwords typed this turn, kept out of the addresses the agent and the canvas see (a form sent by GET puts them there). */
  private readonly secrets = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private idle?: NodeJS.Timeout;
  private readonly limit: NodeJS.Timeout;
  closed = false;
  /** Why the browser closed itself, for the next action to say. */
  closedBecause: string | null = null;
  constructor(private readonly context: BrowserContext, first: Page, private readonly refused: Map<string, string>, private readonly reachable: (url: string) => Promise<void>, private readonly done: () => void) {
    this.page = first;
    this.watch(first);
    context.on('page', page => {
      if (this.tabs.includes(page)) return;
      this.watch(page); this.page = page;
      if (!this.opening) this.notes.push('The page opened a new tab; the browser now shows it.');
    });
    this.limit = setTimeout(() => void this.close(`it was open for ${SESSION_MAX_MS / 60_000} minutes, the most for one turn`), SESSION_MAX_MS);
    this.limit.unref();
  }
  private watch(page: Page) {
    this.tabs.push(page);
    page.on('close', () => { const at = this.tabs.indexOf(page); if (at >= 0) this.tabs.splice(at, 1); if (this.page === page && this.tabs.length) this.page = this.tabs.at(-1)!; });
    page.on('dialog', dialog => {
      if (this.notes.length < 10) this.notes.push(`The page showed a ${dialog.type()} dialog${dialog.message() ? `: "${oneLine(dialog.message(), 200)}"` : ''}; ros.ai ${dialog.type() === 'beforeunload' ? 'let the page close' : 'dismissed it'}.`);
      void (dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
    });
    page.on('download', download => { if (this.notes.length < 10) this.notes.push(`The page offered a download (${oneLine(download.suggestedFilename(), 80)}); the browser does not keep downloads.`); });
  }
  /** One action at a time; each pushes the idle close further out. A page that closed its last tab gets a new one. */
  private run<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new StoreError(`The browser closed${this.closedBecause ? ` because ${this.closedBecause}` : ''}. Open a page again.`, 409));
    clearTimeout(this.idle);
    const act = async () => {
      if (this.page.isClosed() && !this.tabs.length) { this.opening = true; try { this.page = await this.context.newPage(); } finally { this.opening = false; } }
      return work();
    };
    const next = this.queue.then(act, act);
    this.queue = next.catch(() => undefined).finally(() => {
      if (this.closed) return;
      this.idle = setTimeout(() => void this.close(`it was not used for ${SESSION_IDLE_MS / 60_000} minutes`), SESSION_IDLE_MS);
      this.idle.unref();
    });
    return next;
  }
  /** The element a ref names in the latest snapshot, as the step list says it: link "Pricing". */
  private element(ref: string) {
    const line = this.snapshot.split('\n').find(item => item.includes(`[ref=${ref}]`));
    if (!line) throw new StoreError(`There is no element ${ref} on the page now. Use a ref from the latest snapshot.`);
    const match = /^\s*-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?/u.exec(line);
    return { role: match?.[1] ?? '', name: match ? `${match[1]}${match[2] ? ` "${oneLine(match[2], 60)}"` : ''}` : ref };
  }
  private target(ref: string) { return this.page.locator(`aria-ref=${ref}`); }
  private url(page = this.page) {
    let url = page.url();
    for (const secret of this.secrets) for (const form of new Set([secret, encodeURIComponent(secret), new URLSearchParams({ s: secret }).toString().slice(2)])) url = url.split(form).join('••••••');
    return url;
  }
  /** Lets a click or a key finish what it started: a navigation, then the requests the new page makes, briefly. */
  private async settle() {
    await sleep(250);
    await this.page.waitForLoadState('domcontentloaded', { timeout: NAVIGATION_MS }).catch(() => undefined);
    await this.page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => undefined);
  }
  private async view(offset = 0): Promise<PageView> {
    const page = this.page;
    // A page still navigating can lose its document mid-snapshot; one more try after it settles.
    this.snapshot = await page.ariaSnapshot({ mode: 'ai', timeout: ACTION_MS }).catch(async () => { await sleep(500); return page.ariaSnapshot({ mode: 'ai', timeout: ACTION_MS }).catch(() => ''); });
    const start = Math.min(offset, this.snapshot.length);
    let slice = this.snapshot.slice(start, start + SNAPSHOT_SLICE);
    // A slice ends at a line's end, unless that line alone is longer than a slice.
    if (start + SNAPSHOT_SLICE < this.snapshot.length && slice.lastIndexOf('\n') > SNAPSHOT_SLICE / 2) slice = slice.slice(0, slice.lastIndexOf('\n') + 1);
    const refused = [...this.refused].map(([host, why]) => `${host} (${why})`);
    this.refused.clear();
    const notes = this.notes.splice(0);
    return { url: this.url(page), title: await page.title().catch(() => ''), snapshot: slice, offset: start, characters: this.snapshot.length, more: start + slice.length < this.snapshot.length, tabs: this.tabs.length, refused, notes };
  }
  private failed(what: string, error: unknown): never {
    if (error instanceof StoreError) throw error;
    throw new StoreError(`Could not ${what}: ${reason(error)}`, 409);
  }

  open(url: string) {
    return this.run(async () => {
      await this.reachable(url);
      try { await this.page.goto(url, { waitUntil: 'domcontentloaded' }); } catch (error) { this.failed(`open ${url}`, error); }
      await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
      const view = await this.view();
      return { step: `Opened ${pageLink(view.title, view.url)}`, view };
    });
  }
  click(ref: string) {
    return this.run(async () => {
      const { name } = this.element(ref), before = this.url();
      try { await this.target(ref).click(); } catch (error) { this.failed(`click ${name}`, error); }
      await this.settle();
      const view = await this.view();
      return { step: `Clicked ${name}${view.url !== before ? `, which opened ${pageLink(view.title, view.url)}` : ''}`, view };
    });
  }
  /** Text boxes get the text, a dropdown the option with that label, a checkbox or radio button true or false. */
  fill(fields: Field[], submit: boolean) {
    return this.run(async () => {
      const done: string[] = [];
      for (const field of fields) {
        const { role, name } = this.element(field.ref), target = this.target(field.ref);
        try {
          const kind = await target.evaluate(node => node instanceof HTMLSelectElement ? 'select' : node instanceof HTMLInputElement && node.type === 'password' ? 'password' : node instanceof HTMLInputElement && (node.type === 'checkbox' || node.type === 'radio') ? 'check' : 'text');
          if (kind === 'check' || role === 'checkbox' || role === 'radio' || role === 'switch') { const on = TICKED.test(field.value.trim()); await target.setChecked(on); done.push(`${on ? 'ticked' : 'cleared'} ${name}`); }
          else if (kind === 'select') {
            const options = await target.evaluate(node => node instanceof HTMLSelectElement ? Array.from(node.options, option => ({ value: option.value, label: (option.label || option.text).trim() })) : []);
            const wanted = field.value.trim().toLowerCase();
            const chosen = options.find(option => option.label.toLowerCase() === wanted) ?? options.find(option => option.value === field.value) ?? options.find(option => option.label.toLowerCase().includes(wanted));
            if (!chosen) throw new StoreError(`${name} has no option "${oneLine(field.value, 60)}". Its options: ${options.slice(0, 25).map(option => option.label).join(', ')}.`);
            await target.selectOption({ value: chosen.value });
            done.push(`chose "${oneLine(chosen.label, 60)}" in ${name}`);
          } else {
            await target.fill(field.value);
            if (kind === 'password' && field.value.length >= 4) this.secrets.add(field.value);
            done.push(`${name} with "${kind === 'password' ? '••••••' : oneLine(field.value, 60)}"`);
          }
        } catch (error) { this.failed(`fill ${name}`, error); }
      }
      const before = this.url();
      if (submit) try { await this.target(fields.at(-1)!.ref).press('Enter'); } catch (error) { this.failed('press Enter', error); }
      await this.settle();
      const view = await this.view();
      return { step: `Filled ${done.join(', ')}${submit ? `, then pressed Enter${view.url !== before ? `, which opened ${pageLink(view.title, view.url)}` : ''}` : ''}`, view };
    });
  }
  press(key: string) {
    return this.run(async () => {
      const before = this.url();
      try { await this.page.keyboard.press(key); } catch (error) { this.failed(`press ${key}`, error); }
      await this.settle();
      const view = await this.view();
      return { step: `Pressed ${key}${view.url !== before ? `, which opened ${pageLink(view.title, view.url)}` : ''}`, view };
    });
  }
  scroll(direction: 'down' | 'up') {
    return this.run(async () => {
      try { await this.page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2); await this.page.mouse.wheel(0, (direction === 'up' ? -1 : 1) * VIEWPORT.height * 0.8); } catch (error) { this.failed('scroll', error); }
      await sleep(400);
      return { step: `Scrolled ${direction}`, view: await this.view() };
    });
  }
  /** Back in this tab's history; a tab with none closes, back to the tab that opened it. */
  back() {
    return this.run(async () => {
      try {
        const went = await this.page.goBack({ waitUntil: 'domcontentloaded' });
        if (!went && this.tabs.length > 1) await this.page.close();
        else if (!went) throw new StoreError('There is no earlier page in this tab.');
      } catch (error) { this.failed('go back', error); }
      await this.settle();
      const view = await this.view();
      return { step: `Went back to ${pageLink(view.title, view.url)}`, view };
    });
  }
  wait(text?: string) {
    return this.run(async () => {
      let found = true;
      if (text) await this.page.getByText(text).first().waitFor({ timeout: 10_000 }).catch(() => { found = false; });
      else await sleep(2000);
      if (!found) this.notes.push(`"${oneLine(text!, 80)}" did not appear within 10 seconds.`);
      return { step: text ? `Waited for "${oneLine(text, 60)}"${found ? '' : ', which did not appear'}` : 'Waited a moment', view: await this.view() };
    });
  }
  read(offset: number) { return this.run(async () => ({ step: null, view: await this.view(offset) })); }
  /** What the window shows, or the page from its top (up to 8,000 pixels down), as a PNG. */
  screenshot(fullPage: boolean) {
    return this.run(async () => {
      try {
        const height = fullPage ? Number(await this.page.evaluate('document.documentElement.scrollHeight').catch(() => 0)) : 0;
        const bytes = await this.page.screenshot({ type: 'png', animations: 'disabled', timeout: 20_000, ...(fullPage ? { fullPage: true, ...(height > FULL_PAGE_HEIGHT ? { clip: { x: 0, y: 0, width: VIEWPORT.width, height: FULL_PAGE_HEIGHT } } : {}) } : {}) });
        return { bytes, url: this.url(), title: await this.page.title().catch(() => ''), cut: height > FULL_PAGE_HEIGHT };
      } catch (error) { this.failed('take a screenshot', error); }
    });
  }
  async close(because?: string) {
    if (this.closed) return;
    this.closed = true;
    this.closedBecause = because ?? null;
    clearTimeout(this.idle); clearTimeout(this.limit);
    await this.context.close().catch(() => undefined);
    this.done();
  }
}

export function attachBrowserRoutes(app: Express, browser: BrowserService) {
  app.get('/api/browser', (_req, res) => res.json(browser.status()));
  app.put('/api/browser', (req, res) => res.json(browser.setAgents(z.object({ agents: z.boolean() }).strict().parse(req.body).agents)));
  app.post('/api/browser/check', async (_req, res) => res.json(await browser.check()));
  app.post('/api/browser/download', (_req, res) => res.status(202).json(browser.startDownload()));
}
