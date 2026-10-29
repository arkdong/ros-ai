import type { CanvasNode, Connection } from './types.js';

/** A link is one word between two blocks. It says how they relate and never runs, schedules or imports anything.
 * These are the words ros.ai offers first; any other word is kept as typed. */
export const LINK_WORDS = ['supports', 'contradicts', 'answers', 'uses data from', 'builds on', 'part of'] as const;
export const LINK_WORD_LIMIT = 200;

export type LinkSide = 'top' | 'right' | 'bottom' | 'left';
export type LinkPoint = { x: number; y: number };
export type LinkBox = LinkPoint & { width: number; height: number };

const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim().toLowerCase();

/** A trail is a line ros.ai draws itself to show where a block came from: an Agent block to what it added, searched,
 * browsed or asked for, a search or Web block to what it found, a checked block to the agent that checked it. It carries
 * no word on the canvas and cannot be renamed; its wording is fixed (see trailWording). */
export function isTrail(connection: Connection, node: (id: string) => CanvasNode | undefined): boolean {
  const label = normalize(connection.label), from = node(connection.source), to = node(connection.target);
  const source = from?.blockType, target = to?.blockType;
  if (source === 'agent' && (target === 'search' || target === 'web' || to?.label === 'result' || ['added', 'searches', 'browses', 'asks to write'].includes(label))) return true;
  if (source === 'search' && label === 'found') return true;
  if (target === 'agent' && (label === 'taken on by' || label === 'checked by')) return true;
  return target === 'finding' && label === 'finding';
}

/** What a selected trail says about itself. */
export function trailWording(connection: Connection, node: (id: string) => CanvasNode | undefined): string {
  const label = normalize(connection.label), from = node(connection.source), to = node(connection.target);
  const who = (block: CanvasNode | undefined) => block?.title.trim() || 'ROS';
  switch (label) {
    case 'added': return `Added by ${who(from)}`;
    case 'taken on by': return `Taken on by ${who(to)}`;
    case 'checked by': return `Checked by ${who(to)}`;
    case 'searches': return `Searched by ${who(from)}`;
    case 'browses': return `Browsed by ${who(from)}`;
    case 'asks to write': return `Asked for by ${who(from)}`;
    case 'found': case 'finding': return `Found by ${who(from)}`;
    default: return label ? connection.label.trim() : `From ${who(from)}`;
  }
}

/** The sides of two boxes that face each other: across the wider gap between them, so a link leaves a block towards
 * the other block and arrives facing it. */
export function facingSides(a: LinkBox, b: LinkBox): { source: LinkSide; target: LinkSide } {
  const gapX = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
  const gapY = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
  const dx = b.x + b.width / 2 - (a.x + a.width / 2), dy = b.y + b.height / 2 - (a.y + a.height / 2);
  if (gapX >= gapY) return dx >= 0 ? { source: 'right', target: 'left' } : { source: 'left', target: 'right' };
  return dy >= 0 ? { source: 'bottom', target: 'top' } : { source: 'top', target: 'bottom' };
}

/** A point on one side of a box, `fraction` of the way along it (0.5 is the middle). */
export function sideAnchor(box: LinkBox, side: LinkSide, fraction = .5): LinkPoint {
  if (side === 'left') return { x: box.x, y: box.y + box.height * fraction };
  if (side === 'right') return { x: box.x + box.width, y: box.y + box.height * fraction };
  if (side === 'top') return { x: box.x + box.width * fraction, y: box.y };
  return { x: box.x + box.width * fraction, y: box.y + box.height };
}

/** Where `count` links share one side of a block: spread over its middle three fifths, in order, so they never pile
 * up; one link alone takes the middle. */
export function sideFraction(index: number, count: number): number {
  if (count <= 1) return .5;
  const step = Math.min(.3, .6 / (count - 1));
  return .5 + (index - (count - 1) / 2) * step;
}

const outward = (point: LinkPoint, side: LinkSide, distance: number): LinkPoint => ({ x: point.x + (side === 'right' ? distance : side === 'left' ? -distance : 0), y: point.y + (side === 'bottom' ? distance : side === 'top' ? -distance : 0) });

/** The soft curve of a link from one side of a block to the facing side of another, as Obsidian draws a .canvas file,
 * and a way to find any point along it (0 at the start, 1 at the arrow). */
export function linkCurve(from: LinkPoint, fromSide: LinkSide, to: LinkPoint, toSide: LinkSide): { path: string; point: (t: number) => LinkPoint } {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const pull = Math.max(24, Math.min(140, distance * .4));
  const c1 = outward(from, fromSide, pull), c2 = outward(to, toSide, pull);
  const round = (value: number) => Math.round(value * 100) / 100;
  const path = `M ${round(from.x)} ${round(from.y)} C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(to.x)} ${round(to.y)}`;
  const point = (t: number): LinkPoint => {
    const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return { x: a * from.x + b * c1.x + c * c2.x + d * to.x, y: a * from.y + b * c1.y + c * c2.y + d * to.y };
  };
  return { path, point };
}

/** Where the word sits: at the middle of the curve, or the nearest spot along it that no other block covers. */
export function chipPoint(point: (t: number) => LinkPoint, obstacles: readonly LinkBox[]): LinkPoint {
  const covered = (p: LinkPoint) => obstacles.some(box => p.x > box.x && p.x < box.x + box.width && p.y > box.y && p.y < box.y + box.height);
  for (const t of [.5, .42, .58, .34, .66, .26, .74, .18, .82]) { const p = point(t); if (!covered(p)) return p; }
  return point(.5);
}
