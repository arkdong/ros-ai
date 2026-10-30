import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Express } from 'express';
import { z } from 'zod';
import { Store, StoreError } from './store.js';
import type { ExecutionService } from './execution.js';
import type { ModelRequest } from './providers.js';
import type { ModelSelection } from '../shared/model-settings.js';
import type { Canvas, CanvasNode, Mutation, Proposal } from '../shared/types.js';
import type { AssistantAction, AssistantTurn } from '../shared/assistant.js';
import { canvasAfter } from './agent-tools.js';
import { parseWholeJsonObject } from './response-normalization.js';
import { LAYOUT_GAP, freeSpot, groupContentRight, openGroupSize } from '../shared/layout.js';
import { CARD_MAX_HEIGHT, cardFootprintHeight, cardWidth, estimatedCardHeight } from '../shared/card-size.js';
import { SET_ASIDE } from '../shared/groups.js';
import { kindName } from '../shared/vocabulary.js';
import { LINK_WORDS } from '../shared/links.js';
import { layerSummary, plainTitle, replyHasContent, requestTitle, splitReply, type LayerBench, type LayerEngine, type LayerStats, type LayerStatus, type SplitBlock, type SplitReply, type TurnLayer } from '../shared/ros-layer.js';

/** What arranges right now: Local ROS when it is downloaded and running, hosted ROS when the person is signed in to it,
 * otherwise ros.ai's own rules (index.ts decides from the Local ROS and cloud account state). */
export type LayerChoice = { engine: LayerEngine; selection?: ModelSelection };
/** agent: the agent's name, for a group of work that came with no request (an agent working from outside ros.ai). */
export type LandInput = { projectId: string; turnId: string; request: string; reply: string; actions: AssistantAction[]; focusId?: string | null; source: AssistantTurn['source']; agent?: string; hint?: string };
export type LandResult = { layer: TurnLayer; action?: AssistantAction; event?: string };
type Execution = Pick<ExecutionService, 'assistantProposal' | 'acceptGovernedProposal' | 'layerComplete'>;

/** One counted agent turn (or, for an agent working from outside, one quiet spell of its calls). */
type TurnRecord = { id: string; turnId: string; at: string; source: string; blocks: number; loose: number; chatOnly: boolean; outcome: 'arranged' | 'rescued' | 'nothing' | 'failed' | 'off'; proposals: string[]; engine?: LayerEngine; fallback?: boolean; ms?: number; proposalId?: string };
/** A ROS row as Undo needs it: where moved blocks were, and what ROS added. */
type RowRecord = { proposalId: string; turnId: string; projectId: string; at: string; engine: LayerEngine; fallback: boolean; rescued: boolean; manual?: boolean; moved: { id: string; parentId: string | null; x: number; y: number; into: string }[]; groups: string[]; blocks: string[]; links: string[]; undone?: string };
/** What ROS proposes, by block id; 'answer' and 'section:<n>' name blocks it adds for an answer given in chat, 'group:<n>'
 * the new groups in order. */
export type LandingPlan = { place: { block: string; group: string }[]; newGroups: { title: string; blocks: string[] }[]; links: { from: string; to: string; label: string }[]; rescue?: { title: string; blocks: SplitBlock[]; group?: string } };
/** What a landing pass sees of the map: the canvas as the turn left it, the blocks the turn added, those of them still
 * loose (the candidates), the groups, every other block as a link end (inside groups too, the turn's own placed blocks
 * included), and the block or group the request names. */
export type TurnView = { canvas: Canvas; added: CanvasNode[]; candidates: CanvasNode[]; groups: CanvasNode[]; others: CanvasNode[]; named?: CanvasNode };
type Look = TurnView & { pending: Proposal[]; chatOnly: boolean; proposals: string[] };

const SETTINGS = 'ros-layer';
/** Budgets for one landing call: hosted ROS answers in seconds; Local ROS on a laptop reads the packet first. */
const BUDGET_MS: Record<Exclude<LayerEngine, 'layout'>, number> = { hosted: 30_000, local: 60_000 };
/** How long ROS waits for another thread of the project to finish before proposing, so its canvas does not move under it. */
const WAIT_MS = 15 * 60_000;
const MAX = { place: 12, groups: 3, links: 4, refs: 24, blocks: 40, text: 280 } as const;
const snap = (value: number) => Math.round(value / 24) * 24, snapUp = (value: number) => Math.ceil(value / 24) * 24;
const now = () => new Date().toISOString();
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Blocks an agent's research already shapes (its Agent block, Web and Search blocks, results and findings) keep their tree. */
const shaped = (node: CanvasNode) => node.kind === 'group' || ['agent', 'web', 'search', 'finding'].includes(node.blockType ?? '') || node.label === 'result';
const setAside = (node: CanvasNode) => node.title === SET_ASIDE.title && node.description.startsWith(SET_ASIDE.description);
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

