import { useEffect, useState } from 'react';
import { File as FileIcon, Play } from 'lucide-react';
import { blockKind, type KindId } from './block-kinds';
import './kind-preview.css';

/** Kinds whose preview plays three frames while the pointer rests on it; the others keep their still. */
export const PREVIEW_FRAMES: Partial<Record<KindId, [string, string, string]>> = { code: ['Write', 'Run', 'Result'], data: ['Drop', 'Columns', 'Chart'] };

/** The frame to show: the still until the pointer has rested, then one frame a second, and the still again with reduced motion. */
export function usePreviewLoop(kind: KindId, playing: boolean) {
  const frames = PREVIEW_FRAMES[kind], [frame, setFrame] = useState<number | null>(null);
  useEffect(() => {
    if (!frames || !playing || matchMedia('(prefers-reduced-motion: reduce)').matches) { setFrame(null); return; }
    setFrame(0);
    const timer = setInterval(() => setFrame(current => ((current ?? 0) + 1) % 3), 1000);
    return () => clearInterval(timer);
  }, [kind, playing, Boolean(frames)]);
  return frame;
}

const Head = ({ kind, label }: { kind: KindId; label?: string }) => { const item = blockKind(kind); return <div className="bp-kind">{item.icon(12)}{item.name}{label && <b>{label}</b>}</div>; };
const Row = ({ cells, head = false }: { cells: (string | number)[]; head?: boolean }) => <tr>{cells.map((cell, index) => head ? <th key={index} className={index ? 'n' : ''}>{cell}</th> : <td key={index} className={index ? 'n' : ''}>{cell}</td>)}</tr>;

/** A block as it looks on the map, with sample content from one worked example, so a preview never has to be imagined.
 *  `frame` picks one frame of a kind's loop; without it the still shows. */
export function KindPreview({ kind, frame = null, className = '' }: { kind: KindId; frame?: number | null; className?: string }) {
  const body = (() => {
    switch (kind) {
      case 'text': return <><Head kind={kind} label="question"/><h4>Research question</h4><p>Can a 1930s brick house in Utrecht reach comfortable winter temperatures with an air-to-water heat pump?</p></>;
      case 'code': {
        const step = frame ?? 2;
        return <><Head kind={kind}/><h4>Heat loss estimate</h4>
          <div className="bp-mono">{'U = {"wall": 1.6, "roof": 0.4}\nQ = sum(U[k]*A[k] for k in U) * dT'}{step === 0 ? '\nloss' : ''}</div>
          {step === 1 && <div className="bp-foot"><span className="bp-run"><Play size={9}/> Run</span><span className="bp-ring"/>0.4 s</div>}
          {step === 2 && <><table><tbody><Row head cells={['part', 'kW']}/><Row cells={['wall', '6.82']}/><tr><td><b>total</b></td><td className="n"><b>11.2</b></td></tr></tbody></table><div className="bp-foot"><span className="bp-dot"/>Ran · 0.4 s</div></>}</>;
      }
      case 'notebook': return <><Head kind={kind}/><h4>Radiator output</h4><div className="bp-cell">df.groupby("room").kw.sum()</div><div className="bp-cell out">{'north   2.1\nsouth   1.6'}</div></>;
      case 'data': {
        const step = frame ?? 1;
        return <><Head kind={kind}/><h4>gas_use_2025.csv</h4>
          {step === 0 && <div className="bp-drop"><FileIcon size={12}/> gas_use_2025.csv</div>}
          {step === 1 && <><table><tbody><Row head cells={['month', 'm³', '°C']}/><Row cells={['Jan', 312, 2.1]}/><Row cells={['Feb', 274, 3.4]}/><Row cells={['Mar', 198, 6.0]}/></tbody></table><div className="bp-foot">1,204 rows · 6 columns</div></>}
          {step === 2 && <svg className="bp-bars" width="226" height="64" viewBox="0 0 226 64" aria-hidden="true"><path d="M0 60H226" stroke="#ececec"/><rect x="12" y="12" width="24" height="48" fill="#171717"/><rect x="52" y="20" width="24" height="40" fill="#171717"/><rect x="92" y="34" width="24" height="26" fill="#171717"/><rect x="132" y="44" width="24" height="16" fill="#9a9a9a"/><rect x="172" y="50" width="24" height="10" fill="#9a9a9a"/></svg>}</>;
      }
      case 'file': return <><Head kind={kind}/><h4>heat-pump-report.pdf</h4><div className="bp-page"/><p className="bp-beside">12 pages · text read for agents</p></>;
      case 'paper': return <><Head kind={kind}/><h4>Low-temperature radiators in pre-war housing</h4><p>Jansen, de Vries · 2023 · Energy and Buildings</p><div className="bp-foot">OpenAlex · 41 citations · PDF open</div></>;
      case 'notion': return <><Head kind={kind}/><h4>Site visit notes</h4><table><tbody><Row head cells={['Room', 'Radiator', 'W']}/><Row cells={['Living', 'Type 22', '1,900']}/><Row cells={['North bedroom', 'Type 11', '700']}/></tbody></table><div className="bp-foot">Live from Notion · 14 rows</div></>;
      case 'google': return <><Head kind={kind}/><h4>Quotes 2026</h4><table><tbody><Row head cells={['Installer', '€']}/><Row cells={['Warmtewerk', '14,200']}/><Row cells={['Noorderwarmte', '12,850']}/></tbody></table><div className="bp-foot">Live from Google Sheets · 3 tabs</div></>;
      case 'app': return <><Head kind={kind}/><h4>Flow temperature explorer</h4><div className="bp-slider"><span>Flow</span><span className="bp-track"><span className="bp-knob"/></span><span>45 °C</span></div><p><b>7.4 kW</b> from the existing radiators · short by 3.8 kW</p></>;
      case 'metric': return <><Head kind={kind}/><h4>arkdong/ros-ai on GitHub</h4><dl className="bp-metrics"><div><dt>Stars</dt><dd>128 <small>+9 today</small></dd></div><div><dt>Release downloads</dt><dd>412 <small>+37 today</small></dd></div><div><dt>Visitors, 14 days</dt><dd>1,204</dd></div></dl><div className="bp-foot">read 12:40 · again every 15 minutes</div></>;
      case 'training': return <><Head kind={kind}/><h4>nemotron-nano-4b · run 3</h4><svg className="bp-loss" width="226" height="44" viewBox="0 0 226 44" aria-hidden="true"><path d="M2 6 C 40 30, 80 34, 120 36 S 200 40, 224 40" fill="none" stroke="#171717" strokeWidth="1.5"/><path d="M2 42H224" stroke="#ececec"/></svg><div className="bp-foot">val loss 0.403 · step 1,800 of 2,000</div></>;
      case 'group': return <><Head kind={kind}/><h4>Heat loss</h4><div className="bp-frame"><span/><span/></div><div className="bp-foot">2 blocks · closes to one card</div></>;
    }
  })();
  return <div className={`kind-preview ${className}`} aria-hidden="true">{body}</div>;
}
