/** Round 2's structure family: ROS learns when to give an agent's work the map's shape, which blocks to group and which
 * to link (docs: research/ros-layer-direction-2026-10-30). The teacher writes well-organised maps; each map's shape is
 * then taken away in a few ways (a group pulled apart, a block or two taken out of their group, their links dropped),
 * and the original shape is the answer. In some cases the turn's block belongs to no group and has no links, and the
 * answer is to change nothing. Every request is built by the app's own landing pass (seeTurn and landingAsk in
 * src/server/ros-layer.ts) and every answer is read back by its own parser (landingPlan), so ROS learns exactly what the
 * app sends it and what the app keeps. */
import { createHash } from 'node:crypto';
import { LINK_WORDS } from '../../src/shared/links.js';
import { plainTitle } from '../../src/shared/ros-layer.js';
import type { Canvas, CanvasNode, Connection } from '../../src/shared/types.js';
import { landingAsk, landingPlan, landingRules, seeTurn, type LandingAsk, type LandingPlan, type TurnView } from '../../src/server/ros-layer.js';
import { appendJsonl, ask, pool, readJsonl, type ChatAdapter } from './lib.js';

export type StructureMap = {
  id: string; domain: string; title: string;
  blocks: { slug: string; title: string; text: string; label?: string; group?: string }[];
  /** request and reply: what a researcher asked an agent that then added this group's blocks, and the agent's answer. */
  groups: { slug: string; title: string; request?: string; reply?: string }[];
  links: { from: string; to: string; word: string }[];
};
/** regroup: a group's blocks came loose and the group is gone. place: a block or two came out of a group that is still
 * there. mixed: both. links: a block that fits no group came without its links. leave: a block that fits no group and
 * has no links, so the answer is to change nothing. */
export type CaseKind = 'regroup' | 'place' | 'mixed' | 'links' | 'leave';
/** One turn's leftovers: the map after the turn, the blocks it added, what was asked and answered, and the shape the
 * original map had for them, by block id. */
export type StructureCase = { id: string; mapId: string; kind: CaseKind; canvas: Canvas; added: string[]; request: string; reply: string; target: LandingPlan };

// 'result' is left out: the app keeps result blocks in their own tree, so ROS never arranges one.
const LABELS = new Set(['question', 'plan', 'task', 'finding', 'decision', 'draft', 'report']);
const WORDS = new Set<string>(LINK_WORDS);
const MAPS = `You design well-organised ros.ai research maps for a training set. ros.ai is a research workspace: a canvas of blocks (notes, questions, plans, findings, drafts) that a researcher builds while working with AI agents. A well-organised map gathers blocks that share a theme into a group and links blocks that relate with one word.
Return JSON {"maps":[{"title","blocks":[{"slug","title","text","label"?,"group"?}],"groups":[{"slug","title","request","reply"}],"links":[{"from","to","word"}]}]}.
- 8-20 blocks per map and 2-5 groups of 2-6 blocks each (a block's group is the group's slug). One to three blocks stay outside every group because they fit none: the research question, a stray idea, a to-do.
- Group titles name the theme in one to four words (Methods, Prior studies, Open questions, Costs), never "Group 1", "Notes" or "Misc".
- One idea per block: a title of two to eight words and one to six lines a researcher would write, with sources, numbers, dates and doubts.
- label, only when the block is one: ${[...LABELS].join(', ')}.
- links: 3-10, between blocks (never groups), each with one word from: ${LINK_WORDS.join(', ')}. "from <word> to" must read true, as in "the survey supports the claim". Link only blocks that really relate; most blocks have no link.
- request: what the researcher typed to an AI agent that then added this group's blocks, as people write: short or long, sometimes vague, now and then in Dutch. reply: the agent's answer after adding them, one to three sentences.
- Maps differ in stage (just started, well along), size and style. Slugs are short kebab-case and unique within a map.`;

/** Each request's stage, size and style, so the maps of a domain differ although each request writes one. */
const BRIEFS = [
  'It has just started: 8 to 10 blocks in two groups, short notes.',
  'It is well along: 16 to 20 blocks in four or five groups, careful notes with sources and numbers.',
  'It is halfway: 11 to 14 blocks in three groups, some notes terse and some careful.',
  'It is wrapping up: 12 to 16 blocks in three or four groups, with a decision and a draft.',
  'It is early and a little messy: 9 to 12 blocks in two or three groups, with open questions and doubts.',
  'It is a careful review: 14 to 18 blocks in four groups, each claim with its source and date.',
  'It is a quick exploration: 8 to 11 blocks in two or three groups, mostly findings and to-dos.',
  'It is a plan in progress: 12 to 15 blocks in three or four groups, with tasks, a plan and a report.',
];