export const LANDING_PROMPT = `You are ROS, the layer that tidies an agent's work on a ros.ai research map. The agent has finished its turn and its words are final: never rewrite or remove anything. You only give its work the map's shape.

You get the researcher's request, the agent's reply, the blocks the turn left outside any group (refs n1, n2, ...), the groups already on the map (g1, ...), other blocks on the map (b1, ...) and, when the agent answered only in chat, its answer cut into sections (s1, ...).

Return one JSON object:
- place: put a loose block into an existing group when it clearly belongs to that group's theme, as {"block":"n1","group":"g2"}.
- newGroups: when two or more loose blocks share a theme no existing group has, gather them under a short title of one to five words that names the theme, as {"title":"Methods","blocks":["n1","n2"]}. A block that fits no group stays loose.
- links: at most four links that say how this turn's blocks relate to each other or to blocks already on the map, each with one of the map's link words: ${LINK_WORDS.join(', ')}. A link reads from "from" to "to": {"from":"n1","to":"b3","label":"builds on"} says n1 builds on b3. Link only blocks that clearly relate; every link touches an n or s ref.
- toMap: only when sections are given. {"keep":true,"title":"..."} puts the answer on the map as a group of those sections under that title; {"keep":false,"title":""} leaves a reply that is only conversation (a greeting, a status, a how-to about ros.ai) in chat. Otherwise null.
Leave a list empty when nothing fits; an empty answer is often right. Use only refs from the packet.`;
const responseShape = z.object({
  place: z.array(z.object({ block: z.string(), group: z.string() })),
  newGroups: z.array(z.object({ title: z.string(), blocks: z.array(z.string()) })),
  links: z.array(z.object({ from: z.string(), to: z.string(), label: z.string() })),
  toMap: z.object({ keep: z.boolean(), title: z.string() }).nullable(),
});
// The contract goes in ROS's own instructions: one system message, which every chat template takes.
export const LANDING_SYSTEM = `${LANDING_PROMPT}\nReturn only the JSON object, without Markdown fences. Its JSON Schema: ${JSON.stringify(z.toJSONSchema(responseShape))}`;
const WORDS = new Set<string>(LINK_WORDS);
const ref = z.string().trim().min(2).max(16);
const placeItem = z.object({ block: ref, group: ref });
const groupItem = z.object({ title: z.string().trim().min(1).max(300), blocks: z.array(ref).min(1).max(MAX.refs) });
const linkItem = z.object({ from: ref, to: ref, label: z.string().trim().min(1).max(300) });
const toMapItem = z.object({ keep: z.boolean(), title: z.string().max(300).optional() });
const items = <T>(schema: z.ZodType<T>, value: unknown) => Array.isArray(value) ? value.flatMap(item => { const parsed = schema.safeParse(item); return parsed.success ? [parsed.data] : []; }) : [];

/** What a landing pass sees after a turn, from the canvas and the ids of the blocks the turn added. Blocks an agent's
 * research already shapes, and blocks linked to an Agent block, keep their place; the block or group the request names
 * by its title (else the one in focus) is the named one. Shared with ROS's training data
 * (training/ros-nemotron/structure.ts), so ROS learns from what the app shows it. */
export function seeTurn(canvas: Canvas, addedIds: ReadonlySet<string>, request: string, focusId?: string | null): TurnView {
  const byId = new Map(canvas.nodes.map(node => [node.id, node]));
  const added = [...addedIds].flatMap(id => { const node = byId.get(id); return node && node.kind !== 'group' ? [node] : []; });
  const nearAgent = (node: CanvasNode) => canvas.connections.some(edge => (edge.source === node.id && byId.get(edge.target)?.blockType === 'agent') || (edge.target === node.id && byId.get(edge.source)?.blockType === 'agent'));
  const candidates = added.filter(node => !node.parentId && !shaped(node) && !nearAgent(node)), loose = new Set(candidates.map(node => node.id));
  const groups = canvas.nodes.filter(node => node.kind === 'group' && !setAside(node));
  const others = canvas.nodes.filter(node => node.kind !== 'group' && node.blockType !== 'agent' && !loose.has(node.id));
  const lower = request.toLowerCase();
  const named = canvas.nodes.filter(node => !addedIds.has(node.id) && node.title.trim().length >= 5 && new RegExp(`(^|[^\\p{L}\\p{N}])${escaped(node.title.trim().toLowerCase())}($|[^\\p{L}\\p{N}])`, 'u').test(lower)).sort((a, b) => b.title.length - a.title.length)[0]
    ?? (focusId ? byId.get(focusId) : undefined);
  return { canvas, added, candidates, groups, others, ...(named ? { named } : {}) };
}

/** ros.ai's own rules, used when ROS is not there: loose blocks go into the group the request names (or the group of
 * the block it names), three or more go into a group of their own named after the request, and one link joins the work
 * to the named block. An answer given in chat becomes blocks cut at its own headings. */
