import { z } from 'zod';
import { MAX_DASHBOARD_TILES, MAX_FUNNEL_STEPS } from './dashboards.js';
import { LAYOUT_GAP, freeSpot, groupContentRight } from './layout.js';
import { CARD_MIN_WIDTH, PICTURE_MIN_WIDTH, CARD_MAX_WIDTH, CARD_MIN_HEIGHT, CARD_MAX_HEIGHT, CARD_MAX_SET_HEIGHT, CARD_MIN_SCALE, cardWidth, cardFootprintHeight, estimatedCardHeight } from './card-size.js';
import { isPictureNode } from './files.js';
import { groupMembers } from './groups.js';
import { DOI, PAPER_ID } from './papers.js';
import { ACP_AGENT_IDS } from './acp-agents.js';
import { APP_SOURCE_LIMIT, MAX_APP_INPUTS, isHtmlLanguage } from './apps.js';
import { MAX_MAP_PINS, pinLink } from './maps.js';
import { MAX_POST_COMMENTS, MAX_POST_PHOTOS, POST_COMMENT_TEXT, POST_PLATFORMS, POST_SUBTITLES_KEPT, POST_TEXT } from './posts.js';
import type { Artifact, Canvas, CanvasNode, Mutation, Project } from './types.js';

/**
 * The rules of the canvas as one function with no storage behind it: what a change may hold (the schemas) and what a
 * list of changes does to a canvas (applyOperations). The local store applies every edit with it, and anything else
 * that keeps a copy of a canvas, such as the service a team's shared project syncs through, applies the same changes
 * the same way with it. What it has to look up outside the canvas comes in as CanvasLookups.
 */

/** A change the canvas rules refuse. The store reports it as its own error. */
export class CanvasRuleError extends Error {
  constructor(message: string) { super(message); this.name = 'CanvasRuleError'; }
}
/** What the rules read outside the canvas itself. */
export type CanvasLookups = {
  /** Whether a block id was ever used in this project, by a block since removed too: an id is never used twice. */
  retired(nodeId: string): boolean;
  /** A saved version by id. Throws when there is none. */
  artifact(id: string): Pick<Artifact, 'id' | 'projectId' | 'nodeId' | 'hash'>;
  /** The same, or undefined when there is none. */
  savedArtifact(id: string): Pick<Artifact, 'id' | 'projectId' | 'nodeId' | 'hash'> | undefined;
};

export const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
/** Names every plain object already has (`__proto__`, `constructor`, `toString`…). A block with one of them as its id is
 * read as that built-in wherever blocks are looked up by id, such as its approval mode, so new blocks may not use them. */
