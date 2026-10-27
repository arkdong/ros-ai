import type { Canvas, CanvasNode, Mutation } from './types.js';
import { groupMembers } from './groups.js';
import { kindName } from './vocabulary.js';

/** An App block is one HTML page, written by an agent or the person, that runs on its card in a sealed frame
 * and reads only the blocks named as its inputs. */
export const APP_SOURCE_LIMIT = 100_000;
export const MAX_APP_INPUTS = 12;
/** The MCP Apps version whose messages the bridge speaks. */
export const APP_PROTOCOL = '2026-01-26';
/** A page that leaves a ping unanswered this long is unloaded, with a Reload button in its place. */
export const APP_WATCHDOG_MS = 5_000;
/** The most a page may keep with ros.state: filters, answers, a selection. */
export const APP_STATE_BYTES = 64_000;

/** A Code block whose language is html is an App. The tools agents learned on 24 October can write one this way. */
export const isHtmlLanguage = (language: string | undefined) => /^(html?|xhtml)$/iu.test(language?.trim() ?? '');

/** A short name for one version of a page, the same in the browser and on the server (cyrb53). */
export function appVersion(source: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let index = 0; index < source.length; index++) {
    const char = source.charCodeAt(index);
    h1 = Math.imul(h1 ^ char, 2654435761);
    h2 = Math.imul(h2 ^ char, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0').slice(-8);
}

export type AppBlock = { id: string; title: string; kind: string };
const summary = (node: CanvasNode): AppBlock => ({ id: node.id, title: node.title, kind: kindName(node) });

/** What an App may read: its inputs, and for an input Group, the blocks inside it. Links never add to this. */
export function readableBlocks(canvas: Pick<Canvas, 'nodes'>, inputs: readonly string[]): AppBlock[] {
  const found = new Map<string, AppBlock>();
  for (const id of inputs) {
    const node = canvas.nodes.find(item => item.id === id);
    if (!node) continue;
    found.set(node.id, summary(node));
    if (node.kind === 'group') for (const member of groupMembers({ nodes: canvas.nodes, connections: [] }, node.id)) found.set(member.id, summary(member));
  }
  return [...found.values()];
}
/** An App's inputs as the page lists them: in the order named, each with its kind. */
export function appInputs(canvas: Pick<Canvas, 'nodes'>, inputs: readonly string[]): AppBlock[] {
  return inputs.flatMap(id => { const node = canvas.nodes.find(item => item.id === id); return node ? [summary(node)] : []; });
}
/** A block the page names, by ID or else by title (case and spacing ignored), among those it may read. */
export function findReadable(readable: readonly AppBlock[], name: string): AppBlock | undefined {
  const plain = (text: string) => text.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
  return readable.find(block => block.id === name) ?? readable.find(block => plain(block.title) === plain(name));
}

/** The canvas a pending proposal would make, as its preview shows it. */
export function proposedCanvas(canvas: Canvas, operations: readonly Mutation[]): Canvas {
  const result = structuredClone(canvas);
  for (const op of operations) {
    if (op.type === 'addNode') result.nodes.push(structuredClone(op.node));
    else if (op.type === 'updateNode') { const node = result.nodes.find(item => item.id === op.id); if (node) Object.assign(node, structuredClone(op.patch)); }
    else if (op.type === 'removeNode') result.nodes = result.nodes.filter(item => item.id !== op.id);
    else if (op.type === 'addConnection') result.connections.push(op.connection);
    else result.connections = result.connections.filter(item => item.id !== op.id);
  }
  return result;
}

/** Lines of a page that try to leave its frame. The frame blocks every one of them; this tells the person before
 * they accept, the way the reviewer flags Code runs. */
const LEAVING: [RegExp, string][] = [
  [/\b(fetch|XMLHttpRequest|WebSocket|EventSource|WebTransport|sendBeacon)\b/u, 'opens a network connection'],
  [/\b(RTCPeerConnection|RTCDataChannel)\b/u, 'opens a peer-to-peer connection'],
  [/\b(location\s*\.\s*href\s*=(?!=)|location\s*\.\s*(assign|replace)\s*\(|location\s*=(?!=)|window\s*\.\s*open\s*\(|(top|parent|opener)\s*\.\s*location\b)/u, 'navigates away from the page'],
  [/<\s*(form|iframe|frame|object|embed)\b/iu, 'embeds or submits to another page'],
  [/\bhref\s*=\s*["']?\s*(https?:)?\/\//iu, 'links to a web page'],
  [/\b(src|action|srcset|poster|data)\s*=\s*["']?\s*(https?:)?\/\//iu, 'loads something from the web'],
  [/url\(\s*["']?\s*(https?:)?\/\//iu, 'loads a style from the web'],
  [/@import\s+(url\()?\s*["']?\s*(https?:)?\/\//iu, 'loads a style from the web'],
  [/\bimport\s*\(\s*["'`]\s*(https?:)?\/\//u, 'loads code from the web'],
];
export type AppFlag = { line: number; reason: string };
export function appFlags(source: string, limit = 8): AppFlag[] {
  const flags: AppFlag[] = [];
  source.split('\n').forEach((text, index) => {
    if (flags.length >= limit) return;
    for (const [pattern, reason] of LEAVING) if (pattern.test(text)) { flags.push({ line: index + 1, reason }); break; }
  });
  return flags;
}

/** What the page gets for one block it reads (ros.read). Text is Markdown; a table's cells are numbers where a whole
 * column holds numbers; an image is a data address the page can show. */
export type AppInputContent = {
  id: string; title: string; kind: string; label?: string;
  /** The block's own text: a note, a finding's quote, a Code block's description. */
  text: string;
  /** The saved version the value comes from (a Data block's table, a Code run's output, a report). */
  version?: string;
  table?: { columns: string[]; rows: Record<string, string | number | null>[]; truncated: boolean };
  image?: string;
  /** A report's or result's saved text, a PDF's text, a Notion page or a Google Doc, as Markdown. */
  content?: string;
  /** The blocks an input Group holds; each can be read by its ID. */
  members?: AppBlock[];
  /** For blocks read live from Notion or Google Drive: when, and anything that stopped the read. */
  live?: { fetchedAt?: string; link?: string | null; notice?: string };
  truncated?: boolean;
};
/** What the bridge tells a page when it starts. */
export type AppSession = { app: { id: string; title: string; version: string; mode: AppMode }; inputs: AppBlock[]; readable: AppBlock[]; state: unknown };
/** live: on the canvas or in its block view. preview: a proposal not yet accepted, which saves nothing.
 * check: an agent's ros_check_app, in a hidden browser. */
export type AppMode = 'live' | 'preview' | 'check';
export type AppFrameGrant = { token: string; url: string; inputs: AppBlock[]; readable: AppBlock[]; version: string };

/** The page a new App starts with (Add block › App): each input, shown the way the kit shows it. */
export const APP_STARTER = `<!doctype html>
<html lang="en">
<head><title>App</title></head>
<body>
  <h1>New App</h1>
  <p class="ros-note">Name the blocks it reads in Inputs, and write the page in Code.</p>
  <div id="inputs" class="ros-grid"></div>
  <script>
    ros.ready.then(async () => {
      const box = document.getElementById('inputs');
      if (!ros.inputs.length) box.append(ros.el('p', {}, 'No inputs yet.'));
      for (const block of ros.inputs) {
        const input = await ros.read(block.id);
        const heading = ros.source(ros.el('h2', {}, input.title), block.id);
        const body = input.table ? ros.table(input, { limit: 50 })
          : input.image ? ros.el('img', { src: input.image, alt: input.title, style: { maxWidth: '100%' } })
          : ros.markdown(input.content ?? input.text);
        box.append(ros.el('section', { class: 'ros-card' }, heading, body));
      }
    });
  </script>
</body>
</html>
`;
