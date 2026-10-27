/**
 * The ros.ai kit: the first script of every App page, served from the frame's own local address as /kit/ros.js.
 * It removes the browser's peer-to-peer connection API, then talks to ros.ai through the parent window in the
 * MCP Apps message format (JSON-RPC over postMessage), where ros.ai's requests are tools: read, watch, save, focus.
 * The frame itself is the boundary (sandbox, CSP connect-src 'none', its own origin); the kit is a convenience.
 */
import { APP_PROTOCOL, APP_STATE_BYTES, type AppBlock, type AppInputContent, type AppSession } from '../shared/apps.js';

type Row = Record<string, unknown>;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: number };
type ToolResult = { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };

// Before any of the page's own code runs: no WebRTC, the one network path a Content-Security-Policy does not close.
for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver']) {
  try { Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false }); } catch { /* already gone */ }
}

const host = window.parent, embedded = host !== window;
const waiting = new Map<number, Pending>();
let nextId = 1;
const post = (message: object) => { if (embedded) host.postMessage({ jsonrpc: '2.0', ...message }, '*'); };
function request<T>(method: string, params: unknown = {}): Promise<T> {
  if (!embedded) return Promise.reject(new Error('This page runs inside ros.ai, on an App block.'));
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => { if (waiting.delete(id)) reject(new Error(`ros.ai did not answer ${method}.`)); }, 30_000);
    waiting.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    post({ id, method, params });
  });
}
const notify = (method: string, params: unknown = {}) => post({ method, params });

const text = (value: unknown) => value instanceof Error ? value.message : typeof value === 'string' ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
/** Errors reach ros.ai, which shows them on the block's footer and to agents that check the page. */
function report(message: string) { notify('notifications/message', { level: 'error', logger: 'app', data: message.slice(0, 2000) }); }
window.addEventListener('error', event => report(`${event.message || 'Error'}${event.lineno ? ` (line ${event.lineno})` : ''}`));
window.addEventListener('unhandledrejection', event => report(`Unhandled: ${text(event.reason)}`));
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => { report(args.map(text).join(' ')); consoleError(...args); };
// Escape hands the map back, unless the page used it itself.
window.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented) notify('ros/escape'); });

const watchers = new Map<string, Set<(content: AppInputContent) => void>>();
window.addEventListener('message', event => {
  if (event.source !== host || !embedded) return;
  const message = event.data as { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
  if (!message || message.jsonrpc !== '2.0') return;
  if (typeof message.method === 'string') {
    if (message.method === 'ping' && message.id !== undefined) post({ id: message.id, result: {} });
    else if (message.method === 'ui/resource-teardown' && message.id !== undefined) post({ id: message.id, result: {} });
    else if (message.method === 'ros/input-changed') {
      const content = message.params?.content as AppInputContent | undefined;
      if (content) for (const callback of watchers.get(content.id) ?? []) try { callback(content); } catch (error) { report(text(error)); }
    }
    return;
  }
  const pending = typeof message.id === 'number' ? waiting.get(message.id) : undefined;
  if (!pending) return;
  waiting.delete(message.id as number); window.clearTimeout(pending.timer);
  if (message.error) pending.reject(new Error(message.error.message ?? 'ros.ai refused the request.'));
  else pending.resolve(message.result);
});

async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  await ready;
  const result = await request<ToolResult>('tools/call', { name, arguments: args });
  if (result.isError) throw new Error(result.content?.find(item => item.type === 'text')?.text ?? `${name} failed.`);
  return result.structuredContent;
}

let session: AppSession | null = null;
const ready: Promise<AppSession> = request<{ hostContext?: { ros?: AppSession; theme?: string } }>('ui/initialize', { protocolVersion: APP_PROTOCOL, appInfo: { name: 'ros.ai app', version: '1' }, appCapabilities: {} })
  .then(result => {
    const value = result.hostContext?.ros;
    if (!value) throw new Error('ros.ai did not start this App.');
    session = value;
    Object.assign(ros, { app: value.app, inputs: value.inputs, mode: value.app.mode, state: value.state ?? null });
    if (result.hostContext?.theme) document.documentElement.dataset.theme = result.hostContext.theme;
    notify('ui/notifications/initialized');
    return value;
  });
ready.catch(error => report(text(error)));

