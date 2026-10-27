import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, StoreError } from './store.js';
import { reviewCode, type CodeReview } from './review-code.js';
import type { ApprovalMode, ResearchPolicy, ResearchUsage, ReviewDecision } from '../shared/research.js';
import { canvasChange, type CanvasChange } from '../shared/canvas-position.js';
import { groupMembers } from '../shared/groups.js';
import type { Canvas, Mutation } from '../shared/types.js';

export const modeSchema=z.enum(['ask','review','full']);
export const policySchema=z.object({mode:modeSchema}).strict();
const zero=():ResearchUsage=>({experiments:0,modelCalls:0,createdActions:0,runtimeSeconds:0,spendUsd:0});
// A notebook cell arrives already reviewed, because names carry over from earlier cells in its Python session.
type Action={kind:ReviewDecision['kind'];nodeId:string;fingerprint:string;change?:CanvasChange;code?:string;reviewed?:CodeReview;runtimeSeconds?:number;spendUsd?:number};

/** Deterministic permission reviewer. Model output is never authority.
 * The approval mode decides whether work waits for the user; usage is tallied, never capped here.
 * Paid calls stay bounded by each connection's own allowance.
 */
export class Authority {
  constructor(private store:Store){}
  policy(projectId:string):ResearchPolicy {
    this.store.getProject(projectId);
    // Older records also carry the retired scope and project limits; only these fields remain.
    const saved=this.store.record<ResearchPolicy>('policy',projectId);
    return {projectId,mode:saved?.mode??'ask',overrides:saved?.overrides??{},used:{...zero(),...saved?.used},stopped:saved?.stopped??false,revision:saved?.revision??0};
  }
  configure(projectId:string,body:unknown) {
    const {mode}=policySchema.parse(body), prior=this.policy(projectId);
    return this.store.saveRecord('policy',projectId,projectId,{...prior,mode,revision:prior.revision+1});
  }
  override(projectId:string,nodeId:string,mode:ApprovalMode|null){
    if(!this.store.getProject(projectId).canvas.nodes.some(n=>n.id===nodeId))throw new StoreError('Node not found.');
    const policy=this.policy(projectId);
    if(mode===null)delete policy.overrides[nodeId]; else policy.overrides[nodeId]=modeSchema.parse(mode);
    policy.revision++;return this.store.saveRecord('policy',projectId,projectId,policy);
  }
  mode(projectId:string,nodeId:string):ApprovalMode {const p=this.policy(projectId);return p.overrides[nodeId]??p.mode;}
  setStopped(projectId:string,stopped:boolean){const p=this.policy(projectId);return this.store.saveRecord('policy',projectId,projectId,{...p,stopped,revision:p.revision+1});}
  review(projectId:string,action:Action,p=this.policy(projectId)):ReviewDecision {
    const mode=p.overrides[action.nodeId]??p.mode;
    let outcome:ReviewDecision['outcome']='allow',reason=mode==='full'?'Full access runs work without asking.':'Approved automatically.';
    if(p.stopped){outcome='deny';reason='Project research is stopped. Resume explicitly before new work.';}
    else if(mode==='ask'){outcome='escalate';reason='Ask every time requires approval of this exact action.';}
    else if(mode==='review'&&action.kind==='experiment'){
      // Parse source as data with a fixed trusted parser; never execute it.
      // The independent container boundary still applies to manually allowed code.
      const codeReview=action.reviewed??reviewCode(action.code??'');
      if(!codeReview.allowed){outcome='escalate';reason=`Automatic reviewer: ${codeReview.reason}`;}
      else reason='The automatic reviewer found only data-analysis code.';
    }
    else if(mode==='review'&&action.kind==='create-action'){outcome='escalate';reason='Approve for me asks before research adds a related Action.';}
    // Additions and arranging land at once and stay undoable; the person's own words and blocks are not rewritten or removed unasked.
    else if(mode==='review'&&action.kind==='canvas-change'&&action.change==='edit'){outcome='escalate';reason='Approve for me asks before an agent changes a block that is already there.';}
    else if(mode==='review'&&action.kind==='canvas-change'&&action.change==='remove'){outcome='escalate';reason='Approve for me asks before an agent removes anything from the canvas.';}
    else if(mode==='review'&&action.kind==='browser'){outcome='escalate';reason='Approve for me asks before an agent opens a browser, which can send forms on websites.';}
    const decision:ReviewDecision={id:randomUUID(),at:new Date().toISOString(),mode,outcome,reason,kind:action.kind,nodeId:action.nodeId,fingerprint:action.fingerprint,policyRevision:p.revision};
    this.store.saveRecord('review',decision.id,projectId,decision);return decision;
  }
  /** Reviews each change a canvas proposal makes under the mode of every block it touches: an addition by the group it
   * goes into, a move by the block and the groups it leaves and enters, a removal by the block and every block inside it. */
  reviewCanvas(projectId:string,proposalId:string,operations:Mutation[],canvas:Canvas):ReviewDecision[] {
    const checks=new Map<string,{change:CanvasChange;nodeId:string}>();
    const check=(change:CanvasChange,ids:(string|null|undefined)[])=>{for(const id of ids)checks.set(`${change}:${id??'project'}`,{change,nodeId:id??'project'});};
    for(const op of operations){
      const change=canvasChange(op,canvas);
      if(op.type==='addNode')check(change,[op.node.parentId]);
      else if(op.type==='addConnection')check(change,[op.connection.source,op.connection.target]);
      else if(op.type==='removeConnection'){const edge=canvas.connections.find(c=>c.id===op.id);check(change,[edge?.source,edge?.target]);}
      else if(op.type==='removeNode')check(change,[op.id,...groupMembers(canvas,op.id).map(n=>n.id)]);
      else check(change,[op.id,...('parentId' in op.patch?[canvas.nodes.find(n=>n.id===op.id)?.parentId,op.patch.parentId]:[])]);
    }
    const p=this.policy(projectId);
    return this.store.atomic(()=>[...checks.values()].map(({change,nodeId})=>this.review(projectId,{kind:'canvas-change',change,nodeId,fingerprint:`${proposalId}:${change}:${nodeId}`},p)));
  }
  private amount(action:Action):ResearchUsage {return {...zero(),experiments:action.kind==='experiment'?1:0,modelCalls:action.kind==='model'?1:0,createdActions:action.kind==='create-action'?1:0,runtimeSeconds:action.runtimeSeconds??0,spendUsd:action.spendUsd??0};}
  /** Records one admitted unit of work exactly once. Stopped projects admit nothing. */
  reserve(projectId:string,action:Action){
    return this.store.atomic(()=>{
      const key=createHash('sha256').update(`${projectId}:${action.kind}:${action.fingerprint}`).digest('hex');
      if(this.store.record('admission',key))throw new StoreError('This resource admission was already consumed.',409);
      const p=this.policy(projectId);
      if(p.stopped)throw new StoreError('Project research is stopped. Resume explicitly before new work.',409);
      const amount=this.amount(action);
      for(const field of Object.keys(amount) as (keyof ResearchUsage)[]){
        if(!Number.isFinite(amount[field])||amount[field]<0)throw new StoreError(`Invalid ${field} usage.`);
        p.used[field]+=amount[field];
      }
      this.store.saveRecord('admission',key,projectId,{...action,at:new Date().toISOString(),amount});
      return this.store.saveRecord('policy',projectId,projectId,p);
    });
  }
}
