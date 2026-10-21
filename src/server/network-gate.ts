import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { isIP, connect, type Socket } from 'node:net';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';

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

type Pending = NetworkRequest & { session: string; resolve: (allowed: boolean) => void; timer: ReturnType<typeof setTimeout> };
type Session = { id: string; projectId: string | null; source: string; once: Set<string>; denied: Set<string> };

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
    return new Promise<boolean>(resolve => {
      const settle = (allowed: boolean) => { (allowed ? session.once : session.denied).add(host); resolve(allowed); };
      if (waiting) { const previous = waiting.resolve; waiting.resolve = allowed => { previous(allowed); settle(allowed); }; return; }
      const request: NetworkRequest = { id: randomUUID(), host, projectId: session.projectId, source: session.source, at: new Date().toISOString() };
      const timer = setTimeout(() => { this.pending.delete(request.id); settle(false); this.emit({ type: 'settled', id: request.id }); }, WAIT_MS);
      timer.unref();
      this.pending.set(request.id, { ...request, session: session.id, resolve: settle, timer });
      this.emit({ type: 'request', request });
    });
  }

  /** A proxy for one sandboxed Python process, on a port of its own. */
  async open(projectId: string | null, source: string): Promise<{ port: number; close: () => void }> {
    const session: Session = { id: randomUUID(), projectId, source, once: new Set(), denied: new Set() };
    const sockets = new Set<Socket>();
    const server: Server = createServer((req, res) => void this.forward(session, req, res));
    server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => void this.tunnel(session, req, client, head));
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('The network proxy could not start.');
    return { port: address.port, close: () => {
      server.close();
      for (const socket of sockets) socket.destroy();
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

  private async tunnel(session: Session, req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    client.on('error', () => client.destroy());
    const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/u.exec(req.url ?? '');
    const port = match ? Number(match[2]) : 0;
    if (!match || port < 1 || port > 65535) { client.end('HTTP/1.1 400 Bad request\r\n\r\n'); return; }
    const target = await this.target(session, match[1]);
    if ('reason' in target) { client.end(`HTTP/1.1 403 ${target.reason.replace(/[\r\n]/gu, ' ')}\r\nContent-Length: 0\r\n\r\n`); return; }
    const upstream = connect(port, target.address, () => {
      client.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    upstream.on('error', () => { if (!client.destroyed) client.end('HTTP/1.1 502 Bad gateway\r\n\r\n'); });
    client.on('close', () => upstream.destroy());
  }

  private async forward(session: Session, req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    let url: URL;
    try { url = new URL(req.url ?? ''); } catch { res.writeHead(400).end(); return; }
    if (url.protocol !== 'http:') { res.writeHead(400).end(); return; }
    const target = await this.target(session, url.hostname);
    if ('reason' in target) { res.writeHead(403, target.reason.replace(/[\r\n]/gu, ' ')).end(); return; }
    const headers = { ...req.headers };
    delete headers['proxy-connection']; delete headers['proxy-authorization'];
    const upstream = httpRequest({ host: target.address, port: Number(url.port || 80), method: req.method, path: `${url.pathname}${url.search}`, headers: { ...headers, host: url.host } }, reply => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  }
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