/** One map, in a request of its own, which keeps each answer well inside Token Factory's 90-second limit. The request
 * carries the domain's next brief and the titles already written there; asked for one map, the teacher often returns it
 * bare, without the "maps" list. */
export async function makeMap(model: ChatAdapter, domain: string, index: number, written: string[]): Promise<StructureMap | null> {
  const brief = BRIEFS[(parseInt(createHash('md5').update(domain).digest('hex').slice(0, 8), 16) + index) % BRIEFS.length];
  const answer = await ask<{ maps?: unknown[] }>(model, MAPS, `Write one map in the domain: ${domain}. ${brief}${written.length ? `\nTake another angle than the maps already written in this domain: ${written.join('; ')}.` : ''}`, 6_000);
  return tidyMap(Array.isArray(answer?.maps) ? answer.maps[0] : answer, domain);
}

/** The teacher writes links more freely than it groups: about a third of a first run's links were a stretch ("ICU waits
 * supports discharge paperwork waits"). So each map's links are checked once more, one map per request, before training. */
const CHECK = `You check the links on a ros.ai research map before it is used to teach an assistant which blocks to link. A link reads "<from> <word> <to>", with one of the map's words: ${LINK_WORDS.join(', ')}.
Keep a link only when a careful researcher would draw it: given the two blocks' titles and texts the sentence is plainly true, the word is the right one, and it tells the reader something. Drop a link that is vague, a stretch, the wrong way round or in the wrong word.
Return JSON {"links":[{"from","to","why","keep"}]}, one entry per link in the order given, with "from" and "to" as the slugs given; "why" is a few words, "keep" is true or false.`;

export type LinkCheck = { mapId: string; links: (StructureMap['links'][number] & { keep: boolean; why?: string })[] };

/** The teacher's verdict on each of a map's links, matched by slugs or else by position; a link it does not answer for is kept. */
export async function checkLinks(model: ChatAdapter, map: StructureMap): Promise<LinkCheck> {
  const title = (slug: string) => map.blocks.find(block => block.slug === slug)!.title;
  const ends = map.blocks.filter(block => map.links.some(link => link.from === block.slug || link.to === block.slug));
  const answer = await ask<{ links?: { from?: unknown; to?: unknown; why?: unknown; keep?: unknown }[] }>(model, CHECK, `Map: ${map.title} (${map.domain})\n\nBlocks:\n${ends.map(block => `${block.slug}: ${block.title}\n${block.text}`).join('\n\n')}\n\nLinks:\n${map.links.map(link => `- ${link.from} ${link.word} ${link.to}: “${title(link.from)}” ${link.word} “${title(link.to)}”`).join('\n')}`, 2_000);
  const verdicts = Array.isArray(answer?.links) ? answer.links : [];
  return {
    mapId: map.id,
    links: map.links.map((link, index) => {
      const verdict = verdicts.find(item => item?.from === link.from && item?.to === link.to) ?? (verdicts.length === map.links.length ? verdicts[index] : undefined);
      return { ...link, keep: verdict?.keep !== false, ...(typeof verdict?.why === 'string' ? { why: verdict.why.slice(0, 200) } : {}) };
    }),
  };
}
/** The map with only the links its check kept; its id stays, so its split and its cases' seed do too. */
export const keptLinks = (map: StructureMap, check?: LinkCheck): StructureMap => check ? { ...map, links: map.links.filter(link => check.links.find(item => item.from === link.from && item.to === link.to)?.keep !== false) } : map;

/** The check keeps true links but not always in the right word or direction ("Collect Wi-Fi data supports Weekend
 * congestion 40% higher", where the finding uses data from the collection). So each kept pair is labelled once more from
 * scratch against what each word means: the one link a careful researcher would draw between the two blocks, or none.
 * Thinking is off, as in the other structure steps, so answers stay short and cheap; the teacher says in a few words
 * how the blocks relate before it labels them. */
