import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Express } from 'express';
import type { BrowserContext, Page, Response } from 'playwright-core';
import { z } from 'zod';
import { POST_PLATFORM_NAMES, SIGNED_IN_PLATFORMS, type SignedInPlatform } from '../shared/posts.js';
import type { SignedInSiteStatus } from '../shared/types.js';
import { environment, FLAGS, reason, type BrowserService } from './browser.js';
import { openProxy } from './network-gate.js';
import { StoreError } from './store.js';

/** ros.ai's own signed-in browser, for sites that show posts only to people who are logged in (Xiaohongshu first).
 * The person logs in once, by hand, in a window ros.ai opens with a browser profile of its own; ros.ai never copies
 * cookies out of the person's own Chrome and hides nothing about being automated. Later reads reuse that profile without
 * a window, one page at a time, at a person's pace, and stop when the site asks for a check that a person is there.
 * Its traffic goes through the same public-addresses-only proxy as the agents' browser. Logging out deletes the
 * profile. */

const NAVIGATION_MS = 30_000, IDLE_MS = 60_000, LOGIN_MAX_MS = 15 * 60_000;
/** Pages a minute, at most: a search every 10 seconds, a post every 4. */
const SEARCH_GAP_MS = 10_000, READ_GAP_MS = 4_000;

type Site = { name: string; home: string; me: RegExp; checkPage: RegExp; account: (body: unknown) => { signedIn: boolean; account?: string } | undefined };
const SITES: Record<SignedInPlatform, Site> = {
  xiaohongshu: {
    name: POST_PLATFORM_NAMES.xiaohongshu,
    home: 'https://www.xiaohongshu.com/explore',
    // Asked by every Xiaohongshu page: who is looking, a guest or a logged-in account.
    me: /\/api\/sns\/web\/v2\/user\/me/u,
    checkPage: /\/(website-login\/(captcha|error)|web-login\/captcha)|verifytype=|\/404\?.*(error_code=300031|source=)/iu,
    account: body => {
      const data = (body as { data?: { guest?: boolean; nickname?: string; user_id?: string } } | undefined)?.data;
      if (!data || typeof data !== 'object') return undefined;
      return data.guest === false || (data.guest === undefined && typeof data.user_id === 'string') ? { signedIn: true, ...(data.nickname ? { account: String(data.nickname).slice(0, 80) } : {}) } : { signedIn: false };
    },
  },
};

type Saved = { signedIn: boolean; account?: string; checkedAt?: string; userAgent?: string; needsCheck?: boolean };
/** One step a read takes in the signed-in browser. */
export type SignedInWork<T> = (page: Page, tools: { gone: () => boolean; site: SignedInPlatform }) => Promise<T>;

export class SignedInBrowser {
  private readonly root: string;
  private readonly open = new Map<SignedInPlatform, { context: Promise<BrowserContext>; headed: boolean; close: () => Promise<void>; idle?: NodeJS.Timeout }>();
  private readonly queues = new Map<SignedInPlatform, Promise<unknown>>();
  private readonly last = new Map<SignedInPlatform, number>();
  constructor(private readonly browser: BrowserService, dataDir: string, private readonly options: { gap?: (kind: 'search' | 'read') => number; prepare?: (context: BrowserContext) => Promise<void> } = {}) {
    this.root = join(dataDir, 'signed-in');
  }

