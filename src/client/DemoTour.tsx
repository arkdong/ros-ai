import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, RotateCcw, X } from 'lucide-react';
import type { Artifact, ProjectDetail } from '../shared/types';
import './DemoTour.css';

export function demoEvidence(detail: ProjectDetail) {
  const newest = [...detail.artifacts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const role = (name: string) => newest.find(artifact => artifact.metadata?.demoRole === name);
  const article = role('paper') ?? role('article');
  const selectedPlots = new Set(detail.inputs.filter(input => input.nodeId === article?.nodeId).map(input => input.artifactId));
  return { source: role('evidence-source'), writing: role('writing-reference'), plot: newest.find(artifact => artifact.kind === 'plot' && selectedPlots.has(artifact.id)) ?? role('analysis-plot') ?? newest.find(artifact => artifact.nodeId === 'dutch-ai-analysis' && artifact.kind === 'plot'), challenge: role('challenge') ?? newest.find(artifact => artifact.nodeId === 'dutch-ai-challenge' && artifact.kind === 'result'), article };
}

const stages = [
  { id: 'stage-explore', title: 'Explore the question', output: 'A focused, answerable question' },
  { id: 'stage-evidence', title: 'Gather evidence', output: 'Selected evidence, coverage and limits' },
  { id: 'stage-analyze', title: 'Analyze and challenge', output: 'Actual findings and qualified conclusions' },
  { id: 'stage-draft', title: 'Draft', output: 'An editable, cited research draft' },
];

export function DemoTour({ detail, modelAvailable, onArtifact, onResources, onStage, onNote, onPrepareRefinement, onExit }: {
  detail: ProjectDetail; modelAvailable: boolean; onArtifact: (artifact: Artifact) => void;
  onResources: () => void; onStage: (nodeId: string) => void; onNote: (nodeId: string) => void;
  onPrepareRefinement: (nodeId: string) => void; onExit: () => void;
}) {
  const [step, setStep] = useState(0), [missing, setMissing] = useState('');
  const [rect, setRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const evidence = demoEvidence(detail), current = stages[step];
  const banking = detail.project.canvas.nodes.some(node => node.id === 'dutch-ai-brief');
  const focusedId = banking ? 'dutch-ai-direction' : 'focused-question';
  const descriptions = banking ? [
    'Begin with AI adoption and its possible relevance to Dutch banks. The source exploration narrows that broad idea to a comparable CBS study by company size. Open the focused question to see how it emerged.',
    'Inspect six compatible 2024 CBS size groups and the source map. Enterprises with fewer than ten people are excluded. Enterprise share and turnover share use different denominators.',
    'Two saved local Python experiments produced the figures. The adoption gap is 41.4 percentage points; turnover belonging to adopters is not revenue caused by AI. Inspect the check that qualifies the interpretation.',
    'Read the prepared article, its citations and exact selected figures, then edit the note. AURORA writing guidance belongs here as an editorial reference. It does not supply factual evidence.',
  ] : [
    'Begin with how a simple historical risk baseline describes losses as market conditions change. Follow the exploration into a focused retrospective question about preceding observations, comparison windows and limits.',
    'Inspect the captured search evidence, method references and FRED data assessment. The S&P 500 series is a price index without dividends; missing days and redistribution limits stay visible.',
    'Inspect the actual local calculation, the sensitivity comparison and the interpretation of measured results. Saved provenance distinguishes model proposals, reviewed executed code and calculated outputs.',
    'Read the short research paper with its actual results, citations and limitations, then edit its native note. Original baseline results remain available alongside the later extension.',
  ];
  const showArtifact = (artifact: Artifact | undefined) => {
    if (artifact) { setMissing(''); onArtifact(artifact); }
    else setMissing('This saved item is unavailable. Continue the tour or inspect the stage’s remaining notes.');
  };
  const showStage = (index: number) => { setMissing(''); onStage(stages[index].id); };
  const go = (next: number) => { setStep(next); showStage(next); };
  useEffect(() => {
    const update = () => {
      const element = document.querySelector(`.react-flow__node[data-id="${current.id}"] .card-title`), box = element?.getBoundingClientRect();
      const next = box && box.width && box.height && box.top >= 0 && box.bottom <= window.innerHeight ? { x: box.x - 5, y: box.y - 5, width: box.width + 10, height: box.height + 10 } : null;
      setRect(prior => JSON.stringify(prior) === JSON.stringify(next) ? prior : next);
    };
    update(); const timer = window.setInterval(update, 450);
    window.addEventListener('resize', update);
    return () => { window.clearInterval(timer); window.removeEventListener('resize', update); };
  }, [current.id]);
  return <>
    {rect && <div className="demo-tour-highlight" aria-hidden="true" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}/>}
    <section className="demo-tour" aria-label="Guided demo" aria-live="polite">
      <header><span><BookOpen size={14}/> Research tour · {step + 1} / {stages.length}</span><button className="icon-button" aria-label="Exit guided demo" onClick={onExit}><X size={16}/></button></header>
      <h2>{current.title}</h2>
      <section className="demo-tour-guidance" aria-label="Stage guidance"><span className="demo-tour-label">What to explore</span><p>{descriptions[step]}</p></section>
      <section className="demo-tour-output" aria-label="Stage outcome"><span className="demo-tour-label">{step === 0 ? 'Prepared starting point' : step === 1 ? 'Captured evidence' : step === 2 ? 'Saved findings' : 'Saved research draft'}</span><strong>{current.output}</strong></section>
      {missing && <p className="demo-tour-notice" role="status">{missing}</p>}
      <h3 className="demo-tour-research-heading">Explore the saved research</h3>
      <p className="demo-tour-provenance">Open earlier evidence and prepared writing. This tour does not run new research.</p>
      <div className="demo-tour-actions">
        <button className="secondary small" onClick={() => showStage(step)}>Show stage</button>
        {step === 0 && <button className="secondary small" onClick={() => onNote(focusedId)}>Open focused question</button>}
        {step === 1 && <><button className="secondary small" onClick={() => showArtifact(evidence.source)}>Open evidence</button><button className="secondary small" onClick={onResources}>Browse resources</button></>}
        {step === 2 && <><button className="secondary small" onClick={() => showArtifact(evidence.plot)}>Open calculated plot</button><button className="secondary small" onClick={() => showArtifact(evidence.challenge)}>Open interpretation check</button></>}
        {step === 3 && <>
          <button className="secondary small" onClick={() => showArtifact(evidence.article)}>Read saved draft</button>
          {evidence.article && <button className="secondary small" onClick={() => onNote(evidence.article!.nodeId)}>Edit draft</button>}
          {evidence.writing && <button className="secondary small" onClick={() => showArtifact(evidence.writing)}>Open writing reference</button>}
          <details className="demo-tour-refinement"><summary>Prepared, manual and live contributions</summary><p>The tour opens saved work and makes no provider calls. Editing the note changes your draft directly and is undoable. Any new model refinement is a separate recorded request.</p><p>{modelAvailable ? 'Model access is configured; sending still requires current project and provider allowance.' : 'Live refinement is unavailable under the current provider allowance. You can continue editing manually.'}</p>{modelAvailable && evidence.article && <button className="secondary small" onClick={() => onPrepareRefinement(evidence.article!.nodeId)}>Prepare a refinement request</button>}</details>
        </>}
      </div>
      <footer><button className="text-button" onClick={() => go(0)} aria-label="Restart guided demo"><RotateCcw size={13}/></button><button className="text-button" onClick={onExit}>Skip / exit</button><span/><button className="secondary small" disabled={step === 0} onClick={() => go(step - 1)}><ArrowLeft size={13}/></button>{step < stages.length - 1 ? <button className="primary small" onClick={() => go(step + 1)}>Next <ArrowRight size={13}/></button> : <button className="primary small" onClick={onExit}>Finish</button>}</footer>
    </section>
  </>;
}
