import { CARD_DEFAULT_WIDTH, CARD_MAX_HEIGHT, cardWidth } from './card-size.js';
import { LAYOUT_GAP } from './layout.js';
import type { Canvas, CanvasNode, Mutation, NotionTable } from './types.js';

/** The rows a database block turns into page blocks in one go; narrowing the block's filter reaches the rest. */
export const MAX_ROW_BLOCKS = 50;
/** The caption of the link from a database block to a block made from one of its rows. */
export const ROW_LINK = 'row';
const COLUMNS = 3;

/** The canvas edits that give a database block one page block per row: each new block shows its page live,
 * keeps the row's title, sits in the same Group as the database block and is linked from it. Rows already
 * on the canvas as page blocks are left out, as are rows beyond the first MAX_ROW_BLOCKS. */
export function rowBlockOperations(canvas: Canvas, node: CanvasNode, table: NotionTable, newId: () => string = () => crypto.randomUUID()): { operations: Mutation[]; added: number; skipped: number; beyond: number } {
  const present = new Set(canvas.nodes.flatMap(item => item.notion?.url ? [item.notion.url] : []));
  const rows = table.rows.filter(row => row.url && !present.has(row.url));
  const chosen = rows.slice(0, MAX_ROW_BLOCKS);
  // A grid beside the database block, or below everything when that space is taken.
  const width = CARD_DEFAULT_WIDTH + LAYOUT_GAP, height = CARD_MAX_HEIGHT + LAYOUT_GAP, lines = Math.ceil(chosen.length / COLUMNS);
  let x0 = node.x + cardWidth(node) + LAYOUT_GAP, y0 = node.y;
  const grid = { left: x0, top: y0, right: x0 + Math.min(COLUMNS, chosen.length) * width, bottom: y0 + lines * height };
  const taken = canvas.nodes.some(item => item.id !== node.id && (item.parentId ?? null) === (node.parentId ?? null) && item.x < grid.right && item.x + cardWidth(item) > grid.left && item.y < grid.bottom && item.y + CARD_MAX_HEIGHT > grid.top);
  if (taken) { x0 = node.x; y0 = Math.max(...canvas.nodes.filter(item => (item.parentId ?? null) === (node.parentId ?? null)).map(item => item.y)) + height; }
  const operations: Mutation[] = [];
  chosen.forEach((row, index) => {
    const id = newId(), title = (table.titleColumn ? row[table.titleColumn] : row[table.columns[0]])?.trim().slice(0, 200) || 'Untitled';
    operations.push({ type: 'addNode', node: { id, kind: 'topic', blockType: 'notion', parentId: node.parentId ?? null, title, description: '', notion: { url: row.url, kind: 'page' }, x: x0 + (index % COLUMNS) * width, y: y0 + Math.floor(index / COLUMNS) * height } });
    operations.push({ type: 'addConnection', connection: { id: newId(), source: node.id, target: id, label: ROW_LINK, sourceHandle: 'right', targetHandle: 'left' } });
  });
  return { operations, added: chosen.length, skipped: table.rows.length - rows.length, beyond: rows.length - chosen.length };
}