let saving: { value: unknown; timer: number; done: Promise<void>; finish: () => void } | null = null;
/** Keeps a small JSON value on the block (filters, answers, a selection), saved shortly after the last change.
 * A proposal's preview keeps it only while the page is open. */
function save(value: unknown): Promise<void> {
  const json = JSON.stringify(value ?? null);
  if (new TextEncoder().encode(json).length > APP_STATE_BYTES) return Promise.reject(new Error(`ros.save keeps at most ${APP_STATE_BYTES / 1000} KB.`));
  ros.state = JSON.parse(json);
  if (saving) { window.clearTimeout(saving.timer); saving.value = ros.state; }
  else { let finish = () => {}; const done = new Promise<void>(resolve => { finish = resolve; }); saving = { value: ros.state, timer: 0, done, finish }; }
  const current = saving;
  current.timer = window.setTimeout(() => { saving = null; void call('save', { value: current.value }).catch(error => report(text(error))).finally(current.finish); }, 300);
  return current.done;
}

/** A block the page may read, by ID or title. */
const known = (block: string): AppBlock | undefined => {
  const plain = (value: string) => value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
  return session?.readable.find(item => item.id === block) ?? session?.readable.find(item => plain(item.title) === plain(block));
};

function watch(block: string, callback: (content: AppInputContent) => void): () => void {
  let stopped = false, id: string | undefined;
  void call('watch', { block }).then(value => {
    const content = value as AppInputContent;
    if (stopped) return;
    id = content.id;
    if (!watchers.has(id)) watchers.set(id, new Set());
    watchers.get(id)!.add(callback);
    callback(content);
  }).catch(error => report(`ros.watch('${block}'): ${text(error)}`));
  return () => { stopped = true; if (id) watchers.get(id)?.delete(callback); };
}

// Ready parts, in ros.ai's look (ros.css).
type Child = Node | string | number | null | undefined | false | Child[];
function el(tag: string, props: Record<string, unknown> | null = {}, ...children: Child[]): HTMLElement {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key === 'style' && typeof value === 'object') Object.assign(element.style, value);
    else if (key === 'class' || key === 'className') element.className = String(value);
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  const add = (child: Child) => { if (Array.isArray(child)) child.forEach(add); else if (child !== null && child !== undefined && child !== false) element.append(child instanceof Node ? child : String(child)); };
  children.forEach(add);
  return element;
}

const format = {
  number: (value: unknown, digits = 2) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : value === null || value === undefined ? '' : String(value),
  percent: (value: unknown, digits = 0) => typeof value === 'number' ? value.toLocaleString(undefined, { style: 'percent', maximumFractionDigits: digits }) : String(value ?? ''),
  date: (value: unknown) => { const date = new Date(String(value)); return Number.isNaN(date.getTime()) ? String(value ?? '') : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); },
};
const cell = (value: unknown) => typeof value === 'number' ? format.number(value) : value === null || value === undefined ? '' : String(value);
/** Columns of years and codes, whose numbers read without thousands separators (2021, not 2,021). */
function plainColumns(rows: Row[], columns: string[]): Set<string> {
  const yearly = (value: unknown) => value === null || value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 1800 && value <= 2100);
  return new Set(columns.filter(column => /year|jaar|jahr|année|año|\bid\b|code/iu.test(column) || (rows.some(row => typeof row[column] === 'number') && rows.every(row => yearly(row[column])))));
}
const cellText = (value: unknown, plain: boolean) => plain && typeof value === 'number' ? String(value) : cell(value);
const rowsOf = (input: Row[] | AppInputContent | { columns?: string[]; rows: Row[] }): { columns?: string[]; rows: Row[] } =>
  Array.isArray(input) ? { rows: input } : 'table' in input && input.table ? input.table : 'rows' in input ? input as { columns?: string[]; rows: Row[] } : { rows: [] };