export const RESERVED_IDS: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(Object.prototype));
const blockIdSchema = identifier.refine(id => !RESERVED_IDS.has(id), 'That block id is reserved. Choose another id.');
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const decisionSchema = z.object({ id: identifier, text: z.string().trim().min(1).max(2000), reason: z.string().trim().min(1).max(4000), at: z.iso.datetime(), basedOn: z.array(z.object({ artifactId: identifier, hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(20), withdrawnAt: z.iso.datetime().optional() }).strict();
/** Only a picture card may be narrower than CARD_MIN_WIDTH: it keeps its picture's shape, so a small one is useful. */
function narrowOnlyPictures(node: { width?: number; kind?: string; blockType?: string; file?: { path: string } | null }) {
  if (node.width !== undefined && node.width < CARD_MIN_WIDTH && !isPictureNode(node)) throw new CanvasRuleError(`A block is at least ${CARD_MIN_WIDTH} wide; only a picture can be narrower`);
}
/** The most text a block's description holds. */
export const DESCRIPTION_LIMIT = 20_000;
const nodeFields = { title: z.string().trim().min(1).max(200), description: z.string().max(DESCRIPTION_LIMIT), x: coordinate, y: coordinate, width: z.number().int().min(PICTURE_MIN_WIDTH).max(CARD_MAX_WIDTH).optional(), height: z.number().int().min(CARD_MIN_HEIGHT).max(CARD_MAX_SET_HEIGHT).nullable().optional(), scale: z.number().min(CARD_MIN_SCALE).max(1).nullable().optional(), kind: z.enum(['topic', 'activity', 'unspecified', 'group']).optional(), parentId: identifier.nullable().optional(), blockType:z.enum(['note','action','dataset','figure','code','notebook','report','agent','search','finding','notion','file']).optional(), label:z.string().trim().max(40).optional(), file:z.object({path:z.string().trim().min(1).max(1000)}).strict().optional(), notion:z.object({url:z.string().trim().url().max(500),filter:z.string().trim().max(1000).optional(),columns:z.array(z.string().trim().min(1).max(100)).max(30).optional(),kind:z.enum(['database','page']).optional()}).strict().optional(), agent:z.object({runtime:z.enum(['claude','codex','model']),turnId:identifier}).strict().optional(), artifactId:identifier.optional(), code:z.object({language:z.string().trim().min(1).max(50),source:z.string().max(100_000),parameters:z.record(z.string().max(100),z.union([z.string().max(1000),z.number().finite(),z.boolean()])).refine(value=>Object.keys(value).length<=50),inputArtifactId:identifier.nullable().optional()}).strict().optional(), notebook:z.object({sessionId:identifier.optional(),path:z.string().max(1000)}).strict().optional(), legacyKind:z.enum(['topic','activity','unspecified']).optional(), groupHighlights:z.array(z.object({nodeId:identifier,artifactId:identifier,hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(3).optional() };
const connectionSchema = z.object({ id: identifier, source: identifier, target: identifier, label: z.string().max(200),sourceHandle:z.enum(['top','right','bottom','left']).optional(),targetHandle:z.enum(['top','right','bottom','left']).optional() }).strict();
const linkSide = z.enum(['top','right','bottom','left']);
/** The person's edit of a link on the canvas: its word, or its direction. Not offered to agents, whose canvas tool
 * keeps the shape of the training snapshot; they add and remove links. */
const updateConnectionSchema = z.object({ type: z.literal('updateConnection'), id: identifier, patch: z.object({ label: z.string().max(200).optional(), source: identifier.optional(), target: identifier.optional(), sourceHandle: linkSide.optional(), targetHandle: linkSide.optional() }).strict().refine(value => Object.keys(value).length > 0, 'An update must contain a change') }).strict();
const mutations = <T extends z.ZodRawShape>(fields: T) => z.discriminatedUnion('type', [
  z.object({ type: z.literal('addNode'), node: z.object({ id: blockIdSchema, ...fields }).strict() }).strict(),
  z.object({ type: z.literal('updateNode'), id: identifier, patch: z.object(fields).partial().strict().refine(value => Object.keys(value).length > 0, 'An update must contain a change') }).strict(),
  z.object({ type: z.literal('removeNode'), id: identifier }).strict(),
  z.object({ type: z.literal('addConnection'), connection: connectionSchema }).strict(),
  z.object({ type: z.literal('removeConnection'), id: identifier }).strict(),
]);
/** A Google Sheet or Doc shown live (see GoogleView), a Web block and a block's claim marks. Kept apart from nodeFields,
 * so the canvas tool agents see reads as the training snapshot has it while Google Drive is not connected; agents
 * cannot write a Web block or claim marks through it in any case (agent-tools.ts). */
const liveNodeFields = { ...nodeFields, blockType: z.enum(['note','action','dataset','figure','code','notebook','report','agent','search','finding','notion','file','google','web']).optional(), google: z.object({ fileId: z.string().regex(/^[a-zA-Z0-9_-]{10,200}$/u), kind: z.enum(['sheet','doc']), sheet: z.string().trim().min(1).max(200).optional() }).strict().optional(), check:z.object({checkedAt:z.string().max(40),agentNodeId:identifier,textHash:z.string().regex(/^[a-f0-9]{64}$/),claims:z.array(z.object({text:z.string().max(400),verdict:z.enum(['backed','contradicted','unsupported','open']),note:z.string().max(240).optional(),quote:z.string().max(400).optional(),source:z.object({title:z.string().max(300),url:z.string().max(2000).optional()}).strict().optional()}).strict()).max(12)}).strict().optional(), web:z.object({question:z.string().trim().min(1).max(300),directions:z.array(z.object({id:identifier,title:z.string().trim().min(1).max(80),why:z.string().max(160),queries:z.array(z.string().trim().min(1).max(400)).max(8),links:z.array(z.string().max(2000)).max(5).optional(),summary:z.string().max(12000).optional(),aside:z.string().max(160).optional()}).strict()).min(1).max(12)}).strict().optional() };
/** Where a paper came from: set by ros.ai when the person or an agent adds one (papers.ts), so agents never write it. */
export const paperSchema = z.object({ source: z.enum(['openalex', 'arxiv', 'zotero']), id: z.string().regex(PAPER_ID), doi: z.string().regex(DOI).optional(), link: z.string().url().max(2000) }).strict();
/** The agent whose turn an Agent block stands for, ACP agents (Gemini CLI, Goose, OpenCode) included. Kept apart from nodeFields, so the
 * canvas tool agents see reads as the training snapshot has it. */
const agentLinkSchema = z.object({ runtime: z.enum(['claude', 'codex', 'model', ...ACP_AGENT_IDS]), turnId: identifier }).strict();
/** An App block's page and the blocks it reads (see AppDocument). An update may name only the page or only the inputs;
 * ros.ai keeps the other. Kept apart from nodeFields, so the canvas tool agents see reads as the training snapshot has
 * it until Apps are switched on for agents. */
const appSchema = z.object({ source: z.string().max(APP_SOURCE_LIMIT).optional(), inputs: z.array(identifier).max(MAX_APP_INPUTS).optional() }).strict().refine(value => value.source !== undefined || value.inputs !== undefined, 'Give the page (source), the inputs, or both');
const appNodeFields = { ...liveNodeFields, blockType: z.enum(['note','action','dataset','figure','code','notebook','report','agent','search','finding','notion','file','google','web','app']).optional(), app: appSchema.optional() };
/** A training run the person adds (see TrainingView). Kept out of what agents may propose, Apps on or off, because it names a
 * folder and an ssh host on this computer, and out of nodeFields, so the canvas tool agents see reads as the training snapshot has it. */
export const trainingViewSchema = z.object({ folder: z.string().trim().min(1).max(1000), host: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._@-]{0,199}$/u).optional(), remote: z.string().regex(/^[~A-Za-z0-9_./-]{1,500}$/u).optional() }).strict();
/** A Notion block with the account the person chose to read it with (see NotionView), by its key in ros.ai. Kept out
 * of what agents may propose and out of nodeFields, so the canvas tool agents see reads as the training snapshot has it. */
/** A Metric block's source (see MetricView). Kept out of what agents may propose and out of nodeFields, like a training run. */
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
export const metricViewSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('github'), repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u) }).strict(),
  z.object({ source: z.literal('cloud'), show: z.enum(['acquisition', 'engagement', 'activation', 'retention', 'usage', 'costs']).optional() }).strict(),
  z.object({ source: z.literal('umami'), website: uuid }).strict(),
  z.object({ source: z.literal('railway'), project: uuid }).strict(),
]);
/** A Post block's post (see PostView), read by ros.ai from its platform. Kept out of what agents may propose and out of
 * nodeFields: agents add posts with ros_add_posts, which reads them, so a post on the canvas is what the platform showed. */
