import type { Canvas, CanvasNode } from './types.js';
import { splitSources } from './agent-work.js';
import { purposeText } from './card-outcome.js';
import { GROUP_PREVIEW_MEMBERS, groupPreviewMembers } from './groups.js';

export const CARD_DEFAULT_WIDTH = 408;
export const CARD_MIN_WIDTH = 320;
export const CARD_MAX_WIDTH = 720;
export const CARD_DEFAULT_HEIGHT = 264;
export const CARD_MIN_HEIGHT = 224;
export const CARD_MAX_HEIGHT = 420;

export function cardWidth(node: { width?: number }) {
  return Math.min(CARD_MAX_WIDTH, Math.max(CARD_MIN_WIDTH, node.width ?? CARD_DEFAULT_WIDTH));
}

/** Initial footprint before the browser reports actual wrapped text height. */
export function initialCardSize(node: { width?: number; title: string }, text: string) {
  const width = cardWidth(node);
  const titleLines = Math.max(1, Math.ceil(Array.from(node.title).length * 9 / (width - 40)));
  const outcomeLines = Math.max(1, Math.ceil(Array.from(text).length * 7.5 / (width - 66)));
  return { width, height: Math.min(CARD_MAX_HEIGHT, Math.max(CARD_MIN_HEIGHT, Math.ceil(144 + titleLines * 24.3 + outcomeLines * 22.5))) };
}

/** Cards that preview code, a figure, a table or a report can grow to the maximum height. */
const PREVIEW_BLOCKS = ['code', 'notebook', 'figure', 'file', 'dataset', 'report'];
/** A card face shows at most this much of a block's text (.block-primary-preview). */
const TEXT_PREVIEW_HEIGHT = 195;
/** A height guess for a new block's card before the browser measures it. A text card keeps the height its first
 * sentence gives it and cuts the rest; a Finding card shows its whole quote, up to its preview height, and only
 * names the site it quotes. */
export function estimatedCardHeight(node: { width?: number; title: string; description: string; kind?: string; blockType?: string; artifactId?: string }) {
  if (node.kind === 'group' || node.artifactId || PREVIEW_BLOCKS.includes(node.blockType ?? '')) return CARD_MAX_HEIGHT;
  if (node.blockType !== 'finding') return initialCardSize(node, purposeText(node)).height;
  const width = cardWidth(node), text = splitSources(node.description).body;
  const titleLines = Math.max(1, Math.ceil(Array.from(node.title).length * 9 / (width - 40)));
  // Each paragraph, heading or list item starts a new line; blank lines add a paragraph's spacing.
  const textLines = Math.max(1, text.split('\n').reduce((sum, line) => sum + (line.trim() ? Math.ceil(Array.from(line).length * 7.5 / (width - 66)) : 0.3), 0));
  return Math.min(CARD_MAX_HEIGHT, Math.max(CARD_MIN_HEIGHT, Math.ceil(144 + titleLines * 24.3 + Math.min(TEXT_PREVIEW_HEIGHT, textLines * 22.5))));
}
/** A collapsed Group card before the browser measures it: its title, a line of overview and the first few
 * blocks it lists, each up to two lines of 18px, 7px apart, then how many more it holds. */
export function estimatedGroupHeight(node: { width?: number; title: string; description: string }, listed: { title: string }[], members = listed.length) {
  const width = cardWidth(node), lines = (text: string, size: number, inset: number) => Math.max(1, Math.ceil(Array.from(text).length * size / (width - inset)));
  const shown = listed.slice(0, GROUP_PREVIEW_MEMBERS), more = members > shown.length ? 25 : 0;
  const rows = shown.reduce((sum, item, index) => sum + Math.min(2, lines(item.title, 6.5, 70)) * 18 + (index ? 7 : 0), more);
  return Math.min(CARD_MAX_HEIGHT, Math.max(CARD_MIN_HEIGHT, 101 + Math.min(2, lines(node.title, 9, 40)) * 24 + (node.description ? 20 : 0) + rows));
}
/** A block's footprint before the browser measures it, for laying out a tree of new blocks on the server. */
export function estimatedSize(canvas: Canvas, node: CanvasNode) {
  return { width: cardWidth(node), height: node.kind === 'group'
    ? estimatedGroupHeight(node, groupPreviewMembers(canvas, node.id), canvas.nodes.filter(item => item.parentId === node.id).length)
    : Math.max(CARD_MIN_HEIGHT, estimatedCardHeight(node)) };
}
