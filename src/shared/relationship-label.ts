/** Shared rendered-label footprint for routing and explicit arrangement. */
export function relationshipLabelSize(label: string): { width: number; height: number } {
  const text = label.replace(/\s+/gu, ' ').trim();
  if (!text) return { width: 0, height: 0 };
  const width = Math.min(240, Math.max(64, Array.from(text).length * 7 + 24));
  const lines = Math.max(1, Math.ceil(Array.from(text).length * 7 / (width - 24)));
  return { width, height: lines * 19 + 12 };
}
