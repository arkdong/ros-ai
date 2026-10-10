import type { Artifact, Canvas, CanvasNode } from './types.js';

/** What a Result note says until its agent writes the search summary. */
export const RESULT_PLACEHOLDER = 'The agent writes what this search found here.';

type Source = { n: number; title: string; url?: string };
/** A Result note keeps its cited sources as a list at the end, readable in any Markdown viewer. */
export function formatSources(sources: Source[]): string {
  if (!sources.length) return '';
  const link = (source: Source) => source.url ? `[${source.title.replace(/[[\]]/gu, '')}](${source.url})` : source.title;
  return `### Sources\n${sources.map(source => `- [${source.n}] ${link(source)}`).join('\n')}`;
}
/** Cards show a Result note's summary and only count its sources. Earlier notes used a plain "Sources" line. */
export function splitSources(text: string): { body: string; sources: number } {
  const match = /\n[ \t]*\n[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?Sources(?:\*\*)?:?[ \t]*\n((?:[ \t]*(?:[-*][ \t]+)?\[\d+\][^\n]*(?:\n|$))+)\s*$/u.exec(text);
  return match ? { body: text.slice(0, match.index).trimEnd(), sources: match[1].split('\n').filter(line => line.trim()).length } : { body: text, sources: 0 };
}

export type AgentDirection = { search: CanvasNode; result?: CanvasNode; sources: number; written: boolean };
/** An Agent block's searches, read from the canvas: each Search block it points to and the note that search points to. */
export function agentDirections(canvas: Canvas, artifacts: Artifact[], agentId: string): { directions: AgentDirection[]; sources: number; written: number } {
  const node = (id: string) => canvas.nodes.find(item => item.id === id);
  const targets = (id: string) => canvas.connections.filter(edge => edge.source === id).flatMap(edge => { const target = node(edge.target); return target ? [target] : []; });
  const found = (ids: Set<string>) => new Set(artifacts.filter(item => ids.has(item.nodeId) && item.kind === 'source').map(item => item.url ?? item.hash));
  const directions = targets(agentId).filter(target => target.blockType === 'search').map(search => {
    const result = targets(search.id).find(target => target.kind !== 'group' && !['agent', 'search'].includes(target.blockType ?? ''));
    return { search, result, sources: found(new Set([search.id])).size, written: Boolean(result && result.description.trim() && result.description !== RESULT_PLACEHOLDER) };
  });
  return { directions, sources: found(new Set(directions.map(item => item.search.id))).size, written: directions.filter(item => item.written).length };
}