const MEANINGS: Record<(typeof LINK_WORDS)[number], string> = {
  'supports': 'from is evidence or an argument for to',
  'contradicts': 'from is evidence or an argument against to',
  'answers': 'from answers the question or request in to',
  'uses data from': 'from (a finding, analysis or chart) draws on the data or source in to',
  'builds on': 'from extends, refines or takes forward to (a later draft, a next step, a sharper idea)',
  'part of': 'from is a piece of to (a task of a plan, a section of a draft, an item of a list)',
};
const LABEL = `You label the links on a ros.ai research map before it is used to teach an assistant how to link blocks. A link is one sentence "<from> <word> <to>" with one of these words:
${LINK_WORDS.map(word => `- ${word}: ${MEANINGS[word]}.`).join('\n')}
For each pair of blocks below, write the one link a careful researcher would draw between them, in the right direction with the right word, or none when no word fits plainly.
Return JSON {"links":[{"pair","why","from","word","to"}]}, one entry per pair in the order given: "why" first, a few words on how the two blocks relate, then "from" and "to" as the slugs given; for none, {"pair","why","none":true}.`;

export type LinkLabels = { mapId: string; links: StructureMap['links'] };

/** A map's links labelled once more, by pair number or else by position. A pair the teacher answers none for loses its
 * link; one it does not answer for, or answers with other blocks or a word off the list, keeps it as it was. */
export async function labelLinks(model: ChatAdapter, map: StructureMap): Promise<LinkLabels> {
  const title = (slug: string) => map.blocks.find(block => block.slug === slug)!.title;
  const ends = map.blocks.filter(block => map.links.some(link => link.from === block.slug || link.to === block.slug));
  const answer = await ask<{ links?: { pair?: unknown; from?: unknown; word?: unknown; to?: unknown; none?: unknown }[] }>(model, LABEL, `Map: ${map.title} (${map.domain})\n\nBlocks:\n${ends.map(block => `${block.slug}: ${block.title}\n${block.text}`).join('\n\n')}\n\nPairs:\n${map.links.map((link, index) => `${index + 1}. ${link.from} “${title(link.from)}” and ${link.to} “${title(link.to)}”`).join('\n')}`, 6_000);
  const verdicts = Array.isArray(answer?.links) ? answer.links : [];
  return {
    mapId: map.id,
    links: map.links.flatMap((link, index) => {
      const verdict = verdicts.find(item => Number(item?.pair) === index + 1) ?? (verdicts.length === map.links.length ? verdicts[index] : undefined);
      if (verdict?.none === true) return [];
      const word = typeof verdict?.word === 'string' ? verdict.word.toLowerCase().replace(/\s+/gu, ' ').trim() : '', pair = [link.from, link.to];
      return verdict && WORDS.has(word) && verdict.from !== verdict.to && pair.includes(String(verdict.from)) && pair.includes(String(verdict.to)) ? [{ from: String(verdict.from), to: String(verdict.to), word }] : [link];
    }),
  };
}

/** A domain's maps count once per title. */
export const mapKey = (map: Pick<StructureMap, 'domain' | 'title'>) => `${map.domain}\u0000${map.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}`;
export const uniqueMaps = (maps: StructureMap[]) => { const seen = new Set<string>(); return maps.filter(map => !seen.has(mapKey(map)) && Boolean(seen.add(mapKey(map)))); };

/** A written map as the pipeline needs it: unique slugs, groups of two or more blocks, labels from the list, and links
 * between blocks with one of the map's words, one per pair. Null when fewer than five blocks or no group are left. */
