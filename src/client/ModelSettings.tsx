import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, LoaderCircle, RotateCcw } from 'lucide-react';
import type { ProjectDetail } from '../shared/types';
import { modelMaker, resolveModelSetting, type ModelSelection, type ModelSettingsResponse } from '../shared/model-settings';
import { ModelMakerSymbol } from './ModelMakerSymbol';
import { api } from './api';
import './ModelPicker.css';

const settingsChanged = 'ros-ai-model-settings';
export type ModelDisplay = { provider: string; model: string; configured: boolean };

export function ModelSettings({ detail, nodeId, readOnly = false, compact = false, onSelectionChange }: {
  detail: ProjectDetail; nodeId?: string | null; readOnly?: boolean; compact?: boolean;
  onSelectionChange?: (selection: ModelDisplay) => void;
}) {
  const [settings, setSettings] = useState<ModelSettingsResponse | null>(null);
  const [busy, setBusy] = useState(false), [open, setOpen] = useState(false), [activeIndex, setActiveIndex] = useState(0), [error, setError] = useState('');
  const root = useRef<HTMLElement>(null), trigger = useRef<HTMLButtonElement>(null), options = useRef(new Map<number, HTMLButtonElement>());
  const menuId = useId(), projectId = detail.project.id, loadedProject = useRef(projectId), currentProject = useRef(projectId);
  currentProject.current = projectId;
  useEffect(() => {
    let active = true;
    if(loadedProject.current!==projectId){setSettings(null);loadedProject.current=projectId;}
    const load = () => { void api<ModelSettingsResponse>(`/api/projects/${projectId}/models`).then(value => { if (active) { setSettings(value); setError(''); } }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }); };
    load();
    window.addEventListener(settingsChanged, load);
    return () => { active = false; window.removeEventListener(settingsChanged, load); };
  }, [projectId, detail.project.revision]);
  useEffect(()=>{setOpen(false);},[projectId,nodeId]);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as globalThis.Node))setOpen(false);};
    document.addEventListener('pointerdown',outside);
    return()=>document.removeEventListener('pointerdown',outside);
  },[open]);
  useEffect(()=>{if(open&&!busy)options.current.get(activeIndex)?.focus();},[open,activeIndex,busy]);
  const effective = nodeId ? settings?.effective[nodeId] : undefined;
  const selection = effective?.selection || settings?.project || settings?.default;
  const provider = settings?.providers.find(item => item.id === selection?.provider);
  const model = provider?.models.find(item => item.id === selection?.model);
  useEffect(() => {
    if (selection && provider) onSelectionChange?.({ provider: provider.label, model: model?.label || selection.model, configured: provider.configured });
  }, [selection?.provider, selection?.model, provider?.configured, provider?.label, model?.label, onSelectionChange]);
  const override = nodeId ? settings?.overrides[nodeId] : undefined;
  const inheritedNode = detail.project.canvas.nodes.find(node => node.id === effective?.inheritedFrom && node.id !== nodeId);
  const scope = !nodeId ? 'Project default' : override ? 'This block has its own model' : inheritedNode ? `Inherited from ${inheritedNode.title}` : 'Inherited from project default';
  const inherited = nodeId && settings ? resolveModelSetting({ ...settings, overrides:Object.fromEntries(Object.entries(settings.overrides).filter(([id])=>id!==nodeId)) },detail.project.canvas.nodes,nodeId) : undefined;
  const inheritedProvider = settings?.providers.find(item=>item.id===inherited?.selection.provider);
  const inheritedModel = inheritedProvider?.models.find(item=>item.id===inherited?.selection.model);
  const inheritedParent = detail.project.canvas.nodes.find(node=>node.id===inherited?.inheritedFrom);
  const choices = settings?.providers.flatMap(connection=>connection.models.map(item=>({provider:connection,model:item,selection:{provider:connection.id,model:item.id}}))) ?? [];
  const offset = nodeId && override ? 1 : 0, count = choices.length + offset;
  const selectedIndex = Math.max(0,choices.findIndex(item=>item.selection.provider===selection?.provider&&item.selection.model===selection?.model)+offset);
  const via = (label:string,id:string)=>id==='nebius'?'Nebius':label;
  const destination = (connection:ModelSettingsResponse['providers'][number]) => connection.destination==='local-unverified' ? `Local endpoint · processing unverified${connection.endpointOrigin?` · ${connection.endpointOrigin}`:''}` : `External · ${connection.endpointOrigin||via(connection.label,connection.id)}`;
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const show = (index=selectedIndex) => { setActiveIndex(index); setOpen(true); };
  const save = async (next: ModelSelection | null) => {
    if(readOnly||busy)return;
    setBusy(true); setError('');
    try {
      const value = await api<ModelSettingsResponse>(`/api/projects/${projectId}/models`, { method: 'PATCH', body: JSON.stringify({ nodeId: nodeId || null, selection: next }) });
      if(currentProject.current!==projectId)return;
      setSettings(value); setOpen(false);
      window.dispatchEvent(new Event(settingsChanged));
      requestAnimationFrame(()=>trigger.current?.focus());
    } catch (cause) { if(currentProject.current===projectId)setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const navigate = (event:KeyboardEvent<HTMLElement>) => {
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}
    else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
      event.preventDefault();
      setActiveIndex(index=>event.key==='Home'?0:event.key==='End'?count-1:(index+(event.key==='ArrowDown'?1:-1)+count)%count);
    }
  };
  const maker = model?.maker ?? modelMaker(selection?.model ?? '',selection?.provider);
  return <section ref={root} className={`model-settings model-picker${compact ? ' compact' : ''}`} aria-label={nodeId ? 'Block reasoning model' : 'Project reasoning model'} onBlurCapture={event=>{if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget as globalThis.Node))setOpen(false);}}>
    <button ref={trigger} type="button" className="model-picker-trigger" role="combobox" aria-label={selection&&provider?`Choose model: ${maker.label} ${model?.label||selection.model} via ${via(provider.label,provider.id)}`:'Choose reasoning model'} aria-haspopup="listbox" aria-expanded={open} aria-controls={menuId} disabled={!settings||busy} onClick={()=>open?close():show()} onKeyDown={event=>{if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();show(event.key==='Home'?0:event.key==='End'?count-1:selectedIndex);}else if(event.key==='Escape'&&open){event.preventDefault();close();}}}>
      {selection?<><ModelMakerSymbol maker={maker}/><span className="model-picker-current"><strong>{model?.label||selection.model}</strong><small>{provider?provider.destination==='local-unverified'?'Local endpoint · unverified':`via ${via(provider.label,provider.id)}`:'Connection unavailable'}{nodeId&&!override?' · Inherited':''}</small></span></>:<span className="model-picker-current"><strong>Loading models…</strong></span>}
      {busy?<LoaderCircle size={15} className="spin" aria-label="Saving model"/>:<ChevronDown size={16} aria-hidden="true"/>}
    </button>
    {open&&settings&&selection&&<div className="model-picker-popover" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}}}>
      <div id={menuId} role="listbox" aria-label="Choose reasoning model" aria-busy={busy} onKeyDown={navigate}>
        {offset>0&&<button ref={element=>{if(element)options.current.set(0,element);else options.current.delete(0);}} type="button" role="option" aria-selected={false} tabIndex={activeIndex===0?0:-1} disabled={readOnly||busy} className="model-picker-option model-picker-inherit" onFocus={()=>setActiveIndex(0)} onClick={()=>void save(null)}><RotateCcw size={20} aria-hidden="true"/><span><strong>Use inherited model</strong><small>{inheritedModel?.label||inherited?.selection.model} · {inheritedParent?.title||'Project default'}</small></span></button>}
        {settings.providers.map(connection=><div key={connection.id} role="group" aria-label={`Models via ${connection.label}`} className="model-picker-provider-group"><div className="model-picker-provider-heading">Via {connection.label}</div>{choices.filter(choice=>choice.provider.id===connection.id).map(choice=>{
          const index=choices.indexOf(choice)+offset,chosen=choice.selection.provider===selection.provider&&choice.selection.model===selection.model;
          const optionMaker=choice.model.maker??modelMaker(choice.model.id,choice.provider.id);
          return <button key={choice.model.id} ref={element=>{if(element)options.current.set(index,element);else options.current.delete(index);}} type="button" role="option" aria-label={`${optionMaker.label} ${choice.model.label} via ${connection.label}; ${destination(connection)}`} aria-selected={chosen} tabIndex={activeIndex===index?0:-1} disabled={readOnly||busy} className={`model-picker-option${chosen?' is-selected':''}`} onFocus={()=>setActiveIndex(index)} onClick={()=>void save(choice.selection)}><ModelMakerSymbol maker={optionMaker}/><span><strong>{choice.model.label}</strong><small>{optionMaker.label} · {destination(connection)}</small></span>{chosen&&<Check size={16} aria-hidden="true"/>}</button>;
        })}</div>)}
      </div>
      <details className="model-picker-details"><summary>Model details</summary><p>{scope}</p><code>{selection.model}</code>{provider&&<p>{destination(provider)}</p>}<p>{provider?.configured?'Connection configured.':provider?'Connection key missing. Open Connections to configure it.':'The saved connection is disabled or unavailable. Choose another configured connection explicitly.'} Changing a model starts no work and grants no spending permission.</p></details>
    </div>}
    {error&&<p className="model-picker-error" role="alert">{error}</p>}
  </section>;
}