const postCount = z.number().int().min(0).max(1e13);
export const postViewSchema = z.object({
  platform: z.enum(POST_PLATFORMS), shape: z.enum(['photo', 'video', 'text']), url: z.string().url().max(2000), id: z.string().trim().min(1).max(200),
  title: z.string().max(500).optional(), text: z.string().max(POST_TEXT), author: z.object({ name: z.string().max(200), url: z.string().url().max(2000).optional() }).strict(),
  community: z.string().max(200).optional(), postedAt: z.string().max(40).optional(),
  counts: z.object({ likes: postCount, comments: postCount, views: postCount, points: z.number().int().min(-1e9).max(1e13), stars: postCount, forks: postCount, saves: postCount }).partial().strict(),
  photos: z.array(z.object({ url: z.string().url().max(4000), path: z.string().max(1000).optional(), width: z.number().int().positive().max(100_000).optional(), height: z.number().int().positive().max(100_000).optional() }).strict()).max(MAX_POST_PHOTOS),
  tags: z.array(z.string().max(100)).max(30).optional(),
  comments: z.array(z.object({ author: z.string().max(200), text: z.string().max(POST_COMMENT_TEXT), likes: z.number().int().min(-1e9).max(1e13).optional(), at: z.string().max(40).optional(), depth: z.number().int().min(0).max(10).optional() }).strict()).max(MAX_POST_COMMENTS).optional(),
  duration: z.number().min(0).max(1e7).optional(),
  subtitles: z.object({ language: z.string().max(40), automatic: z.boolean(), characters: z.number().int().min(0).max(1e8), path: z.string().max(1000).optional(), text: z.string().max(POST_SUBTITLES_KEPT).optional() }).strict().optional(),
  readAt: z.string().max(40), notice: z.string().max(500).optional(),
}).strict();
const notionViewSchema = nodeFields.notion.unwrap().extend({ account: z.string().regex(/^[a-z0-9-]{1,40}$/u).optional() }).strict();
/** A Map block's pins (see MapView). Kept out of nodeFields, so the canvas tool agents see reads as the training snapshot
 * has it; agents place pins with ros_place_pins. */