export function tidyMap(raw: unknown, domain: string): StructureMap | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>, text = (item: unknown) => typeof item === 'string' ? item.trim() : '';
  const list = (item: unknown) => (Array.isArray(item) ? item : []).filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object');
  const groups = new Map<string, StructureMap['groups'][number]>();
  for (const group of list(value.groups)) {
    const slug = text(group.slug), title = plainTitle(text(group.title), 80);
    if (slug && title && !groups.has(slug)) groups.set(slug, { slug, title, ...(text(group.request) ? { request: text(group.request) } : {}), ...(text(group.reply) ? { reply: text(group.reply) } : {}) });
  }
  const blocks: StructureMap['blocks'] = [], slugs = new Set<string>();
  for (const block of list(value.blocks)) {
    const slug = text(block.slug), title = plainTitle(text(block.title), 120), label = text(block.label).toLowerCase(), group = text(block.group);
    if (!slug || !title || slugs.has(slug) || groups.has(slug)) continue;
    slugs.add(slug);
    blocks.push({ slug, title, text: text(block.text), ...(LABELS.has(label) ? { label } : {}), ...(groups.has(group) ? { group } : {}) });
  }
  // A group needs two blocks; the block of a lone one goes back to the top of the map.
  for (const slug of [...groups.keys()]) if (blocks.filter(block => block.group === slug).length < 2) groups.delete(slug);
  for (const block of blocks) if (block.group && !groups.has(block.group)) delete block.group;
  const links: StructureMap['links'] = [], pairs = new Set<string>();
  for (const link of list(value.links)) {
    const from = text(link.from), to = text(link.to), word = text(link.word).toLowerCase().replace(/\s+/gu, ' '), pair = [from, to].sort().join('\u0000');
    if (!slugs.has(from) || !slugs.has(to) || from === to || !WORDS.has(word) || pairs.has(pair)) continue;
    pairs.add(pair); links.push({ from, to, word });
  }
  if (blocks.length < 5 || !groups.size) return null;
  const map = { domain, title: plainTitle(text(value.title), 120) || domain, blocks, groups: [...groups.values()], links };
  return { id: createHash('sha256').update(JSON.stringify(map)).digest('hex').slice(0, 12), ...map };
}

const groupId = (slug: string) => `group-${slug}`, blockId = (slug: string) => `block-${slug}`;
const blockNode = (block: StructureMap['blocks'][number], parentId: string | null, x: number, y: number): CanvasNode => ({ id: blockId(block.slug), title: block.title, description: block.text, kind: 'topic', blockType: 'note', parentId, x, y, ...(block.label ? { label: block.label } : {}) });
/** The map as a canvas: groups in a row with their blocks inside in two columns, the blocks outside every group below. */
export function toCanvas(map: StructureMap): Canvas {
  const nodes: CanvasNode[] = [];
  map.groups.forEach((group, index) => {
    nodes.push({ id: groupId(group.slug), title: group.title, description: '', kind: 'group', parentId: null, x: index * 1032, y: 0 });
    map.blocks.filter(block => block.group === group.slug).forEach((block, at) => nodes.push(blockNode(block, groupId(group.slug), (at % 2) * 480, Math.floor(at / 2) * 336)));
  });
  map.blocks.filter(block => !block.group).forEach((block, at) => nodes.push(blockNode(block, null, at * 480, 1440)));
  const connections: Connection[] = map.links.map((link, index) => ({ id: `link-${index + 1}`, source: blockId(link.from), target: blockId(link.to), label: link.word }));
  return { nodes, connections };
}

/** Requests that say nothing about where the work belongs, as people and agents working from outside send them. */
const VAGUE = ['Add what you found to the map.', 'Can you put your notes on the map?', 'Write this up as blocks.', 'Continue with the next part.', 'go on', 'Zet je aantekeningen op de kaart.', ''];
const quoted = (titles: string[]) => titles.map(title => `“${title}”`).join(titles.length > 2 ? ', ' : ' and ');

/** The turns one map gives, each with the original shape as its answer. Up to four of the moved blocks' links are taken
 * away and belong to the answer; any others stay on the map, as links the agent made itself. */
