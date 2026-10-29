import { useEffect, useState } from 'react';
import { ArrowRight, Copy, Check, Download, LoaderCircle } from 'lucide-react';
import type { TutorialCatalog, TutorialScenario } from '../shared/tutorial';
import { api } from './api';
import { RosMark } from './RosDock';
import './hosted-demo.css';

const release = 'https://github.com/arkdong/ros-ai/releases/latest/download';
export const DOWNLOAD = { arm: `${release}/ros.ai-mac-arm64.dmg`, intel: `${release}/ros.ai-mac-x64.dmg`, site: 'https://ros-ai.io/#get' };
const CURL = 'curl -fsSL https://ros-ai.io/install.sh | sh';

/** The hosted demo's first screen: download first, then the guided tours, which play back saved work. */
export function HostedStart({ onDemo }: { onDemo: (scenario: TutorialScenario) => Promise<void> }) {
  const [scenarios, setScenarios] = useState<TutorialScenario[] | null>(null), [busy, setBusy] = useState<string | null>(null), [copied, setCopied] = useState(false);
  useEffect(() => { void api<TutorialCatalog>('/api/demo-scenarios').then(next => setScenarios(next.scenarios.filter(item => item.available !== false))).catch(() => setScenarios([])); }, []);
  const start = async (scenario: TutorialScenario) => { setBusy(scenario.id); try { await onDemo(scenario); } finally { setBusy(null); } };
  const copy = () => { void navigator.clipboard?.writeText(CURL).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }).catch(() => undefined); };
  // The walk-through with agents comes first.
  const tours = [...(scenarios ?? [])].sort((a, b) => Number(b.id === 'workflow') - Number(a.id === 'workflow'));
  return <div className="start-screen hosted-start">
    <div className="start-column">
      <span className="start-ring"><RosMark/></span>
      <h1>Run ros.ai on your own work</h1>
      <p className="hosted-lead">This page is a demo that plays back saved work. Agents, plugins and code run only in the app on your computer, so download it to try them on your own projects.</p>
      <div className="hosted-get">
        <a className="primary hosted-download" href={DOWNLOAD.arm}><Download size={15}/>Download for Mac</a>
        <span className="start-cap">Apple silicon · <a href={DOWNLOAD.intel}>Intel</a></span>
      </div>
      <div className="hosted-cmd"><code>{CURL}</code><button type="button" className="text-button" onClick={copy} aria-label="Copy the install command">{copied ? <Check size={13}/> : <Copy size={13}/>}</button></div>
      <span className="start-cap">Mac, Linux or Windows under WSL · free and open source</span>
    </div>
    {tours.length > 0 && <section className="start-gallery hosted-tours" aria-label="Guided tours">
      <div className="start-gallery-head"><h2>Or take a guided tour first</h2><span className="start-cap">Saved results, step by step. Nothing runs live.</span></div>
      <div className="hosted-tour-row">
        {tours.map(scenario => <button key={scenario.id} type="button" className="hosted-tour" disabled={busy !== null} onClick={() => void start(scenario)}>
          <strong>{scenario.title}</strong>
          <span className="hosted-tour-sum">{scenario.summary}</span>
          <span className="hosted-tour-go">{scenario.steps} steps {busy === scenario.id ? <LoaderCircle size={13} className="spin"/> : <ArrowRight size={13}/>}</span>
        </button>)}
      </div>
    </section>}
  </div>;
}

/** On every page of the hosted demo: what it is, and the way to the real thing. */
export function HostedChip() {
  return <span className="hosted-chip"><span>Demo · saved work</span><a href={DOWNLOAD.site} target="_blank" rel="noreferrer">Download ros.ai</a></span>;
}
