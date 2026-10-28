import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, BookOpen, Check, LoaderCircle, Quote, Square } from 'lucide-react';
import type { Artifact, CanvasNode, ProjectDetail, WebSearch } from '../shared/types';
import { webState, type WebSource, type WebState } from '../shared/agent-work';
import './web-block.css';

/** What a Web block's card draws: the question in the middle, its directions around it, and each page the searches
 * found as a mark beside the direction that found it, larger the more relevant the search service scored it. */
export type WebFaceData = { search: WebSearch; state: WebState; onOpen: (source: WebSource) => void; onStop?: () => void };

/** At most this many pages show beside a direction, the most relevant; the block counts the rest. */
const PAGES_SHOWN = 14;
const PILL_HEIGHT = 26, CENTRE_HEIGHT = 30;
const FONT = '500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

let measuring: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, font = FONT): number {
  if (measuring === undefined) measuring = document.createElement('canvas').getContext('2d');
  if (!measuring) return text.length * 6.6;
  measuring.font = font;
  return measuring.measureText(text).width;
}
/** The text cut with an ellipsis to fit a width. */
function fitted(text: string, width: number, font = FONT): string {
  if (textWidth(text, font) <= width) return text;
  let end = text.length;
  while (end > 1 && textWidth(`${text.slice(0, end).trimEnd()}…`, font) > width) end--;
  return `${text.slice(0, end).trimEnd()}…`;
}
/** Two letters for a site without an icon. */
const monogram = (site: string) => site.replace(/^(?:www|m|en)\./u, '').slice(0, 2);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : word.endsWith('h') ? 'es' : 's'}`;

/** `w` is the most room the pill takes (with its written mark and its running dot), kept free of pages. */
type Pill = { id: string; title: string; label: string; x: number; y: number; w: number; aside?: string; pending: number; written: boolean; hidden: number };
/** `aside`: every direction that found the page was set aside, so it is dimmed with them. */
type Mark = { source: WebSource; x: number; y: number; r: number; from: { x: number; y: number }[]; aside: boolean };
type Layout = { centre: { x: number; y: number; w: number; label: string }; pills: Pill[]; marks: Mark[]; widest: number };

/** Places the directions on an ellipse around the question, then each page beside its direction, in the order the
 * pages were found: a page takes the nearest free spot on a spiral around its direction (between its directions when
 * several found it), so the pages already shown stay put as more arrive. */
function layoutWeb(search: WebSearch, state: WebState, width: number, height: number): Layout {
  const cx = width / 2, cy = height / 2;
  const bold = '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', centreLabel = fitted(search.question, Math.min(240, width * 0.36) - 32, bold);
  const centre = { x: cx, y: cy, w: Math.min(240, textWidth(centreLabel, bold) + 32), label: centreLabel };
  const n = search.directions.length, start = n === 1 || n === 2 ? 0 : n === 4 ? -Math.PI / 4 : -Math.PI / 2;
  const rx = width * 0.31, ry = height * 0.31, widest = Math.min(180, width * 0.28);
  // The pages each direction shows: its most relevant, counted for the first direction that found them.
  const known = new Set(search.directions.map(direction => direction.id));
  const own = new Map<string, WebSource[]>();
  for (const source of state.sources) {
    const first = source.directions.find(id => known.has(id));
    if (first) own.set(first, [...own.get(first) ?? [], source]);
  }
  const shown = new Set<string>(), hidden = new Map<string, number>();
  for (const [id, list] of own) {
    list.slice(0, PAGES_SHOWN).forEach(source => shown.add(source.key));
    hidden.set(id, Math.max(0, list.length - PAGES_SHOWN));
  }
  const pills: Pill[] = search.directions.map((direction, index) => {
    // Room for the padding, the written mark and the running dot, so a pill never grows over the pages beside it.
    const angle = start + 2 * Math.PI * index / n, label = fitted(direction.title, widest - 56);
    return { id: direction.id, title: direction.title, label, x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle), w: Math.min(widest, textWidth(label) + 56),
      ...(direction.aside ? { aside: direction.aside } : {}), pending: state.pending[direction.id] ?? 0, written: Boolean(direction.summary), hidden: hidden.get(direction.id) ?? 0 };
  });
  const byId = new Map(pills.map(pill => [pill.id, pill]));
  type Box = { x: number; y: number; w: number; h: number };
  const boxes: Box[] = [{ x: cx - centre.w / 2 - 6, y: cy - CENTRE_HEIGHT / 2 - 6, w: centre.w + 12, h: CENTRE_HEIGHT + 12 },
    ...pills.map(pill => ({ x: pill.x - pill.w / 2 - 5, y: pill.y - PILL_HEIGHT / 2 - 5, w: pill.w + 10, h: PILL_HEIGHT + 10 + (pill.hidden ? 16 : 0) }))];
  const marks: Mark[] = [];
  const free = (x: number, y: number, r: number) => x - r >= 2 && x + r <= width - 2 && y - r >= 2 && y + r <= height - 2
    && boxes.every(box => x + r <= box.x || x - r >= box.x + box.w || y + r <= box.y || y - r >= box.y + box.h)
    && marks.every(mark => Math.hypot(mark.x - x, mark.y - y) >= mark.r + r + 4);
  for (const source of [...state.sources].filter(item => shown.has(item.key)).sort((a, b) => a.order - b.order)) {
    const from = source.directions.flatMap(id => { const pill = byId.get(id); return pill ? [pill] : []; });
    // A read page carries a ring, so it needs a little more room.
    const r = 8 + 6 * Math.max(0, Math.min(1, source.score)), room = r + (source.read ? 3 : 0);
    let ax = from.reduce((sum, pill) => sum + pill.x, 0) / from.length, ay = from.reduce((sum, pill) => sum + pill.y, 0) / from.length;
    if (from.length === 1) {
      // One direction's pages gather on its far side, away from the question.
      const dx = ax - cx, dy = ay - cy, length = Math.hypot(dx, dy) || 1;
      ax += dx / length * 40; ay += dy / length * 40;
    }
    const turn = (search.directions.findIndex(direction => direction.id === from[0].id) + 1) * 0.7;
    for (let k = 0; k < 700; k++) {
      const radius = 9.5 * Math.sqrt(k), angle = k * 2.399963 + turn, x = ax + radius * Math.cos(angle), y = ay + radius * Math.sin(angle);
      if (!free(x, y, room)) continue;
      marks.push({ source, x, y, r, from: from.map(pill => ({ x: pill.x, y: pill.y })), aside: from.every(pill => pill.aside) });
      break;
    }
  }
  return { centre, pills, marks, widest };
}

/** The face of a Web block on the canvas. */
export function WebFace({ data }: { data: WebFaceData }) {
  const { search, state } = data;
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const update = () => setSize(current => current && current.width === element.clientWidth && current.height === element.clientHeight ? current : { width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(update); observer.observe(element); update();
    return () => observer.disconnect();
  }, []);
  // The layout changes only when a page arrives, changes or is read, or the block is resized.
  const shape = JSON.stringify([search.question, search.directions.map(direction => [direction.id, direction.title, Boolean(direction.summary), direction.aside ?? '', state.pending[direction.id] ?? 0]),
    state.sources.map(source => [source.key, source.score, source.directions, source.read, source.order])]);
  const layout = useMemo(() => size && size.width > 120 && size.height > 120 ? layoutWeb(search, state, size.width, size.height) : null, [size?.width, size?.height, shape]); // eslint-disable-line react-hooks/exhaustive-deps
  const sites = useMemo(() => {
    const counted = new Map<string, { site: string; count: number; favicon?: string }>();
    for (const source of state.sources) {
      const entry = counted.get(source.site) ?? { site: source.site, count: 0 };
      entry.count++; entry.favicon ??= source.favicon;
      counted.set(source.site, entry);
    }
    return [...counted.values()].sort((a, b) => b.count - a.count).slice(0, 5);
  }, [state.sources]);
  const siteCount = new Set(state.sources.map(source => source.site)).size;
  const status = state.phase === 'searching' ? `Searching ${state.done + state.failed} of ${state.searches}` : state.phase === 'stopped' ? `Stopped at ${state.done} of ${state.searches}`
    : state.phase === 'failed' ? 'Search failed' : state.phase === 'waiting' ? (state.sources.length ? `${plural(state.sources.length, 'named page')}` : 'Waiting to search')
    : state.failed ? `${state.done} of ${state.searches} searches done` : `${plural(state.searches, 'search')} done`;
  const icon = (site: string, favicon?: string) => favicon && !broken.has(favicon)
    ? <img src={favicon} alt="" referrerPolicy="no-referrer" loading="lazy" draggable={false} onError={() => setBroken(current => new Set(current).add(favicon))}/>
    : <span aria-hidden="true">{monogram(site)}</span>;
  return <div className="web-face">
    <div className="web-head">
      <span className={`web-status ${state.phase}`} title={state.error}>{state.phase === 'searching' && <LoaderCircle size={12} className="spin"/>}{status}</span>
      <span className="web-stats"><span><b>{state.sources.length}</b> {state.sources.length === 1 ? 'page' : 'pages'}</span><span><b>{siteCount}</b> {siteCount === 1 ? 'site' : 'sites'}</span>
        {state.pagesRead > 0 && <span><b>{state.pagesRead}</b> read</span>}{state.credits !== null && <span title="Tavily credits: one per search, one per five pages read">{plural(state.credits, 'credit')}</span>}</span>
      {data.onStop && state.phase === 'searching' && <button type="button" className="secondary web-stop nodrag" onClick={event => { event.stopPropagation(); data.onStop!(); }}><Square size={10}/> Stop</button>}
    </div>
    <div ref={box} className="web-map">
      {layout && <>
        <svg className="web-lines" width={size!.width} height={size!.height} aria-hidden="true">
          {layout.pills.map(pill => <line key={pill.id} className={`web-spoke${pill.aside ? ' aside' : ''}`} x1={layout.centre.x} y1={layout.centre.y} x2={pill.x} y2={pill.y}/>)}
          {layout.marks.flatMap(mark => mark.from.map((from, index) => <line key={`${mark.source.key}:${index}`} className={`web-link${mark.aside ? ' aside' : ''}`} x1={from.x} y1={from.y} x2={mark.x} y2={mark.y}/>))}
        </svg>
        <div className="web-centre" style={{ left: layout.centre.x, top: layout.centre.y, maxWidth: layout.centre.w }} title={search.question}>{layout.centre.label}</div>
        {layout.pills.map(pill => <div key={pill.id} className={`web-direction${pill.aside ? ' aside' : ''}${pill.pending ? ' searching' : ''}`} style={{ left: pill.x, top: pill.y, maxWidth: layout.widest }}
          title={`${pill.title}${pill.aside ? `\nSet aside: ${pill.aside}` : pill.written ? '\nWritten up in this block' : ''}${pill.pending ? `\n${plural(pill.pending, 'search')} still running` : ''}`}>
          {pill.written && <Check size={11} aria-label="Written up"/>}<span>{pill.label}</span>{pill.pending > 0 && <i className="web-pulse" aria-hidden="true"/>}
          {pill.hidden > 0 && <small className="web-more">+{pill.hidden} more</small>}
        </div>)}
        {layout.marks.map(({ source, x, y, r, aside }) => <button key={source.key} type="button" className={`web-page${source.read ? ' read' : ''}${source.quoted ? ' quoted' : ''}${aside ? ' aside' : ''}`}
          style={{ left: x - r, top: y - r, width: r * 2, height: r * 2, fontSize: Math.max(8, r * 0.75) }}
          aria-label={`${source.title}, ${source.site}`} onClick={event => { event.stopPropagation(); data.onOpen(source); }} onDoubleClick={event => event.stopPropagation()}
          title={`${source.title}\n${source.site} · relevance ${Math.round(source.score * 100)}%${source.directions.length > 1 ? ` · found by ${source.directions.length} directions` : ''}${source.read ? ' · read in full' : ''}${source.quoted ? ' · quoted in a finding' : ''}`}>
          {icon(source.site, source.favicon)}
        </button>)}
      </>}
    </div>
    {sites.length > 0 && <div className="web-sites"><span>Found most</span>{sites.map(site => <span key={site.site} className="web-site" title={`${plural(site.count, 'page')} from ${site.site}`}><i>{icon(site.site, site.favicon)}</i>{site.site}<b>{site.count}</b></span>)}</div>}
  </div>;
}

/** The pages behind a Web block, under each direction, for its opened view: what the direction searched for and
 * every page it found, most relevant first. */
export function WebSources({ node, detail, onOpenArtifact }: { node: CanvasNode; detail: ProjectDetail; onOpenArtifact: (artifact: Artifact) => void }) {
  const state = useMemo(() => webState(node, detail.project.canvas, detail.runs, detail.artifacts), [node, detail.project.canvas, detail.runs, detail.artifacts]);
  if (!node.web) return null;
  return <section className="web-sources" aria-label="Pages the searches found">
    <h3>Pages found <small>{plural(state.sources.length, 'page')} · {plural(state.done, 'search')}</small></h3>
    {node.web.directions.map(direction => {
      const pages = state.sources.filter(source => source.directions.includes(direction.id));
      return <details key={direction.id} className={`web-sources-direction${direction.aside ? ' aside' : ''}`} open={!direction.aside}>
        <summary><strong>{direction.title}</strong><small>{plural(pages.length, 'page')}{direction.summary ? ' · written up' : ''}{direction.aside ? ' · set aside' : ''}</small></summary>
        {(direction.aside || direction.why) && <p className="web-sources-why">{direction.aside ? `Set aside: ${direction.aside}` : direction.why}</p>}
        {direction.queries.length > 0 && <p className="web-sources-queries">{direction.queries.map((query, index) => <span key={index}>{query}</span>)}</p>}
        <ul>{pages.map(source => <li key={source.key}>
          <button type="button" onClick={() => source.artifacts[0] ? onOpenArtifact(source.artifacts[0]) : window.open(source.url, '_blank', 'noopener,noreferrer')}><span>{source.title}</span></button>
          <small>{source.site}{source.read && <><BookOpen size={11}/> read</>}{source.quoted && <><Quote size={11}/> quoted</>}</small>
          <a href={source.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${source.site} in the browser`}><ArrowUpRight size={13}/></a>
        </li>)}</ul>
      </details>;
    })}
  </section>;
}
