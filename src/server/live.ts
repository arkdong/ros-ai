import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Store } from './store.js';

export const LIVE_PATH = '/api/live';
/** What the page sends: the project it shows now, or null for none. */
export type LiveWatch = { type: 'watch'; projectId: string | null };
/** What the server sends: this project has writes up to `stamp`. It says that something changed, never what. */
export type LiveChanged = { type: 'changed'; projectId: string; stamp: number };

// A first change is sent almost at once; a burst of writes (an agent's turn) is sent as a few messages a second.
const LEAD_MS = 30, GAP_MS = 300, PING_MS = 30_000;

/**
 * One WebSocket from each open page to this server. The page says which project it shows and is told when anything in
 * it is written, by any window, an agent or the project folder, so it reloads then instead of asking on a timer.
 */
export class LiveChannel {
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  private readonly watching = new Map<WebSocket, string>();
  private readonly alive = new WeakSet<WebSocket>();
  private readonly waiting = new Map<string, { stamp: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly sent = new Map<string, number>();
  private readonly stopListening: () => void;
  private readonly pings: ReturnType<typeof setInterval>;

  constructor(private readonly store: Pick<Store, 'onChange' | 'stamp'>) {
    this.stopListening = store.onChange((projectId, stamp) => this.changed(projectId, stamp));
    // A page that went away without closing (a laptop lid) is dropped at the second ping it does not answer.
    this.pings = setInterval(() => {
      for (const socket of this.sockets.clients) {
        if (!this.alive.has(socket)) { socket.terminate(); continue; }
        this.alive.delete(socket);
        socket.ping();
      }
    }, PING_MS);
    this.pings.unref();
  }

  /**
   * Takes this server's WebSocket requests. Only ros.ai's own page may connect: a WebSocket is not held back by the
   * browser's same-origin rule, so the Origin header is checked here. `shared` leaves other WebSockets on the server
   * alone (Vite's reload socket in development); otherwise they are refused.
   */
  attach(server: Server, shared = false): void {
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      let path = '';
      try { path = new URL(request.url ?? '/', 'http://local').pathname; } catch { /* refused below */ }
      if (path !== LIVE_PATH) { if (!shared) socket.destroy(); return; }
      const host = request.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host) || request.headers.origin !== `http://${host}`) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      this.sockets.handleUpgrade(request, socket, head, accepted => this.accept(accepted));
    });
  }

  private accept(socket: WebSocket): void {
    this.alive.add(socket);
    socket.on('pong', () => this.alive.add(socket));
    socket.on('error', () => socket.terminate());
    socket.on('close', () => this.watching.delete(socket));
    socket.on('message', data => {
      let message: Partial<LiveWatch>;
      try { message = JSON.parse(String(data)) as Partial<LiveWatch>; } catch { return; }
      if (message?.type !== 'watch') return;
      const projectId = message.projectId;
      if (typeof projectId !== 'string' || !projectId || projectId.length > 200) { this.watching.delete(socket); return; }
      this.watching.set(socket, projectId);
      // The newest stamp now: a page that was away (a dropped connection, a restart) sees at once whether it missed anything.
      this.send(socket, { type: 'changed', projectId, stamp: this.store.stamp(projectId) });
    });
  }

  private changed(projectId: string, stamp: number): void {
    const waiting = this.waiting.get(projectId);
    if (waiting) { waiting.stamp = stamp; return; }
    if (![...this.watching.values()].includes(projectId)) return;
    const wait = Math.max(LEAD_MS, (this.sent.get(projectId) ?? 0) + GAP_MS - Date.now());
    const timer = setTimeout(() => {
      const newest = this.waiting.get(projectId)?.stamp ?? stamp;
      this.waiting.delete(projectId);
      this.sent.set(projectId, Date.now());
      for (const [socket, watched] of this.watching) if (watched === projectId) this.send(socket, { type: 'changed', projectId, stamp: newest });
    }, wait);
    timer.unref();
    this.waiting.set(projectId, { stamp, timer });
  }

  private send(socket: WebSocket, message: LiveChanged): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }

  shutdown(): void {
    this.stopListening();
    clearInterval(this.pings);
    for (const { timer } of this.waiting.values()) clearTimeout(timer);
    this.waiting.clear();
    for (const socket of this.sockets.clients) socket.terminate();
    this.sockets.close();
  }
}
