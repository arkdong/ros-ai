import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { LoaderCircle, RotateCw } from 'lucide-react';
import type { TrainingRead, TrainingStage, TrainingView } from '../shared/types';
import { api } from './api';
import { BrandLogo } from './brand-logos';
import { clock, stop } from './live-block';
import './live-block.css';
import './training-block.css';

type Tab = 'data' | 'training' | 'evaluation' | 'model';
const TABS: { id: Tab; label: string }[] = [{ id: 'data', label: 'Data' }, { id: 'training', label: 'Training' }, { id: 'evaluation', label: 'Evaluation' }, { id: 'model', label: 'Model' }];
const tabOf = (stage: TrainingStage): Tab => stage === 'model' ? 'model' : stage === 'trained' ? 'evaluation' : stage === 'training' ? 'training' : 'data';
const usd = (value: number) => `US$${value.toFixed(2)}`;
const number = (value: number) => value.toLocaleString('en-US');
const percent = (part: number, whole: number) => whole ? `${Math.round(part / whole * 100)}%` : '–';
const minutes = (seconds: number) => seconds >= 3600 ? `${Math.floor(seconds / 3600)} h ${Math.round(seconds % 3600 / 60)} min` : `${Math.max(1, Math.round(seconds / 60))} min`;
const gpuUsd = (read: TrainingRead) => read.training ? read.training.seconds / 3600 * read.training.usdPerHour : 0;

/** What the card says in one line, and how far the current stage is. */
function status(read: TrainingRead): { text: string; progress: number; tone: 'running' | 'done' | 'idle' } {
  const { data, training } = read;
  switch (read.stage) {
    case 'model': return { text: `Model ready · ${(read.model!.bytes / 2 ** 30).toFixed(1)} GB`, progress: 1, tone: 'done' };
    case 'trained': return { text: 'Trained · making the GGUF', progress: 1, tone: 'done' };
    case 'training': return { text: `Training · epoch ${training!.epoch.toFixed(1)} of ${training!.epochs}`, progress: training!.maxSteps ? training!.step / training!.maxSteps : 0, tone: 'running' };
    case 'data-ready': return { text: `Data ready · ${number(data.train ?? 0)} samples`, progress: 1, tone: 'done' };
    default: return { text: `${read.running ? 'Making data' : 'Data paused'} · ${number(data.run)} of ${number(data.tasks)} tasks`, progress: data.tasks ? data.run / data.tasks : 0, tone: read.running ? 'running' : 'idle' };
  }
}

/** A model training run read live: the teacher's data on this computer, the LoRA run on the GPU machine over ssh.
 * The card shows the stage, its progress and the spend; the block view has one tab per stage. ros.ai only reads. */
