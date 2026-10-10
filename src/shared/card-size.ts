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
const PREVIEW_BLOCKS = ['code', 'notebook', 'figure', 'dataset', 'report'];
/** A height guess for a new block's card before the browser measures it. */
export function estimatedCardHeight(node: { width?: number; title: string; description: string; kind?: string; blockType?: string; artifactId?: string }) {
  return node.kind === 'group' || node.artifactId || PREVIEW_BLOCKS.includes(node.blockType ?? '') ? CARD_MAX_HEIGHT : initialCardSize(node, node.description).height;
}
