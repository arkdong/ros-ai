import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Express } from 'express';
import { z } from 'zod';
import { ACP_AGENTS, isAcpAgent } from '../shared/acp-agents.js';
import { nodeBlockType, primaryArtifact } from '../shared/blocks.js';
import { cardWidth, estimatedCardHeight, pictureCardHeight } from '../shared/card-size.js';
import { artifactTable } from '../shared/data-view.js';
import { isImageType, isPdfType, fileMediaType } from '../shared/files.js';
import { isGroup } from '../shared/groups.js';
import { svgImageUrl } from '../shared/reports.js';
import { Redactor, SHARE_FILE_BYTES, SHARE_KIND, SHARE_TABLE_ROWS, SHARE_TEXT, SHARE_VERSION, shareFileName, type ShareBox, type ShareBundle, type ShareChoices, type ShareCopy, type ShareFace, type ShareFile, type ShareMessage, type ShareNode, type SharePreview } from '../shared/share.js';
import type { Artifact, CanvasNode, GoogleRead, MetricRead, NotionRead, ProjectDetail } from '../shared/types.js';
import { kindName } from '../shared/vocabulary.js';
import { IMAGE_HEAD_BYTES, imageSize } from './image-size.js';
import type { ProjectCache } from './project-cache.js';
import { metricViewKey } from './metric-view.js';
import { StoreError, type Store } from './store.js';

/** Where a File block's file is on disk. Only ProjectFolders knows; tests pass their own. */
export type FileSource = { fileOf(projectId: string, nodeId: string): { absolute: string; name: string; mediaType: string; size: number } };

const RUNTIMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', model: 'ROS' };
const runtimeName = (runtime: string) => RUNTIMES[runtime] ?? (isAcpAgent(runtime) ? ACP_AGENTS[runtime].label : 'Agent');
const clip = (text: string, limit = SHARE_TEXT) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
const LIVE = new Set(['notion', 'google', 'metric', 'dashboard', 'training']);

/** Builds the clean copy of a project that a Share leaves the computer with. Everything is chosen field by field
 * from an allow list: a block's text, code, table, picture or numbers. Conversations and agent details only when
 * switched on; account names, addresses, file ids and the folder's location never. Personal things found in any
 * text (emails, phone numbers, keys, home folder paths, private addresses) are hidden unless shown again. */
export class ShareCopies {
  constructor(private readonly store: Store, private readonly options: { files?: () => FileSource | undefined; cache?: ProjectCache } = {}) {}

  build(projectId: string, choices: ShareChoices): { copy: ShareCopy; preview: SharePreview; paths: Record<string, string> } {
    const detail = this.store.detail(projectId), canvas = detail.project.canvas;
    const redactor = new Redactor(new Set(choices.reveal));
    const byId = new Map(canvas.nodes.map(node => [node.id, node]));
    // A left-out Group takes everything inside it.
    const out = new Set(choices.leaveOut.filter(id => byId.has(id)));
    const leftOut = (node: CanvasNode): boolean => { for (let at: CanvasNode | undefined = node; at; at = at.parentId ? byId.get(at.parentId) : undefined) if (out.has(at.id)) return true; return false; };
    const open = new Set(choices.open ?? []);
    const files: Record<string, ShareFile> = {}, paths: Record<string, string> = {};
    let bytes = 0, live = 0, agents = 0;
    const nodes: ShareNode[] = [];
    for (const node of canvas.nodes) {
      if (leftOut(node)) continue;
      const block = nodeBlockType(node), isLive = !isGroup(node) && LIVE.has(block);
      if (isLive && !choices.live) continue;
      const title = redactor.clean(node.title.slice(0, 300), node.title);
      let face = this.face(projectId, node, detail, redactor, title);
      if (face.type === 'picture' && face.file || face.type === 'pdf') {
        const key = face.file!;
        const source = this.fileOf(projectId, node.id);
        if (!choices.files) face = { type: 'left', note: face.type === 'pdf' ? 'PDF left out' : 'Picture left out' };
        else if (!source) face = { type: 'left', note: 'File missing' };
        else if (bytes + source.size > SHARE_FILE_BYTES) face = { type: 'left', note: 'Too large to include' };
        else {
          bytes += source.size; paths[key] = source.absolute;
          // Only the file's own name travels, never where it is on this computer.
          files[key] = { name: redactor.clean(posix.basename(source.name), title), mediaType: source.mediaType, size: source.size, ...(face.type === 'picture' && face.width ? { width: face.width, height: face.height } : {}) };
        }
      }
      if (isLive) live++;
      const agentNode = block === 'agent' && node.agent;
      if (agentNode) agents++;
      const label = node.label && !['result'].includes(node.label) ? redactor.clean(node.label.slice(0, 60), title) : undefined;
      nodes.push({
        id: node.id, title, kindName: isGroup(node) ? 'Group' : kindName(node), ...(label ? { label } : {}),
        ...(node.parentId && byId.has(node.parentId) ? { parentId: node.parentId } : {}),
        ...(isGroup(node) && open.has(node.id) ? { open: true } : {}),
        face, ...(isLive ? { snapshot: this.snapshotOf(projectId, node) } : {}),
        ...(agentNode && choices.agentDetails ? { agent: { runtime: runtimeName(node.agent!.runtime), ...(this.agentModel(detail, node) ? { model: this.agentModel(detail, node) } : {}) } } : {}),
      });
    }
    this.place(nodes, canvas.nodes, choices.layout, files);
    const kept = new Set(nodes.map(node => node.id));
    const links = canvas.connections.filter(link => kept.has(link.source) && kept.has(link.target))
      .map(link => ({ id: link.id, source: link.source, target: link.target, label: redactor.clean(link.label.slice(0, 200), 'Links') }));
    const messages = this.store.listMessages(projectId, null).filter(message => message.role === 'user' || message.role === 'assistant');
    const conversation: ShareMessage[] | undefined = choices.conversation ? messages.slice(-400).map(message => ({ role: message.role as ShareMessage['role'], text: redactor.clean(clip(message.content, 20_000), 'Conversation'), at: message.createdAt })) : undefined;
    const copy: ShareCopy = { kind: SHARE_KIND, version: SHARE_VERSION, title: redactor.clean(detail.project.title.slice(0, 200), 'Title') || 'Untitled', sharedAt: new Date().toISOString(), nodes, links, files, ...(conversation ? { conversation } : {}) };
    const preview: SharePreview = { copy, finds: redactor.list(), bytes, counts: { blocks: nodes.length, total: canvas.nodes.length, files: Object.keys(files).length, live, messages: messages.length, agents } };
    return { copy, preview, paths };
  }