/** A pin's own link: a web page, never an address that opens something else on this computer (see pinLink). Any other
 * link is left out rather than refused, so a map saved with one earlier can still be edited; the agent tool that places
 * pins refuses such a link with a reason. */
const pinUrlSchema = z.string().trim().url().max(2000).transform(pinLink);
export const mapPinSchema = z.object({ id: identifier, name: z.string().trim().min(1).max(200), lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180), note: z.string().max(2000).optional(), url: pinUrlSchema.optional(), place: z.string().trim().max(300).optional() }).strict();
const mapViewSchema = z.object({ pins: z.array(mapPinSchema).max(MAX_MAP_PINS), provider: z.literal('google').optional() }).strict();
/** A Dashboard block's tiles (see DashboardView): numbers pinned from other blocks. Kept out of nodeFields, so the canvas
 * tool agents see reads as the training snapshot has it; agents pin numbers with ros_pin_to_dashboard. */
const dashboardTileSchema = z.object({ id: identifier, block: identifier, keys: z.array(z.string().min(1).max(80)).min(1).max(MAX_FUNNEL_STEPS), show: z.enum(['number', 'line', 'bars', 'funnel']), label: z.string().trim().min(1).max(80).optional(), section: z.string().trim().min(1).max(60).optional() }).strict().refine(tile => tile.show === 'funnel' ? tile.keys.length >= 2 : tile.keys.length === 1, 'A funnel tile names two or more numbers; any other tile names one');
export const dashboardViewSchema = z.object({ tiles: z.array(dashboardTileSchema).max(MAX_DASHBOARD_TILES) }).strict();
const canvasMutationSchema = mutations({ ...appNodeFields, blockType: z.enum(['note','action','dataset','figure','code','notebook','report','agent','search','finding','notion','file','google','web','app','training','map','metric','post','dashboard']).optional(), map: mapViewSchema.optional(), post: postViewSchema.optional(), dashboard: dashboardViewSchema.optional(), notion: notionViewSchema.optional(), training: trainingViewSchema.optional(), metric: metricViewSchema.optional(), agent: agentLinkSchema.optional(), paper: paperSchema.optional(), decisions: z.array(decisionSchema).max(100).optional() });
export const mutationSchema = z.discriminatedUnion('type', [...canvasMutationSchema.options, updateConnectionSchema]);
/** What agents may propose: decisions are recorded only by the researcher. */
export const proposalMutationSchema = mutations(liveNodeFields);
/** The same without Google blocks: the schema agents are shown while Google Drive is not connected. */
export const snapshotProposalMutationSchema = mutations(nodeFields);
/** What agents may propose while Apps are switched on for them, with and without Google blocks. */
export const appProposalMutationSchema = mutations(appNodeFields);
export const snapshotAppProposalMutationSchema = mutations({ ...nodeFields, blockType: z.enum(['note','action','dataset','figure','code','notebook','report','agent','search','finding','notion','file','app']).optional(), app: appSchema.optional() });
const operationsSchema = z.array(mutationSchema).min(1).max(500);

const clone = <T>(value: T): T => structuredClone(value);
const GRID = 24;
// Placement runs before the browser measures outcome content. Existing cards may
// show results, so reserve the bounded maximum height for them; blocks added in
// the same edit have no results yet. Explicit Arrange uses measured footprints.
const MAX_NODES = 500;
const MAX_CONNECTIONS = 2_000;
const snap = (value: number) => Math.round(value / GRID) * GRID;

