/** ROS as the layer on top of any agent (docs: research/ros-layer-direction-2026-10-30). The person's agent does the
 * thinking; after its turn ROS gives what it added the map's shape (a group, a few links) and puts an answer given only in
 * chat on the map, as one row on the turn's review card that the person can undo. Shared by the landing pass on the
 * server (ros-layer.ts) and the card. */

/** What arranged a turn: Local ROS on this computer, hosted ROS when the person is signed in to it, or ros.ai's own
 * rules when neither can (or when ROS could not answer in time). */
export type LayerEngine = 'local' | 'hosted' | 'layout';
export const LAYER_ENGINES: Record<LayerEngine, string> = { local: 'Local ROS', hosted: 'Hosted ROS', layout: 'ros.ai’s own rules' };

/** The landing pass of one turn. running: ROS is reading what the turn left. done: it proposed its row (proposalId).
 * skipped: nothing needed shaping. failed: it stopped on an error; nothing was changed. */
export type TurnLayer = { state: 'running' | 'done' | 'skipped' | 'failed'; engine?: LayerEngine; note?: string; proposalId?: string; ms?: number };

/** Counted on every agent turn while ros.ai runs, kept on this computer: what agents leave on the map without help, and
 * how the person takes ROS's rows. changes: rows the agents' turns put on their cards; blocks: blocks they added; loose:
 * of those, outside any group and without a link; chatOnly: answers with content given only in chat. rows: ROS rows
 * proposed; fallback: rows made by ros.ai's own rules because ROS was not there or did not answer in time. */
export type LayerStats = { turns: number; changes: number; blocks: number; loose: number; chatOnly: number; rows: number; rescued: number; accepted: number; undone: number; dismissed: number; fallback: number; failed: number };
/** One measurement of the engine on this computer: reading a long prompt, then writing a short answer. */
export type LayerBench = { at: string; engine: LayerEngine; model: string; promptTokens: number; prefillMs: number; outputTokens: number; decodeMs: number };
export type LayerStatus = { on: boolean; engine: LayerEngine; model?: string; stats: LayerStats; bench?: LayerBench };

export type SplitBlock = { title: string; text: string };
/** title: the answer's own top heading, when it has one above all its sections. */
export type SplitReply = { title: string | null; blocks: SplitBlock[] };