export function landingRules(input: Pick<LandInput, 'request' | 'reply' | 'agent'>, look: TurnView, chatOnly: boolean, manual: boolean): LandingPlan | null {
  const named = look.named, group = named?.kind === 'group' ? named : named?.parentId ? look.canvas.nodes.find(node => node.id === named.parentId && node.kind === 'group') : undefined;
  const link = named && named.kind !== 'group' ? named : undefined;
  // The work builds on the block the request names, or answers it when that block is a question.
  const word = link?.label === 'question' ? 'answers' : 'builds on';
  if (chatOnly && (manual || !look.candidates.length)) {
    const split = splitReply(input.reply);
    if (!split.blocks.length) return null;
    const title = split.title || requestTitle(input.request);
    return { place: [], newGroups: [], links: link ? [{ from: 'answer', to: link.id, label: word }] : [], rescue: { title, blocks: split.blocks.map(block => ({ ...block, title: block.title || title })), ...(group && split.blocks.length === 1 ? { group: group.id } : {}) } };
  }
  const blocks = look.candidates.slice(0, MAX.place).map(node => node.id);
  const plan: LandingPlan = { place: [], newGroups: [], links: [] };
  if (group && !setAside(group)) plan.place = blocks.map(block => ({ block, group: group.id }));
  else if (blocks.length >= 3) plan.newGroups = [{ title: input.request.trim() ? requestTitle(input.request) : `Added by ${input.agent ?? 'your agent'}`, blocks }];
  if (link && blocks.length && !look.canvas.connections.some(edge => [edge.source, edge.target].includes(link.id) && look.added.some(node => node.id === edge.source || node.id === edge.target))) plan.links = [{ from: plan.newGroups.length ? 'group:0' : blocks[0], to: link.id, label: word }];
  return plan;
}

/** The landing request as ROS gets it, with short refs in place of ids: n for the loose blocks, g for the groups (the
 * named one first), b for the other blocks and s for the sections of an answer given only in chat. */
export type LandingAsk = { messages: ModelRequest['messages']; refs: Map<string, string>; split?: SplitReply };
export function landingAsk(input: Pick<LandInput, 'request' | 'reply' | 'hint'>, view: TurnView, chatOnly: boolean): LandingAsk {
  const refs = new Map<string, string>(), packet: Record<string, unknown> = { request: input.request.slice(0, 1500) };
  const text = (node: CanvasNode) => node.description.replace(/\s+/gu, ' ').trim().slice(0, MAX.text);
  const named = (prefix: string, nodes: CanvasNode[], limit: number = MAX.refs) => nodes.slice(0, limit).map((node, index) => { const key = `${prefix}${index + 1}`; refs.set(key, node.id); return { key, node }; });
  const loose = named('n', view.candidates), groups = named('g', [...view.groups].sort((a, b) => Number(b.id === view.named?.id || b.id === view.named?.parentId) - Number(a.id === view.named?.id || a.id === view.named?.parentId)));
  // Other blocks as link ends: the named one first, then those on the map's top level, then those inside groups.
  const rank = (node: CanvasNode) => node.id === view.named?.id ? 0 : node.parentId ? 2 : 1;
  const others = named('b', [...view.others].sort((a, b) => rank(a) - rank(b)), MAX.blocks), groupKey = new Map(groups.map(({ key, node }) => [node.id, key]));
  packet.loose = loose.map(({ key, node }) => ({ ref: key, title: node.title, kind: kindName(node), ...(node.label ? { label: node.label } : {}), text: text(node) }));
  packet.groups = groups.map(({ key, node }) => ({ ref: key, title: node.title, holds: view.canvas.nodes.filter(child => child.parentId === node.id).slice(0, 4).map(child => child.title) }));
  packet.blocks = others.map(({ key, node }) => ({ ref: key, title: node.title, ...(node.parentId && groupKey.has(node.parentId) ? { in: groupKey.get(node.parentId) } : {}) }));
  const split = chatOnly && !view.candidates.length ? splitReply(input.reply) : undefined;
  if (split?.blocks.length) packet.sections = split.blocks.map((block, index) => { refs.set(`s${index + 1}`, `section:${index}`); return { ref: `s${index + 1}`, title: block.title, text: block.text.replace(/\s+/gu, ' ').slice(0, 240) }; });
  packet.reply = input.reply.slice(0, split ? 1500 : 3000);
  if (input.hint) packet.hint = input.hint.slice(0, 1200);
  return { messages: [{ role: 'system', content: LANDING_SYSTEM }, { role: 'user', content: JSON.stringify(packet) }], refs, ...(split ? { split } : {}) };
}

/** ROS's answer as a plan, keeping only what checks out: refs from the packet, each loose block placed once, new groups
 * of two or more, and links with one of the map's words that touch the turn's work and are not on the map yet. Throws
 * when the answer holds no JSON object. */