export function makeCases(map: StructureMap, random: () => number): StructureCase[] {
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
  const shuffled = <T>(items: T[]) => items.map(item => ({ item, key: random() })).sort((a, b) => a.key - b.key).map(({ item }) => item);
  const members = (slug: string) => map.blocks.filter(block => block.group === slug);
  const title = (slug: string) => map.blocks.find(block => block.slug === slug)!.title;
  const cases: StructureCase[] = [];
  const build = (kind: CaseKind, moved: string[], dropped: string[], request: string, reply: string, shape: Pick<LandingPlan, 'place' | 'newGroups'>) => {
    const canvas = toCanvas(map), ids = new Set(moved.map(blockId)), gone = new Set(dropped.map(groupId));
    let column = 0;
    canvas.nodes = canvas.nodes.filter(node => !gone.has(node.id)).map(node => ids.has(node.id) ? { ...node, parentId: null, x: 6000 + column++ * 480, y: 0 } : node);
    const touching = shuffled(canvas.connections.filter(edge => ids.has(edge.source) || ids.has(edge.target))), restored = touching.slice(0, 4);
    canvas.connections = canvas.connections.filter(edge => !restored.includes(edge));
    const target: LandingPlan = { ...shape, links: restored.map(edge => ({ from: edge.source, to: edge.target, label: edge.label })) };
    cases.push({ id: `${map.id}-${cases.length + 1}`, mapId: map.id, kind, canvas, added: [...ids], request, reply, target });
  };
  const whole = shuffled(map.groups).slice(0, 2), split = shuffled(map.groups.filter(group => members(group.slug).length >= 3)).slice(0, 2);
  for (const group of whole) {
    const blocks = members(group.slug).map(block => block.slug);
    build('regroup', blocks, [group.slug], group.request && random() < .75 ? group.request : pick(VAGUE), group.reply || `I added ${blocks.length} blocks: ${quoted(blocks.map(title))}.`, { place: [], newGroups: [{ title: group.title, blocks: blocks.map(blockId) }] });
  }
  for (const group of split) {
    const blocks = shuffled(members(group.slug)).slice(0, random() < .7 ? 1 : 2).map(block => block.slug), titles = blocks.map(title);
    const request = random() < .3 ? `Add ${titles.join(' and ')} to ${group.title}` : random() < .5 ? `Add a note on ${titles[0].toLowerCase()}` : pick(VAGUE);
    build('place', blocks, [], request, `I added ${quoted(titles)}.`, { place: blocks.map(slug => ({ block: blockId(slug), group: groupId(group.slug) })), newGroups: [] });
  }
  const apart = whole[0], from = split.find(group => group.slug !== apart?.slug);
  if (apart && from) {
    const blocks = members(apart.slug).map(block => block.slug), extra = pick(members(from.slug)).slug;
    build('mixed', [...blocks, extra], [apart.slug], pick(VAGUE), `I added ${quoted([...blocks, extra].map(title))}.`, { place: [{ block: blockId(extra), group: groupId(from.slug) }], newGroups: [{ title: apart.title, blocks: blocks.map(blockId) }] });
  }
  const outside = shuffled(map.blocks.filter(block => !block.group));
  const linked = (slug: string) => map.links.some(link => link.from === slug || link.to === slug);
  for (const block of outside.filter(item => linked(item.slug)).slice(0, 2)) build('links', [block.slug], [], random() < .5 ? `Add a note: ${block.title}` : pick(VAGUE), `I added “${block.title}”.`, { place: [], newGroups: [] });
  for (const block of outside.filter(item => !linked(item.slug)).slice(0, 2)) build('leave', [block.slug], [], random() < .5 ? `Add a note: ${block.title}` : pick(VAGUE), `I added “${block.title}”.`, { place: [], newGroups: [] });
  return cases;
}

/** A case's landing request, built by the app's own pass. */
export function askFor(item: StructureCase): { view: TurnView; asked: LandingAsk } {
  const view = seeTurn(item.canvas, new Set(item.added), item.request);
  return { view, asked: landingAsk({ request: item.request, reply: item.reply }, view, false) };
}
/** The original shape in the packet's refs, as ROS should answer; null when part of it has no ref (the packet was cut). */
export function answerFor(target: LandingPlan, asked: LandingAsk) {
  const keys = new Map([...asked.refs].map(([key, id]) => [id, key])), key = (id: string) => keys.get(id) ?? '';
  const answer = {
    place: target.place.map(item => ({ block: key(item.block), group: key(item.group) })),
    newGroups: target.newGroups.map(group => ({ title: group.title, blocks: group.blocks.map(key) })),
    links: target.links.map(link => ({ from: key(link.from), to: key(link.to), label: link.label })),
    toMap: null,
  };
  const ends = [...answer.place.flatMap(item => [item.block, item.group]), ...answer.newGroups.flatMap(group => group.blocks), ...answer.links.flatMap(link => [link.from, link.to])];
  return ends.every(Boolean) ? answer : null;
}
/** A case as a chat sample in round 1's format: the app's landing request, and the original shape as ROS's answer. */
export function toStructureSample(item: StructureCase) {
  const { asked } = askFor(item), answer = answerFor(item.target, asked);
  if (!answer) return null;
  return { id: item.id, family: `structure-${item.kind}`, fixtureId: item.mapId, tools: [], messages: [...asked.messages.map(message => ({ role: message.role, content: message.content })), { role: 'assistant', content: JSON.stringify(answer), train: true }] };
}

