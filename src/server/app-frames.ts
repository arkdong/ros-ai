import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Express } from 'express';
import { z } from 'zod';
import { APP_SOURCE_LIMIT, APP_STATE_BYTES, MAX_APP_INPUTS, appFlags, appInputs, appVersion, findReadable, proposedCanvas, readableBlocks, type AppBlock, type AppFrameGrant, type AppInputContent, type AppMode, type AppSession } from '../shared/apps.js';
import { primaryArtifact } from '../shared/blocks.js';
import { artifactTable, columnSummary, type TableData } from '../shared/data-view.js';
import { groupMembers } from '../shared/groups.js';
import { METRIC_TOOLS, metricTable } from '../shared/metrics.js';
import type { Artifact, Canvas, CanvasNode, ProjectDetail } from '../shared/types.js';
import { kindName, textLabel } from '../shared/vocabulary.js';
import { AgentWorkspaceTools } from './agent-tools.js';
import type { AppKit } from './app-kit.js';
import type { BrowserService } from './browser.js';
import { StoreError, type Store } from './store.js';

/** App blocks run their page on a second local server: its own port, on the other loopback name than ros.ai's page
 * (localhost when ros.ai is on 127.0.0.1, and the reverse), so the browser treats it as another site. It serves App
 * pages and the kit and nothing else; the page's own policy seals it (no network, no forms, no pop-ups, no frames),
 * and ros.ai's API refuses anything a sealed page could send. A page sees the project only through the bridge:
 * ros.ai's page asks the server here for the blocks the App names as its inputs, with a token only ros.ai's page holds. */

const SETTINGS = 'apps';
const STATE = 'app-state';
const GRANT_MS = 12 * 60 * 60_000, MAX_GRANTS = 300, MAX_ERRORS = 20, MAX_CALLS = 50;
const TEXT_LIMIT = 60_000, CONTENT_LIMIT = 200_000, TABLE_ROWS = 5_000, TABLE_CELLS = 250_000, IMAGE_BYTES = 4_000_000;
const CHECK_START_MS = 8_000, CHECK_SETTLE_MS = 1_500, OUTLINE_LIMIT = 6_000;
/** The kit runs before any of the page's own code; on the page's first line, so the browser's line numbers stay the page's own. */
const KIT_HEAD = '<!doctype html><meta charset="utf-8"><script src="/kit/ros.js"></script><link rel="stylesheet" href="/kit/ros.css">';
export const framedPage = (source: string) => KIT_HEAD + source.replace(/^﻿?[ \t]*<!doctype[^>]*>/iu, '');

type Grant = {
  token: string; page: string; projectId: string; mode: AppMode; expires: number;
  /** The App on the canvas (or in the pending proposal), or null for a page an agent checks before proposing it. */
  nodeId: string | null; proposalId?: string;
  /** The page as it was when the frame opened; a changed page opens a new frame. */
  source: string; version: string; title: string; url: string;
  /** A checked draft's inputs; an App on the canvas reads its current inputs on every request. */
  draftInputs?: string[];
  started: boolean; errors: string[]; calls: { tool: string; block?: string; ok: boolean; error?: string }[];
};
export type AppError = { at: string; version: string; message: string };
export type AppCheck = {
  version: string; started: boolean; errors: string[]; failedCalls: { tool: string; block?: string; error?: string }[]; reads: string[];
  outline: string; size?: { width: number; height: number }; leaves: { line: number; reason: string }[]; note: string;
};