export function landingPlan(content: string, asked: LandingAsk, view: TurnView, request: string): LandingPlan {
  const answer = parseWholeJsonObject(content.replace(/^\s*<think>[\s\S]*?<\/think>\s*/u, '')) as Record<string, unknown>;
  if (!answer || typeof answer !== 'object') throw new Error('ROS answered without a JSON object.');
  const keyed = (prefix: string) => new Set([...asked.refs].flatMap(([key, id]) => key.startsWith(prefix) ? [id] : []));
  const looseIds = keyed('n'), groupIds = keyed('g'), used = new Set<string>(), split = asked.split;
  const resolve = (key: string) => asked.refs.get(key.trim());
  const plan: LandingPlan = { place: [], newGroups: [], links: [] };
  for (const item of items(placeItem, answer.place)) {
    const block = resolve(item.block), group = resolve(item.group);
    if (block && group && looseIds.has(block) && groupIds.has(group) && !used.has(block) && plan.place.length < MAX.place) { used.add(block); plan.place.push({ block, group }); }
  }
  for (const item of items(groupItem, answer.newGroups)) {
    const blocks = [...new Set(item.blocks.map(resolve).filter((id): id is string => Boolean(id && looseIds.has(id) && !used.has(id))))];
    const title = plainTitle(item.title, 80);
    if (blocks.length >= 2 && title && plan.newGroups.length < MAX.groups) { blocks.forEach(id => used.add(id)); plan.newGroups.push({ title, blocks }); }
  }
  const work = (id: string) => looseIds.has(id) || id.startsWith('section:') || view.added.some(node => node.id === id), pairs = new Set<string>();
  for (const item of items(linkItem, answer.links)) {
    const from = resolve(item.from), to = resolve(item.to), label = plainTitle(item.label, 40).toLowerCase();
    if (!from || !to || from === to || !WORDS.has(label) || !(work(from) || work(to)) || plan.links.length >= MAX.links) continue;
    const pair = [from, to].sort().join('\u0000');
    if (pairs.has(pair) || view.canvas.connections.some(edge => (edge.source === from && edge.target === to) || (edge.source === to && edge.target === from))) continue;
    pairs.add(pair); plan.links.push({ from, to, label });
  }
  if (split?.blocks.length) {
    const toMap = toMapItem.safeParse(answer.toMap);
    if (!toMap.success || toMap.data.keep) plan.rescue = { title: plainTitle(toMap.success ? toMap.data.title ?? '' : '', 80) || split.title || requestTitle(request), blocks: split.blocks.map(block => ({ ...block, title: block.title || split.title || requestTitle(request) })) };
    else plan.links = plan.links.filter(link => !link.from.startsWith('section:') && !link.to.startsWith('section:'));
  }
  return plan;
}

/** ROS as the canvas layer on top of whichever agent the person picked (docs: research/ros-layer-direction-2026-10-30).
 * After a turn it reads what the turn left loose (blocks outside any group, without links) or an answer given only in
 * chat, and proposes the map's shape for it: a group, a few links, the answer as blocks. The agent's words and the
 * blocks it placed on purpose are never changed or removed. The proposal follows the approval mode like any agent's,
 * shows as one row on the turn's card, and can be undone. When ROS is not there or does not answer in time, ros.ai's
 * own rules arrange instead; when that fails too, nothing changes. */
export class RosLayer {
  constructor(private readonly store: Store, private readonly execution: Execution, private readonly choose: () => LayerChoice = () => ({ engine: 'layout' })) {}

  on() { return this.store.globalRecord<{ on: boolean }>(SETTINGS, 'settings')?.on ?? true; }
  engine(): LayerChoice { try { return this.choose(); } catch { return { engine: 'layout' }; } }
  status(): LayerStatus {
    const choice = this.engine(), stats: LayerStats = { turns: 0, changes: 0, blocks: 0, loose: 0, chatOnly: 0, rows: 0, rescued: 0, accepted: 0, undone: 0, dismissed: 0, fallback: 0, failed: 0 };
    for (const project of this.store.listProjects()) {
      for (const turn of this.store.records<TurnRecord>('ros-layer-turn', project.id)) { stats.turns++; stats.changes += turn.proposals.length; stats.blocks += turn.blocks; stats.loose += turn.loose; if (turn.chatOnly) stats.chatOnly++; if (turn.outcome === 'failed') stats.failed++; }
      for (const row of this.store.records<RowRecord>('ros-layer-row', project.id)) {
        stats.rows++; if (row.rescued) stats.rescued++; if (row.fallback) stats.fallback++;
        if (row.undone) { stats.undone++; continue; }
        try { const status = this.store.proposalStatus(project.id, row.proposalId); if (status === 'accepted') stats.accepted++; else if (status === 'dismissed') stats.dismissed++; } catch { /* removed with its project's history */ }
      }
    }
    const bench = this.store.globalRecord<LayerBench>(SETTINGS, 'bench');
    return { on: this.on(), engine: choice.engine, ...(choice.selection ? { model: choice.selection.model } : {}), stats, ...(bench ? { bench } : {}) };
  }
  save(supplied: unknown): LayerStatus {
    const { on } = z.object({ on: z.boolean() }).strict().parse(supplied);
    this.store.saveGlobalRecord(SETTINGS, 'settings', { on });
    return this.status();
  }

