import type { CanvasNode, DashboardShow, Mutation } from '../shared/types';
import { MAX_DASHBOARD_TILES } from '../shared/dashboards';
import { CARD_DEFAULT_WIDTH } from '../shared/card-size';

/** The blocks a dashboard tile can read: the Metrics blocks on the map. */
export const dashboardSources = (nodes: readonly CanvasNode[]) => nodes.filter(node => node.blockType === 'metric' && node.metric).map(node => ({ id: node.id, title: node.title }));

/** The dashboards with room for one more tile. */
export const dashboardsWithRoom = (nodes: readonly CanvasNode[]) => nodes.filter(node => node.blockType === 'dashboard' && (node.dashboard?.tiles.length ?? 0) < MAX_DASHBOARD_TILES).map(node => ({ id: node.id, title: node.title }));

/** The change that pins one number of a Metrics block: onto a dashboard on the map that has room, or onto a new one
 * beside the block. A full dashboard never loses a tile to make room. */
export function pinOperations(nodes: readonly CanvasNode[], from: CanvasNode, key: string, dashboard: string | null, show: DashboardShow): Mutation[] {
  const tile = { id: crypto.randomUUID(), block: from.id, keys: [key], show };
  const target = dashboard ? nodes.find(node => node.id === dashboard && node.blockType === 'dashboard' && (node.dashboard?.tiles.length ?? 0) < MAX_DASHBOARD_TILES) : undefined;
  if (target) return [{ type: 'updateNode', id: target.id, patch: { dashboard: { tiles: [...(target.dashboard?.tiles ?? []), tile] } } }];
  return [{ type: 'addNode', node: { id: crypto.randomUUID(), title: 'Dashboard', description: '', kind: 'topic', blockType: 'dashboard', dashboard: { tiles: [tile] }, parentId: from.parentId ?? null, x: from.x + (from.width ?? CARD_DEFAULT_WIDTH) + 80, y: from.y } }];
}
