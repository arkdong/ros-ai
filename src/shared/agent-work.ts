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
/** Cards show a Result note's summary and only count its sources, or name the sites a Finding quotes.
 * Earlier notes used a plain "Sources" line. */
export function splitSources(text: string): { body: string; sources: number; hosts: string[] } {
  const match = /\n[ \t]*\n[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?Sources(?:\*\*)?:?[ \t]*\n((?:[ \t]*(?:[-*][ \t]+)?\[\d+\][^\n]*(?:\n|$))+)\s*$/u.exec(text);
  if (!match) return { body: text, sources: 0, hosts: [] };
  const hosts = [...match[1].matchAll(/\]\((https?:\/\/[^)\s]+)\)/gu)].flatMap(([, url]) => { try { return [new URL(url).hostname.replace(/^www\./u, '')]; } catch { return []; } });
  return { body: text.slice(0, match.index).trimEnd(), sources: match[1].split('\n').filter(line => line.trim()).length, hosts: [...new Set(hosts)] };
}

export type AgentDirection = { search: CanvasNode; result?: CanvasNode; sources: number; written: boolean; findings: CanvasNode[] };
/** An Agent block's searches, read from the canvas: each Search block it points to, the note that search points to,
 * and the findings that note points to; with the pages the agent read in full. */
export function agentDirections(canvas: Canvas, artifacts: Artifact[], agentId: string): { directions: AgentDirection[]; sources: number; written: number; findings: number; pages: Artifact[] } {
  const node = (id: string) => canvas.nodes.find(item => item.id === id);
  const targets = (id: string) => canvas.connections.filter(edge => edge.source === id).flatMap(edge => { const target = node(edge.target); return target ? [target] : []; });
  const found = (ids: Set<string>) => new Set(artifacts.filter(item => ids.has(item.nodeId) && item.kind === 'source').map(item => item.url ?? item.hash));
  const directions = targets(agentId).filter(target => target.blockType === 'search').map(search => {
    const result = targets(search.id).find(target => target.kind !== 'group' && !['agent', 'search', 'finding'].includes(target.blockType ?? ''));
    return { search, result, sources: found(new Set([search.id])).size, written: Boolean(result && result.description.trim() && result.description !== RESULT_PLACEHOLDER), findings: result ? targets(result.id).filter(target => target.blockType === 'finding') : [] };
  });
  const pages = artifacts.filter(item => item.nodeId === agentId && item.capture === 'full-content');
  return { directions, sources: found(new Set(directions.map(item => item.search.id))).size, written: directions.filter(item => item.written).length, findings: directions.reduce((sum, item) => sum + item.findings.length, 0), pages };
}