  /** The landing pass after a turn. Counts the turn whatever happens; null while the switch is off. `busy` says another
   * turn of the project is still working, which ROS waits out before it proposes. `hurry` fires when the person starts
   * another turn: Local ROS serves one request at a time, so ROS stops asking it and ros.ai's own rules arrange. */
  async land(input: LandInput, signal: AbortSignal, busy: () => boolean = () => false, hurry?: AbortSignal): Promise<LandResult | null> {
    const started = Date.now(), look = this.look(input, false), id = randomUUID();
    const record = (outcome: TurnRecord['outcome'], extra: Partial<TurnRecord> = {}) => this.store.saveRecord<TurnRecord>('ros-layer-turn', id, input.projectId, { id, turnId: input.turnId, at: now(), source: input.source, blocks: look.added.length, loose: look.added.filter(node => !node.parentId && !look.canvas.connections.some(edge => edge.source === node.id || edge.target === node.id)).length, chatOnly: look.chatOnly, outcome, proposals: look.proposals, ...extra });
    if (!this.on()) { record('off'); return null; }
    if (!look.candidates.length && !look.chatOnly) { record('nothing'); return { layer: { state: 'skipped', note: 'Nothing was left loose.' } }; }
    const choice = this.engine();
    let plan: LandingPlan | null = null, fallback = false;
    if (choice.selection && choice.engine !== 'layout') {
      try { plan = await this.ask(input, look, choice, choice.engine === 'local' && hurry ? AbortSignal.any([signal, hurry]) : signal); }
      catch (error) { if (signal.aborted) throw error; fallback = true; console.error(`ROS layer: ${choice.engine} ROS did not arrange this turn: ${error instanceof Error ? error.message : error}`); }
    }
    plan ??= landingRules(input, look, look.chatOnly, false);
    const engine: LayerEngine = fallback || !choice.selection ? 'layout' : choice.engine;
    if (!plan || (!plan.place.length && !plan.newGroups.length && !plan.links.length && !plan.rescue)) { record('nothing', { engine, fallback }); return { layer: { state: 'skipped', engine, note: 'Everything already had its place.' } }; }
    // Another thread still at work would find the canvas moved under its next change.
    let waited = false;
    for (const until = Date.now() + WAIT_MS; busy(); waited = true) {
      if (Date.now() > until) { record('nothing', { engine, fallback }); return { layer: { state: 'skipped', engine, note: 'Another thread kept working, so ROS left this turn as it was.' } }; }
      await delay(1500, undefined, { signal });
    }
    // The person carried on before the answer went on the map, perhaps asking for just that: Put this on the map stays.
    if (waited && plan.rescue) { record('nothing', { engine, fallback }); return { layer: { state: 'skipped', engine, note: 'You carried on first, so the answer stays in chat.' } }; }
    try {
      const made = this.propose(input, this.look(input, false), plan, engine, fallback);
      if (!made) { record('nothing', { engine, fallback }); return { layer: { state: 'skipped', engine, note: 'Everything already had its place.' } }; }
      const ms = Date.now() - started;
      record(plan.rescue ? 'rescued' : 'arranged', { engine, fallback, ms, proposalId: made.action.proposalId });
      return { layer: { state: 'done', engine, proposalId: made.action.proposalId, ms }, action: made.action, event: made.event };
    } catch (error) {
      record('failed', { engine, fallback });
      throw error;
    }
  }

  /** "Put this on the map" under an answer: the person's own click, so it lands at once, cut by ros.ai's own rules. */
  toMap(input: LandInput): AssistantAction {
    const look = this.look(input, true), plan = landingRules(input, look, look.chatOnly, true);
    if (!plan?.rescue) throw new StoreError('This answer has no text to put on the map.', 409);
    const made = this.propose(input, look, plan, 'layout', false, true);
    if (!made) throw new StoreError('This answer has no text to put on the map.', 409);
    if (made.proposal.status === 'pending' && !this.execution.acceptGovernedProposal(input.projectId, made.proposal.id)) this.store.acceptProposal(input.projectId, made.proposal.id);
    return { ...made.action, status: 'completed' };
  }

  /** Takes an accepted ROS row back: its links go, moved blocks return to where they were (unless the person has moved
   * them since), and the groups and blocks it added go, with anything the person put into them since left outside. */
  undo(projectId: string, proposalId: string) {
    const row = this.store.record<RowRecord>('ros-layer-row', proposalId);
    if (!row || row.projectId !== projectId) throw new StoreError('This ROS change was not found.', 404);
    if (row.undone) throw new StoreError('This ROS change is already undone.', 409);
    if (this.store.proposalStatus(projectId, proposalId) !== 'accepted') throw new StoreError('Only an accepted change can be undone; dismiss one that waits.', 409);
    const canvas = this.store.getProject(projectId).canvas, find = (id: string) => canvas.nodes.find(node => node.id === id), operations: Mutation[] = [];
    for (const id of row.links) if (canvas.connections.some(edge => edge.id === id)) operations.push({ type: 'removeConnection', id });
    for (const moved of row.moved) if (find(moved.id)?.parentId === moved.into) operations.push({ type: 'updateNode', id: moved.id, patch: { parentId: moved.parentId, x: moved.x, y: moved.y } });
    for (const groupId of row.groups) {
      const group = find(groupId);
      if (group) for (const child of canvas.nodes.filter(node => node.parentId === groupId && !row.blocks.includes(node.id) && !row.moved.some(moved => moved.id === node.id))) operations.push({ type: 'updateNode', id: child.id, patch: { parentId: group.parentId ?? null, x: group.x + child.x, y: group.y + child.y } });
    }
    for (const id of [...row.blocks, ...row.groups]) if (find(id)) operations.push({ type: 'removeNode', id });
    if (operations.length) this.store.mutate(projectId, operations, 'Undo: arranged by ROS');
    this.store.saveRecord<RowRecord>('ros-layer-row', proposalId, projectId, { ...row, undone: now() });
  }