type Counts = { tp: number; fp: number; fn: number };
/** How one answer compares with the original shape. Group membership counts a block placed in the right group, and each
 * pair of blocks put together in a new group; links count by pair, then by word and direction. */
export type CaseScore = { id: string; kind: CaseKind; valid: boolean; empty: boolean; expectEmpty: boolean; member: Counts; link: Counts & { word: number; direction: number }; titles: number[]; ms?: number };
const memberships = (plan: LandingPlan) => new Set([...plan.place.map(item => `${item.block}>${item.group}`), ...plan.newGroups.flatMap(group => group.blocks.flatMap((a, index) => group.blocks.slice(index + 1).map(b => [a, b].sort().join('+'))))]);
const isEmpty = (plan: LandingPlan) => !plan.place.length && !plan.newGroups.length && !plan.links.length;
const words = (text: string) => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 2));
/** Shared words of two titles over all their words (0 to 1). */
const overlap = (a: string, b: string) => { const x = words(a), y = words(b), both = [...x].filter(word => y.has(word)).length; return x.size + y.size ? both / (x.size + y.size - both) : 1; };
export function scoreCase(item: StructureCase, plan: LandingPlan | null, ms?: number): CaseScore {
  const target = item.target, got = plan ?? { place: [], newGroups: [], links: [] };
  const want = memberships(target), have = memberships(got);
  const member = { tp: [...have].filter(key => want.has(key)).length, fp: [...have].filter(key => !want.has(key)).length, fn: [...want].filter(key => !have.has(key)).length };
  const pair = (link: { from: string; to: string }) => [link.from, link.to].sort().join('+'), wanted = new Map(target.links.map(link => [pair(link), link]));
  const matched = got.links.flatMap(link => { const match = wanted.get(pair(link)); return match ? [{ link, match }] : []; });
  const link = { tp: matched.length, fp: got.links.length - matched.length, fn: target.links.length - matched.length, word: matched.filter(({ link, match }) => link.label === match.label).length, direction: matched.filter(({ link, match }) => link.from === match.from).length };
  const titles = target.newGroups.map(group => { const best = got.newGroups.map(mine => ({ mine, shared: mine.blocks.filter(id => group.blocks.includes(id)).length })).sort((a, b) => b.shared - a.shared)[0]; return best?.shared ? overlap(best.mine.title, group.title) : 0; });
  return { id: item.id, kind: item.kind, valid: Boolean(plan), empty: isEmpty(got), expectEmpty: isEmpty(target), member, link, titles, ...(ms === undefined ? {} : { ms }) };
}

/** The numbers the round is judged on: valid answers, group F1, link F1 (and words and directions among the right
 * pairs), how often a map that needed nothing was left alone, how often one that needed something was, title overlap
 * and speed. */
export function summarise(scores: CaseScore[]) {
  const total = (pick: (score: CaseScore) => number) => scores.reduce((sum, score) => sum + pick(score), 0);
  const counts = (pick: (score: CaseScore) => Counts) => ({ tp: total(score => pick(score).tp), fp: total(score => pick(score).fp), fn: total(score => pick(score).fn) });
  const round = (value: number) => Number(value.toFixed(3)), share = (part: number, whole: number) => whole ? round(part / whole) : null;
  const rates = (c: Counts) => { const precision = c.tp / Math.max(1, c.tp + c.fp), recall = c.tp / Math.max(1, c.tp + c.fn); return { precision: round(precision), recall: round(recall), f1: round(precision + recall ? 2 * precision * recall / (precision + recall) : 0) }; };
  const member = counts(score => score.member), link = counts(score => score.link);
  const quiet = scores.filter(score => score.expectEmpty), busy = scores.filter(score => !score.expectEmpty), titles = scores.flatMap(score => score.titles);
  const ms = scores.flatMap(score => score.ms === undefined ? [] : [score.ms]).sort((a, b) => a - b), at = (part: number) => ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * part))] : null;
  return {
    cases: scores.length, valid: share(total(score => Number(score.valid)), scores.length),
    group: rates(member),
    link: { ...rates(link), word: share(total(score => score.link.word), link.tp), direction: share(total(score => score.link.direction), link.tp) },
    leftAlone: share(quiet.filter(score => score.empty).length, quiet.length), missed: share(busy.filter(score => score.empty).length, busy.length),
    titleOverlap: titles.length ? round(titles.reduce((sum, value) => sum + value, 0) / titles.length) : null,
    p50Ms: at(.5), p90Ms: at(.9),
  };
}

