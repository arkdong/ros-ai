import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, StoreError } from './store.js';
import { reviewCode } from './review-code.js';
import type { ApprovalMode, ResearchLimits, ResearchPolicy, ReviewDecision } from '../shared/research.js';

export const modeSchema=z.enum(['ask','review','full']);
export const limitsSchema=z.object({experiments:z.number().int().min(0).max(1000),modelCalls:z.number().int().min(0).max(1000),createdActions:z.number().int().min(0).max(100),runtimeSeconds:z.number().min(0).max(30000),spendUsd:z.number().finite().min(0).max(1000)}).strict();
export const policySchema=z.object({mode:modeSchema,scope:z.string().trim().max(4000),nodeIds:z.array(z.string()).max(500),datasetIds:z.array(z.string()).max(100),allowActionCreation:z.boolean(),limits:limitsSchema}).strict();
const zero=():ResearchLimits=>({experiments:0,modelCalls:0,createdActions:0,runtimeSeconds:0,spendUsd:0});
type Action={kind:ReviewDecision['kind'];nodeId:string;fingerprint:string;datasetId?:string;code?:string;relation?:string;runtimeSeconds?:number;spendUsd?:number};

/** Deterministic independent permission reviewer. Model output is never authority.
 * Resource reservations are cumulative for the project, across nodes and sessions.
 */
export class Authority {
  constructor(private store:Store){}
  policy(projectId:string):ResearchPolicy {
    this.store.getProject(projectId);
    return this.store.record<ResearchPolicy>('policy',projectId) ?? {projectId,mode:'ask',overrides:{},scope:'',nodeIds:[],datasetIds:[],allowActionCreation:false,limits:{experiments:100,modelCalls:20,createdActions:20,runtimeSeconds:3000,spendUsd:0},used:zero(),stopped:false,revision:0};
  }
  configure(projectId:string,body:unknown) {
    const value=policySchema.parse(body), prior=this.policy(projectId), project=this.store.getProject(projectId);
    for(const nodeId of value.nodeIds) if(!project.canvas.nodes.some(n=>n.id===nodeId))throw new StoreError('Scope contains a node outside this project.');
    for(const datasetId of value.datasetIds){const a=this.store.getArtifact(datasetId);if(a.projectId!==projectId||a.kind!=='dataset')throw new StoreError('Scope contains a dataset outside this project.');}
    if(value.mode!=='ask' && (!value.scope || !value.nodeIds.length))throw new StoreError('Automatic modes require an explicit research scope and selected nodes.');
    for(const key of Object.keys(prior.used) as (keyof ResearchLimits)[])if(value.limits[key]<prior.used[key])throw new StoreError(`The ${key} ceiling cannot be below already reserved usage (${prior.used[key]}). Usage never resets.`);
    return this.store.saveRecord('policy',projectId,projectId,{...prior,...value,revision:prior.revision+1});
  }
  override(projectId:string,nodeId:string,mode:ApprovalMode|null){
    if(!this.store.getProject(projectId).canvas.nodes.some(n=>n.id===nodeId))throw new StoreError('Node not found.');
    const policy=this.policy(projectId);
    if(mode===null)delete policy.overrides[nodeId]; else policy.overrides[nodeId]=modeSchema.parse(mode);
    policy.revision++;return this.store.saveRecord('policy',projectId,projectId,policy);
  }
  mode(projectId:string,nodeId:string):ApprovalMode {const p=this.policy(projectId);return p.overrides[nodeId]??p.mode;}
  setStopped(projectId:string,stopped:boolean){const p=this.policy(projectId);return this.store.saveRecord('policy',projectId,projectId,{...p,stopped,revision:p.revision+1});}
  review(projectId:string,action:Action):ReviewDecision {
    const p=this.policy(projectId), mode=this.mode(projectId,action.nodeId);
    let outcome:ReviewDecision['outcome']='allow',reason='Within explicit scope, captured data and shared resource limits.';
    try{this.check(p,action);}catch(error){outcome='deny';reason=(error as Error).message;}
    if(outcome==='allow'){
      if(mode==='ask'){outcome='escalate';reason='Ask every time requires approval of this exact action.';}
      else if(!p.scope || !p.nodeIds.includes(action.nodeId)){outcome='escalate';reason='This node is outside the explicit automatic research scope.';}
      else if(action.kind==='experiment' && (!action.datasetId||!p.datasetIds.includes(action.datasetId))){outcome='escalate';reason='The exact dataset is not in the research grant.';}
      else if(action.kind==='create-action'&&!p.allowActionCreation){outcome='escalate';reason='Creating additional Actions is outside the grant.';}
      else if(mode==='review'){
        // Parse source as data with a fixed trusted parser; never execute it.
        // The independent container boundary still applies to manually allowed code.
        if(action.kind==='experiment'){
          const codeReview=reviewCode(action.code??'');
          if(!codeReview.allowed){outcome='escalate';reason=`Automatic reviewer: ${codeReview.reason}`;}
        }
        if(action.kind==='create-action'){
          const terms=p.scope.toLowerCase().match(/[a-z]{4,}/g)??[];
          if(!action.relation || !terms.some(word=>action.relation!.toLowerCase().includes(word))){outcome='escalate';reason='The relationship to the granted research question is not explicit enough for the rule reviewer.';}
        }
      }
    }
    const decision:ReviewDecision={id:randomUUID(),at:new Date().toISOString(),mode,outcome,reason,kind:action.kind,nodeId:action.nodeId,fingerprint:action.fingerprint,policyRevision:p.revision};
    this.store.saveRecord('review',decision.id,projectId,decision);return decision;
  }
  private amount(action:Action):ResearchLimits {return {...zero(),experiments:action.kind==='experiment'?1:0,modelCalls:action.kind==='model'?1:0,createdActions:action.kind==='create-action'?1:0,runtimeSeconds:action.runtimeSeconds??0,spendUsd:action.spendUsd??0};}
  private check(p:ResearchPolicy,action:Action){
    if(p.stopped)throw new StoreError('Project research is stopped. Resume explicitly before new work.',409);
    const amount=this.amount(action);
    for(const key of Object.keys(amount) as (keyof ResearchLimits)[])if(!Number.isFinite(amount[key])||amount[key]<0||p.used[key]+amount[key]>p.limits[key]+1e-9)throw new StoreError(`Shared project ${key} limit reached; new Actions and retries do not replenish it.`,409);
  }
  reserve(projectId:string,action:Action){
    return this.store.atomic(()=>{
      const key=createHash('sha256').update(`${projectId}:${action.kind}:${action.fingerprint}`).digest('hex');
      if(this.store.record('admission',key))throw new StoreError('This resource admission was already consumed.',409);
      const p=this.policy(projectId);this.check(p,action);const amount=this.amount(action);
      for(const field of Object.keys(amount) as (keyof ResearchLimits)[])p.used[field]+=amount[field];
      this.store.saveRecord('admission',key,projectId,{...action,at:new Date().toISOString(),amount});
      return this.store.saveRecord('policy',projectId,projectId,p);
    });
  }
  includeCreatedNode(projectId:string,nodeId:string){const p=this.policy(projectId);if(!p.nodeIds.includes(nodeId))p.nodeIds.push(nodeId);this.store.saveRecord('policy',projectId,projectId,p);}
}