  preview(projectId: string, choices: ShareChoices): SharePreview { return this.build(projectId, choices).preview; }

  /** The copy with its files, as a canvas file carries it. */
  bundle(projectId: string, choices: ShareChoices): ShareBundle {
    const { copy, paths } = this.build(projectId, choices);
    const data: Record<string, string> = {};
    for (const [key, path] of Object.entries(paths)) data[key] = readFileSync(path).toString('base64');
    return { ...copy, data };
  }

  private fileOf(projectId: string, nodeId: string) {
    try { return this.options.files?.()?.fileOf(projectId, nodeId); } catch { return undefined; }
  }

  private agentModel(detail: ProjectDetail, node: CanvasNode) {
    const run = detail.runs.find(item => item.nodeId === node.id && item.model);
    return run?.model ? run.model.slice(0, 80) : undefined;
  }

  private snapshotOf(projectId: string, node: CanvasNode): ShareNode['snapshot'] {
    const from = node.notion ? 'Notion' : node.google ? (node.google.kind === 'sheet' ? 'Google Sheets' : 'Google Docs') : node.metric ? kindName(node) : node.blockType === 'dashboard' ? 'Dashboard' : node.training ? 'Training' : 'Outside source';
    const at = node.notion ? this.cached<NotionRead>(projectId, 'notion', JSON.stringify(node.notion))?.fetchedAt
      : node.google ? this.cached<GoogleRead>(projectId, 'google', JSON.stringify([node.google.fileId, node.google.kind, node.google.sheet ?? '']))?.fetchedAt
      : node.metric ? this.metricRead(projectId, node)?.fetchedAt : undefined;
    return { from, ...(at ? { at } : {}) };
  }
  private cached<T>(projectId: string, namespace: string, key: string): T | null { return this.options.cache?.read<T>(projectId, namespace, key) ?? null; }
  private metricRead(projectId: string, node: CanvasNode): MetricRead | null {
    return node.metric ? this.cached<{ read: MetricRead }>(projectId, 'metric', `${projectId}:${metricViewKey(node.metric)}`)?.read ?? null : null;
  }