const bridgeSchema = z.object({ method: z.enum(['initialize', 'read', 'state', 'errors']), params: z.record(z.string(), z.unknown()).default({}) }).strict();
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u);
const clip = (text: string, limit: number) => text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
const summary = (node: CanvasNode): AppBlock => ({ id: node.id, title: node.title, kind: kindName(node) });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A table as the page gets it: one object per row, numbers where a whole column holds numbers. */
function typedTable(data: TableData, extra?: (index: number) => Record<string, string>): NonNullable<AppInputContent['table']> {
  const numeric = new Set(columnSummary(data).filter(column => column.type === 'number').map(column => column.index));
  const limit = Math.min(TABLE_ROWS, Math.floor(TABLE_CELLS / Math.max(1, data.columns.length)));
  const rows = data.rows.slice(0, limit).map((row, index) => ({ ...Object.fromEntries(data.columns.map((column, at) => {
    const cell = row[at] ?? '';
    return [column, !cell.trim() ? null : numeric.has(at) ? Number(cell) : cell];
  })), ...extra?.(index) }));
  return { columns: data.columns, rows, truncated: data.rows.length > rows.length };
}
const imageAddress = (artifact: Artifact) => artifact.mediaType === 'image/png' ? `data:image/png;base64,${artifact.content}` : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(artifact.content)}`;

/** Where Google's keyless map embed lives: the path itself and below it. */
const GOOGLE_EMBED = 'https://www.google.com/maps https://www.google.com/maps/';
export class AppFrames {
  private readonly servers: Server[] = [];
  private port = 0;
  private mainPort = 0;
  private readonly grants = new Map<string, Grant>();
  private readonly pages = new Map<string, Grant>();
  /** The last errors each live App reported, for agents reading the canvas. */
  private readonly recent = new Map<string, AppError[]>();
  constructor(private readonly store: Store, private readonly kit: AppKit, private readonly options: { browser?: BrowserService } = {}) {}

  /** Whether agents are offered App blocks and their tools (Settings › General). Off, their tools are exactly as before. */
  agentsOn(): boolean { return this.store.globalRecord<{ agents?: boolean }>(SETTINGS, 'settings')?.agents === true; }
  settings() { return { agents: this.agentsOn(), running: this.port > 0 }; }
  setAgents(on: boolean) { this.store.saveGlobalRecord(SETTINGS, 'settings', { agents: on }); return this.settings(); }

  /** Starts the App server once ros.ai's own server listens on mainPort, the only page allowed to frame App pages. */
  async start(mainPort: number): Promise<void> {
    this.mainPort = mainPort;
    void this.kit.ready().catch(error => console.error(`  The App kit could not be built: ${message(error)}`));
    for (let attempt = 0; attempt < 5 && !this.port; attempt++) {
      const ipv4 = createServer((req, res) => this.serve(req, res));
      await new Promise<void>((resolve, reject) => { ipv4.once('error', reject); ipv4.listen(0, '127.0.0.1', resolve); });
      const port = (ipv4.address() as AddressInfo).port;
      // Browsers try localhost on ::1 first: the same port there too, or another program on it could answer.
      const ipv6 = createServer((req, res) => this.serve(req, res));
      const taken = await new Promise<boolean>(resolve => {
        ipv6.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'EADDRINUSE'));
        ipv6.listen(port, '::1', () => resolve(false));
      });
      if (taken) { ipv4.close(); continue; }
      this.servers.push(ipv4, ...(ipv6.listening ? [ipv6] : []));
      this.port = port;
    }
    if (!this.port) throw new Error('No free port for App pages.');
  }
  stop() { for (const server of this.servers) server.close(); this.servers.length = 0; this.port = 0; }

  /** The policy ros.ai's own pages carry: frames load only from here. The browser checks it before any navigation of an
   * App's frame, so a page that sends its frame elsewhere (a link, a refresh, a script) is stopped before it asks. Google's
   * keyless map embed (Google Maps blocks without a key) is the one page elsewhere, and only under google.com/maps. */
  framePolicy(): string { return `frame-src ${this.port ? ['localhost', '127.0.0.1'].map(host => `http://${host}:${this.port}`).join(' ') : ''} ${GOOGLE_EMBED}`.replace(/\s+/gu, ' '); }
  /** The other loopback name than the one ros.ai's page is on, so App pages are another site to the browser. */
  private frameHost(mainHost?: string) { return /^localhost(:\d+)?$/iu.test(mainHost ?? '') ? '127.0.0.1' : 'localhost'; }
  private policy(): string {
    const kit = ['localhost', '127.0.0.1'].map(host => `http://${host}:${this.port}/kit/`).join(' ');
    const ancestors = ['127.0.0.1', 'localhost'].map(host => `http://${host}:${this.mainPort}`).join(' ');
    return ['sandbox allow-scripts', "default-src 'none'", `script-src 'unsafe-inline' 'unsafe-eval' ${kit}`, `style-src 'unsafe-inline' ${kit}`, 'img-src data: blob:', `font-src data: ${kit}`,
      'media-src data: blob:', "connect-src 'none'", "worker-src 'none'", "child-src 'none'", "frame-src 'none'", "object-src 'none'", "manifest-src 'none'", "form-action 'none'", "base-uri 'none'",
      `frame-ancestors ${ancestors}`].join('; ');
  }
  private serve(req: IncomingMessage, res: ServerResponse) {
    const end = (status: number, text: string) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(text); };
    // Only these names: a page elsewhere that points its own domain at this computer reaches nothing here.
    if (!['localhost', '127.0.0.1', '[::1]'].some(host => req.headers.host === `${host}:${this.port}`)) return end(421, 'Not an App address.');
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(405, 'App pages are read only.');
    const path = (req.url ?? '/').split('?')[0];
    const page = /^\/app\/([A-Za-z0-9_-]{32})$/u.exec(path);
    if (page) {
      const grant = this.pages.get(page[1]);
      if (!grant || grant.expires < Date.now()) return end(404, 'This App page has closed. Reload the App in ros.ai.');
      const body = Buffer.from(framedPage(grant.source), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Content-Security-Policy': this.policy(), 'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-DNS-Prefetch-Control': 'off', 'Cross-Origin-Resource-Policy': 'cross-origin' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    const kit = /^\/kit\/((?:fonts\/)?[A-Za-z0-9_-]+\.(?:js|css|woff2))$/u.exec(path);
    const file = kit ? this.kit.file(kit[1]) : undefined;
    if (!file) return end(404, 'Not found.');
    // A sealed page has no origin of its own, so the kit is shared with any frame; it holds nothing private.
    res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.body.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Access-Control-Allow-Origin': '*' });
    res.end(req.method === 'HEAD' ? undefined : file.body);
  }

  /** Opens a frame for an App: on the canvas (live), in a pending proposal (preview), or for an agent's check. */
  grant(projectId: string, nodeId: string, options: { proposalId?: string; mainHost?: string } = {}): AppFrameGrant {
    const grant = this.issue(projectId, { nodeId, proposalId: options.proposalId, mode: options.proposalId ? 'preview' : 'live', mainHost: options.mainHost });
    const canvas = this.canvas(grant);
    const inputs = this.inputsOf(grant, canvas);
    return { token: grant.token, url: grant.url, inputs: appInputs(canvas, inputs), readable: readableBlocks(canvas, inputs), version: grant.version };
  }
  private issue(projectId: string, target: { nodeId?: string | null; proposalId?: string; source?: string; inputs?: string[]; title?: string; mode: AppMode; mainHost?: string }): Grant {
    if (!this.port) throw new StoreError('App pages are still starting. Try again in a moment.', 503);
    let source: string, title: string, draftInputs: string[] | undefined;
    if (target.source !== undefined) {
      source = target.source; title = target.title ?? 'App draft'; draftInputs = target.inputs ?? [];
      const canvas = this.store.getProject(projectId).canvas;
      for (const input of draftInputs) if (!canvas.nodes.some(node => node.id === input)) throw new StoreError(`Input ${input} is not a block on the canvas. To check an App that reads blocks you are adding, propose them together and check it with its nodeId.`, 404);
    } else {
      const node = this.appNode(projectId, target.nodeId!, target.proposalId);
      source = node.app?.source ?? ''; title = node.title;
    }
    const now = Date.now();
    for (const [token, grant] of this.grants) if (grant.expires < now || this.grants.size >= MAX_GRANTS) this.revoke(token);
    const token = randomBytes(24).toString('base64url'), page = randomBytes(24).toString('base64url');
    const grant: Grant = { token, page, projectId, mode: target.mode, expires: now + GRANT_MS, nodeId: target.nodeId ?? null, ...(target.proposalId ? { proposalId: target.proposalId } : {}),
      source, version: appVersion(source), title, url: `http://${this.frameHost(target.mainHost)}:${this.port}/app/${page}`, ...(draftInputs ? { draftInputs } : {}), started: false, errors: [], calls: [] };
    this.grants.set(token, grant); this.pages.set(page, grant);
    return grant;
  }
  /** Closes a frame's page and bridge. */
  revoke(token: string) { const grant = this.grants.get(token); if (!grant) return; this.grants.delete(token); this.pages.delete(grant.page); }

  private proposal(projectId: string, proposalId: string) {
    const proposal = this.store.detail(projectId).proposals.find(item => item.id === proposalId);
    if (!proposal || proposal.status !== 'pending') throw new StoreError('This proposal is no longer waiting. Its App runs on the canvas once accepted.', 409);
    return proposal;
  }
  private appNode(projectId: string, nodeId: string, proposalId?: string): CanvasNode {
    const canvas = proposalId ? proposedCanvas(this.store.getProject(projectId).canvas, this.proposal(projectId, proposalId).operations) : this.store.getProject(projectId).canvas;
    const node = canvas.nodes.find(item => item.id === nodeId);
    if (!node || node.blockType !== 'app') throw new StoreError('This App is no longer on the canvas.', 404);
    return node;
  }
  /** The canvas a frame reads from: the project's own, or as a pending proposal would leave it. */
  private canvas(grant: Grant): Canvas {
    const canvas = this.store.getProject(grant.projectId).canvas;
    return grant.proposalId ? proposedCanvas(canvas, this.proposal(grant.projectId, grant.proposalId).operations) : canvas;
  }
  /** What an App may read now: its inputs as they stand, never wider than when its frame opened a draft. */
  private inputsOf(grant: Grant, canvas: Canvas): string[] {
    if (grant.draftInputs) return grant.draftInputs;
    const node = canvas.nodes.find(item => item.id === grant.nodeId);
    if (!node || node.blockType !== 'app') throw new StoreError('This App is no longer on the canvas.', 404);
    return node.app?.inputs ?? [];
  }
  private live(token: string): Grant {
    const grant = this.grants.get(token);
    if (!grant || grant.expires < Date.now()) throw new StoreError('This App page has closed. Reload the App.', 404);
    return grant;
  }
  private key(projectId: string, nodeId: string) { return `${projectId}/${nodeId}`; }

  /** The bridge: what ros.ai's page asks for on behalf of the App in a frame. */
  async bridge(token: string, body: unknown): Promise<unknown> {
    const grant = this.live(token), { method, params } = bridgeSchema.parse(body);
    if (method === 'initialize') {
      const canvas = this.canvas(grant), inputs = this.inputsOf(grant, canvas);
      grant.started = true;
      const session: AppSession = { app: { id: grant.nodeId ?? 'draft', title: grant.title, version: grant.version, mode: grant.mode }, inputs: appInputs(canvas, inputs), readable: readableBlocks(canvas, inputs), state: this.state(grant) };
      return session;
    }
    if (method === 'read') {
      const { block } = z.object({ block: z.string().trim().min(1).max(200) }).strict().parse(params);
      try {
        const content = await this.read(grant, block);
        this.call(grant, { tool: 'read', block: content.id, ok: true });
        return content;
      } catch (error) { this.call(grant, { tool: 'read', block, ok: false, error: message(error) }); throw error; }
    }
    if (method === 'state') {
      const { value } = z.object({ value: z.unknown() }).strict().parse(params);
      const json = JSON.stringify(value ?? null);
      if (Buffer.byteLength(json) > APP_STATE_BYTES) throw new StoreError(`An App keeps at most ${APP_STATE_BYTES / 1000} KB with ros.save.`, 413);
      // A preview or a check keeps nothing; a live App's state is kept out of undo, like layout.
      if (grant.mode !== 'live' || !grant.nodeId) return { saved: false };
      this.store.saveRecord(STATE, this.key(grant.projectId, grant.nodeId), grant.projectId, { value: JSON.parse(json), version: grant.version, savedAt: new Date().toISOString() });
      return { saved: true };
    }
    const { messages } = z.object({ messages: z.array(z.string().max(2000)).min(1).max(MAX_ERRORS) }).strict().parse(params);
    grant.errors.push(...messages); grant.errors.splice(0, Math.max(0, grant.errors.length - MAX_ERRORS));
    if (grant.mode === 'live' && grant.nodeId) {
      const key = this.key(grant.projectId, grant.nodeId), list = this.recent.get(key) ?? [];
      list.push(...messages.map(text => ({ at: new Date().toISOString(), version: grant.version, message: text })));
      this.recent.set(key, list.slice(-MAX_ERRORS));
    }
    return { ok: true };
  }
  private call(grant: Grant, entry: Grant['calls'][number]) { grant.calls.push(entry); grant.calls.splice(0, Math.max(0, grant.calls.length - MAX_CALLS)); }
  private state(grant: Grant): unknown {
    if (!grant.nodeId || grant.mode === 'preview') return null;
    return this.store.record<{ value: unknown }>(STATE, this.key(grant.projectId, grant.nodeId))?.value ?? null;
  }
  /** What a live App last saved with ros.save, for agents reading it. */
  savedState(projectId: string, nodeId: string): unknown { return this.store.record<{ value: unknown }>(STATE, this.key(projectId, nodeId))?.value ?? null; }
  /** The errors a live App reported lately (newest last), for agents reading it. */
  errors(projectId: string, nodeId: string): AppError[] { return this.recent.get(this.key(projectId, nodeId)) ?? []; }

  private async read(grant: Grant, name: string): Promise<AppInputContent> {
    const detail = this.store.detail(grant.projectId);
    const canvas = grant.proposalId ? proposedCanvas(detail.project.canvas, this.proposal(grant.projectId, grant.proposalId).operations) : detail.project.canvas;
    const readable = readableBlocks(canvas, this.inputsOf(grant, canvas)), found = findReadable(readable, name);
    if (!found) throw new StoreError(readable.length ? `This App reads only its inputs: ${readable.slice(0, 12).map(block => `"${block.title}"`).join(', ')}. "${name.slice(0, 80)}" is not one of them.` : 'This App has no inputs yet. Add them in its Inputs tab.', 403);
    return this.content(detail, canvas, canvas.nodes.find(node => node.id === found.id)!);
  }
  /** One block's current content, as an App gets it from ros.read. */
  async content(detail: ProjectDetail, canvas: Canvas, node: CanvasNode): Promise<AppInputContent> {
    const label = textLabel(node), text = clip(node.description, TEXT_LIMIT);
    const base: AppInputContent = { id: node.id, title: node.title, kind: kindName(node), ...(label ? { label } : {}), text: text.text, ...(text.truncated ? { truncated: true } : {}) };
    const projectId = detail.project.id;
    if (node.kind === 'group') return { ...base, members: groupMembers({ nodes: canvas.nodes, connections: [] }, node.id).map(summary) };
    if (node.notion) {
      try {
        const read = await AgentWorkspaceTools.views?.read(node.notion, false, projectId);
        if (!read) return { ...base, live: { notice: 'Notion is not connected here.' } };
        const live = { fetchedAt: read.fetchedAt, link: read.link, ...(read.notice ? { notice: read.notice } : {}) };
        if (read.kind === 'page') { const content = clip(read.content, CONTENT_LIMIT); return { ...base, content: content.text, live, ...(content.truncated ? { truncated: true } : {}) }; }
        const table = typedTable({ columns: read.columns, rows: read.rows.map(row => read.columns.map(column => row[column] ?? '')) }, (index): Record<string, string> => read.rows[index]?.url ? { url: read.rows[index].url } : {});
        return { ...base, table: { ...table, truncated: table.truncated || read.truncated }, live };
      } catch (error) { return { ...base, live: { notice: `Notion could not be read now: ${message(error)}` } }; }
    }
    if (node.google) {
      try {
        const read = await AgentWorkspaceTools.google?.read(node.google, false, projectId);
        if (!read) return { ...base, live: { notice: 'Google Drive is not connected here.' } };
        const live = { fetchedAt: read.fetchedAt, link: read.link, ...(read.notice ? { notice: read.notice } : {}) };
        if (read.kind === 'doc') { const content = clip(read.content, CONTENT_LIMIT); return { ...base, content: content.text, live, ...(content.truncated || read.truncated ? { truncated: true } : {}) }; }
        const table = typedTable({ columns: read.columns, rows: read.rows });
        return { ...base, table: { ...table, truncated: table.truncated || read.truncated }, live };
      } catch (error) { return { ...base, live: { notice: `Google Drive could not be read now: ${message(error)}` } }; }
    }
    if (node.metric) {
      const tool = METRIC_TOOLS[node.metric.source];
      try {
        const read = await AgentWorkspaceTools.metrics?.read(node.metric, false, projectId);
        if (!read) return { ...base, live: { notice: `${tool} numbers are read only in the local app.` } };
        return { ...base, ...metricTable(read), live: { fetchedAt: read.fetchedAt, link: read.link, ...(read.notice ? { notice: read.notice } : {}) } };
      } catch (error) { return { ...base, live: { notice: `${tool} could not be read now: ${message(error)}` } }; }
    }
    if (node.file) {
      const text = detail.artifacts.filter(artifact => artifact.nodeId === node.id && artifact.kind === 'source').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (text) { const content = clip(text.content, CONTENT_LIMIT); return { ...base, content: content.text, version: text.hash, ...(content.truncated ? { truncated: true } : {}) }; }
      try {
        const file = AgentWorkspaceTools.folders?.fileOf(projectId, node.id);
        if (file && file.mediaType.startsWith('image/') && file.size <= IMAGE_BYTES) return { ...base, image: `data:${file.mediaType};base64,${readFileSync(file.absolute).toString('base64')}`, ...(file.hash ? { version: file.hash } : {}) };
      } catch { /* The file is missing; its block says so. */ }
      return base;
    }
    if (node.blockType === 'app' || node.blockType === 'agent') return base;
    const artifact = primaryArtifact(node, detail);
    if (!artifact) return base;
    if (artifact.kind === 'plot') return { ...base, version: artifact.hash, ...(artifact.content.length <= IMAGE_BYTES ? { image: imageAddress(artifact) } : { truncated: true }) };
    if (['table', 'dataset'].includes(artifact.kind)) {
      try { return { ...base, version: artifact.hash, table: typedTable(artifactTable(artifact.content, artifact.kind === 'dataset' || artifact.mediaType === 'text/csv')) }; }
      catch { /* Not a table after all: its text below. */ }
    }
    const content = clip(artifact.content, CONTENT_LIMIT);
    return { ...base, version: artifact.hash, content: content.text, ...(content.truncated ? { truncated: true } : {}) };
  }

  /** ros_check_app: opens an App in a hidden browser with its real inputs and reports what went wrong and what it shows. */
  async check(projectId: string, target: { nodeId?: string; proposalId?: string; source?: string; inputs?: string[]; title?: string }, signal?: AbortSignal): Promise<AppCheck> {
    const browser = this.options.browser;
    if (!browser?.engine()) throw new StoreError('There is no browser on this computer to check an App with. Install Google Chrome or Microsoft Edge, or download Chromium in Plugins › Browser.', 409);
    if (target.source !== undefined && target.source.length > APP_SOURCE_LIMIT) throw new StoreError(`An App page holds at most ${APP_SOURCE_LIMIT / 1000} KB.`);
    if ((target.inputs?.length ?? 0) > MAX_APP_INPUTS) throw new StoreError(`An App reads at most ${MAX_APP_INPUTS} blocks.`);
    const grant = this.issue(projectId, { ...target, mode: 'check', mainHost: `127.0.0.1:${this.mainPort}` });
    const window = await browser.checkWindow([`http://127.0.0.1:${this.mainPort}`, `http://localhost:${this.port}`]);
    try {
      await window.page.goto(`http://127.0.0.1:${this.mainPort}/app-check.html#${encodeURIComponent(JSON.stringify({ token: grant.token, url: grant.url, title: grant.title }))}`, { waitUntil: 'load' });
      for (const started = Date.now() + CHECK_START_MS; !grant.started && Date.now() < started && !signal?.aborted;) await sleep(100);
      if (grant.started) await sleep(CHECK_SETTLE_MS);
      const frame = window.page.frames().find(item => item.url().startsWith(grant.url));
      let outline = '', size: AppCheck['size'];
      if (frame) {
        outline = await frame.locator('body').ariaSnapshot({ timeout: 5_000 }).catch(error => `(The outline could not be read: ${message(error).split('\n')[0]})`);
        size = await frame.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })).catch(() => undefined);
      }
      const failedCalls = grant.calls.filter(call => !call.ok).map(({ ok: _ok, ...call }) => call);
      const leaves = appFlags(grant.source);
      return {
        version: grant.version, started: grant.started, errors: [...grant.errors], failedCalls, reads: [...new Set(grant.calls.filter(call => call.ok && call.block).map(call => call.block!))],
        outline: outline.length > OUTLINE_LIMIT ? `${outline.slice(0, OUTLINE_LIMIT)}\n…` : outline, ...(size ? { size } : {}), leaves,
        note: !grant.started ? 'The page never started the kit: a script error before it ran, or a page that is not HTML. Fix the errors above and check again.'
          : grant.errors.length || failedCalls.length ? 'Fix these errors and check again before asking the person to look.'
          : leaves.length ? 'No errors, but some lines try to leave the frame; the frame blocks them, so the page will not work as written there. Remove them.'
          : 'No errors. The outline is what the page shows, as a screen reader reads it.',
      };
    } finally {
      await window.close();
      this.revoke(grant.token);
    }
  }
}