function placeNode(node: CanvasNode, others: CanvasNode[], fresh: ReadonlySet<string> = new Set()): CanvasNode {
  const placed = { ...node, x: snap(node.x), y: snap(node.y) };
  const height = (item: CanvasNode) => fresh.has(item.id) ? estimatedCardHeight(item) : cardFootprintHeight(item);
  const overlaps = () => others.some(other => (other.parentId ?? null) === (placed.parentId ?? null)
    && placed.x < other.x + cardWidth(other) + LAYOUT_GAP && other.x < placed.x + cardWidth(placed) + LAYOUT_GAP
    && (other.y <= placed.y ? placed.y < other.y + height(other) + LAYOUT_GAP : other.y < placed.y + height(placed) + LAYOUT_GAP));
  if (placed.parentId && overlaps()) {
    // Inside a Group, the first free spot beside or below its blocks keeps its frame as tight as it is.
    const boxes = others.filter(other => other.parentId === placed.parentId).map(other => ({ x: other.x, y: other.y, width: cardWidth(other), height: height(other) }));
    const spot = freeSpot(boxes, { width: cardWidth(placed), height: height(placed) }, { x: 0, y: 0 }, groupContentRight(boxes));
    if (spot) { coordinate.parse(spot.x); coordinate.parse(spot.y); return { ...placed, ...spot }; }
  }
  const originX = placed.x;
  const stepX = Math.ceil((cardWidth(placed) + LAYOUT_GAP) / GRID) * GRID;
  const stepY = Math.ceil((CARD_MAX_HEIGHT + LAYOUT_GAP) / GRID) * GRID;
  // Deterministic placement makes the proposal preview match the accepted mutation.
  for (let attempt = 0; overlaps(); attempt++) {
    if (attempt >= MAX_NODES * 4) throw new CanvasRuleError('No free placement found near the requested position');
    placed.x = originX + ((attempt + 1) % 5) * stepX;
    placed.y = snap(node.y) + Math.floor((attempt + 1) / 5) * stepY;
  }
  coordinate.parse(placed.x); coordinate.parse(placed.y);
  return placed;
}

/** A Code block whose language is html is saved as an App: the alias the frozen agent tools of 24 October write.
 * An App keeps its page and inputs in `app`, never in `code`; a Code input artifact becomes the block holding it. */
function asApp(projectId: string, lookups: CanvasLookups, node: CanvasNode): CanvasNode {
  const alias = isHtmlLanguage(node.code?.language) && (node.blockType === 'code' || node.blockType === undefined);
  if (node.blockType !== 'app' && !alias) return node;
  if (node.kind === 'group') throw new CanvasRuleError('A Group cannot be an App.');
  if (node.code && !isHtmlLanguage(node.code.language)) throw new CanvasRuleError('An App block holds one HTML page. Send app {source, inputs}, or code with language "html".');
  const { code, ...rest } = node;
  return { ...rest, blockType: 'app', app: { source: node.app?.source ?? code?.source ?? '', inputs: node.app?.inputs ?? codeInput(projectId, lookups, code?.inputArtifactId) } };
}
/** The patch an update makes, with an App's page always whole in `app`. Edits that leave the page alone stay as sent. */
function appPatch(projectId: string, lookups: CanvasLookups, node: CanvasNode, patch: Partial<CanvasNode>): Partial<CanvasNode> {
  const merged = { ...node, ...patch }, wasApp = node.blockType === 'app';
  const alias = isHtmlLanguage(merged.code?.language) && (merged.blockType === 'code' || merged.blockType === 'app');
  if (!wasApp && merged.blockType !== 'app' && !alias) return patch;
  if (wasApp && merged.blockType !== 'app' && !alias) throw new CanvasRuleError(`${node.title} is an App and stays one. Change its page with app {source}.`);
  if (!('app' in patch) && !('code' in patch) && !('blockType' in patch)) return patch;
  if (patch.code && !isHtmlLanguage(patch.code.language)) throw new CanvasRuleError('An App block holds one HTML page. Send app {source, inputs}, or code with language "html".');
  const { code, ...rest } = patch;
  const source = patch.app?.source ?? code?.source ?? node.app?.source ?? node.code?.source ?? '';
  const inputs = patch.app?.inputs ?? node.app?.inputs ?? codeInput(projectId, lookups, (code ?? node.code)?.inputArtifactId);
  return { ...rest, blockType: 'app', app: { source, inputs } };
}
function codeInput(projectId: string, lookups: CanvasLookups, artifactId: string | null | undefined): string[] {
  if (!artifactId) return [];
  const artifact = lookups.artifact(artifactId);
  if (artifact.projectId !== projectId) throw new CanvasRuleError('The Code input must belong to this project.');
  return [artifact.nodeId];
}