export function TrainingBlock({ projectId, nodeId, view, full = false }: { projectId: string; nodeId: string; view: TrainingView; full?: boolean }) {
  const [read, setRead] = useState<TrainingRead | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [tab, setTab] = useState<Tab | null>(null);
  const key = JSON.stringify(view);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setRead(await api<TrainingRead>(`/api/projects/${projectId}/nodes/${nodeId}/training`, { signal: AbortSignal.timeout(60_000) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, nodeId, key]);
  useEffect(() => { void load(); }, [load]);
  // A running stage is read again every minute.
  useEffect(() => { if (!read?.running) return; const timer = window.setInterval(() => void load(), 60_000); return () => window.clearInterval(timer); }, [read?.running, load]);
  const shown = status(read ?? { stage: 'data', running: false, fetchedAt: '', data: { tasks: 0, run: 0, kept: 0, seconds: 0, families: [], spentUsd: 0 }, evals: [] });
  const spent = read ? read.data.spentUsd + gpuUsd(read) : 0, current = tab ?? (read ? tabOf(read.stage) : 'data');
  return <div className={`live-block training-block${full ? ' full' : ''}`}>
    {error ? <p className="live-block-error">{error}</p>
      : !read ? <p className="live-block-loading"><LoaderCircle size={13} className="spin"/> Reading the training run…</p>
      : <>
        <div className="training-status">
          <span className={`training-dot ${shown.tone}`} aria-hidden="true"/>
          <span>{shown.text}</span>
          {!full && <span className="training-spent" title="Token Factory for the data, plus the GPU time so far">{usd(spent)}</span>}
        </div>
        <div className="training-progress" role="progressbar" aria-label="Progress of this stage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(shown.progress * 100)}><div style={{ width: `${Math.min(100, shown.progress * 100)}%` }}/></div>
        {full && <>
          <nav className="training-tabs" aria-label="Stages">{TABS.map(item => <button key={item.id} type="button" aria-pressed={item.id === current} onClick={() => setTab(item.id)}>{item.label}</button>)}</nav>
          <div className="training-pane">
            {current === 'data' ? <DataPane read={read}/> : current === 'training' ? <TrainingPane read={read} view={view}/> : current === 'evaluation' ? <EvaluationPane read={read}/> : <ModelPane read={read}/>}
          </div>
        </>}
      </>}
    {read?.notice && <p className="live-block-notice">{read.notice}</p>}
    <footer>
      <BrandLogo id="nebius" size={12}/>
      <span>{read ? `${full ? `${usd(read.data.spentUsd)} Token Factory${read.training ? ` · about ${usd(gpuUsd(read))} GPU` : ''} · ` : ''}read ${clock(read.fetchedAt)}${read.running ? ', again every minute' : ''}` : 'Live from the run folder'}</span>
      <button className="icon-button" aria-label="Read the run again" title="Read the run again" disabled={loading} onClick={event => { stop(event); void load(); }}>{loading ? <LoaderCircle size={13} className="spin"/> : <RotateCw size={13}/>}</button>
    </footer>
  </div>;
}

function Stats({ items }: { items: [string, string][] }) {
  return <dl className="training-stats">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function DataPane({ read }: { read: TrainingRead }) {
  const { data } = read;
  if (!data.run) return <p className="live-block-empty">No teacher runs yet. They appear here as <code>run.ts rollout</code> writes them.</p>;
  return <>
    <Stats items={[['Tasks run', `${number(data.run)} of ${number(data.tasks)}`], ['Kept', `${number(data.kept)} · ${percent(data.kept, data.run)}`], ['Token Factory', usd(data.spentUsd)], ['Per task', `${(data.seconds / data.run).toFixed(0)} s`]]}/>
    <div className="live-block-scroll nowheel"><table>
      <thead><tr><th>Kind of task</th><th>Kept</th><th>Pass</th><th>Commonest failure</th></tr></thead>
      <tbody>{data.families.map(item => <tr key={item.family}><td>{item.family}</td><td>{item.kept} of {item.run}</td><td>{percent(item.kept, item.run)}</td><td title={item.top}>{item.top ?? '–'}</td></tr>)}</tbody>
    </table></div>
    <p className="training-note">{data.train !== undefined ? `Exported ${number(data.train)} training and ${number(data.val ?? 0)} validation samples.` : 'Kept runs become samples when the data is exported.'} A refused tool call stays in a sample, masked from training.</p>
  </>;
}

function TrainingPane({ read, view }: { read: TrainingRead; view: TrainingView }) {
  const run = read.training;
  if (!run) return <p className="live-block-empty">{view.host ? `Training has not started on ${view.host}.` : 'Training has not started.'} It runs on the H100 with train_lora.py, and this tab then follows its metrics.jsonl{view.host ? '' : ' (name the GPU machine in the block to follow it live)'}.</p>;
  const left = run.step && run.maxSteps > run.step ? run.seconds / run.step * (run.maxSteps - run.step) : 0;
  return <>
    <Stats items={[['Step', `${number(run.step)} of ${number(run.maxSteps)}`], ['Loss now', run.loss.at(-1)?.value.toFixed(3) ?? '–'], [run.finished ? 'Took' : 'Time left', run.finished ? minutes(run.seconds) : left ? `about ${minutes(left)}` : '–'], ['GPU so far', `about ${usd(gpuUsd(read))}`]]}/>
    <LossChart train={run.loss} validation={run.evalLoss} maxSteps={run.maxSteps}/>
    <p className="training-note">{run.pilot ? 'A pilot run of 40 steps, to measure speed and memory. ' : ''}LoRA rank {run.rank ?? '–'} on all linear layers · {run.epochs} epochs · learning rate {run.lr ?? '–'} · {number(run.samples ?? 0)} samples{run.base ? ` · ${run.base}` : ''}</p>
  </>;
}

function EvaluationPane({ read }: { read: TrainingRead }) {
  if (!read.evals.length) return <p className="live-block-empty">No evaluation yet. Each <code>run.ts eval</code> (Nano 4B as it is, ros-nemotron, Super) adds a row here, scored on the same held-out tasks.</p>;
  return <div className="live-block-scroll nowheel"><table>
    <thead><tr><th>Model</th><th>Held-out tasks passed</th><th>Pass</th></tr></thead>
    <tbody>{read.evals.map(item => <tr key={item.label}><td>{item.label}</td><td>{item.passed} of {item.run}</td><td>{percent(item.passed, item.run)}</td></tr>)}</tbody>
  </table></div>;
}

function ModelPane({ read }: { read: TrainingRead }) {
  if (!read.model) return <p className="live-block-empty">The 4-bit GGUF for Local Ros appears here once to_gguf.sh has made it.</p>;
  return <Stats items={[['File', read.model.file], ['Size', `${(read.model.bytes / 2 ** 30).toFixed(1)} GB`]]}/>;
}

/** Training loss per logged step (solid) and validation loss per epoch (dashed, with points), on one loss axis. */
function LossChart({ train, validation, maxSteps }: { train: { step: number; value: number }[]; validation: { step: number; value: number }[]; maxSteps: number }) {
  const [hover, setHover] = useState<number | null>(null), [width, setWidth] = useState(640), box = useRef<HTMLDivElement>(null);
  // Drawn at the width it is shown, so its text stays the size of the text around it.
  useEffect(() => { const element = box.current; if (!element) return; const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry.contentRect.width)))); observer.observe(element); return () => observer.disconnect(); }, [train.length > 0]);
  if (!train.length) return <p className="live-block-empty">The first loss is logged after 5 steps.</p>;
  const W = width, H = 220, left = 44, right = 12, top = 10, bottom = 26;
  const all = [...train, ...validation].map(point => point.value), low = Math.min(...all), high = Math.max(...all), span = high - low || 1;
  const steps = Math.max(maxSteps, ...train.map(point => point.step), 1);
  const x = (step: number) => left + step / steps * (W - left - right), y = (value: number) => top + (high - value) / span * (H - top - bottom);
  const path = (points: { step: number; value: number }[]) => points.map((point, index) => `${index ? 'L' : 'M'}${x(point.step).toFixed(1)},${y(point.value).toFixed(1)}`).join('');
  const ticks = [high, low + span / 2, low];
  const at = hover === null ? null : train[hover], near = at && validation.length ? validation.reduce((best, point) => Math.abs(point.step - at.step) < Math.abs(best.step - at.step) ? point : best) : null;
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect(), step = ((event.clientX - box.left) / box.width * W - left) / (W - left - right) * steps;
    let best = 0; train.forEach((point, index) => { if (Math.abs(point.step - step) < Math.abs(train[best].step - step)) best = index; }); setHover(best);
  };
  return <figure className="training-chart">
    <figcaption><span className="training-key"><svg width="18" height="8" aria-hidden="true"><line x1="0" y1="4" x2="18" y2="4" stroke="currentColor" strokeWidth="2"/></svg>Training loss</span>
      {validation.length > 0 && <span className="training-key"><svg width="18" height="8" aria-hidden="true"><line x1="0" y1="4" x2="18" y2="4" stroke="currentColor" strokeWidth="2" strokeDasharray="4 3"/></svg>Validation loss</span>}</figcaption>
    <div className="training-plot" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Training loss from ${train[0].value.toFixed(3)} to ${train.at(-1)!.value.toFixed(3)} over ${train.at(-1)!.step} steps`} onPointerMove={move} onPointerLeave={() => setHover(null)}>
        {ticks.map(value => <g key={value}><line x1={left} x2={W - right} y1={y(value)} y2={y(value)} className="training-grid"/><text x={left - 6} y={y(value) + 4} textAnchor="end">{value.toFixed(2)}</text></g>)}
        <text x={left} y={H - 6}>step 0</text><text x={W - right} y={H - 6} textAnchor="end">step {number(steps)}</text>
        <path d={path(train)} className="training-line"/>
        {validation.length > 0 && <path d={path(validation)} className="training-line dashed"/>}
        {validation.map(point => <circle key={point.step} cx={x(point.step)} cy={y(point.value)} r="4" className="training-point"/>)}
        {at && <><line x1={x(at.step)} x2={x(at.step)} y1={top} y2={H - bottom} className="training-cross"/><circle cx={x(at.step)} cy={y(at.value)} r="4" className="training-point"/></>}
      </svg>
      {at && <div className="training-tip" style={{ left: `${x(at.step) / W * 100}%` }}><strong>Step {number(at.step)}</strong><span>Training {at.value.toFixed(3)}</span>{near && <span>Validation {near.value.toFixed(3)} (step {number(near.step)})</span>}</div>}
    </div>
  </figure>;
}
