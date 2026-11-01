import type { DashboardShow, DashboardTile, MetricPoint } from './types.js';

/** A dashboard holds at most this many tiles; a funnel at most this many steps. */
export const MAX_DASHBOARD_TILES = 40;
export const MAX_FUNNEL_STEPS = 8;
export const DASHBOARD_SHOWS: readonly DashboardShow[] = ['number', 'line', 'bars', 'funnel'];
/** The words for each way a tile shows its number, as the person picks them. */
export const SHOW_NAMES: Record<DashboardShow, string> = { number: 'Number', line: 'Line', bars: 'Bars', funnel: 'Funnel' };

const DAY = 24 * 60 * 60_000;

/** The tiles under each heading, in the order the headings first appear; tiles without one come first. */
export function dashboardSections(tiles: readonly DashboardTile[]): { section: string; tiles: DashboardTile[] }[] {
  const sections: { section: string; tiles: DashboardTile[] }[] = [];
  for (const tile of tiles) {
    const name = tile.section?.trim() ?? '';
    let found = sections.find(item => item.section === name);
    if (!found) { found = { section: name, tiles: [] }; if (name) sections.push(found); else sections.unshift(found); }
    found.tiles.push(tile);
  }
  return sections;
}

/** A number's points over the last `days` days of reads, oldest first. */
export function recentPoints(history: readonly MetricPoint[], key: string, days = 14): { at: number; value: number }[] {
  const latest = history.at(-1), since = latest ? Date.parse(latest.at) - days * DAY : 0;
  return history.flatMap(point => {
    const at = Date.parse(point.at), value = point.values[key];
    return at >= since && value !== undefined ? [{ at, value }] : [];
  });
}

/** The number at the end of each of the last `days` days ros.ai read it (a day it did not read is left out), oldest first. */
export function dailyValues(history: readonly MetricPoint[], key: string, days = 14): { day: string; value: number }[] {
  const byDay = new Map<string, number>();
  for (const point of recentPoints(history, key, days)) byDay.set(new Date(point.at).toISOString().slice(0, 10), point.value);
  return [...byDay].map(([day, value]) => ({ day, value }));
}

/** Tiles made from one choice: a funnel is one tile over all the keys; any other way is one tile per key. */
export function tilesFor(block: string, keys: readonly string[], show: DashboardShow, section: string | undefined, id: () => string): DashboardTile[] {
  const at = section?.trim() ? { section: section.trim().slice(0, 60) } : {};
  if (show === 'funnel') return [{ id: id(), block, keys: keys.slice(0, MAX_FUNNEL_STEPS), show, ...at }];
  return keys.map(key => ({ id: id(), block, keys: [key], show, ...at }));
}
