import { useState } from 'react';
import { Check, LoaderCircle, Square } from 'lucide-react';
import type { ApprovalMode, ResearchPolicy } from '../shared/research';
import type { ProjectDetail } from '../shared/types';
import { api, post } from './api';
import './detail-polish.css';
export const modeLabel=(mode:ApprovalMode)=>mode==='ask'?'Ask every time':mode==='review'?'Approve for me':'Full access';
const explanations:Record<ApprovalMode,string>={ask:'Every code run, and every canvas change the assistant makes, waits for your OK.',review:'Plain data-analysis code runs straight away, and the assistant adds, moves and regroups blocks at once. Other code, and any edit or removal, waits for your OK.',full:'Code runs straight away in the isolated sandbox, and the assistant\'s canvas changes land at once. Everything stays undoable.'};

export function PolicyPanel({detail,policy,onRefresh}:{detail:ProjectDetail;policy:ResearchPolicy;onRefresh:()=>Promise<unknown>}) {
  const [mode,setMode]=useState(policy.mode),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
  const choose=async(next:ApprovalMode)=>{const previous=mode;setMode(next);setBusy(true);setError('');setSaved(false);try{await api(`/api/projects/${detail.project.id}/policy`,{method:'PUT',body:JSON.stringify({mode:next})});await onRefresh();setSaved(true);}catch(e){setMode(previous);setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  const resume=async()=>{setBusy(true);setError('');try{await post(`/api/projects/${detail.project.id}/policy/resume`);await onRefresh();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  return <div className="research-settings detail-polish">
    <p className="modal-description">Choose how much ros.ai may do without asking. Code always runs in the isolated Python sandbox.</p>
    <div className="approval-choices" role="radiogroup" aria-label="Project approval mode">{(['ask','review','full'] as const).map(value=><label className={mode===value?'selected':''} key={value}><input type="radio" name="project-approval" value={value} checked={mode===value} disabled={busy} onChange={()=>void choose(value)}/><span><strong>{modeLabel(value)}</strong><small>{explanations[value]}</small></span></label>)}</div>
    {policy.stopped&&<p className="detail-footnote"><Square size={12}/> Work in this project is paused. <button className="text-button" disabled={busy} onClick={()=>void resume()}>Resume</button></p>}
    <p className="permission-status" role="status">{busy?<><LoaderCircle size={14} className="spin"/> Saving</>:saved?<><Check size={14}/> Saved</>:null}</p>
    {error&&<p className="inline-error" role="alert">{error}</p>}
  </div>;
}