export const SPLIT_LIMITS = { blocks: 12, title: 120, text: 19_000 } as const;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u;
const FENCE = /^[ \t]*(`{3,}|~{3,})/u;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/u;
const BOLD_LEAD = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?\*\*([^*\n]{2,120}?)\*\*\s*[:：.—–-]?\s*(.*)$/u;
/** Closing lines that talk to the person rather than add to the answer. */
const FOLLOW_UP = /^(?:let me know|want me|shall i|should i|would you like|do you want|if you(?:'|’)d like|if you want|happy to|i can also)\b/iu;

/** A title as plain words, cut at a word near the limit. */
export function plainTitle(text: string, limit: number = SPLIT_LIMITS.title) {
  const plain = text.replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1').replace(/[*_`~]+/gu, '').replace(/^#+\s*/u, '').replace(/[:：]\s*$/u, '').replace(/\s+/gu, ' ').trim();
  if (plain.length <= limit) return plain;
  const cut = plain.slice(0, limit - 1), space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

type Line = { text: string; heading?: { level: number; title: string } };
/** The reply's lines, with the headings outside code fences marked. */
function readLines(markdown: string): Line[] {
  let fence: string | null = null;
  return markdown.replace(/\r\n?/gu, '\n').split('\n').map(text => {
    const opened = text.match(FENCE);
    if (opened) { if (!fence) fence = opened[1][0]; else if (opened[1][0] === fence) fence = null; return { text }; }
    const heading = fence ? null : text.match(HEADING);
    return heading ? { text, heading: { level: heading[1].length, title: heading[2] } } : { text };
  });
}
const joined = (lines: Line[]) => lines.map(line => line.text).join('\n').trim();
const clipText = (text: string) => text.length > SPLIT_LIMITS.text ? `${text.slice(0, SPLIT_LIMITS.text - 1).trimEnd()}…` : text;

/** An answer the agent gave in chat with enough in it to belong on the map: long, or shaped like notes (headings, a
 * table, a list or several paragraphs). Short replies and status lines stay in chat. */
export function replyHasContent(reply: string): boolean {
  const text = reply.trim();
  if (text.length < 400) return false;
  if (text.length >= 1500) return true;
  const lines = readLines(text), headings = lines.filter(line => line.heading).length;
  const table = /^\s*\|.+\|\s*$/mu.test(text) && /^\s*\|?\s*:?-{3,}/mu.test(text);
  const items = lines.filter(line => LIST_ITEM.test(line.text)).length;
  const paragraphs = text.split(/\n\s*\n/u).filter(part => part.trim()).length;
  return headings >= 2 || table || items >= 5 || paragraphs >= 4;
}

/** Openings of a request that say nothing about its topic. */
const OPENER = /^(?:(?:please|can you|could you|would you)\s+)?(?:what (?:do|does) (?:we|the literature|the research|research|studies) (?:know|say) (?:about|on)|what is known about|tell me (?:more )?about|give me an overview of)\s+/iu;
/** A short title for what the person asked, for a group that holds the answer. */
export function requestTitle(request: string, limit = 80): string {
  const line = request.replace(/^\/\S+\s*/u, '').split('\n').map(part => part.trim()).find(Boolean) ?? '';
  const sentence = (line.split(/(?<=[.?!])\s/u)[0] ?? line).replace(/[?!.…]+$/u, ''), topic = sentence.replace(OPENER, '');
  const first = topic.split(/\s+/u).length >= 2 ? topic : sentence;
  const title = plainTitle(first, limit);
  return title ? title[0].toUpperCase() + title.slice(1) : 'Answer';
}

/** Cuts an answer written in chat into blocks without changing its words: one block per section under the answer's
 * headings (the top heading becomes the title when it stands above the rest), or per bold lead-in when it has no
 * headings, otherwise one block. A closing question to the person stays in chat. */
export function splitReply(markdown: string): SplitReply {
  const paragraphs = markdown.trim().split(/\n\s*\n/u);
  const last = paragraphs.at(-1)?.trim() ?? '';
  if (paragraphs.length > 1 && last.length <= 240 && !last.includes('\n') && (last.endsWith('?') || FOLLOW_UP.test(last))) paragraphs.pop();
  const lines = readLines(paragraphs.join('\n\n'));
  let title: string | null = null;
  const first = lines.findIndex(line => line.text.trim());
  const headings = lines.filter(line => line.heading);
  if (first >= 0 && lines[first].heading && headings.every(line => line === lines[first] || line.heading!.level > lines[first].heading!.level)) {
    title = plainTitle(lines[first].heading!.title);
    lines.splice(first, 1);
  }
  const sections = sectionsByHeading(lines) ?? sectionsByLead(lines);
  if (!sections) {
    const text = joined(lines);
    return { title, blocks: text ? [{ title: title ?? '', text: clipText(text) }] : [] };
  }
  const blocks = sections.filter(section => section.title && section.text).map(section => ({ title: plainTitle(section.title), text: clipText(section.text) }));
  if (blocks.length > SPLIT_LIMITS.blocks) {
    const rest = blocks.splice(SPLIT_LIMITS.blocks - 1);
    blocks.push({ title: rest[0].title, text: clipText(rest.map((block, index) => index ? `**${block.title}**\n\n${block.text}` : block.text).join('\n\n')) });
  }
  return { title, blocks };
}

type Section = { title: string; text: string };
/** Sections at the highest heading level that appears at least twice; text before the first stays as an overview. */
function sectionsByHeading(lines: Line[]): Section[] | null {
  const levels = [...new Set(lines.flatMap(line => line.heading ? [line.heading.level] : []))].sort((a, b) => a - b);
  const level = levels.find(value => lines.filter(line => line.heading?.level === value).length >= 2);
  if (level === undefined) return null;
  const starts = lines.flatMap((line, index) => line.heading && line.heading.level <= level ? [index] : []);
  const sections: Section[] = [];
  const intro = joined(lines.slice(0, starts[0]));
  starts.forEach((start, index) => sections.push({ title: lines[start].heading!.title, text: joined(lines.slice(start + 1, starts[index + 1] ?? lines.length)) }));
  return withIntro(sections, intro);
}
/** Without headings, paragraphs or list items that open with a bold phrase ("**Cost:** …") start the sections. */
function sectionsByLead(lines: Line[]): Section[] | null {
  const starts = lines.flatMap((line, index) => BOLD_LEAD.test(line.text) && (index === 0 || !lines[index - 1].text.trim() || LIST_ITEM.test(line.text)) ? [index] : []);
  if (starts.length < 2) return null;
  const sections = starts.map((start, index) => {
    const [, lead, rest] = lines[start].text.match(BOLD_LEAD)!;
    return { title: lead, text: [rest, joined(lines.slice(start + 1, starts[index + 1] ?? lines.length))].filter(Boolean).join('\n').trim() || lead };
  });
  return withIntro(sections, joined(lines.slice(0, starts[0])));
}
/** A real overview becomes a block of its own; a line or two goes on top of the first section. */
function withIntro(sections: Section[], intro: string): Section[] {
  if (!intro) return sections;
  if (intro.length >= 160) return [{ title: 'Overview', text: intro }, ...sections];
  return sections.map((section, index) => index ? section : { ...section, text: `${intro}\n\n${section.text}`.trim() });
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const names = (titles: string[]) => titles.length === 1 ? titles[0] : `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}`;
/** The words of a ROS row on the review card, as in "Arranged by ROS: 4 blocks into Methods, 2 links". */
export function layerSummary(change: { blocks: number; into: string[]; links: number; rescued?: { blocks: number; title: string } }): string {
  if (change.rescued) {
    const where = change.rescued.blocks > 1 ? `${count(change.rescued.blocks, 'block')} in “${change.rescued.title}”` : `a block, “${change.rescued.title}”`;
    return `Put the answer on the map: ${where}${change.links ? `, ${count(change.links, 'link')}` : ''}`;
  }
  const parts = [change.blocks ? `${count(change.blocks, 'block')}${change.into.length ? ` into ${names(change.into.slice(0, 3))}${change.into.length > 3 ? ' and more' : ''}` : ''}` : '', change.links ? count(change.links, 'link') : ''].filter(Boolean);
  return `Arranged by ROS: ${parts.join(', ') || 'nothing'}`;
}
