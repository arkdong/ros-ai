import { cardFootprintHeight, cardWidth, estimatedCardHeight } from './card-size.js';
import { groupMembers } from './groups.js';
import { LAYOUT_GAP } from './layout.js';
import type { Canvas, CanvasNode, Connection, Mutation } from './types.js';

/** Copied blocks: the picked ones, everything inside a picked Group, and the links between them. */
export type CopiedBlocks = { kind: 'ros-blocks'; version: 1; projectId: string; nodes: CanvasNode[]; connections: Connection[] };
export const BLOCKS_MIME = 'application/x-ros-blocks';

export function copyBlocks(canvas: Canvas, ids: readonly string[], projectId: string): CopiedBlocks | null {
  const byId = new Map(canvas.nodes.map(node => [node.id, node]));
  const picked = new Set(ids.filter(id => byId.has(id)));
  // A block inside a picked Group travels with its Group, so it is not copied twice.
  const inPicked = (node: CanvasNode) => { for (let parent = node.parentId; parent; parent = byId.get(parent)?.parentId) if (picked.has(parent)) return true; return false; };
  const roots = [...picked].map(id => byId.get(id)!).filter(node => !inPicked(node));
  if (!roots.length) return null;
  const nodes = roots.flatMap(node => [node, ...groupMembers(canvas, node.id)]);
  const copied = new Set(nodes.map(node => node.id));
  const connections = canvas.connections.filter(connection => copied.has(connection.source) && copied.has(connection.target));
  return structuredClone({ kind: 'ros-blocks', version: 1, projectId, nodes, connections });
}

export function readCopiedBlocks(text: string): CopiedBlocks | null {
  try {
    const value = JSON.parse(text) as Partial<CopiedBlocks>;
    return value?.kind === 'ros-blocks' && value.version === 1 && typeof value.projectId === 'string' && Array.isArray(value.nodes) && Array.isArray(value.connections) ? value as CopiedBlocks : null;
  } catch { return null; }
}

export type BlockSize = { width: number; height: number };
const GRID = 24, grid = (value: number) => Math.ceil(value / GRID) * GRID;

/**
 * The changes that paste a copy as new blocks with their own ids. Blocks never overlap on the canvas, so the
 * copy lands on the nearest free spot right of or below the copied blocks, and pasting again finds the next one.
 * A pasted block keeps its Group when that Group is still on this canvas. An Agent block's link to its turn and
 * a Group's chosen highlights stay with the original. In another project, links to saved results and decisions
 * stay behind too, because they belong to the original project. `measure` gives a block's size as shown.
 */
export function pasteOperations(copy: CopiedBlocks, canvas: Canvas, projectId: string, newId: () => string = () => crypto.randomUUID(), measure?: (node: CanvasNode) => BlockSize | undefined): { operations: Mutation[]; ids: string[] } {
  const ids = new Map(copy.nodes.map(node => [node.id, newId()]));
  const present = new Set(canvas.nodes.map(node => node.id)), sameProject = copy.projectId === projectId;
  const parentOf = (node: CanvasNode) => node.parentId && present.has(node.parentId) ? node.parentId : null;
  // The room the server keeps clear around a block, or more where the block is shown bigger.
  const size = (node: CanvasNode, placed: boolean): BlockSize => { const shown = measure?.(node); return { width: Math.max(cardWidth(node), shown?.width ?? 0), height: Math.max(placed ? cardFootprintHeight(node) : estimatedCardHeight(node), shown?.height ?? 0) }; };
  const outer = copy.nodes.filter(node => !ids.has(node.parentId ?? '')).map(node => ({ node, parentId: parentOf(node), ...size(node, false) }));
  const others = canvas.nodes.map(node => ({ node, ...size(node, true) }));
  const clear = (dx: number, dy: number) => outer.every(block => others.every(other => {
    if ((other.node.parentId ?? null) !== block.parentId) return true;
    const x = block.node.x + dx, y = block.node.y + dy;
    const apartX = x >= other.node.x + other.width + LAYOUT_GAP || other.node.x >= x + block.width + LAYOUT_GAP;
    const apartY = other.node.y <= y ? y >= other.node.y + other.height + LAYOUT_GAP : other.node.y >= y + block.height + LAYOUT_GAP;
    return apartX || apartY;
  }));
  const column = grid(Math.max(...outer.map(block => block.node.x + block.width)) - Math.min(...outer.map(block => block.node.x)) + LAYOUT_GAP);
  // Once pasted, the originals count with the room the server keeps below them.
  const row = grid(Math.max(...outer.map(block => block.node.y + size(block.node, true).height)) - Math.min(...outer.map(block => block.node.y)) + LAYOUT_GAP);
  const spots = Array.from({ length: 16 * 16 }, (_, index) => ({ right: index % 16, down: Math.floor(index / 16) })).filter(spot => spot.right + spot.down > 0).sort((a, b) => a.right + a.down - (b.right + b.down) || a.down - b.down);
  const spot = spots.find(({ right, down }) => clear(right * column, down * row)) ?? { right: 1, down: 0 };
  const roots: string[] = [];
  const operations: Mutation[] = copy.nodes.map(original => {
    const { id, parentId, agent, artifactId, decisions, groupHighlights, code, ...kept } = structuredClone(original);
    const copiedParent = parentId ? ids.get(parentId) : undefined;
    if (!copiedParent) roots.push(ids.get(id)!);
    const node: CanvasNode = {
      ...kept, id: ids.get(id)!,
      // Blocks inside a copied Group keep their place in it; only the outermost blocks move.
      parentId: copiedParent ?? parentOf(original),
      ...(copiedParent ? {} : { x: original.x + spot.right * column, y: original.y + spot.down * row }),
      ...(code ? { code: sameProject ? code : { ...code, inputArtifactId: null } } : {}),
      ...(sameProject && artifactId ? { artifactId } : {}),
      ...(sameProject && decisions?.length ? { decisions } : {}),
    };
    return { type: 'addNode' as const, node };
  });
  for (const connection of copy.connections) operations.push({ type: 'addConnection', connection: { ...connection, id: newId(), source: ids.get(connection.source)!, target: ids.get(connection.target)! } });
  return { operations, ids: roots };
}