/** Applies a list of changes to a project's canvas, or refuses the whole list. Returns the new canvas and the changes
 * as they landed (a new block at the free spot it was given, a moved block on the grid). `proposal`: an agent's
 * suggestion, which may not record decisions and whose moves are nudged to free spots unless ros.ai `arranged` them. */
export function applyOperations(project: Pick<Project, 'id' | 'canvas'>, supplied: Mutation[], lookups: CanvasLookups, proposal: boolean, arranged = false): { canvas: Canvas; operations: Mutation[] } {
  const parsed = operationsSchema.parse(supplied) as Mutation[];
  const operations = proposal && !arranged ? batchGrid(parsed, project.canvas.nodes) : parsed;
  const canvas = clone(project.canvas);
  const activeNode = (id: string) => {
    const node = canvas.nodes.find(item => item.id === id);
    if (!node) throw new CanvasRuleError(`Node ${id} is not active in this project`);
    return node;
  };
  const normalized: Mutation[] = [];
  const recordedDecisions = new Set<string>();
  const added = new Set<string>();
  for (const operation of operations) {
    const decided = operation.type === 'addNode' ? operation.node.decisions && operation.node.id : operation.type === 'updateNode' && 'decisions' in operation.patch ? operation.id : undefined;
    if (decided) {
      if (proposal) throw new CanvasRuleError('Decisions are recorded by the researcher. A proposal cannot add or change them.');
      recordedDecisions.add(decided);
    }
    if (operation.type === 'addNode') {
      if (canvas.nodes.some(item => item.id === operation.node.id) || lookups.retired(operation.node.id)) throw new CanvasRuleError(`Node id ${operation.node.id} already exists or belongs to a removed node`);
      if (canvas.nodes.length >= MAX_NODES) throw new CanvasRuleError(`A project supports at most ${MAX_NODES} nodes`);
      added.add(operation.node.id);
      const node = operation.node.kind === 'group' ? { ...operation.node, x:snap(operation.node.x), y:snap(operation.node.y) } : placeNode(asApp(project.id, lookups, operation.node), canvas.nodes, added);
      narrowOnlyPictures(node);
      canvas.nodes.push(node); normalized.push({ type: 'addNode', node });
    } else if (operation.type === 'updateNode') {
      const node = activeNode(operation.id);
      let patch = appPatch(project.id, lookups, node, operation.patch);
      // An agent that changes a Notion block's filter or columns keeps the account the person chose for it.
      if (proposal && patch.notion && node.notion?.account && !patch.notion.account && patch.notion.url === node.notion.url) patch = { ...patch, notion: { ...patch.notion, account: node.notion.account } };
      let updated = { ...node, ...patch };
      if (updated.blockType === 'app') delete updated.code;
      // A null height gives the card back to its content.
      if (operation.patch.height === null) delete updated.height;
      // A null or full scale shows the block at its own size again.
      if (operation.patch.scale === null || operation.patch.scale === 1) delete updated.scale;
      if ('x' in operation.patch || 'y' in operation.patch) {
        updated.x = snap(updated.x); updated.y = snap(updated.y);
        if (proposal && !arranged) updated = placeNode(updated, canvas.nodes.filter(item => item.id !== node.id));
      }
      coordinate.parse(updated.x); coordinate.parse(updated.y);
      narrowOnlyPictures(updated);
      canvas.nodes = canvas.nodes.map(item => item.id === node.id ? updated : item);
      normalized.push({ type: 'updateNode', id: node.id, patch: { ...patch, ...('x' in operation.patch || 'y' in operation.patch ? { x: updated.x, y: updated.y } : {}) } });
    } else if (operation.type === 'removeNode') {
      activeNode(operation.id);
      // Removing a workspace removes its children in the same undoable edit;
      // durable identities, runs, messages and artifacts remain untouched.
      const removed = new Set([operation.id, ...canvas.nodes.filter(item => item.parentId === operation.id).map(item => item.id)]);
      for(let previous=-1; previous!==removed.size;) { previous=removed.size; for(const item of canvas.nodes) if(item.parentId && removed.has(item.parentId)) removed.add(item.id); }
      canvas.nodes = canvas.nodes.filter(item => !removed.has(item.id));
      canvas.connections = canvas.connections.filter(item => !removed.has(item.source) && !removed.has(item.target));
      // An App stops reading a removed block, as a link to it goes; Undo brings both back.
      canvas.nodes = canvas.nodes.map(item => item.app?.inputs.some(input => removed.has(input)) ? { ...item, app: { ...item.app, inputs: item.app.inputs.filter(input => !removed.has(input)) } } : item);
      normalized.push(operation);
    } else if (operation.type === 'addConnection') {
      const connection = operation.connection;
      activeNode(connection.source); activeNode(connection.target);
      if (connection.source === connection.target) throw new CanvasRuleError('Connect two different nodes');
      if (canvas.connections.some(item => item.id === connection.id)) throw new CanvasRuleError('Connection id already exists');
      if (canvas.connections.some(item => item.source === connection.source && item.target === connection.target)) throw new CanvasRuleError('These nodes are already connected');
      if (canvas.connections.length >= MAX_CONNECTIONS) throw new CanvasRuleError(`A project supports at most ${MAX_CONNECTIONS} connections`);
      canvas.connections.push(connection); normalized.push(operation);
    } else if (operation.type === 'removeConnection') {
      if (!canvas.connections.some(item => item.id === operation.id)) throw new CanvasRuleError('Connection is not active in this project');
      canvas.connections = canvas.connections.filter(item => item.id !== operation.id); normalized.push(operation);
    } else {
      const current = canvas.connections.find(item => item.id === operation.id);
      if (!current) throw new CanvasRuleError('Connection is not active in this project');
      const updated = { ...current, ...operation.patch };
      activeNode(updated.source); activeNode(updated.target);
      if (updated.source === updated.target) throw new CanvasRuleError('Connect two different nodes');
      if (canvas.connections.some(item => item.id !== current.id && item.source === updated.source && item.target === updated.target)) throw new CanvasRuleError('These nodes are already connected');
      canvas.connections = canvas.connections.map(item => item.id === current.id ? updated : item); normalized.push(operation);
    }
  }
  // Validate the final transaction, allowing a proposal to add parent and
  // child together. Deeper nesting is allowed; missing parents and cycles are not.
  for (const node of canvas.nodes) {
    if (!node.parentId) continue;
    const seen=new Set([node.id]); let parentId:string|null|undefined=node.parentId;
    while(parentId) {
      if(seen.has(parentId)) throw new CanvasRuleError('A workspace cannot contain itself or a parent cycle');
      seen.add(parentId); const parent=activeNode(parentId);
      if(parent.kind!=='group')throw new CanvasRuleError('Only an explicit Group can contain blocks. Create a Group or move this block to the canvas root.');
      parentId=parent.parentId;
    }
  }
  for (const node of canvas.nodes) {
    if (recordedDecisions.has(node.id) && node.decisions) {
      // Unknown citations are refused, never dropped. Unchanged entries were checked when recorded.
      const previous = new Map((project.canvas.nodes.find(item => item.id === node.id)?.decisions ?? []).map(decision => [decision.id, JSON.stringify(decision)]));
      if (new Set(node.decisions.map(decision => decision.id)).size !== node.decisions.length) throw new CanvasRuleError('Each decision needs its own id.');
      for (const decision of node.decisions) {
        if (previous.get(decision.id) === JSON.stringify(decision)) continue;
        for (const basis of decision.basedOn) {
          const saved = lookups.savedArtifact(basis.artifactId);
          if (saved?.projectId !== project.id || saved.hash !== basis.hash) throw new CanvasRuleError(`A decision can only cite saved versions in this project. ${basis.artifactId} is not one.`);
        }
      }
    }
    if (node.code?.inputArtifactId && lookups.artifact(node.code.inputArtifactId).projectId!==project.id) throw new CanvasRuleError('The Code input must belong to this project.');
    if (node.app) {
      if (node.blockType !== 'app') throw new CanvasRuleError('Only an App block has a page. Give it blockType "app".');
      if (new Set(node.app.inputs).size !== node.app.inputs.length) throw new CanvasRuleError(`Name each input of ${node.title} once.`);
      for (const input of node.app.inputs) {
        if (input === node.id) throw new CanvasRuleError(`${node.title} cannot read itself.`);
        if (!canvas.nodes.some(item => item.id === input)) throw new CanvasRuleError(`${node.title} reads ${input}, which is not a block on this canvas.`);
      }
    }
    if (node.artifactId) {
      const artifact = lookups.artifact(node.artifactId);
      if (artifact.projectId !== project.id) throw new CanvasRuleError('The block artifact must belong to this project.');
    }
    if (node.groupHighlights?.length) {
      if (node.kind !== 'group') throw new CanvasRuleError('Only a Group can own group highlights.');
      const descendants = groupMembers(canvas,node.id);
      const members = new Set([node.id,...descendants.map(member=>member.id)]);
      const represented = new Set([node.artifactId,...descendants.map(member=>member.artifactId)].filter(Boolean));
      // Moving an originating block out also removes its visual pin. The
      // immutable evidence/version is retained in its original block.
      if (!operations.some(operation => operation.type==='updateNode' && operation.id===node.id && 'groupHighlights' in operation.patch)) {
        const retained=node.groupHighlights.filter(highlight=>members.has(highlight.nodeId)||represented.has(highlight.artifactId));
        if (retained.length!==node.groupHighlights.length) { node.groupHighlights=retained; normalized.push({type:'updateNode',id:node.id,patch:{groupHighlights:retained}}); }
      }
      const versions = new Set<string>();
      for (const highlight of node.groupHighlights) {
        const artifact = lookups.artifact(highlight.artifactId);
        if (artifact.projectId !== project.id || artifact.nodeId !== highlight.nodeId || artifact.hash !== highlight.hash || !members.has(highlight.nodeId) && !represented.has(highlight.artifactId)) throw new CanvasRuleError('Choose an exact saved artifact version from this Group.');
        if (versions.has(artifact.id)) throw new CanvasRuleError('Choose each highlighted version once.');
        versions.add(artifact.id);
      }
    }
  }
  // Relationships can span branches; they never move notes or import artifacts.
  return { canvas, operations: normalized };
}

