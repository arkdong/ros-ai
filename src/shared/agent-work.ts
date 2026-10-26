import type { Artifact, Canvas, CanvasNode, Run, WebSearch } from './types.js';

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
export function splitSources(text: string): { body: string; sources: number; hosts: string[]; urls: string[] } {
  const match = /\n[ \t]*\n[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?Sources(?:\*\*)?:?[ \t]*\n((?:[ \t]*(?:[-*][ \t]+)?\[\d+\][^\n]*(?:\n|$))+)\s*$/u.exec(text);
  if (!match) return { body: text, sources: 0, hosts: [], urls: [] };
  const urls = [...match[1].matchAll(/\]\((https?:\/\/[^)\s]+)\)/gu)].map(([, url]) => url);
  const hosts = urls.flatMap(url => { try { return [new URL(url).hostname.replace(/^www\./u, '')]; } catch { return []; } });
  return { body: text.slice(0, match.index).trimEnd(), sources: match[1].split('\n').filter(line => line.trim()).length, hosts: [...new Set(hosts)], urls };
}

/** One search direction of an Agent block: the Result note its searches ran on (and, on canvases from before
 * 20 October 2026, the Search block that ran them), with the findings the note points to; or, from 26 October 2026,
 * a direction of the Web block it fills, whose findings are those quoting a page the direction found. `open` is
 * the block that shows it. */
export type AgentDirection = { id: string; title: string; open: string; result?: CanvasNode; legacySearch?: CanvasNode; web?: CanvasNode; sources: number; written: boolean; findings: CanvasNode[] };
/** An Agent block's search directions, read from the canvas, with the pages the agent read in full. */
export function agentDirections(canvas: Canvas, artifacts: Artifact[], agentId: string, runs: Run[] = []): { directions: AgentDirection[]; sources: number; written: number; findings: number; pages: Artifact[] } {
  const node = (id: string) => canvas.nodes.find(item => item.id === id);
  const targets = (id: string) => canvas.connections.filter(edge => edge.source === id).flatMap(edge => { const target = node(edge.target); return target ? [target] : []; });
  const found = (ids: Set<string>) => new Set(artifacts.filter(item => ids.has(item.nodeId) && item.kind === 'source' && item.capture !== 'full-content').map(item => item.url ?? item.hash));
  const written = (result?: CanvasNode) => Boolean(result && result.description.trim() && result.description !== RESULT_PLACEHOLDER);
  const findings = (result?: CanvasNode) => result ? targets(result.id).filter(target => target.blockType === 'finding') : [];
  let webSources = 0;
  const directions = targets(agentId).flatMap((target): AgentDirection[] => {
    if (target.blockType === 'web' && target.web) {
      const state = webState(target, canvas, runs, artifacts), quoting = findings(target);
      webSources += state.sources.length;
      return target.web.directions.map(direction => {
        const pages = new Set(state.sources.filter(source => source.directions.includes(direction.id)).map(source => source.key));
        return { id: direction.id, title: direction.title, open: target.id, web: target, sources: pages.size, written: Boolean(direction.summary),
          findings: quoting.filter(finding => splitSources(finding.description).urls.some(url => pages.has(pageKey(url)))) };
      });
    }
    if (target.blockType === 'search') {
      const result = targets(target.id).find(item => item.kind !== 'group' && !['agent', 'search', 'finding'].includes(item.blockType ?? ''));
      return [{ id: target.id, title: target.title, open: (result ?? target).id, result: result ?? target, legacySearch: target, sources: found(new Set([target.id])).size, written: written(result), findings: findings(result) }];
    }
    if (target.kind === 'group' || target.label !== 'result') return [];
    return [{ id: target.id, title: target.title, open: target.id, result: target, sources: found(new Set([target.id])).size, written: written(target), findings: findings(target) }];
  });
  const pages = artifacts.filter(item => item.nodeId === agentId && item.capture === 'full-content');
  const noted = new Set(directions.flatMap(item => item.result ? [(item.legacySearch ?? item.result).id] : []));
  return { directions, sources: found(noted).size + webSources, written: directions.filter(item => item.written).length, findings: new Set(directions.flatMap(item => item.findings.map(finding => finding.id))).size, pages };
}

/** A Web block's size when an agent adds it: room for its directions and their sources around the question. */
export const WEB_BLOCK_SIZE = { width: 720, height: 624 };

/** The text of a Web block: what the agent wrote for each direction, under the direction's title. Agents that read
 * the canvas read this; the sources stay with the block's searches. */
export function describeWeb(web: WebSearch): string {
  return web.directions.filter(direction => direction.summary).map(direction => `## ${direction.title}\n\n${direction.summary}`).join('\n\n').slice(0, 20_000);
}

/** The same page found twice can differ in its scheme, a www. or a trailing slash. */
export const pageKey = (url: string) => url.replace(/^https?:\/\/(?:www\.)?/u, '').replace(/[/?#]+$/u, '');
export function siteOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./u, ''); } catch { return url; }
}

