import { useEffect, useState } from 'react';
import { LoaderCircle, RotateCcw } from 'lucide-react';
import type { ProjectDetail } from '../shared/types';
import type { ModelSelection, ModelSettingsResponse } from '../shared/model-settings';
import { api } from './api';
import './model-settings.css';

const settingsChanged = 'ros-ai-model-settings';
export type ModelDisplay = { provider: string; model: string; configured: boolean };

export function ModelSettings({ detail, nodeId, readOnly = false, compact = false, onSelectionChange }: {
  detail: ProjectDetail; nodeId?: string | null; readOnly?: boolean; compact?: boolean;
  onSelectionChange?: (selection: ModelDisplay) => void;
}) {
  const [settings, setSettings] = useState<ModelSettingsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const projectId = detail.project.id;
  useEffect(() => {
    let active = true;
    const load = () => { void api<ModelSettingsResponse>(`/api/projects/${projectId}/models`).then(value => { if (active) { setSettings(value); setError(''); } }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }); };
    load();
    window.addEventListener(settingsChanged, load);
    return () => { active = false; window.removeEventListener(settingsChanged, load); };
  }, [projectId, detail.project.revision]);
  const effective = nodeId ? settings?.effective[nodeId] : undefined;
  const selection = effective?.selection || settings?.project || settings?.default;
  const provider = settings?.providers.find(item => item.id === selection?.provider);
  const model = provider?.models.find(item => item.id === selection?.model);
  useEffect(() => {
    if (selection && provider) onSelectionChange?.({ provider: provider.label, model: model?.label || selection.model, configured: provider.configured });
  }, [selection?.provider, selection?.model, provider?.configured, provider?.label, model?.label, onSelectionChange]);
  const override = nodeId ? settings?.overrides[nodeId] : undefined;
  const inheritedNode = detail.project.canvas.nodes.find(node => node.id === effective?.inheritedFrom && node.id !== nodeId);
  const isStage = Boolean(nodeId && detail.project.canvas.nodes.some(node => node.parentId === nodeId));
  const save = async (next: ModelSelection | null) => {
    setBusy(true); setError('');
    try {
      const value = await api<ModelSettingsResponse>(`/api/projects/${projectId}/models`, { method: 'PATCH', body: JSON.stringify({ nodeId: nodeId || null, selection: next }) });
      setSettings(value);
      window.dispatchEvent(new Event(settingsChanged));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <section className={`model-settings${compact ? ' compact' : ''}`} aria-label={nodeId ? 'Note reasoning model' : 'Project reasoning model'}>
    <div className="model-settings-heading"><strong>{nodeId ? isStage ? 'Stage model' : 'Reasoning model' : 'Project model'}</strong>{busy && <LoaderCircle className="spin" size={12}/>}<span>{nodeId ? override ? 'Custom setting' : inheritedNode ? `From ${inheritedNode.title}` : 'From project default' : 'Default for stages and tasks'}</span></div>
    {selection && provider && <>
      <div className="model-settings-selects">
        <label>Provider<select aria-label="Reasoning provider" value={selection.provider} disabled={readOnly || busy} onChange={event => { const next = settings?.providers.find(item => item.id === event.target.value); if (next?.models[0]) void save({ provider: next.id, model: next.models[0].id }); }}>{settings?.providers.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>Model<select aria-label="Reasoning model" title={selection.model} value={selection.model} disabled={readOnly || busy} onChange={event => void save({ ...selection, model: event.target.value })}>{provider.models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      </div>
      <div className="model-settings-foot"><span>{provider.configured ? 'Credential configured' : 'Credential not configured'}{isStage ? ' · Used by tasks without an override' : ''}</span>{nodeId && override && !readOnly && <button type="button" className="text-button" disabled={busy} onClick={() => void save(null)}><RotateCcw size={11}/> Use inherited setting</button>}</div>
    </>}
    {!settings && !error && <span className="subtle">Loading model settings…</span>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
