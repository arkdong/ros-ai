import { useState } from 'react';
import { Check, LoaderCircle, Signpost } from 'lucide-react';
import type { Artifact, CanvasNode, Decision, ProjectDetail } from '../shared/types';
import { date } from './Content';
import './decisions.css';

/** A block's decisions with their reasons. Saving is an ordinary canvas edit, so
 * Undo removes a new decision; withdrawing keeps it in the record, struck through. */
export function DecisionLog({ node, detail, save, basis, readOnly = false, onOpenArtifact }: { node: CanvasNode; detail: ProjectDetail; save: (decisions: Decision[], label: string) => Promise<boolean>; basis?: Artifact; readOnly?: boolean; onOpenArtifact?: (artifact: Artifact) => void }) {
  const decisions = node.decisions ?? [];
  const [open, setOpen] = useState(false), [text, setText] = useState(''), [reason, setReason] = useState(''), [chosen, setChosen] = useState<string[]>(basis ? [basis.id] : []), [busy, setBusy] = useState(false), [error, setError] = useState('');
  // Newest first, one entry per content hash: reruns save identical programs and inputs again.
  const seen = new Set<string>(), candidates: Artifact[] = [];
  for (const value of [basis, ...detail.artifacts.filter(artifact => artifact.nodeId === node.id || artifact.id === node.artifactId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))]) if (value && !seen.has(value.hash) && candidates.length < 12) { seen.add(value.hash); candidates.push(value); }
  const artifact = (id: string) => detail.artifacts.find(value => value.id === id);
  const write = async (next: Decision[], label: string) => {
    setBusy(true); setError('');
    try { return await save(next, label.slice(0, 200)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { setBusy(false); }
  };
  const record = async () => {
    const decision: Decision = { id: crypto.randomUUID(), text: text.trim(), reason: reason.trim(), at: new Date().toISOString(), basedOn: chosen.map(id => artifact(id)).filter((value): value is Artifact => Boolean(value)).map(value => ({ artifactId: value.id, hash: value.hash })) };
    if (await write([...decisions, decision], `Record decision: ${decision.text}`)) { setText(''); setReason(''); setChosen(basis ? [basis.id] : []); setOpen(false); }
  };
  if (readOnly && !decisions.length) return null;
  return <section className="decision-log" aria-label={`Decisions in ${node.title}`}>
    <div className="decision-heading"><h3><Signpost size={15}/> Decisions</h3>{!readOnly && !open && <button className="secondary small" onClick={() => setOpen(true)}>Record a decision</button>}</div>
    {!decisions.length && !open && <p className="subtle">No decisions recorded here yet. Note what you chose and why, so a reader can follow your choices.</p>}
    {decisions.map(decision => <article key={decision.id} className={`decision-entry ${decision.withdrawnAt ? 'withdrawn' : ''}`}>
      <p className="decision-text">{decision.withdrawnAt ? <s>{decision.text}</s> : decision.text}</p>
      <p className="decision-reason">Reason: {decision.withdrawnAt ? <s>{decision.reason}</s> : decision.reason}</p>
      {decision.basedOn.length > 0 && <div className="decision-basis">Based on {decision.basedOn.map(item => { const value = artifact(item.artifactId); return value && onOpenArtifact ? <button key={item.artifactId} className="text-button" onClick={() => onOpenArtifact(value)}>{value.title} · {item.hash.slice(0, 8)}</button> : <span key={item.artifactId}>{value?.title ?? 'Saved version'} · {item.hash.slice(0, 8)}</span>; })}</div>}
      <div className="decision-meta"><small>Recorded by you · {date(decision.at)}{decision.withdrawnAt ? ` · withdrawn ${date(decision.withdrawnAt)}` : ''}</small>{!readOnly && !decision.withdrawnAt && <button className="text-button small" disabled={busy} onClick={() => void write(decisions.map(item => item.id === decision.id ? { ...item, withdrawnAt: new Date().toISOString() } : item), `Withdraw decision: ${decision.text}`)}>Withdraw</button>}</div>
    </article>)}
    {open && <form className="decision-form" onSubmit={event => { event.preventDefault(); if (!busy && text.trim() && reason.trim()) void record(); }}>
      <label className="field-label">Decision<input aria-label="Decision" value={text} maxLength={2000} placeholder="What did you choose?" onChange={event => setText(event.target.value)}/></label>
      <label className="field-label">Reason<textarea aria-label="Reason for the decision" value={reason} maxLength={4000} rows={3} placeholder="Why? Name the evidence or constraint." onChange={event => setReason(event.target.value)}/></label>
      {candidates.length > 0 && <fieldset className="decision-candidates"><legend>Based on these saved versions</legend>{candidates.map(value => <label key={value.id}><input type="checkbox" checked={chosen.includes(value.id)} onChange={event => setChosen(ids => event.target.checked ? [...ids, value.id] : ids.filter(id => id !== value.id))}/><span>{value.title}<small>{value.kind} · {value.hash.slice(0, 8)} · {date(value.createdAt)}</small></span></label>)}</fieldset>}
      <p className="subtle">Saved with this block, so Undo removes it. Withdrawing keeps it, struck through. When AI is on, the project assistant reads your decisions.</p>
      <div className="row gap"><button className="primary small" disabled={busy || !text.trim() || !reason.trim()}>{busy ? <LoaderCircle size={13} className="spin"/> : <Check size={13}/>} Record decision</button><button type="button" className="secondary small" disabled={busy} onClick={() => { setOpen(false); setError(''); }}>Cancel</button></div>
    </form>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