  private folder(site: SignedInPlatform) { return join(this.root, site); }
  private savedFile(site: SignedInPlatform) { return join(this.root, `${site}.json`); }
  private saved(site: SignedInPlatform): Saved {
    try { return JSON.parse(readFileSync(this.savedFile(site), 'utf8')) as Saved; } catch { return { signedIn: false }; }
  }
  private save(site: SignedInPlatform, next: Partial<Saved>) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeFileSync(this.savedFile(site), JSON.stringify({ ...this.saved(site), ...next }), { mode: 0o600 });
  }

  status(): { sites: SignedInSiteStatus[] } {
    const engine = this.browser.engine();
    return { sites: SIGNED_IN_PLATFORMS.map(site => {
      const saved = this.saved(site), open = this.open.get(site);
      return { id: site, name: SITES[site].name, signedIn: saved.signedIn, ...(saved.account ? { account: saved.account } : {}), ...(saved.checkedAt ? { checkedAt: saved.checkedAt } : {}), needsCheck: saved.needsCheck === true, window: open?.headed === true, canWindow: Boolean(engine && !/headless/iu.test(engine.path)) };
    }) };
  }
  signedIn(site: SignedInPlatform) { return this.saved(site).signedIn; }

  /** A context on the site's profile: a window for logging in, or none for reading. Only one at a time per profile. */
  private async start(site: SignedInPlatform, headed: boolean): Promise<BrowserContext> {
    const current = this.open.get(site);
    if (current && current.headed === headed) { clearTimeout(current.idle); return current.context; }
    if (current) await current.close();
    const engine = this.browser.engine();
    if (!engine) throw new StoreError('There is no browser to run. Install Google Chrome, or open Plugins › Browser to download Chromium.', 409);
    if (headed && /headless/iu.test(engine.path)) throw new StoreError('Logging in needs a browser with a window. Install Google Chrome or Microsoft Edge, then try again.', 409);
    const proxy = await openProxy(host => this.browser.address(host));
    mkdirSync(this.folder(site), { recursive: true, mode: 0o700 });
    const userAgent = headed ? undefined : this.saved(site).userAgent;
    const options = { executablePath: engine.path, headless: !headed, proxy: { server: `http://127.0.0.1:${proxy.port}` }, args: FLAGS, env: environment(), timeout: NAVIGATION_MS, acceptDownloads: false, serviceWorkers: 'block' as const, ...(headed ? { viewport: null } : { viewport: { width: 1280, height: 860 } }), ...(userAgent ? { userAgent } : {}) };
    const context = (async () => {
      const { chromium } = await import('playwright-core');
      try { return await chromium.launchPersistentContext(this.folder(site), { ...options, chromiumSandbox: true }); }
      catch (error) {
        if (process.platform !== 'linux') throw new StoreError(`${engine.name} did not start: ${reason(error)}`, 503);
        try { return await chromium.launchPersistentContext(this.folder(site), { ...options, chromiumSandbox: false }); }
        catch (again) { throw new StoreError(`${engine.name} did not start: ${reason(again)}`, 503); }
      }
    })();
    const entry = { context, headed, close: async () => { if (this.open.get(site) === entry) this.open.delete(site); clearTimeout(entry.idle); await context.then(item => item.close()).catch(() => undefined); proxy.close(); } } as { context: Promise<BrowserContext>; headed: boolean; close: () => Promise<void>; idle?: NodeJS.Timeout };
    this.open.set(site, entry);
    try {
      const ready = await context;
      ready.setDefaultNavigationTimeout(NAVIGATION_MS);
      await this.options.prepare?.(ready);
      ready.on('close', () => { if (this.open.get(site) === entry) this.open.delete(site); proxy.close(); });
      return ready;
    } catch (error) { await entry.close(); throw error; }
  }
  private release(site: SignedInPlatform) {
    const current = this.open.get(site);
    if (!current || current.headed) return;
    clearTimeout(current.idle);
    current.idle = setTimeout(() => void current.close(), IDLE_MS);
    current.idle.unref();
  }

  /** Opens a window on the site for the person to log in, by hand. It closes by itself once the site says who is
   * logged in, or when the person closes it. */
  async login(site: SignedInPlatform): Promise<{ sites: SignedInSiteStatus[] }> {
    const rule = SITES[site];
    // Waits for a read in progress to finish, so the profile is not open twice.
    await this.queues.get(site)?.catch(() => undefined);
    const context = await this.start(site, true);
    const page = context.pages()[0] ?? await context.newPage();
    let done = false;
    const finish = setTimeout(() => void this.open.get(site)?.close(), LOGIN_MAX_MS);
    finish.unref();
    context.on('close', () => { clearTimeout(finish); });
    // The person's own browser says what it is; reads without a window later say the same.
    page.evaluate(() => navigator.userAgent).then(agent => this.save(site, { userAgent: String(agent).replace(/HeadlessChrome/gu, 'Chrome') }), () => undefined);
    context.on('response', (response: Response) => {
      if (done || !rule.me.test(response.url())) return;
      void response.json().then(body => {
        const who = rule.account(body);
        if (!who) return;
        this.save(site, { signedIn: who.signedIn, account: who.account, checkedAt: new Date().toISOString(), ...(who.signedIn ? { needsCheck: false } : {}) });
        if (who.signedIn && !done) { done = true; setTimeout(() => void this.open.get(site)?.close(), 2_500).unref(); }
      }, () => undefined);
    });
    await page.goto(rule.home, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    return this.status();
  }

  /** Deletes the site's profile: its login and everything else the site kept. */
  async logout(site: SignedInPlatform): Promise<{ sites: SignedInSiteStatus[] }> {
    await this.open.get(site)?.close();
    await this.queues.get(site)?.catch(() => undefined);
    rmSync(this.folder(site), { recursive: true, force: true });
    rmSync(this.savedFile(site), { force: true });
    return this.status();
  }

  /** Loads the site without a window and asks it who is logged in. */
  async check(site: SignedInPlatform): Promise<{ sites: SignedInSiteStatus[] }> {
    if (!existsSync(this.folder(site))) { this.save(site, { signedIn: false, checkedAt: new Date().toISOString() }); return this.status(); }
    await this.run(site, 'read', async page => {
      let who: { signedIn: boolean; account?: string } | undefined;
      page.on('response', response => { if (SITES[site].me.test(response.url())) void response.json().then(body => { who = SITES[site].account(body) ?? who; }, () => undefined); });
      await page.goto(SITES[site].home, { waitUntil: 'domcontentloaded' });
      for (let waited = 0; !who && waited < 10_000; waited += 250) await page.waitForTimeout(250);
      this.save(site, { signedIn: who?.signedIn ?? false, account: who?.account, checkedAt: new Date().toISOString() });
    }, { signedOut: true });
    return this.status();
  }

  /** One read on the site, in turn with the others and paced like a person, on a page of its own. Refused while the
   * login window is open, before a login, and after the site asked for a check until the person passes it. */
  run<T>(site: SignedInPlatform, kind: 'search' | 'read', work: SignedInWork<T>, options: { signedOut?: boolean } = {}): Promise<T> {
    const name = SITES[site].name;
    const job = (this.queues.get(site) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (this.open.get(site)?.headed) throw new StoreError(`The ${name} window is open. Finish logging in there and close it, then try again.`, 409);
      const saved = this.saved(site);
      if (!options.signedOut && !saved.signedIn) throw new StoreError(`ros.ai is not logged in to ${name}. Ask the person to log in once in Plugins › ${name}; nothing else works until then.`, 401);
      if (!options.signedOut && saved.needsCheck) throw new StoreError(`${name} asked for a check that a person is there. Ask the person to open Plugins › ${name} and press Log in to pass it in the window, then try again.`, 429);
      const gap = this.options.gap?.(kind) ?? (kind === 'search' ? SEARCH_GAP_MS : READ_GAP_MS), wait = (this.last.get(site) ?? 0) + gap - Date.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait + Math.floor(Math.random() * 1_000)));
      const context = await this.start(site, false);
      const page = await context.newPage();
      let gone = false;
      page.on('close', () => { gone = true; });
      try {
        return await work(page, { gone: () => gone, site });
      } catch (error) {
        if (SITES[site].checkPage.test(page.url()) || (error instanceof StoreError && error.status === 429)) {
          this.save(site, { needsCheck: true });
          throw new StoreError(`${name} asked for a check that a person is there, so ros.ai stopped. Ask the person to open Plugins › ${name} and press Log in to pass it in the window.`, 429);
        }
        throw error instanceof StoreError ? error : new StoreError(`${name} did not load: ${reason(error)}`, 502);
      } finally {
        this.last.set(site, Date.now());
        await page.close().catch(() => undefined);
        this.release(site);
      }
    });
    this.queues.set(site, job);
    return job;
  }
  /** Called by a reader that sees the site's check page or its login wall. */
  checkPage(site: SignedInPlatform, url: string) { return SITES[site].checkPage.test(url); }
  signedOut(site: SignedInPlatform) { this.save(site, { signedIn: false }); }
  async shutdown() { for (const site of [...this.open.keys()]) await this.open.get(site)?.close(); }
}

const siteParam = z.enum(SIGNED_IN_PLATFORMS);
export function attachSignedInRoutes(app: Express, signedIn: SignedInBrowser) {
  app.get('/api/signed-in', (_req, res) => res.json(signedIn.status()));
  app.post('/api/signed-in/:site/login', async (req, res) => res.json(await signedIn.login(siteParam.parse(req.params.site))));
  app.post('/api/signed-in/:site/check', async (req, res) => res.json(await signedIn.check(siteParam.parse(req.params.site))));
  app.delete('/api/signed-in/:site', async (req, res) => res.json(await signedIn.logout(siteParam.parse(req.params.site))));
}
