import { APP_PROTOCOL, APP_WATCHDOG_MS, findReadable, type AppInputContent, type AppSession } from '../shared/apps';
import { post } from './api';

/** ros.ai's side of an App frame, without React so the check page (app-check.html) runs the same code.
 * It answers the page's MCP Apps messages (JSON-RPC over postMessage): ui/initialize, and tools/call for the kit's
 * read, watch, save and focus, each read checked by the server against the App's inputs. It pings the page and
 * unloads it when it stops answering, and unloads it when it leaves its own page (a second load). */
export type AppHostEvents = {
  /** The page asked to select a block it reads (ros.focus or a source link). */
  onFocus?: (blockId: string) => void;
  /** Escape inside the page, which hands the map back. */
  onEscape?: () => void;
  /** An error inside the page (uncaught, a rejected promise, console.error), as the kit reports it. */
  onError?: (message: string) => void;
  /** The page started the kit. */
  onReady?: (session: AppSession) => void;
  /** The page was unloaded: it stopped answering, or it tried to leave its page. */
  onStopped?: (reason: 'frozen' | 'left') => void;
};
type Request = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
const text = (value: unknown) => value instanceof Error ? value.message : String(value);

export class AppHost {
  readonly frame: HTMLIFrameElement;
  private session: AppSession | null = null;
  /** Blocks the page watches, with the content it has, so a change sends only what is new. */
  private readonly watched = new Map<string, string>();
  private loads = 0;
  private stopped = false;
  private watchdog = 0;
  private ping: { id: string; at: number } | null = null;
  private pingCount = 0;
  private errors: string[] = [];
  private flush = 0;
  private refreshing: Promise<void> | null = null;
  private again = false;

  constructor(container: HTMLElement, private readonly token: string, url: string, title: string, private readonly events: AppHostEvents = {}) {
    const frame = document.createElement('iframe');
    // Scripts and nothing else: no same-origin access, forms, pop-ups, dialogs, top navigation, downloads or devices.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('allow', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = title;
    frame.className = 'app-frame';
    frame.addEventListener('load', this.loaded);
    window.addEventListener('message', this.received);
    // The address goes on before the frame joins the page, so its first load is the App and not about:blank.
    frame.src = url;
    container.append(frame);
    this.frame = frame;
  }

  /** Unloads the page and stops listening. */
  dispose() {
    if (this.stopped) return;
    this.stopped = true;
    window.clearInterval(this.watchdog); window.clearTimeout(this.flush);
    window.removeEventListener('message', this.received);
    this.frame.removeEventListener('load', this.loaded);
    this.frame.remove();
  }
  private stop(reason: 'frozen' | 'left') {
    if (this.stopped) return;
    this.dispose();
    this.events.onStopped?.(reason);
  }

  private loaded = () => {
    this.loads++;
    // A second load is the page navigating its own frame: away to the web, or reloading itself. Neither is an App's to do.
    if (this.loads > 1) { this.stop('left'); return; }
    window.clearInterval(this.watchdog);
    this.watchdog = window.setInterval(() => {
      // A hidden tab slows both sides' timers, so the watchdog waits until it is shown again.
      if (document.visibilityState !== 'visible') { this.ping = null; return; }
      if (this.ping && Date.now() - this.ping.at >= APP_WATCHDOG_MS) { this.stop('frozen'); return; }
      if (!this.ping) { this.ping = { id: `ping-${++this.pingCount}`, at: Date.now() }; this.send({ id: this.ping.id, method: 'ping', params: {} }); }
    }, APP_WATCHDOG_MS / 2);
  };

  private send(message: Omit<Request, 'jsonrpc'>) { if (!this.stopped) this.frame.contentWindow?.postMessage({ jsonrpc: '2.0', ...message }, '*'); }
  private bridge<T>(method: 'initialize' | 'read' | 'state' | 'errors', params: Record<string, unknown> = {}) { return post<T>(`/api/app-bridge/${this.token}`, { method, params }); }

  private received = (event: MessageEvent) => {
    if (this.stopped || event.source !== this.frame.contentWindow) return;
    const message = event.data as Request;
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return;
    if (typeof message.method !== 'string') {
      if (this.ping && message.id === this.ping.id) this.ping = null;
      return;
    }
    if (message.id === undefined) { this.notified(message.method, message.params ?? {}); return; }
    const id = message.id;
    void this.answer(message.method, message.params ?? {}).then(result => this.send({ id, result }), error => this.send({ id, error: { code: -32000, message: text(error) } }));
  };
  private notified(method: string, params: Record<string, unknown>) {
    if (method === 'ros/escape') this.events.onEscape?.();
    else if (method === 'notifications/message' && params.level === 'error') this.report(String(params.data ?? 'Error').slice(0, 2000));
  }
  /** Errors reach the block's footer at once, and the server (for agents) a second later in one batch. */
  private report(message: string) {
    this.events.onError?.(message);
    if (this.errors.length < 20) this.errors.push(message);
    window.clearTimeout(this.flush);
    this.flush = window.setTimeout(() => { const messages = this.errors.splice(0); if (messages.length) void this.bridge('errors', { messages }).catch(() => undefined); }, 1000);
  }

  private async answer(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'ui/initialize') {
      const session = await this.bridge<AppSession>('initialize');
      this.session = session;
      this.events.onReady?.(session);
      return { protocolVersion: APP_PROTOCOL, hostInfo: { name: 'ros.ai', version: '1' }, hostCapabilities: { serverTools: {} }, hostContext: { theme: 'light', displayMode: 'inline', availableDisplayModes: ['inline'], ros: session } };
    }
    if (method === 'ping') return {};
    if (method !== 'tools/call') throw new Error(`ros.ai does not answer ${method.slice(0, 60)}.`);
    const name = String(params.name ?? ''), args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const value = await this.tool(name, args);
      return { content: [{ type: 'text', text: typeof value === 'object' ? JSON.stringify(value).slice(0, 2000) : String(value) }], structuredContent: value };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: text(error) }] }; }
  }
  private async tool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const block = typeof args.block === 'string' ? args.block : '';
    if (name === 'read' || name === 'watch') {
      const content = await this.bridge<AppInputContent>('read', { block });
      if (name === 'watch') this.watched.set(content.id, JSON.stringify(content));
      return content;
    }
    if (name === 'save') return this.bridge('state', { value: args.value ?? null });
    if (name === 'focus') {
      const found = this.session ? findReadable(this.session.readable, block) : undefined;
      if (!found) throw new Error(`"${block.slice(0, 80)}" is not a block this App reads.`);
      this.events.onFocus?.(found.id);
      return { focused: found.id };
    }
    throw new Error(`ros.ai has no tool called ${name.slice(0, 60)} for Apps.`);
  }

  /** The project changed: watched blocks are read again and sent when their content is new. */
  changed() {
    if (this.stopped || !this.watched.size) return;
    if (this.refreshing) { this.again = true; return; }
    this.refreshing = (async () => {
      for (const id of [...this.watched.keys()]) {
        try {
          const content = await this.bridge<AppInputContent>('read', { block: id }), json = JSON.stringify(content);
          if (json !== this.watched.get(id)) { this.watched.set(id, json); this.send({ method: 'ros/input-changed', params: { content } }); }
        } catch { /* The block left the App's inputs; the page keeps what it had. */ }
      }
    })().finally(() => { this.refreshing = null; if (this.again) { this.again = false; this.changed(); } });
  }
}