  private face(projectId: string, node: CanvasNode, detail: ProjectDetail, redactor: Redactor, block: string): ShareFace {
    const clean = (text: string, limit = SHARE_TEXT) => redactor.clean(clip(text, limit), block);
    const text = (markdown: string): ShareFace => markdown.trim() ? { type: 'text', markdown: clean(markdown) } : { type: 'empty' };
    if (isGroup(node)) return { type: 'group', note: clean(node.description, 2_000) };
    const type = nodeBlockType(node);
    if (node.file) {
      const mediaType = fileMediaType(node.file.path);
      if (isPdfType(mediaType)) return { type: 'pdf', file: node.id };
      if (isImageType(mediaType)) return { type: 'picture', file: node.id, ...this.pictureSize(projectId, node.id) };
      return { type: 'left', note: 'File' };
    }
    if (type === 'app') return { type: 'app', source: clean(node.app?.source ?? '', 500_000) };
    if (type === 'code') return { type: 'code', language: node.code?.language ?? 'python', source: clean(node.code?.source ?? detail.artifacts.find(item => item.id === node.artifactId && item.kind === 'code')?.content ?? '') };
    if (node.notion) {
      const read = this.cached<NotionRead>(projectId, 'notion', JSON.stringify(node.notion));
      if (!read) return { type: 'left', note: 'Not read yet' };
      return read.kind === 'page' ? text(read.content) : this.table(read.columns, read.rows.map(row => read.columns.map(column => row[column] ?? '')), redactor, block);
    }
    if (node.google) {
      const read = this.cached<GoogleRead>(projectId, 'google', JSON.stringify([node.google.fileId, node.google.kind, node.google.sheet ?? '']));
      if (!read) return { type: 'left', note: 'Not read yet' };
      return read.kind === 'doc' ? text(read.content) : this.table(read.columns, read.rows, redactor, block);
    }
    if (node.metric) {
      const read = this.metricRead(projectId, node);
      return read ? { type: 'numbers', values: read.values.slice(0, 24).map(value => ({ label: clean(value.label, 120), value: value.text ? clean(value.text, 120) : value.value === null ? '–' : value.value.toLocaleString('en-US'), ...(value.note ? { note: clean(value.note, 200) } : {}) })) } : { type: 'left', note: 'Not read yet' };
    }
    if (type === 'dashboard') {
      const values = (node.dashboard?.tiles ?? []).flatMap(tile => {
        const source = detail.project.canvas.nodes.find(item => item.id === tile.block), read = source ? this.metricRead(projectId, source) : null;
        return tile.keys.flatMap(key => { const value = read?.values.find(item => item.key === key); return value ? [{ label: clean(tile.label ?? value.label, 120), value: value.text ? clean(value.text, 120) : value.value === null ? '–' : value.value.toLocaleString('en-US') }] : []; });
      });
      return values.length ? { type: 'numbers', values: values.slice(0, 24) } : { type: 'left', note: 'Not read yet' };
    }
    if (node.training) return { type: 'left', note: 'Training run' };
    if (node.post) {
      const post = node.post;
      return { type: 'post', ...(post.title ? { title: clean(post.title, 300) } : {}), text: clean(post.text, 20_000), author: clean(post.author.name, 120), ...(post.community ? { community: clean(post.community, 120) } : {}), url: post.url, counts: Object.fromEntries(Object.entries(post.counts).filter((entry): entry is [string, number] => typeof entry[1] === 'number')) };
    }
    if (node.map) return { type: 'pins', pins: node.map.pins.slice(0, 200).map(pin => ({ name: clean(pin.name, 200), lat: pin.lat, lng: pin.lng, ...(pin.note ? { note: clean(pin.note, 1_000) } : {}) })) };
    const primary = primaryArtifact(node, detail);
    if (primary) {
      const face = this.artifactFace(primary, redactor, block);
      if (face) return face;
    }
    return text(node.description);
  }

  private artifactFace(artifact: Artifact, redactor: Redactor, block: string): ShareFace | null {
    if (artifact.kind === 'plot') return { type: 'picture', src: svgImageUrl(artifact) };
    if (artifact.kind === 'dataset' || artifact.kind === 'table') {
      try { const table = artifactTable(artifact.content, artifact.kind === 'dataset' || artifact.mediaType === 'text/csv'); return this.table(table.columns, table.rows, redactor, block); } catch { return null; }
    }
    if (artifact.kind === 'metric') {
      try { const value = (JSON.parse(artifact.content) as { value?: unknown }).value; if (value !== undefined) return { type: 'numbers', values: [{ label: redactor.clean(artifact.title.slice(0, 120), block), value: String(value) }] }; } catch { /* plain text below */ }
    }
    if (artifact.kind === 'code') return { type: 'code', language: 'python', source: redactor.clean(clip(artifact.content), block) };
    return { type: 'text', markdown: redactor.clean(clip(artifact.content), block) };
  }

  private table(columns: string[], rows: string[][], redactor: Redactor, block: string): ShareFace {
    const kept = rows.slice(0, SHARE_TABLE_ROWS);
    return { type: 'table', columns: columns.slice(0, 60).map(column => redactor.clean(column.slice(0, 200), block)), rows: kept.map(row => row.slice(0, 60).map(cell => redactor.clean(String(cell ?? '').slice(0, 1_000), block))), total: rows.length };
  }