  /** Measures the engine on this computer: one call that reads a map of about 8,000 tokens, one that writes about 200. */
  async bench(signal: AbortSignal): Promise<LayerStatus> {
    const choice = this.engine();
    if (!choice.selection || choice.engine === 'layout') throw new StoreError('Download Local ROS or sign in to hosted ROS first; ros.ai’s own rules need no measuring.', 409);
    const project = this.store.listProjects()[0];
    if (!project) throw new StoreError('Create a project first; the measurement runs in one.', 409);
    const words = ['survey', 'method', 'sample', 'result', 'claim', 'source', 'model', 'bias', 'cost', 'trial', 'dataset', 'baseline'];
    const map = Array.from({ length: 150 }, (_, index) => ({ ref: `b${index + 1}`, title: `${words[index % words.length]} note ${index + 1}`, text: Array.from({ length: 24 }, (__, step) => words[(index * 7 + step * 5) % words.length]).join(' ') }));
    const read = await this.execution.layerComplete(project.id, { messages: [{ role: 'system', content: LANDING_PROMPT }, { role: 'user', content: JSON.stringify({ request: 'Measure only: answer with {}.', blocks: map }) }], maxOutputTokens: 8 }, signal, choice.selection);
    const write = await this.execution.layerComplete(project.id, { messages: [{ role: 'user', content: 'Write the numbers from 1 to 120, separated by spaces, and nothing else.' }], maxOutputTokens: 240 }, signal, choice.selection);
    const ms = (value: unknown) => typeof value === 'number' ? value : 0;
    this.store.saveGlobalRecord<LayerBench>(SETTINGS, 'bench', { at: now(), engine: choice.engine, model: choice.selection.model, promptTokens: read.response.usage?.inputTokens ?? 0, prefillMs: ms(read.response.metadata.latencyMs), outputTokens: write.response.usage?.outputTokens ?? 0, decodeMs: ms(write.response.metadata.latencyMs) });
    return this.status();
  }

  /** The map as the turn left it: its changes still waiting count as made. Stale changes, and changes earlier passes
   * already arranged, are left out. */
  private look(input: LandInput, manual: boolean): Look {
    const detail = this.store.detail(input.projectId), revision = detail.project.revision;
    const handled = new Set(this.store.records<TurnRecord>('ros-layer-turn', input.projectId).filter(item => item.turnId === input.turnId).flatMap(item => item.proposals));
    const own = new Set(input.actions.filter(action => action.by !== 'ros' && action.proposalId && !handled.has(action.proposalId)).map(action => action.proposalId!));
    const proposals = detail.proposals.filter(proposal => own.has(proposal.id) && (proposal.status === 'accepted' || (proposal.status === 'pending' && proposal.baseRevision === revision)));
    const pending = proposals.filter(proposal => proposal.status === 'pending');
    const canvas = canvasAfter(detail.project.canvas, pending.flatMap(proposal => proposal.operations));
    const addedIds = new Set(proposals.flatMap(proposal => proposal.operations.flatMap(op => op.type === 'addNode' ? [op.node.id] : [])));
    const worked = input.actions.some(action => action.by !== 'ros' && (action.proposalId || action.reportProposalId || action.runId));
    const chatOnly = input.source !== 'outside-agent' && Boolean(input.reply.trim()) && (manual || (!worked && replyHasContent(input.reply)));
    return { ...seeTurn(canvas, addedIds, input.request, input.focusId), pending, chatOnly, proposals: proposals.map(proposal => proposal.id) };
  }

  /** Asks ROS for the shape under its contract (landingAsk) and keeps what checks out (landingPlan). A reply that does
   * not parse throws, and ros.ai's rules step in. */
  private async ask(input: LandInput, look: Look, choice: LayerChoice, signal: AbortSignal): Promise<LandingPlan> {
    const asked = landingAsk(input, look, look.chatOnly);
    const request: ModelRequest = { messages: asked.messages, maxOutputTokens: choice.engine === 'hosted' ? 2000 : 900 };
    const { response } = await this.execution.layerComplete(input.projectId, request, AbortSignal.any([signal, AbortSignal.timeout(BUDGET_MS[choice.engine as 'local' | 'hosted'])]), choice.selection!);
    return landingPlan(response.content, asked, look, input.request);
  }