export function attachAppFrameRoutes(app: Express, frames: AppFrames | undefined) {
  const routeId = (value: unknown) => id.parse(value);
  app.get('/api/apps/settings', (_req, res) => res.json(frames?.settings() ?? { agents: false, running: false }));
  app.put('/api/apps/settings', (req, res) => {
    const { agents } = z.object({ agents: z.boolean() }).strict().parse(req.body);
    if (!frames) throw new StoreError('Apps run in ros.ai on your computer.', 409);
    res.json(frames.setAgents(agents));
  });
  app.post('/api/projects/:id/apps/:nodeId/frame', (req, res) => {
    const { proposalId } = z.object({ proposalId: id.optional() }).strict().parse(req.body ?? {});
    if (!frames) throw new StoreError('Apps run in ros.ai on your computer.', 409);
    res.json(frames.grant(routeId(req.params.id), routeId(req.params.nodeId), { proposalId, mainHost: req.headers.host }));
  });
  app.post('/api/app-bridge/:token', async (req, res) => {
    if (!frames) throw new StoreError('Apps run in ros.ai on your computer.', 409);
    res.json(await frames.bridge(z.string().regex(/^[A-Za-z0-9_-]{32}$/u).parse(req.params.token), req.body));
  });
  app.delete('/api/app-bridge/:token', (req, res) => { frames?.revoke(z.string().regex(/^[A-Za-z0-9_-]{32}$/u).parse(req.params.token)); res.json({ ok: true }); });
}
