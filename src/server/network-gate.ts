import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { isIP, connect, type Socket } from 'node:net';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';

import type { PythonRuntime, PythonSetupEvent } from './local-python.js';
import type { Store } from './store.js';

/** Network for sandboxed Python, the way Claude Code gives its sandbox network: the sandbox may reach only a proxy
 * on this computer, and the proxy lets a site through only when it is on the project's list, the person allows it
 * once, or Settings says Full network. Package installs from PyPI are always allowed. */

export type NetworkMode = 'ask' | 'full';
export type NetworkChoice = 'once' | 'always' | 'deny';
export type NetworkRequest = { id: string; host: string; projectId: string | null; source: string; at: string };
export type NetworkEvent = { type: 'request'; request: NetworkRequest } | { type: 'settled'; id: string };

const SETTINGS = 'python-network';
const SITES = 'python-network-sites';
/** pip needs these to install packages. */
export const PRESET_SITES = ['pypi.org', 'files.pythonhosted.org'];
const WAIT_MS = 120_000;

const hostSchema = z.string().min(1).max(253).regex(/^[a-z0-9.-]+$|^\[?[0-9a-f:.]+\]?$/iu);
const blockedAddress = (address: string) => {
  const ip = address.replace(/^::ffff:/iu, '');
  // ros.ai itself and other services on this computer stay out of reach, so a cell cannot call ros.ai's own API.
  return /^127\.|^0\.|^169\.254\./u.test(ip) || ip === '::1' || ip === '::' || /^fe80:/iu.test(ip);
};

/** One Python process's proxy. `waiting` is true while a site waits for the person, so wall-clock limits can pause. */
export type NetworkSession = { port: number; waiting: () => boolean; close: () => void };
type Pending = NetworkRequest & { session: string; resolve: (allowed: boolean) => void; timer: ReturnType<typeof setTimeout> };
type Session = { id: string; projectId: string | null; source: string; once: Set<string>; denied: Set<string>; waiting: number };

export class NetworkGate {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: NetworkEvent) => void>();

  constructor(private readonly store: Store) {}

  mode(): NetworkMode { return this.store.globalRecord<{ mode: NetworkMode }>(SETTINGS, 'settings')?.mode === 'full' ? 'full' : 'ask'; }
  setMode(mode: NetworkMode): NetworkMode { this.store.saveGlobalRecord(SETTINGS, 'settings', { mode }); return mode; }
  sites(projectId: string | null): string[] { return projectId ? this.store.record<{ hosts: string[] }>(SITES, projectId)?.hosts ?? [] : []; }
  private remember(projectId: string, host: string): void {
    const hosts = this.sites(projectId);
    if (!hosts.includes(host)) this.store.saveRecord(SITES, projectId, projectId, { hosts: [...hosts, host].sort() });
  }
  forget(projectId: string, host: string): string[] {
    const hosts = this.sites(projectId).filter(item => item !== host);
    this.store.saveRecord(SITES, projectId, projectId, { hosts });
    return hosts;
  }
  requests(): NetworkRequest[] { return [...this.pending.values()].map(({ resolve: _, timer: __, session: ___, ...request }) => request); }
  subscribe(listener: (event: NetworkEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: NetworkEvent): void { for (const listener of this.listeners) try { listener(event); } catch { /* a closed stream */ } }

  /** The person's answer to one waiting request. */
  answer(id: string, choice: NetworkChoice): void {
    const item = this.pending.get(id);
    if (!item) return;
    clearTimeout(item.timer);
    this.pending.delete(id);
    if (choice === 'always' && item.projectId) this.remember(item.projectId, item.host);
    item.resolve(choice !== 'deny');
    this.emit({ type: 'settled', id });
  }

  private allowed(session: Session, host: string): Promise<boolean> {
    if (this.mode() === 'full' || PRESET_SITES.includes(host) || session.once.has(host) || this.sites(session.projectId).includes(host)) return Promise.resolve(true);
    if (session.denied.has(host)) return Promise.resolve(false);
    // Requests for the same site from one session share the question.
    const waiting = [...this.pending.values()].find(item => item.host === host && item.projectId === session.projectId);
    session.waiting++;
    return new Promise<boolean>(resolve => {
      const settle = (allowed: boolean) => { session.waiting--; (allowed ? session.once : session.denied).add(host); resolve(allowed); };
      if (waiting) { const previous = waiting.resolve; waiting.resolve = allowed => { previous(allowed); settle(allowed); }; return; }
      const request: NetworkRequest = { id: randomUUID(), host, projectId: session.projectId, source: session.source, at: new Date().toISOString() };
      const timer = setTimeout(() => { this.pending.delete(request.id); settle(false); this.emit({ type: 'settled', id: request.id }); }, WAIT_MS);
      timer.unref();
      this.pending.set(request.id, { ...request, session: session.id, resolve: settle, timer });
      this.emit({ type: 'request', request });
    });
  }

  /** A proxy for one sandboxed Python process, on a port of its own. */
  async open(projectId: string | null, source: string): Promise<NetworkSession> {
    const session: Session = { id: randomUUID(), projectId, source, once: new Set(), denied: new Set(), waiting: 0 };
    const proxy = await openProxy(host => this.target(session, host));
    return { port: proxy.port, waiting: () => session.waiting > 0, close: () => {
      proxy.close();
      for (const item of this.pending.values()) if (item.session === session.id) this.answer(item.id, 'deny');
    } };
  }

  /** The address to connect to, or why not: a refused site, or an address on this computer. */
  private async target(session: Session, host: string): Promise<{ address: string } | { reason: string }> {
    const name = host.replace(/^\[|\]$/gu, '').toLowerCase().replace(/\.$/u, '');
    if (!hostSchema.safeParse(name).success) return { reason: 'not a valid site' };
    if (name === 'localhost' || name.endsWith('.localhost') || (isIP(name) && blockedAddress(name))) return { reason: `${name} is on this computer, which sandboxed Python cannot reach` };
    if (!await this.allowed(session, name)) return { reason: `${name} is not allowed by ros.ai` };
    let address = name;
    if (!isIP(name)) {
      try { address = (await lookup(name)).address; } catch { return { reason: `${name} could not be found` }; }
    }
    if (blockedAddress(address)) return { reason: `${name} is on this computer, which sandboxed Python cannot reach` };
    return { address };
  }
}

