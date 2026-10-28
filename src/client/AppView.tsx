import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { APP_SOURCE_LIMIT, MAX_APP_INPUTS, appFlags, appInputs, appVersion } from '../shared/apps';
import type { CanvasNode, ProjectDetail } from '../shared/types';
import { kindName } from '../shared/vocabulary';
import { AppFrame } from './AppFrame';
import { CodeEditor, modKey } from './code';
import { readSaved, saveLocal } from './persistence';
import './app-block.css';

type Tab = 'app' | 'code' | 'inputs';

/** An App's block view: the page to use, its code, and the blocks it reads. A proposal's App runs in preview and
 * reads only what the proposal names; a saved canvas from the past shows its code only. */
export function AppView({ node, detail, proposalId, readOnly = false, still, onUpdate, onReveal }: {
  node: CanvasNode; detail: ProjectDetail; proposalId?: string; readOnly?: boolean; still?: string;
  onUpdate: (patch: Partial<CanvasNode>, label: string) => Promise<unknown>; onReveal: (blockId: string) => void;
}) {
  const saved = node.app?.source ?? '', inputs = node.app?.inputs ?? [];
  const [tab, setTabState] = useState<Tab>(() => readSaved<Tab>(`app-tab:${node.id}`, 'app'));
  const setTab = (value: Tab) => { setTabState(value); saveLocal(`app-tab:${node.id}`, value); };
  const [draft, setDraft] = useState(saved), [base, setBase] = useState(saved);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false), [adding, setAdding] = useState('');
  // A page changed elsewhere (an agent, the file in apps/) replaces an unedited draft.
  if (saved !== base) { setBase(saved); if (draft === base) setDraft(saved); }
  const dirty = draft !== saved, flags = useMemo(() => appFlags(draft), [draft]);
  const canvas = detail.project.canvas, listed = appInputs(canvas, inputs);
  const choices = canvas.nodes.filter(item => item.id !== node.id && !inputs.includes(item.id) && item.blockType !== 'agent').sort((a, b) => a.title.localeCompare(b.title));
  const watchKey = `${detail.project.revision}:${detail.artifacts.length}:${detail.artifacts[0]?.id ?? ''}`;
  const save = async () => {
    if (!dirty || readOnly || saving || draft.length > APP_SOURCE_LIMIT) return;
    setSaving(true);
    try { await onUpdate({ app: { source: draft, inputs } }, `Edit App page: ${node.title}`); } finally { setSaving(false); }
  };
  const setInputs = (next: string[], label: string) => onUpdate({ app: { source: saved, inputs: next } }, label);
  return <div className="app-view">
    <div className="app-view-tabs" role="tablist" aria-label={`${node.title} views`}>
      {(['app', 'code', 'inputs'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>
        {value === 'app' ? 'App' : value === 'code' ? `Code${dirty ? ' •' : ''}` : `Inputs · ${inputs.length}`}
      </button>)}
    </div>
    {tab === 'app' && <>
      <div className="app-view-page">{still ? <p className="app-face-still">{still}</p>
        : <AppFrame projectId={detail.project.id} nodeId={node.id} title={node.title} version={appVersion(saved)} proposalId={proposalId} watchKey={watchKey} onErrors={setErrors} onFocus={onReveal}/>}</div>
      {errors.length > 0 && <div className="app-view-errors" role="status"><strong>{errors.length === 1 ? 'The page reported an error' : `The page reported ${errors.length} errors`}</strong><ul>{errors.slice(-5).map((error, index) => <li key={index}>{error}</li>)}</ul></div>}
    </>}
    {tab === 'code' && <div className="app-view-code">
      <CodeEditor value={draft} onChange={setDraft} language="html" ariaLabel={`Page of ${node.title}`} readOnly={readOnly} maxLength={APP_SOURCE_LIMIT} onSave={() => void save()}/>
      {flags.length > 0 && <p className="app-leaves">{flags.map(flag => `Line ${flag.line} ${flag.reason}`).join(' · ')}. The frame blocks these, so they will not work.</p>}
      {!readOnly && <div className="app-view-actions">
        <span className="subtle">Version {appVersion(dirty ? draft : saved)}{dirty ? ' · not saved' : ''} · {modKey}S saves · Undo brings an earlier page back</span>
        {dirty && <button type="button" className="secondary" disabled={saving} onClick={() => setDraft(saved)}>Discard</button>}
        <button type="button" className="primary" disabled={!dirty || saving || draft.length > APP_SOURCE_LIMIT} onClick={() => void save()}>{saving ? 'Saving…' : 'Save page'}</button>
      </div>}
    </div>}
    {tab === 'inputs' && <div className="app-view-inputs">
      <p className="subtle">The page reads only these blocks, and for a Group the blocks inside it. Links never add to them.</p>
      {listed.length ? <ul>{listed.map(input => <li key={input.id}>
        <span title={input.title}>{input.title}</span><small>{input.kind}</small>
        {!readOnly && <button type="button" className="icon-button" aria-label={`Stop reading ${input.title}`} title="Remove input" onClick={() => void setInputs(inputs.filter(item => item !== input.id), `Remove ${input.title} from ${node.title}'s inputs`)}><X size={14}/></button>}
      </li>)}</ul> : <p className="subtle">No inputs yet.</p>}
      {!readOnly && inputs.length < MAX_APP_INPUTS && <div className="row">
        <select aria-label="Block to read" value={adding} onChange={event => setAdding(event.target.value)}>
          <option value="">Choose a block…</option>
          {choices.map(item => <option key={item.id} value={item.id}>{item.title} · {kindName(item)}</option>)}
        </select>
        <button type="button" className="secondary" disabled={!adding} onClick={() => { const added = canvas.nodes.find(item => item.id === adding); setAdding(''); void setInputs([...inputs, adding], `Let ${node.title} read ${added?.title ?? 'a block'}`); }}><Plus size={14}/> Add input</button>
      </div>}
    </div>}
  </div>;
}