  /** Turns a plan into one proposal on the map as it is now, laid out by ros.ai: blocks go into free spots inside their
   * group, a new group sits where its blocks were, an answer goes beside the block it is about or right of the map. */
  private propose(input: LandInput, look: Look, plan: LandingPlan, engine: LayerEngine, fallback: boolean, manual = false): { proposal: Proposal; action: AssistantAction; event: string } | null {
    const canvas = look.canvas, byId = new Map(canvas.nodes.map(node => [node.id, node])), operations: Mutation[] = [];
    const row: RowRecord = { proposalId: '', turnId: input.turnId, projectId: input.projectId, at: now(), engine, fallback, rescued: Boolean(plan.rescue), ...(manual ? { manual } : {}), moved: [], groups: [], blocks: [], links: [] };
    const loose = (id: string) => { const node = byId.get(id); return node && !node.parentId && node.kind !== 'group' ? node : undefined; };
    const children = new Map<string, Box[]>();
    const inside = (groupId: string) => children.get(groupId) ?? (children.set(groupId, canvas.nodes.filter(node => node.parentId === groupId).map(node => ({ x: node.x, y: node.y, width: cardWidth(node), height: cardFootprintHeight(node) }))), children.get(groupId)!);
    const into: string[] = [];
    let blocks = 0;
    for (const { block, group } of plan.place) {
      const node = loose(block), target = byId.get(group);
      if (!node || target?.kind !== 'group') continue;
      const boxes = inside(group), size = { width: cardWidth(node), height: estimatedCardHeight(node) };
      const spot = freeSpot(boxes, size, { x: 0, y: 0 }, groupContentRight(boxes)) ?? { x: 0, y: snapUp(Math.max(0, ...boxes.map(box => box.y + box.height)) + LAYOUT_GAP) };
      boxes.push({ ...spot, ...size });
      operations.push({ type: 'updateNode', id: node.id, patch: { parentId: group, x: spot.x, y: spot.y } });
      row.moved.push({ id: node.id, parentId: null, x: node.x, y: node.y, into: group });
      blocks++; if (!into.includes(target.title)) into.push(target.title);
    }
    const groupIds: string[] = [];
    for (const group of plan.newGroups) {
      const members = group.blocks.map(loose).filter((node): node is CanvasNode => Boolean(node) && !row.moved.some(moved => moved.id === node!.id)).sort((a, b) => a.y - b.y || a.x - b.x);
      if (members.length < 2) { groupIds.push(''); continue; }
      const id = randomUUID(), x = snap(Math.min(...members.map(node => node.x))), y = snap(Math.min(...members.map(node => node.y)));
      operations.push({ type: 'addNode', node: { id, title: group.title, description: '', kind: 'group', parentId: null, x, y } });
      grid(members).forEach(({ node, at }) => { operations.push({ type: 'updateNode', id: node.id, patch: { parentId: id, ...at } }); row.moved.push({ id: node.id, parentId: null, x: node.x, y: node.y, into: id }); });
      row.groups.push(id); groupIds.push(id); blocks += members.length; into.push(group.title);
    }
    let rescued: { blocks: number; title: string } | undefined;
    const sections: string[] = [];
    let answer: string | undefined;
    if (plan.rescue) {
      const cards = plan.rescue.blocks.map(block => ({ id: randomUUID(), title: plainTitle(block.title, 200) || plan.rescue!.title, description: block.text, kind: 'topic' as const, blockType: 'note' as const }));
      cards.forEach(card => sections.push(card.id));
      const group = plan.rescue.group ? byId.get(plan.rescue.group) : undefined;
      if (cards.length === 1 && group?.kind === 'group') {
        const boxes = inside(group.id), size = { width: cardWidth(cards[0]), height: estimatedCardHeight(cards[0]) };
        const spot = freeSpot(boxes, size, { x: 0, y: 0 }, groupContentRight(boxes)) ?? { x: 0, y: snapUp(Math.max(0, ...boxes.map(box => box.y + box.height)) + LAYOUT_GAP) };
        operations.push({ type: 'addNode', node: { ...cards[0], parentId: group.id, ...spot } });
        answer = cards[0].id;
      } else if (cards.length === 1) {
        const spot = topSpot(canvas, { width: cardWidth(cards[0]), height: CARD_MAX_HEIGHT }, anchorOf(canvas, look.named));
        operations.push({ type: 'addNode', node: { ...cards[0], parentId: null, ...spot } });
        answer = cards[0].id;
      } else {
        const id = randomUUID(), laid = grid(cards.map(card => ({ ...card, x: 0, y: 0 }) as CanvasNode));
        const content = { width: Math.max(...laid.map(({ node, at }) => at.x + cardWidth(node))), height: Math.max(...laid.map(({ node, at }) => at.y + estimatedCardHeight(node))) };
        const spot = topSpot(canvas, openGroupSize(content), anchorOf(canvas, look.named));
        operations.push({ type: 'addNode', node: { id, title: plan.rescue.title, description: '', kind: 'group', parentId: null, ...spot } });
        laid.forEach(({ node, at }) => operations.push({ type: 'addNode', node: { ...node, parentId: id, ...at } }));
        row.groups.push(id); answer = id;
      }
      row.blocks.push(...cards.map(card => card.id));
      rescued = { blocks: cards.length, title: cards.length > 1 ? plan.rescue.title : cards[0].title };
    }
    const endpoint = (id: string) => id === 'answer' ? answer : id.startsWith('section:') ? sections[Number(id.slice(8))] : id.startsWith('group:') ? groupIds[Number(id.slice(6))] || undefined : byId.has(id) ? id : undefined;
    for (const link of plan.links) {
      const source = endpoint(link.from), target = endpoint(link.to);
      if (!source || !target || source === target) continue;
      const id = randomUUID();
      operations.push({ type: 'addConnection', connection: { id, source, target, label: link.label } });
      row.links.push(id);
    }
    if (!operations.length) return null;
    // A change that builds on blocks the turn's waiting changes add waits for them, and is dismissed with them.
    const touched = new Set(operations.flatMap(op => op.type === 'updateNode' ? [op.id, op.patch.parentId] : op.type === 'addConnection' ? [op.connection.source, op.connection.target] : op.type === 'addNode' ? [op.node.parentId] : []));
    const after = look.pending.filter(proposal => proposal.operations.some(op => op.type === 'addNode' && touched.has(op.node.id))).map(proposal => proposal.id);
    const summary = layerSummary({ blocks, into, links: row.links.length, ...(rescued ? { rescued } : {}) });
    const proposal = this.execution.assistantProposal(input.projectId, `${summary}\nWhy: ${engine === 'layout' ? 'ros.ai’s own rules' : engine === 'local' ? 'Local ROS' : 'hosted ROS'} gave what the turn left loose a place on the map.`, operations, true, { ...(after.length ? { after } : {}), batch: input.turnId });
    this.store.saveRecord<RowRecord>('ros-layer-row', proposal.id, input.projectId, { ...row, proposalId: proposal.id });
    const action: AssistantAction = { id: randomUUID(), type: 'proposal', title: summary, proposalId: proposal.id, status: proposal.status === 'accepted' ? 'completed' : 'pending', by: 'ros' };
    return { proposal, action, event: rescued ? `ROS put the answer on the map (${count(rescued.blocks, 'block')}).` : 'ROS arranged what the turn left loose.' };
  }
}