  private pictureSize(projectId: string, nodeId: string): { width?: number; height?: number } {
    const source = this.fileOf(projectId, nodeId);
    if (!source) return {};
    try {
      const handle = openSync(source.absolute, 'r'), head = Buffer.alloc(Math.min(IMAGE_HEAD_BYTES, source.size));
      try { readSync(handle, head, 0, head.length, 0); } finally { closeSync(handle); }
      const size = imageSize(head);
      return size ? { width: size.width, height: size.height } : {};
    } catch { return {}; }
  }

  /** Where each block sits: as shown on the canvas when the sheet opened, or else from its saved place. */
  private place(nodes: ShareNode[], all: CanvasNode[], layout: Record<string, ShareBox> | undefined, files: Record<string, ShareFile>) {
    const byId = new Map(all.map(node => [node.id, node]));
    for (const node of nodes) {
      const shown = layout?.[node.id];
      if (shown) { node.box = shown; continue; }
      const saved = byId.get(node.id)!;
      if (layout || saved.parentId) continue;
      const width = cardWidth(saved), file = node.face.type === 'picture' && node.face.file ? files[node.face.file] : undefined;
      const height = file?.width && file.height ? pictureCardHeight(width, { width: file.width, height: file.height }) : estimatedCardHeight(saved);
      node.box = { x: saved.x, y: saved.y, width, height };
    }
  }
}

/** The still canvas page, built into dist/still: built on first use in a checkout, read from disk after. */
export class StillPage {
  private loading: Promise<{ js: string; css: string }> | null = null;
  constructor(private readonly root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')) {}
  ready() {
    return this.loading ??= (async () => {
      const script = resolve(this.root, 'scripts/build-still.mjs');
      if (existsSync(resolve(this.root, 'src/still/main.tsx')) && existsSync(script)) {
        const { buildStill } = await import(pathToFileURL(script).href) as { buildStill: (options: { root: string; onlyIfStale: boolean }) => Promise<boolean> };
        await buildStill({ root: this.root, onlyIfStale: true });
      }
      const dir = resolve(this.root, 'dist/still');
      if (!existsSync(resolve(dir, 'still.js'))) throw new StoreError('The canvas file viewer is not built. Run npm run build.', 500);
      return { js: readFileSync(resolve(dir, 'still.js'), 'utf8'), css: existsSync(resolve(dir, 'still.css')) ? readFileSync(resolve(dir, 'still.css'), 'utf8') : '' };
    })().catch(error => { this.loading = null; throw error; });
  }
  /** In development the page is rebuilt when its sources change. */
  reset() { this.loading = null; }
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);
/** JSON inside a script element: `<` written as < so no text in a block can close the element. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</gu, '\\u003c').replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');

/** One .html file: the still canvas page with the copy inside. It opens in any browser without a network: its
 * Content-Security-Policy lets it load nothing from anywhere, so opening it tells nobody. */
export function canvasFileHtml(bundle: ShareBundle, page: { js: string; css: string }) {
  const policy = "default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; frame-src blob:; base-uri 'none'; form-action 'none'";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="generator" content="ros.ai">
<title>${escapeHtml(bundle.title)}</title>
<style>${page.css.replace(/<\/style/giu, '<\\/style')}</style>
</head>
<body>
<div id="root"></div>
<script type="application/json" id="ros-canvas">${scriptJson(bundle)}</script>
<script>${page.js.replace(/<\/script/giu, '<\\/script')}</script>
</body>
</html>
`;
}

const box = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(1).max(20_000), height: z.number().finite().min(1).max(20_000) }).strict();
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u);
export const shareChoicesSchema = z.object({
  leaveOut: z.array(identifier).max(5_000).default([]), files: z.boolean().default(true), live: z.boolean().default(true),
  conversation: z.boolean().default(false), agentDetails: z.boolean().default(false), reveal: z.array(z.string().max(80)).max(2_000).default([]),
  layout: z.record(identifier, box).optional(), open: z.array(identifier).max(5_000).optional(),
}).strict();

export function attachShareRoutes(app: Express, copies: ShareCopies, page: StillPage, dev = false) {
  app.post('/api/projects/:id/share/preview', (req, res) => {
    res.json(copies.preview(identifier.parse(req.params.id), shareChoicesSchema.parse(req.body ?? {})));
  });
  app.post('/api/projects/:id/share/file', async (req, res) => {
    const bundle = copies.bundle(identifier.parse(req.params.id), shareChoicesSchema.parse(req.body ?? {}));
    if (dev) page.reset();
    const html = canvasFileHtml(bundle, await page.ready());
    const name = shareFileName(bundle.title);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]|"/gu, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('ETag', `"${createHash('sha256').update(html).digest('hex').slice(0, 32)}"`);
    res.send(html);
  });
}
