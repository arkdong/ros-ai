import { createHash } from 'node:crypto';
import { Store, StoreError } from './store.js';
import type { SandboxCostGate } from '../shared/experiments.js';
import type { CombinedNebiusBudget } from './combined-budget.js';

export type SandboxBudgetOptions = { authorizationId?:string; maxRuns?:number; maxUsd?:number; maxCostPerRunUsd?:number; pricingBasis?:string; combinedBudget?:CombinedNebiusBudget };
type Grant = { signature:string; authorizationId:string; maxRuns:number; maxUsd:number; maxCostPerRunUsd:number; pricingBasis:string; runIds:string[] };
const number = (value:string|undefined) => value?.trim() ? Number(value) : undefined;
const environment = ():SandboxBudgetOptions => ({authorizationId:process.env.ROS_NEBIUS_SANDBOX_AUTHORIZATION_ID,maxRuns:number(process.env.ROS_NEBIUS_SANDBOX_MAX_RUNS),maxUsd:number(process.env.ROS_NEBIUS_SANDBOX_AUTHORIZED_USD),maxCostPerRunUsd:number(process.env.ROS_NEBIUS_SANDBOX_MAX_COST_PER_RUN_USD),pricingBasis:process.env.ROS_NEBIUS_SANDBOX_PRICING_BASIS});

/** Operator-attested worst-case charge, additionally bounded by the shared build grant.
 * Never converts the provider's undocumented raw cost unit into USD. Every admitted
 * attempt retains its full ceiling, including unknown and cancelled outcomes.
 */
export class SandboxBudget {
  private readonly options:SandboxBudgetOptions;
  constructor(private readonly store:Store, options?:SandboxBudgetOptions) {
    // Supplying only the shared budget must not discard operator price settings.
    const onlyShared=options?.combinedBudget&&Object.keys(options).every(key=>key==='combinedBudget');
    this.options={...(options===undefined||onlyShared?environment():options),combinedBudget:options?.combinedBudget};
  }
  private configured():Omit<Grant,'runIds'>|undefined {
    const {authorizationId,maxRuns,maxUsd,maxCostPerRunUsd,pricingBasis}=this.options;
    if(!authorizationId?.trim()||authorizationId.length>200||!pricingBasis?.trim()||pricingBasis.length>2000||!Number.isInteger(maxRuns)||maxRuns!<1||maxRuns!>50||!Number.isFinite(maxUsd)||maxUsd!<0||maxUsd!>1000||!Number.isFinite(maxCostPerRunUsd)||maxCostPerRunUsd!<0||maxCostPerRunUsd!>maxUsd!)return;
    const data={authorizationId:authorizationId.trim(),maxRuns:maxRuns!,maxUsd:maxUsd!,maxCostPerRunUsd:maxCostPerRunUsd!,pricingBasis:pricingBasis.trim()};
    return {...data,signature:createHash('sha256').update(JSON.stringify(data)).digest('hex')};
  }
  private key(id:string){return createHash('sha256').update(id).digest('hex');}
  status():SandboxCostGate {
    const config=this.configured();
    if(!config)return {ready:false,reason:'Sandbox execution needs a separate bounded authorization and a verified worst-case USD price (or documented free-beta terms). An account balance does not establish sandbox pricing.',maxCostPerRunUsd:null,pricingBasis:null,remainingRuns:0,remainingUsd:0};
    const saved=this.store.record<Grant>('sandbox-grant',this.key(config.authorizationId));
    const changed=saved&&saved.signature!==config.signature;
    const count=saved?.runIds.length??0, remainingRuns=Math.max(0,config.maxRuns-count), remainingUsd=Math.max(0,config.maxUsd-count*config.maxCostPerRunUsd);
    const shared=this.options.combinedBudget?.status(config.maxCostPerRunUsd);
    const ready=!changed&&remainingRuns>0&&remainingUsd+1e-9>=config.maxCostPerRunUsd&&(!shared||shared.ready);
    return {ready,reason:changed?'This sandbox authorization was already used with different limits or pricing. Restore its original terms; changing settings cannot replenish it.':shared&&!shared.ready?shared.reason:ready?'Each attempt reserves the configured conservative ceiling; failed, cancelled and uncertain runs retain it.':'The shared sandbox authorization is exhausted. New runs, retries and restarts do not replenish it.',maxCostPerRunUsd:config.maxCostPerRunUsd,pricingBasis:config.pricingBasis,remainingRuns,remainingUsd:Math.min(remainingUsd,shared?.remainingUsd??remainingUsd)};
  }
  fingerprint():string { return `${this.configured()?.signature??'unconfigured'}:${this.options.combinedBudget?.fingerprint()??'no-combined-grant'}`; }
  reserve(runId:string,projectId:string):number {
    return this.store.atomic(()=>{
      const config=this.configured(), status=this.status();
      if(!config)throw new StoreError(status.reason,409);
      const key=this.key(config.authorizationId), saved=this.store.record<Grant>('sandbox-grant',key);
      if(saved?.signature===config.signature&&saved.runIds.includes(runId))return config.maxCostPerRunUsd;
      if(!status.ready)throw new StoreError(status.reason,409);
      this.options.combinedBudget?.reserve({kind:'sandbox',attemptId:runId,projectId,amountUsd:config.maxCostPerRunUsd,basis:config.pricingBasis});
      this.store.saveRecord('sandbox-grant',key,projectId,{...config,runIds:[...(saved?.runIds??[]),runId]});
      this.store.saveRecord('sandbox-admission',runId,projectId,{runId,authorization: key,reservedUsd:config.maxCostPerRunUsd,pricingBasis:config.pricingBasis,at:new Date().toISOString(),basis:'Conservative admission ceiling, not a reported charge. Retained for every outcome.'});
      return config.maxCostPerRunUsd;
    });
  }
}