type Box = { x: number; y: number; width: number; height: number };
/** Blocks inside a new group in reading order: two columns for up to four, three for more. */
function grid(nodes: CanvasNode[]): { node: CanvasNode; at: { x: number; y: number } }[] {
  const columns = nodes.length <= 2 ? nodes.length : nodes.length <= 4 ? 2 : 3, step = snapUp(Math.max(...nodes.map(cardWidth)) + LAYOUT_GAP);
  const rows: number[] = [];
  nodes.forEach((node, index) => { const row = Math.floor(index / columns); rows[row] = Math.max(rows[row] ?? 0, estimatedCardHeight(node)); });
  const tops = rows.reduce<number[]>((list, height, index) => [...list, index ? list[index - 1] + snapUp(rows[index - 1] + LAYOUT_GAP) : 0], []);
  return nodes.map((node, index) => ({ node, at: { x: (index % columns) * step, y: tops[Math.floor(index / columns)] } }));
}
/** A top-level block's footprint: an open group's frame around its blocks, or a card at its tallest. */
function footprint(canvas: Canvas, node: CanvasNode): Box {
  if (node.kind !== 'group') return { x: node.x, y: node.y, width: cardWidth(node), height: cardFootprintHeight(node) };
  const inside = canvas.nodes.filter(child => child.parentId === node.id);
  if (!inside.length) return { x: node.x, y: node.y, width: cardWidth(node), height: CARD_MAX_HEIGHT };
  return { x: node.x, y: node.y, ...openGroupSize({ width: Math.max(...inside.map(child => Math.max(0, child.x) + cardWidth(child))), height: Math.max(...inside.map(child => Math.max(0, child.y) + cardFootprintHeight(child))) }) };
}
/** The top-level block a new answer goes beside: the named block, or the group it sits in. */
function anchorOf(canvas: Canvas, node: CanvasNode | undefined): CanvasNode | undefined {
  for (let current = node, depth = 0; current && depth < 8; depth++) { if (!current.parentId) return current; current = canvas.nodes.find(item => item.id === current!.parentId); }
  return undefined;
}
/** The first free top-level spot for something this big: right of the anchor, else right of everything, going down. */
function topSpot(canvas: Canvas, size: { width: number; height: number }, anchor?: CanvasNode) {
  const boxes = canvas.nodes.filter(node => !node.parentId).map(node => footprint(canvas, node));
  const origin = anchor ? (() => { const box = footprint(canvas, anchor); return { x: snapUp(box.x + box.width + LAYOUT_GAP * 2), y: snap(box.y) }; })()
    : boxes.length ? { x: snapUp(Math.max(...boxes.map(box => box.x + box.width)) + LAYOUT_GAP * 2), y: snap(Math.min(...boxes.map(box => box.y))) } : { x: 0, y: 0 };
  const free = (y: number) => boxes.every(box => origin.x >= box.x + box.width + LAYOUT_GAP || origin.x + size.width + LAYOUT_GAP <= box.x || y >= box.y + box.height + LAYOUT_GAP || y + size.height + LAYOUT_GAP <= box.y);
  for (let step = 0; step < 400; step++) if (free(origin.y + step * 24)) return { x: origin.x, y: origin.y + step * 24 };
  return origin;
}

export function attachRosLayerRoutes(app: Express, layer: RosLayer) {
  app.get('/api/ros-layer', (_req, res) => res.json(layer.status()));
  app.put('/api/ros-layer', (req, res) => res.json(layer.save(req.body)));
  app.post('/api/ros-layer/bench', async (req, res) => {
    const controller = new AbortController();
    req.on('close', () => { if (!res.writableEnded) controller.abort(); });
    res.json(await layer.bench(AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)])));
  });
}
