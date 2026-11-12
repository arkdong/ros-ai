import { X } from 'lucide-react';
import type { Artifact, Change, ChangeSummary, ProjectDetail } from '../shared/types';
import { contentTimeline, type ContentTimelineEntry } from '../shared/content-timeline';
import { date } from './Content';

/** The timeline with a run of the same canvas change, one after another, folded into its newest entry and a count. */
function foldRepeats(entries:ContentTimelineEntry[]){
  const rows:{entry:ContentTimelineEntry;ids:string[]}[]=[];
  for(const entry of entries){
    const last=rows[rows.length-1];
    if(entry.kind==='canvas'&&last?.entry.kind==='canvas'&&last.entry.change.label===entry.change.label)last.ids.push(entry.change.id);
    else rows.push({entry,ids:entry.kind==='canvas'?[entry.change.id]:[]});
  }
  return rows;
}

export function CanvasHistory({detail,historical,onClose,onCanvas,onEvidence}:{detail:ProjectDetail;historical:Change|null;onClose:()=>void;onCanvas:(change:ChangeSummary|null)=>void;onEvidence:(artifact:Artifact)=>void}){
  return <section className="history-panel" aria-label="Canvas content history"><div className="section-heading"><h3>Canvas history</h3><button className="icon-button" aria-label="Close history" onClick={onClose}><X size={15}/></button></div><button className={`history-entry ${!historical?'active':''}`} onClick={()=>onCanvas(null)}><strong>Current canvas</strong></button>{foldRepeats(contentTimeline(detail)).map(({entry,ids})=>entry.kind==='canvas'?<button className={`history-entry ${historical&&ids.includes(historical.id)?'active':''}`} key={entry.id} title={ids.length>1?`${ids.length} changes in a row; this opens the newest`:undefined} onClick={()=>onCanvas(entry.change)}><span className="history-timeline-dot"/><div><strong>{entry.change.label}</strong><small>{date(entry.createdAt)}{ids.length>1&&` · ${ids.length} times`}</small></div></button>:<details className="history-evidence" key={entry.id}><summary><strong>Saved evidence · {entry.title}</strong><small>{entry.artifacts.length} saved {entry.artifacts.length===1?'version':'versions'} · {date(entry.createdAt)}</small></summary><div>{entry.artifacts.map(artifact=><button className="history-evidence-link" key={artifact.id} onClick={()=>onEvidence(artifact)}>{artifact.title}<small>{artifact.kind} · {artifact.hash.slice(0,8)}</small></button>)}</div></details>)}</section>;
}
