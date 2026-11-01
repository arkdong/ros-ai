import { useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Pin, Plus, X } from 'lucide-react';
import type { DashboardShow, DashboardTile, DashboardView, MetricRead, MetricValue } from '../shared/types';
import { DASHBOARD_SHOWS, MAX_DASHBOARD_TILES, MAX_FUNNEL_STEPS, SHOW_NAMES, dailyValues, dashboardSections, recentPoints, tilesFor } from '../shared/dashboards';
import { metricChange } from '../shared/metrics';
import { api } from './api';
import { clock, stop } from './live-block';
import './live-block.css';
import './dashboard-block.css';

/** A block a tile can read: today, a Metrics block. */
export type DashboardSource = { id: string; title: string };
/** Tiles ask their blocks again this often while the dashboard is on screen; each block's server reads its tool at most every 10 minutes. */
const AGAIN_MS = 15 * 60_000;
const number = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 });
const signed = (delta: number) => `${delta > 0 ? '+' : delta < 0 ? '−' : '±'}${number(Math.abs(delta))}`;
const newId = () => crypto.randomUUID();

/** The latest read of each block the tiles name, asked again every 15 minutes. */
function useReads(projectId: string, blocks: readonly string[]) {
  const [reads, setReads] = useState<Record<string, MetricRead | { error: string }>>({});
  const key = [...new Set(blocks)].sort().join(',');
  useEffect(() => {
    let live = true;
    const load = () => { for (const id of key ? key.split(',') : []) {
      void api<MetricRead>(`/api/projects/${projectId}/nodes/${id}/metric`, { signal: AbortSignal.timeout(60_000) })
        .then(read => { if (live) setReads(old => ({ ...old, [id]: read })); })
        .catch(reason => { if (live) setReads(old => ({ ...old, [id]: { error: reason instanceof Error ? reason.message : String(reason) } })); });
    } };
    load();
    const timer = window.setInterval(load, AGAIN_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [projectId, key]);
  return reads;
}

function Line({ points, width, height }: { points: { at: number; value: number }[]; width: number; height: number }) {
  if (points.length < 2) return <p className="dash-wait">The line appears after a few reads.</p>;
  const first = points[0].at, span = Math.max(1, points.at(-1)!.at - first), values = points.map(point => point.value);
  const low = Math.min(...values), range = Math.max(...values) - low || 1;
  const path = points.map((point, index) => `${index ? 'L' : 'M'}${((point.at - first) / span * (width - 2) + 1).toFixed(1)} ${(height - 2 - (point.value - low) / range * (height - 4)).toFixed(1)}`).join(' ');
  return <svg className="dash-line" width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true"><path d={path}/></svg>;
}

function Bars({ days }: { days: { day: string; value: number }[] }) {
  if (days.length < 2) return <p className="dash-wait">Bars appear after reads on two days.</p>;
  const high = Math.max(...days.map(day => day.value)) || 1;
  return <div className="dash-bars" aria-hidden="true">{days.map(day => <span key={day.day} title={`${day.day}: ${number(day.value)}`} style={{ height: `${Math.max(3, day.value / high * 100)}%` }}/>)}</div>;
}

/** One tile: what it pins, read from its block, and where it came from. */
/** full: a tile in the opened block. compact: a smaller tile on the card on the map, chart and all, without the source line. */
function Tile({ tile, read, source, full, compact = false, onRemove }: { tile: DashboardTile; read: MetricRead | { error: string } | undefined; source: DashboardSource | undefined; full: boolean; compact?: boolean; onRemove?: () => void }) {
  const from = source ? source.title : 'A block no longer on the map';
  const values = read && !('error' in read) ? tile.keys.map(key => read.values.find(item => item.key === key)) : [];
  const first = values[0];
  const body = () => {
    if (!source) return <p className="dash-missing">Its block was removed. Remove the tile, or pin the number again.</p>;
    if (!read) return <p className="dash-wait"><LoaderCircle size={12} className="spin"/> Reading…</p>;
    if ('error' in read) return <p className="dash-missing">{read.error}</p>;
    if (tile.show === 'funnel') {
      const steps = values.map((item, index) => ({ key: tile.keys[index], item }));
      const top = steps.find(step => step.item?.value !== null && step.item?.value !== undefined)?.item?.value || 1;
      return <ol className="dash-funnel">{steps.map((step, index) => {
        const value = step.item?.value ?? null, before = index ? steps[index - 1].item?.value ?? null : null;
        return <li key={step.key}>
          <span className="dash-funnel-label">{step.item?.label ?? step.key}</span>
          <span className="dash-funnel-value"><strong>{value === null ? '–' : number(value)}</strong>{value !== null && before ? <small>{Math.round(value / before * 100)}%</small> : null}</span>
          <span className="dash-funnel-track"><span style={{ width: `${value === null ? 0 : Math.max(2, value / top * 100)}%` }}/></span>
        </li>;
      })}</ol>;
    }
    if (!first) return <p className="dash-missing">{source.title} no longer gives this number.</p>;
    if (first.text) return <p className="dash-state"><span className={`livestat-dot${first.tone ? ` ${first.tone}` : ''}`} aria-hidden="true"/>{first.text}</p>;
    if (first.value === null) return <p className="dash-missing">{first.note ?? 'Not available'}</p>;
    const change = metricChange(read, first.key, first.value);
    return <>
      <div className="dash-number"><strong>{number(first.value)}</strong>
        <span className="dash-change">{change.today !== undefined && <span>{signed(change.today)} today</span>}{full && change.week !== undefined && <span>{signed(change.week)} this week</span>}</span>
      </div>
      {(full || compact) && tile.show === 'line' && (!compact || recentPoints(read.history, first.key).length > 1) && <Line points={recentPoints(read.history, first.key)} width={compact ? 160 : 240} height={compact ? 28 : 56}/>}
      {(full || compact) && tile.show === 'bars' && (!compact || dailyValues(read.history, first.key).length > 1) && <Bars days={dailyValues(read.history, first.key)}/>}
    </>;
  };
  const label = tile.label ?? (tile.show === 'funnel' ? 'Funnel' : first?.label ?? tile.keys[0]);
  if (!full && !compact) return <div className="dash-row"><dt>{label}</dt><dd>{first && !first.text && first.value !== null && tile.show !== 'funnel' ? <strong>{number(first.value)}</strong> : tile.show === 'funnel' && values.length ? <strong>{values.map(item => item?.value === null || item?.value === undefined ? '–' : number(item.value)).join(' → ')}</strong> : first?.text ?? '–'}</dd></div>;
  return <div className={`dash-tile ${tile.show}`}>
    <div className="dash-tile-head"><span>{label}</span>{onRemove && <button type="button" className="icon-button" aria-label={`Remove ${label} from the dashboard`} title="Remove tile" onClick={onRemove}><X size={13}/></button>}</div>
    {body()}
    {!compact && <span className="dash-from" title={from}>from {from}</span>}
  </div>;
}

/** The Add a tile form: a block, which of its numbers, and how to show them. */
function AddTile({ projectId, sources, onAdd, onClose, sections }: { projectId: string; sources: DashboardSource[]; sections: string[]; onAdd: (tiles: DashboardTile[]) => void; onClose: () => void }) {
  const [block, setBlock] = useState(sources[0]?.id ?? ''), [keys, setKeys] = useState<string[]>([]), [show, setShow] = useState<DashboardShow>('number'), [section, setSection] = useState(sections.at(-1) ?? '');
  const reads = useReads(projectId, block ? [block] : []), read = reads[block];
  const numbers: MetricValue[] = read && !('error' in read) ? read.values : [];
  useEffect(() => setKeys([]), [block]);
  const ready = block && (show === 'funnel' ? keys.length >= 2 : keys.length >= 1);
  if (!sources.length) return <div className="dash-add"><p className="dash-missing">Add a Metrics block to the map first; its numbers can then be pinned here.</p><button type="button" className="dash-secondary" onClick={onClose}>Close</button></div>;
  return <form className="dash-add" onSubmit={event => { event.preventDefault(); if (ready) onAdd(tilesFor(block, keys, show, section, newId)); }}>
    <label>Block<select value={block} onChange={event => setBlock(event.target.value)}>{sources.map(source => <option key={source.id} value={source.id}>{source.title}</option>)}</select></label>
    <fieldset><legend>Numbers{show === 'funnel' ? ', in funnel order' : ''}</legend>
      {!read ? <p className="dash-wait"><LoaderCircle size={12} className="spin"/> Reading…</p> : 'error' in read ? <p className="dash-missing">{read.error}</p>
        : <div className="dash-keys">{numbers.map(item => <label key={item.key}><input type="checkbox" checked={keys.includes(item.key)} onChange={event => setKeys(old => event.target.checked ? [...old, item.key] : old.filter(key => key !== item.key))}/>{item.label}</label>)}</div>}
    </fieldset>
    <fieldset><legend>Show as</legend><div className="dash-shows">{DASHBOARD_SHOWS.map(way => <button type="button" key={way} aria-pressed={show === way} onClick={() => setShow(way)}>{SHOW_NAMES[way]}</button>)}</div></fieldset>
    <label>Section<input value={section} maxLength={60} placeholder="None" list="dash-sections" onChange={event => setSection(event.target.value)}/><datalist id="dash-sections">{sections.map(name => <option key={name} value={name}/>)}</datalist></label>
    <p className="dash-hint">{show === 'funnel' ? `Pick two to ${MAX_FUNNEL_STEPS} numbers; each step shows the share of the one before.` : 'Each number you pick becomes its own tile.'}</p>
    <div className="dash-add-actions"><button type="button" className="dash-secondary" onClick={onClose}>Cancel</button><button type="submit" className="dash-primary" disabled={!ready}>Add {show === 'funnel' ? 'funnel' : keys.length > 1 ? `${keys.length} tiles` : 'tile'}</button></div>
  </form>;
}

/** A Dashboard block: numbers pinned from other blocks, each still read from its block, under the headings the person gives.
 * The card lists the first few; the block view shows every tile, lets the person add and remove them. */
/** The card on the map shows the first tiles as the opened block does, smaller; the rest are in the block view. */
const ON_CARD = 6;

export function DashboardBlock({ projectId, view, sources, full = false, onTiles }: { projectId: string; view: DashboardView; sources: DashboardSource[]; full?: boolean; onTiles?: (tiles: DashboardTile[]) => void }) {
  const reads = useReads(projectId, view.tiles.map(tile => tile.block).filter(id => sources.some(source => source.id === id)));
  const [adding, setAdding] = useState(false);
  const byId = useMemo(() => new Map(sources.map(source => [source.id, source])), [sources]);
  const sections = dashboardSections(view.tiles), names = sections.map(item => item.section).filter(Boolean);
  const latest = Object.values(reads).flatMap(read => 'error' in read ? [] : [read.fetchedAt]).sort().at(-1);
  if (!full) return <div className="live-block dash-block">
    {view.tiles.length ? dashboardSections(view.tiles.slice(0, ON_CARD)).map(group => <section key={group.section || '-'} className="dash-section">
        {group.section && <h3>{group.section}</h3>}
        <div className="dash-grid">{group.tiles.map(tile => <Tile key={tile.id} tile={tile} read={reads[tile.block]} source={byId.get(tile.block)} full={false} compact/>)}</div>
      </section>)
      : <p className="dash-empty">No numbers yet. Open the block to add some, or use Pin on a Metrics number.</p>}
    <footer><span>{view.tiles.length > ON_CARD ? `${ON_CARD} of ${view.tiles.length} tiles` : `${view.tiles.length} ${view.tiles.length === 1 ? 'tile' : 'tiles'}`}{latest ? ` · read ${clock(latest)}` : ''}</span></footer>
  </div>;
  return <div className="live-block dash-block full">
    {sections.map(group => <section key={group.section || '-'} className="dash-section">
      {group.section && <h3>{group.section}</h3>}
      <div className="dash-grid">{group.tiles.map(tile => <Tile key={tile.id} tile={tile} read={reads[tile.block]} source={byId.get(tile.block)} full onRemove={onTiles ? () => onTiles(view.tiles.filter(item => item.id !== tile.id)) : undefined}/>)}</div>
    </section>)}
    {!view.tiles.length && !adding && <p className="dash-empty">No numbers yet. Add a tile, or open a Metrics block and use Pin on one of its numbers.</p>}
    {onTiles && (adding ? <AddTile projectId={projectId} sources={sources} sections={names} onClose={() => setAdding(false)} onAdd={tiles => { onTiles([...view.tiles, ...tiles].slice(0, MAX_DASHBOARD_TILES)); setAdding(false); }}/>
      : view.tiles.length < MAX_DASHBOARD_TILES && <button type="button" className="dash-add-button" onClick={() => setAdding(true)}><Plus size={14}/> Add a tile</button>)}
    <footer><span>{view.tiles.length} {view.tiles.length === 1 ? 'tile' : 'tiles'} from {new Set(view.tiles.map(tile => tile.block)).size} {new Set(view.tiles.map(tile => tile.block)).size === 1 ? 'block' : 'blocks'}{latest ? ` · read ${clock(latest)}` : ''}</span><span>Each tile reads again with its block</span></footer>
  </div>;
}

/** Pin on one number of a Metrics block: which dashboard (or a new one) and how to show it. */
export function PinButton({ label, dashboards, onPin }: { label: string; dashboards: { id: string; title: string }[]; onPin: (dashboard: string | null, show: DashboardShow) => void }) {
  const [open, setOpen] = useState(false), [show, setShow] = useState<DashboardShow>('number'), box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [open]);
  return <div className="dash-pin" ref={box}>
    <button type="button" className="icon-button" aria-label={`Pin ${label} to a dashboard`} title="Pin to a dashboard" aria-expanded={open} onClick={event => { stop(event); setOpen(value => !value); }}><Pin size={12}/></button>
    {open && <div className="dash-pin-menu" role="menu">
      <div className="dash-shows small">{DASHBOARD_SHOWS.filter(way => way !== 'funnel').map(way => <button type="button" key={way} aria-pressed={show === way} onClick={() => setShow(way)}>{SHOW_NAMES[way]}</button>)}</div>
      {dashboards.map(dashboard => <button type="button" role="menuitem" key={dashboard.id} onClick={() => { onPin(dashboard.id, show); setOpen(false); }}>Pin to “{dashboard.title}”</button>)}
      <button type="button" role="menuitem" onClick={() => { onPin(null, show); setOpen(false); }}>New dashboard</button>
    </div>}
  </div>;
}
