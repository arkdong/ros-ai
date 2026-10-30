import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Cloud, LoaderCircle, RotateCw } from 'lucide-react';
import type { MetricPoint, MetricRead, MetricSource, MetricValue, MetricView } from '../shared/types';
import { METRIC_TOOLS, metricChange } from '../shared/metrics';
import { api } from './api';
import { BrandLogo } from './brand-logos';
import { clock, stop } from './live-block';
import './live-block.css';
import './metric-block.css';

/** The card asks again this often while it is on screen; the server reads the service at most every 10 minutes. */
const AGAIN_MS = 15 * 60_000;
const HOUR = 60 * 60_000;
/** The card shows the first few numbers; the block view shows them all. */
const ON_CARD = 4;
const number = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 });
/** Where a block reads, in the person's words, until the first read names it. */
const metricSourceName = (view: MetricView) => view.source === 'github' ? view.repo : METRIC_TOOLS[view.source];
/** The tool's own logo, heading the block; ros.ai cloud is a cloud. */
export function MetricLogo({ source, size }: { source: MetricSource; size: number }) {
  return source === 'cloud' ? <Cloud size={size}/> : <BrandLogo id={source} size={size}/>;
}

function Change({ delta, span }: { delta: number | undefined; span: 'day' | 'week' }) {
  if (delta === undefined) return null;
  return <span className="livestat-change" title={`Change over the last ${span}`}>{delta > 0 ? '+' : delta < 0 ? '−' : '±'}{number(Math.abs(delta))} {span === 'day' ? 'today' : 'this week'}</span>;
}

/** The value's line over the last 14 days of reads; nothing until there are two. */
function Spark({ history, item, width, height }: { history: MetricPoint[]; item: MetricValue; width: number; height: number }) {
  const latest = history.at(-1), since = latest ? Date.parse(latest.at) - 14 * 24 * HOUR : 0;
  const points = history.filter(point => Date.parse(point.at) >= since && point.values[item.key] !== undefined);
  if (points.length < 2) return null;
  const first = Date.parse(points[0].at), span = Math.max(1, Date.parse(points.at(-1)!.at) - first);
  const values = points.map(point => point.values[item.key]), low = Math.min(...values), high = Math.max(...values), range = high - low || 1;
  const path = points.map((point, index) => `${index ? 'L' : 'M'}${((Date.parse(point.at) - first) / span * (width - 2) + 1).toFixed(1)} ${(height - 2 - (point.values[item.key] - low) / range * (height - 4)).toFixed(1)}`).join(' ');
  return <svg className="livestat-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true"><path d={path}/></svg>;
}

/** Launch numbers read live from a service (GitHub, ros.ai cloud, Umami, Railway): each number, how it moved today, and its line over two
 * weeks of ros.ai's own reads. The card shows the first few; the block view shows all, with the week's change too.
 * The footer names what was read (a repository, a website) only when the block's title does not already. */
export function MetricBlock({ projectId, nodeId, view, title, full = false }: { projectId: string; nodeId: string; view: MetricView; title?: string; full?: boolean }) {
  const [read, setRead] = useState<MetricRead | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const key = JSON.stringify(view);
  const load = useCallback(async (refresh = false) => {
    setLoading(true); setError('');
    try { setRead(await api<MetricRead>(`/api/projects/${projectId}/nodes/${nodeId}/metric${refresh ? '?refresh=1' : ''}`, { signal: AbortSignal.timeout(60_000) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, nodeId, key]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const timer = window.setInterval(() => void load(), AGAIN_MS); return () => window.clearInterval(timer); }, [load]);
  const shown = read ? (full ? read.values : read.values.filter(item => item.value !== null || item.text).slice(0, ON_CARD)) : [];
  return <div className={`live-block livestat-block${full ? ' full' : ''}`}>
    {error && !read ? <p className="live-block-error">{error}</p>
      : !read ? <p className="live-block-loading"><LoaderCircle size={13} className="spin"/> Reading {metricSourceName(view)}…</p>
      : <dl className="livestat-values">{shown.map(item => <div key={item.key} className="livestat-value">
          <dt>{item.label}</dt>
          {item.text ? <dd className="livestat-state"><span className={`livestat-dot${item.tone ? ` ${item.tone}` : ''}`} aria-hidden="true"/>{item.text}</dd>
            : item.value === null ? <dd className="livestat-missing">{item.note ?? 'Not available'}</dd>
            : <dd>
              <strong>{number(item.value)}</strong>
              <Change delta={metricChange(read, item.key, item.value).today} span="day"/>
              {full && <Change delta={metricChange(read, item.key, item.value).week} span="week"/>}
              <Spark history={read.history} item={item} width={full ? 160 : 72} height={full ? 32 : 18}/>
            </dd>}
        </div>)}</dl>}
    {read?.notice && <p className="live-block-notice">{read.notice}</p>}
    {full && read && read.history.length < 2 && <p className="livestat-note">Lines and changes appear as ros.ai reads the numbers again: about once an hour while this project is open.</p>}
    <footer>
      <span>{read ? `${read.title === title ? '' : `${read.title} · `}read ${clock(read.fetchedAt)}` : metricSourceName(view)}</span>
      {read?.link && <a className="live-block-open" href={read.link} target="_blank" rel="noreferrer" onClick={stop}>Open <ArrowUpRight size={12}/></a>}
      <button className="icon-button" aria-label="Read the numbers again" title="Read the numbers again" disabled={loading} onClick={event => { stop(event); void load(true); }}>{loading ? <LoaderCircle size={13} className="spin"/> : <RotateCw size={13}/>}</button>
    </footer>
  </div>;
}