/** Where one connection may go: the address to connect to, looked up once so the name cannot point elsewhere between
 * the check and the connection, or why not. */
export type ProxyTarget = (host: string) => Promise<{ address: string } | { reason: string }>;

/** An HTTP proxy on this computer for one program (a sandboxed Python process, an agent's browser), on a port of its own:
 * every connection goes only where `target` says. */
export async function openProxy(target: ProxyTarget): Promise<{ port: number; close: () => void }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => void forward(target, req, res));
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => void tunnel(target, req, client, head));
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The network proxy could not start.');
  return { port: address.port, close: () => {
    server.close();
    for (const socket of sockets) socket.destroy();
  } };
}

async function tunnel(target: ProxyTarget, req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
  client.on('error', () => client.destroy());
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/u.exec(req.url ?? '');
  const port = match ? Number(match[2]) : 0;
  if (!match || port < 1 || port > 65535) { client.end('HTTP/1.1 400 Bad request\r\n\r\n'); return; }
  const to = await target(match[1]);
  if ('reason' in to) { client.end(`HTTP/1.1 403 ${to.reason.replace(/[\r\n]/gu, ' ')}\r\nContent-Length: 0\r\n\r\n`); return; }
  const upstream = connect(port, to.address, () => {
    client.write('HTTP/1.1 200 Connection established\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(client); client.pipe(upstream);
  });
  upstream.on('error', () => { if (!client.destroyed) client.end('HTTP/1.1 502 Bad gateway\r\n\r\n'); });
  client.on('close', () => upstream.destroy());
}

async function forward(target: ProxyTarget, req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
  let url: URL;
  try { url = new URL(req.url ?? ''); } catch { res.writeHead(400).end(); return; }
  if (url.protocol !== 'http:') { res.writeHead(400).end(); return; }
  const to = await target(url.hostname);
  if ('reason' in to) { res.writeHead(403, to.reason.replace(/[\r\n]/gu, ' ')).end(); return; }
  const headers = { ...req.headers };
  delete headers['proxy-connection']; delete headers['proxy-authorization'];
  const upstream = httpRequest({ host: to.address, port: Number(url.port || 80), method: req.method, path: `${url.pathname}${url.search}`, headers: { ...headers, host: url.host } }, reply => {
    res.writeHead(reply.statusCode ?? 502, reply.headers);
    reply.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(upstream);
}

const choiceSchema = z.object({ choice: z.enum(['once', 'always', 'deny']) }).strict();
const modeSchema = z.object({ mode: z.enum(['ask', 'full']) }).strict();

export function attachNetworkRoutes(app: Express, gate: NetworkGate): void {
  app.get('/api/python-network', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : null;
    res.json({ mode: gate.mode(), preset: PRESET_SITES, sites: gate.sites(projectId), requests: gate.requests() });
  });
  app.put('/api/python-network', (req, res) => res.json({ mode: gate.setMode(modeSchema.parse(req.body).mode) }));
  app.post('/api/python-network/requests/:id', (req, res) => { gate.answer(z.string().uuid().parse(req.params.id), choiceSchema.parse(req.body).choice); res.json({ ok: true }); });
  app.delete('/api/python-network/sites/:projectId/:host', (req, res) => res.json({ sites: gate.forget(z.string().max(128).parse(req.params.projectId), hostSchema.parse(req.params.host)) }));
  app.get('/api/python-network/events', (req: Request, res: Response) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    for (const request of gate.requests()) res.write(`data: ${JSON.stringify({ type: 'request', request } satisfies NetworkEvent)}\n\n`);
    const unsubscribe = gate.subscribe(event => res.write(`data: ${JSON.stringify(event)}\n\n`));
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    req.on('close', () => { clearInterval(keepAlive); unsubscribe(); });
  });
}

/** The one-time Python setup, streamed to the notice that explains it. */
export function attachPythonSetupRoute(app: Express, runtime: PythonRuntime): void {
  app.get('/api/python/setup/events', (req: Request, res: Response) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const current = runtime.setup();
    if (current) res.write(`data: ${JSON.stringify(current)}\n\n`);
    const unsubscribe = runtime.subscribe((event: PythonSetupEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`));
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    req.on('close', () => { clearInterval(keepAlive); unsubscribe(); });
  });
}