/** Runs the held-out cases through a model under test (or ros.ai's own rules, which need none) and scores each answer as
 * the app reads it. Results go to `out` one per line, so a stopped run carries on where it was. */
export async function evaluate(cases: StructureCase[], model: ChatAdapter | 'rules', out: string, concurrency = 2) {
  const done = new Set(readJsonl<CaseScore>(out).map(score => score.id));
  await pool(cases.filter(item => !done.has(item.id)), concurrency, async item => {
    const { view, asked } = askFor(item), started = Date.now();
    let plan: LandingPlan | null = null;
    if (model === 'rules') plan = landingRules({ request: item.request, reply: item.reply }, view, false, false);
    else {
      const signal = AbortSignal.timeout(120_000);
      await model.prepare(signal);
      const response = await model.complete({ messages: asked.messages, maxOutputTokens: 900 }, signal).catch(error => { console.warn(`${item.id}: ${(error as Error).message}`); return null; });
      try { plan = response ? landingPlan(response.content, asked, view, item.request) : null; } catch { plan = null; }
    }
    appendJsonl(out, scoreCase(item, plan, model === 'rules' ? undefined : Date.now() - started));
  });
  return summarise(readJsonl<CaseScore>(out));
}

/** A small map written by hand, for the offline smoke run and the tests. */
export const SMOKE_MAP: StructureMap = {
  id: 'smoke-sleep', domain: 'sleep and memory', title: 'Sleep and memory consolidation',
  blocks: [
    { slug: 'question', title: 'Does sleep help memory?', text: 'Thesis question: how much does a night of sleep improve recall of word pairs, compared with the same hours awake?', label: 'question' },
    { slug: 'booking', title: 'Ask Lotte about the lab booking', text: 'TODO: the sleep lab is booked until December; ask Lotte about January slots.', label: 'task' },
    { slug: 'walker', title: 'Walker 2017 overview', text: 'Popular overview; strong claims, few effect sizes. Use with care.', group: 'prior' },
    { slug: 'meta', title: 'Meta-analysis of sleep and recall', text: 'Berres & Erdfelder 2021: sleep helps declarative memory, g = 0.25 over 40 studies.', group: 'prior', label: 'finding' },
    { slug: 'nap', title: 'Naps also help', text: 'Lahl et al. 2008: a six-minute nap already improved recall.', group: 'prior', label: 'finding' },
    { slug: 'pairs', title: 'Word-pair task', text: '40 Dutch-English word pairs, cued recall at 9:00 and 21:00.', group: 'methods' },
    { slug: 'actigraphy', title: 'Actigraphy for sleep time', text: 'Wrist actigraphy for seven nights; cheaper than polysomnography but overestimates sleep.', group: 'methods' },
    { slug: 'sample', title: 'Sample of 60 students', text: 'Power analysis for d = 0.5 gives 52; recruit 60 at TU Delft.', group: 'methods', label: 'plan' },
    { slug: 'approval', title: 'Ethics approval', text: 'HREC form due 15 November; it needs the data management plan.', group: 'admin', label: 'task' },
    { slug: 'dmp', title: 'Data management plan', text: 'Actigraphy files on the project drive; raw data deleted after ten years.', group: 'admin' },
  ],
  groups: [
    { slug: 'prior', title: 'Prior studies', request: 'What do studies say about sleep and memory? Add the key ones.', reply: 'I added three blocks on earlier studies, from the meta-analysis to the nap studies.' },
    { slug: 'methods', title: 'Methods', request: 'Sketch the method for the experiment', reply: 'I added the task, how we measure sleep and the sample size.' },
    { slug: 'admin', title: 'Ethics and data', request: 'wat moet ik regelen voor ethiek?', reply: 'Twee dingen: de HREC-goedkeuring en het datamanagementplan.' },
  ],
  links: [
    { from: 'meta', to: 'question', word: 'answers' },
    { from: 'nap', to: 'meta', word: 'supports' },
    { from: 'pairs', to: 'question', word: 'builds on' },
    { from: 'approval', to: 'dmp', word: 'builds on' },
  ],
};
