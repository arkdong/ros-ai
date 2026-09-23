import { GROUP_INSET } from './layout.js';
/** Only group children are bounded by their parent's content inset. Root notes
 * live on an unbounded plane; the viewport is never a persistence boundary. */
export function savedCanvasPosition(position: { x: number; y: number }, nested: boolean) {
  const snap = (value: number) => Math.round(value / 24) * 24;
  const x = snap(position.x - (nested ? GROUP_INSET.x : 0));
  const y = snap(position.y - (nested ? GROUP_INSET.y : 0));
  return { x: nested ? Math.max(0, x) : x, y: nested ? Math.max(0, y) : y };
}