/** A proposal that adds several blocks to one scope is laid out by ros.ai as a
 * compact grid, so the whole batch can be read at once. It starts where the
 * proposal put its first block and moves down past existing blocks it would cover. */
export function batchGrid(operations: Mutation[], existing: readonly CanvasNode[], columns = 4): Mutation[] {
  const scopes = new Map<string | null, number[]>();
  operations.forEach((op, index) => {
    if (op.type !== 'addNode' || op.node.kind === 'group') return;
    const scope = op.node.parentId ?? null;
    scopes.set(scope, [...(scopes.get(scope) ?? []), index]);
  });
  const result = [...operations];
  for (const [scope, indexes] of scopes) {
    if (indexes.length < 3) continue;
    const nodes = indexes.map(index => (result[index] as Extract<Mutation, { type: 'addNode' }>).node);
    const count = Math.min(columns, nodes.length), stepX = Math.ceil((Math.max(...nodes.map(cardWidth)) + LAYOUT_GAP) / GRID) * GRID;
    const rows: number[] = [];
    nodes.forEach((node, index) => { const row = Math.floor(index / count); rows[row] = Math.max(rows[row] ?? 0, estimatedCardHeight(node)); });
    const width = (count - 1) * stepX + Math.max(...nodes.map(cardWidth)), height = rows.reduce((sum, row) => sum + row + LAYOUT_GAP, -LAYOUT_GAP);
    const x = snap(Math.min(...nodes.map(node => node.x))); let y = snap(Math.min(...nodes.map(node => node.y)));
    // Existing blocks in this scope the grid would cover push it down below them.
    const covered = existing.filter(other => (other.parentId ?? null) === scope && x < other.x + cardWidth(other) + LAYOUT_GAP && other.x < x + width + LAYOUT_GAP);
    if (covered.some(other => y < other.y + cardFootprintHeight(other) + LAYOUT_GAP && other.y < y + height + LAYOUT_GAP)) y = snap(Math.max(...covered.map(other => other.y + cardFootprintHeight(other) + LAYOUT_GAP)));
    let top = y;
    nodes.forEach((node, index) => {
      const column = index % count, row = Math.floor(index / count);
      if (column === 0 && row > 0) top += Math.ceil((rows[row - 1] + LAYOUT_GAP) / GRID) * GRID;
      result[indexes[index]] = { type: 'addNode', node: { ...node, x: x + column * stepX, y: top } };
    });
  }
  return result;
}