/** One page a Web block's searches found: how relevant Tavily scored it (the best of its searches), which directions
 * found it, and whether an agent read it in full or quoted it in a Finding linked from the block. `order` is when it
 * was first found, so pages keep their places on the block as more arrive. */
export type WebSource = { key: string; url: string; title: string; site: string; favicon?: string; score: number; order: number; directions: string[]; artifacts: Artifact[]; read: boolean; quoted: boolean };
/** Where a Web block's searches are: not started (the plan may wait for approval), running, stopped, failed or done. */
export type WebPhase = 'waiting' | 'searching' | 'stopped' | 'failed' | 'done';
/** What a Web block shows: its pages, how far its searches got, and how many searches each direction still runs. */
export type WebState = { sources: WebSource[]; searches: number; done: number; failed: number; phase: WebPhase; sweepId?: string; error?: string; pending: Record<string, number>; pagesRead: number; credits: number };

/** A Web block's state, read from its runs, the sources they saved and the Findings linked from it. Named links count
 * as sources before they are read. */
export function webState(node: CanvasNode, canvas: Pick<Canvas, 'nodes' | 'connections'>, runs: Run[], artifacts: Artifact[]): WebState {
  const sweeps = runs.filter(run => run.nodeId === node.id && run.configuration.purpose === 'web-sweep');
  const read = new Set(artifacts.filter(item => item.capture === 'full-content' && item.url).map(item => pageKey(item.url!)));
  const quoted = new Set(canvas.connections.filter(edge => edge.source === node.id).flatMap(edge => {
    const target = canvas.nodes.find(item => item.id === edge.target);
    return target?.blockType === 'finding' ? splitSources(target.description).urls.map(pageKey) : [];
  }));
  const byKey = new Map<string, WebSource>();
  const add = (url: string, title: string, direction: string, score: number, artifact?: Artifact) => {
    const key = pageKey(url), favicon = typeof artifact?.metadata?.favicon === 'string' ? artifact.metadata.favicon : undefined;
    let source = byKey.get(key);
    if (!source) byKey.set(key, source = { key, url, title, site: siteOf(url), score, order: byKey.size, directions: [], artifacts: [], read: read.has(key), quoted: quoted.has(key) });
    source.score = Math.max(source.score, score);
    if (!source.directions.includes(direction)) source.directions.push(direction);
    if (artifact) { source.artifacts.push(artifact); if (source.title === source.site) source.title = artifact.title; }
    if (favicon && !source.favicon) source.favicon = favicon;
  };
  const directions = new Set(node.web?.directions.map(direction => direction.id));
  for (const direction of node.web?.directions ?? []) for (const url of direction.links ?? []) add(url, siteOf(url), direction.id, 0.8);
  const sweepIds = new Set(sweeps.map(run => run.id));
  const found = artifacts.filter(artifact => sweepIds.has(artifact.runId) && artifact.capture === 'search-snippet' && artifact.url && typeof artifact.metadata?.direction === 'string' && directions.has(artifact.metadata.direction))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const artifact of found) add(artifact.url!, artifact.title, artifact.metadata!.direction as string, typeof artifact.metadata?.score === 'number' ? artifact.metadata.score : 0.5, artifact);
  const events = sweeps.flatMap(run => run.events);
  const listed = (run: Run) => Array.isArray(run.configuration.searches) ? run.configuration.searches as { direction?: unknown }[] : [];
  const searches = sweeps.reduce((sum, run) => sum + listed(run).length, 0);
  const done = events.filter(event => event.type === 'search-captured').length, failed = events.filter(event => event.type === 'search-failed').length;
  // The searches a running sweep has not finished yet, by direction.
  const pending: Record<string, number> = {};
  for (const run of sweeps.filter(item => item.status === 'running' || item.status === 'queued')) {
    for (const item of listed(run)) if (typeof item.direction === 'string') pending[item.direction] = (pending[item.direction] ?? 0) + 1;
    for (const event of run.events) {
      const direction = (event.data as { direction?: unknown } | undefined)?.direction;
      if ((event.type === 'search-captured' || event.type === 'search-failed') && typeof direction === 'string' && pending[direction]) pending[direction]--;
    }
  }
  const sources = [...byKey.values()].sort((a, b) => b.score - a.score);
  const pagesRead = sources.filter(source => source.read).length;
  const latest = [...sweeps].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const phase: WebPhase = !latest ? 'waiting' : latest.status === 'running' || latest.status === 'queued' ? 'searching' : latest.status === 'completed' ? 'done'
    : latest.status === 'failed' ? 'failed' : 'stopped';
  return { sources, searches, done, failed, phase, ...(latest ? { sweepId: latest.id } : {}), ...(latest?.error ? { error: latest.error } : {}), pending, pagesRead,
    // Each basic search costs one credit; pages are read five to a credit.
    credits: done + Math.ceil(pagesRead / 5) };
}
