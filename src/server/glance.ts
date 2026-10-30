import { z } from 'zod';
import type { AssistantGlance } from '../shared/assistant.js';
import type { CanvasNode } from '../shared/types.js';
import { nodeBlockType } from '../shared/blocks.js';

/** Where the person was on the map when they sent a message: the open block, the clicked ones, the ones looked at before and
 * those on screen. ROS gets it as a short hint that names blocks without their text, enough to tell what "this" or "these"
 * means and too little to steer the work; it never limits or picks what ROS works on. */
const CLICKED = 12, LOOKED_AT = 5, LOOKED_AT_MINUTES = 30, ON_SCREEN = 24, TITLE = 80;

const id = z.string().min(1).max(128), at = z.iso.datetime();
export const glanceSchema = z.object({
  open: z.object({ nodeId: id, artifactId: id.nullable().optional() }).strict().nullable().optional(),
  clicked: z.array(z.object({ nodeId: id, at }).strict()).max(200).optional(),
  lookedAt: z.array(z.object({ nodeId: id, at }).strict()).max(50).optional(),
  onScreen: z.union([z.literal('all'), z.array(id).max(2000)]).optional(),
}).strict();

/** The glance as it is saved on the turn: blocks no longer on the map left out, each block named once, the lists shortened.
 * Undefined when nothing is left. */
export function keepGlance(supplied: z.infer<typeof glanceSchema> | undefined, nodes: readonly CanvasNode[], artifactNode: (artifactId: string) => string | undefined, sentAt: string): AssistantGlance | undefined {
  if (!supplied) return undefined;
  const onMap = new Set(nodes.map(node => node.id)), named = new Set<string>(), sent = Date.parse(sentAt);
  const open = supplied.open && onMap.has(supplied.open.nodeId) ? { nodeId: supplied.open.nodeId, ...(supplied.open.artifactId && artifactNode(supplied.open.artifactId) === supplied.open.nodeId ? { artifactId: supplied.open.artifactId } : {}) } : null;
  if (open) named.add(open.nodeId);
  const fresh = (entries: { nodeId: string; at: string }[] | undefined, limit: number, minutes = Infinity) => (entries ?? []).filter(entry => {
    if (!onMap.has(entry.nodeId) || named.has(entry.nodeId) || sent - Date.parse(entry.at) > minutes * 60_000) return false;
    named.add(entry.nodeId); return true;
  }).slice(0, limit);
  const clicked = fresh(supplied.clicked, CLICKED), lookedAt = fresh(supplied.lookedAt, LOOKED_AT, LOOKED_AT_MINUTES);
  const onScreen = supplied.onScreen === 'all' ? 'all' as const : [...new Set(supplied.onScreen ?? [])].filter(item => onMap.has(item)).slice(0, 400);
  const glance: AssistantGlance = { ...(open ? { open } : {}), ...(clicked.length ? { clicked } : {}), ...(lookedAt.length ? { lookedAt } : {}), ...(onScreen === 'all' || onScreen.length ? { onScreen } : {}) };
  return Object.keys(glance).length ? glance : undefined;
}

/** The hint ROS reads: blocks by id, title and kind, how long ago they were clicked or looked at, and whether a clicked block is
 * still on screen. No block text: ROS reads a block when the request points at it. */
export function glanceHint(glance: AssistantGlance | undefined, nodes: readonly CanvasNode[], artifactTitle: (artifactId: string) => string | undefined, sentAt: string) {
  if (!glance) return undefined;
  const byId = new Map(nodes.map(node => [node.id, node])), sent = Date.parse(sentAt);
  const title = (value: string) => value.length > TITLE ? `${value.slice(0, TITLE - 1)}…` : value;
  const block = (nodeId: string) => {
    const node = byId.get(nodeId)!, group = node.parentId ? byId.get(node.parentId) : undefined;
    return { id: node.id, title: title(node.title), kind: node.kind === 'group' ? 'group' : nodeBlockType(node), ...(group ? { group: title(group.title) } : {}) };
  };
  const ago = (value: string) => Math.max(0, Math.round((sent - Date.parse(value)) / 60_000));
  const screen = glance.onScreen === 'all' ? null : glance.onScreen ?? [];
  const seen = (nodeId: string) => glance.onScreen === 'all' || Boolean(screen?.includes(nodeId));
  const version = glance.open?.artifactId ? artifactTitle(glance.open.artifactId) : undefined;
  return {
    ...(glance.open && byId.has(glance.open.nodeId) ? { open: { ...block(glance.open.nodeId), ...(glance.open.artifactId && version !== undefined ? { version: { artifactId: glance.open.artifactId, title: title(version) } } : {}) } } : {}),
    ...(glance.clicked?.length ? { clicked: glance.clicked.filter(entry => byId.has(entry.nodeId)).map(entry => ({ ...block(entry.nodeId), minutesAgo: ago(entry.at), onScreen: seen(entry.nodeId) })) } : {}),
    ...(glance.lookedAt?.length ? { lookedAt: glance.lookedAt.filter(entry => byId.has(entry.nodeId)).map(entry => ({ ...block(entry.nodeId), minutesAgo: ago(entry.at) })) } : {}),
    ...(glance.onScreen === 'all' ? { onScreen: 'whole map' } : screen?.length ? { onScreen: screen.filter(nodeId => byId.has(nodeId)).slice(0, ON_SCREEN).map(nodeId => { const { id: blockId, title: name, kind } = block(nodeId); return { id: blockId, title: name, kind }; }), ...(screen.length > ON_SCREEN ? { moreOnScreen: screen.length - ON_SCREEN } : {}) } : {}),
    blocksOnMap: nodes.length,
  };
}

/** The hint as a paragraph of an agent's first message, placed after the selection and before the request, so the request
 * comes last. Empty when there is no glance. */
export function glanceText(hint: ReturnType<typeof glanceHint>) {
  if (!hint) return '';
  return `Where the researcher was on the map when they sent this (JSON). A weak hint, not part of the request: use it only to tell what words like "this", "here" or "these" point at. Work from the message and the whole map, and do not narrow the work to these blocks.\n${JSON.stringify(hint)}`;
}