/** A sortable table. rows: an array of objects, a Data block from ros.read, or {columns, rows}. */
function table(input: Row[] | AppInputContent | { columns?: string[]; rows: Row[] }, options: { columns?: string[]; limit?: number; onRow?: (row: Row) => void; caption?: string } = {}): HTMLElement {
  const { columns: given, rows } = rowsOf(input);
  const columns = options.columns ?? given ?? [...new Set(rows.flatMap(row => Object.keys(row)))];
  const plain = plainColumns(rows, columns), wrapper = el('div', { class: 'ros-table' });
  let sortKey: string | null = null, descending = false;
  const compare = (a: Row, b: Row) => {
    const x = a[sortKey!], y = b[sortKey!];
    const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true });
    return descending ? -order : order;
  };
  const render = () => {
    const sorted = sortKey ? [...rows].sort(compare) : rows, limit = options.limit ?? 500, shown = sorted.slice(0, limit);
    wrapper.replaceChildren(...[
      el('table', {},
        options.caption ? el('caption', {}, options.caption) : null,
        el('thead', {}, el('tr', {}, columns.map(column => el('th', { scope: 'col', 'aria-sort': sortKey === column ? (descending ? 'descending' : 'ascending') : 'none',
          onclick: () => { if (sortKey === column) descending = !descending; else { sortKey = column; descending = false; } render(); } }, column, sortKey === column ? (descending ? ' ↓' : ' ↑') : '')))),
        el('tbody', {}, shown.map(row => el('tr', options.onRow ? { class: 'clickable', onclick: () => options.onRow!(row) } : {}, columns.map(column => el('td', { class: typeof row[column] === 'number' ? 'number' : null }, cellText(row[column], plain.has(column)))))))),
      rows.length > shown.length ? el('p', { class: 'ros-note' }, `First ${shown.length} of ${rows.length} rows`) : null].filter((node): node is HTMLElement => node !== null));
  };
  render();
  return wrapper;
}

/** A filter bar: one menu per field and a search box. Calls onChange with the matching rows now and on every change. */
function filter(input: Row[] | AppInputContent, fields: string[], onChange: (rows: Row[]) => void): HTMLElement {
  const { rows } = rowsOf(input), chosen = new Map<string, string>(), plain = plainColumns(rows, fields);
  let words = '';
  const apply = () => onChange(rows.filter(row => [...chosen].every(([field, value]) => !value || cellText(row[field], plain.has(field)) === value)
    && (!words || Object.values(row).some(value => cell(value).toLocaleLowerCase().includes(words)))));
  const bar = el('div', { class: 'ros-filter' },
    fields.map(field => {
      const values = [...new Set(rows.map(row => cellText(row[field], plain.has(field))).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return el('label', {}, el('span', {}, field), el('select', { onchange: (event: Event) => { chosen.set(field, (event.target as HTMLSelectElement).value); apply(); } }, el('option', { value: '' }, 'All'), values.map(value => el('option', { value }, value))));
    }),
    el('input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search', oninput: (event: Event) => { words = (event.target as HTMLInputElement).value.trim().toLocaleLowerCase(); apply(); } }));
  apply();
  return bar;
}

/** A chart in a frame with a title, caption and source line. spec is Observable Plot options (load /kit/plot.js
 * first) or an element you drew yourself. */
function chart(spec: Node | Record<string, unknown>, options: { title?: string; caption?: string; source?: string } = {}): HTMLElement {
  let body: Node;
  if (spec instanceof Node) body = spec;
  else {
    const Plot = (window as unknown as { Plot?: { plot: (options: Record<string, unknown>) => Node } }).Plot;
    if (!Plot) throw new Error('ros.chart draws Observable Plot options once <script src="/kit/plot.js"></script> is on the page.');
    body = Plot.plot({ style: { fontFamily: 'inherit', fontSize: '12px', background: 'transparent' }, ...spec });
  }
  const figure = el('figure', { class: 'ros-chart' }, options.title ? el('figcaption', {}, options.title) : null, body);
  if (options.caption || options.source) {
    const line = el('p', { class: 'ros-note' }, options.caption ?? '');
    if (options.source) { const from = el('span', { class: 'ros-source-link' }, `${options.caption ? ' · ' : ''}From ${known(options.source)?.title ?? options.source}`); source(from, options.source); line.append(from); }
    figure.append(line);
  }
  return figure;
}

let tip: HTMLElement | null = null;
/** Marks an element as coming from a block: hovering names the block (and version or quote), a click selects it on the map. */
function source<T extends Element>(element: T, block: string, detail: { quote?: string; version?: string } = {}): T {
  element.classList.add('ros-source');
  element.addEventListener('mouseenter', () => {
    tip ??= document.body.appendChild(el('div', { class: 'ros-tooltip', role: 'tooltip' }));
    const from = known(block);
    tip.replaceChildren(...[el('strong', {}, from?.title ?? block), from ? el('span', {}, ` · ${from.kind}`) : null, detail.version ? el('span', {}, ` · Version ${detail.version.slice(0, 8)}`) : null, detail.quote ? el('q', {}, detail.quote) : null].filter((node): node is HTMLElement => node !== null));
    const box = element.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - 288))}px`;
    tip.style.top = `${box.bottom + 6 + 120 > window.innerHeight ? Math.max(8, box.top - 6 - tip.offsetHeight) : box.bottom + 6}px`;
    tip.hidden = false;
  });
  element.addEventListener('mouseleave', () => { if (tip) tip.hidden = true; });
  element.addEventListener('click', () => focus(block));
  return element;
}

/** Selects a block on the map, so a value can show where it came from. */
function focus(block: string) { void call('focus', { block }).catch(error => report(`ros.focus('${block}'): ${text(error)}`)); }

/** Markdown as safe elements: headings, paragraphs, lists, quotes, code, bold, italic and links (shown, not followed). */
function markdown(value: string): HTMLElement {
  const root = el('div', { class: 'ros-markdown' });
  const inline = (line: string): Child[] => {
    const parts: Child[] = [];
    const pattern = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/gu;
    let last = 0;
    for (const match of line.matchAll(pattern)) {
      parts.push(line.slice(last, match.index));
      const token = match[0];
      if (token.startsWith('**')) parts.push(el('strong', {}, token.slice(2, -2)));
      else if (token.startsWith('`')) parts.push(el('code', {}, token.slice(1, -1)));
      else if (token.startsWith('[')) { const [, label, href] = /^\[([^\]]+)\]\(([^)\s]+)\)$/u.exec(token)!; parts.push(el('span', { class: 'ros-link', title: href }, label)); }
      else parts.push(el('em', {}, token.slice(1, -1)));
      last = (match.index ?? 0) + token.length;
    }
    parts.push(line.slice(last));
    return parts;
  };
  const lines = value.replace(/\r\n?/gu, '\n').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (line.startsWith('```')) {
      const code: string[] = [];
      for (index++; index < lines.length && !lines[index].startsWith('```'); index++) code.push(lines[index]);
      root.append(el('pre', {}, el('code', {}, code.join('\n'))));
    } else if (/^#{1,4}\s/u.test(line)) root.append(el(`h${Math.min(4, line.indexOf(' ') + 1)}`, {}, inline(line.replace(/^#+\s+/u, ''))));
    else if (/^\s*([-*]|\d+\.)\s/u.test(line)) {
      const ordered = /^\s*\d+\./u.test(line), list = el(ordered ? 'ol' : 'ul');
      for (; index < lines.length && /^\s*([-*]|\d+\.)\s/u.test(lines[index]); index++) list.append(el('li', {}, inline(lines[index].replace(/^\s*([-*]|\d+\.)\s+/u, ''))));
      index--; root.append(list);
    } else if (line.startsWith('>')) root.append(el('blockquote', {}, inline(line.replace(/^>\s?/u, ''))));
    else {
      const paragraph: string[] = [line];
      for (; index + 1 < lines.length && lines[index + 1].trim() && !/^(#{1,4}\s|```|>|\s*([-*]|\d+\.)\s)/u.test(lines[index + 1]); index++) paragraph.push(lines[index + 1]);
      root.append(el('p', {}, inline(paragraph.join(' '))));
    }
  }
  return root;
}

const ros = {
  /** Resolves once ros.ai has started the page: { app, inputs, readable, state }. */
  ready,
  app: null as AppSession['app'] | null,
  inputs: [] as AppBlock[],
  mode: 'live' as AppSession['app']['mode'],
  /** What ros.save kept last time, or null. */
  state: null as unknown,
  read: (block: string) => call('read', { block }) as Promise<AppInputContent>,
  watch, save, focus,
  el, table, filter, chart, source, markdown, format,
};
// Configurable, so a page that declares its own `const ros = window.ros` still loads.
Object.defineProperty(window, 'ros', { value: ros, enumerable: true, writable: false, configurable: true });
