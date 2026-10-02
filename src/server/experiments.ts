import { executionNodeContext } from '../shared/groups.js';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import type { Express } from 'express';
import { z } from 'zod';
import { Store, StoreError } from './store.js';
import { Authority } from './authority.js';
import { DockerPythonBackend, type ExecutionBackend, type RemoteExecutionState } from './sandbox.js';
import { NebiusSandboxBackend } from './nebius-sandbox.js';
import { SandboxBudget } from './sandbox-budget.js';
import type { Artifact, CodeDocument, Run } from '../shared/types.js';
import type { AutoResearch, ExperimentApproval, ExperimentCapabilities, ExperimentParameters, ExperimentPreview } from '../shared/experiments.js';

const now = () => new Date().toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const SAMPLE = 'value,group\n10,A\n20,A\n30,B\n40,B\n';
const EXAMPLE = 'values = column("value")\ntable("Summary", describe(values))\nmetric("Mean", mean(values))\nplot("Values", values)';
const POLICY = 'bounded-python-v1';
const MAX_QUEUE = 20;
const environment = { PATH: '/usr/bin:/bin', LC_ALL: 'C.UTF-8' };
const workerPath = fileURLToPath(new URL('./experiment_worker.py', import.meta.url));
const paramsSchema = z.record(z.string().max(100), z.union([z.string().max(1000), z.number().finite().min(-1e100).max(1e100), z.boolean()]));
const previewSchema = z.object({ nodeId: z.string().min(1).max(128), request: z.string().trim().min(1).max(12000), csv: z.string().max(500000).optional(), datasetArtifactId: z.string().max(128).optional(), code: z.string().min(1).max(100000).refine(value=>!!value.trim()&&Buffer.byteLength(value)<=100000,'Code must be nonempty and at most 100 KB.').optional(), parameters: paramsSchema.default({}), retryOf: z.string().max(128).optional(), planRunId: z.string().max(128).optional(), backend:z.enum(['bounded','docker-python','nebius-sandbox']).default('bounded'), researchSessionId:z.string().max(128).optional(), manualCode:z.boolean().optional() }).strict();
type PreviewRequest = z.input<typeof previewSchema>;
type LocalConfiguration = {
  kind: 'local-experiment'; policy: string; approval: ExperimentApproval; code: string; csv: string;
  datasetHash: string|null; codeHash: string; parameters: ExperimentParameters; planner: string;
  sourceDatasetArtifactId?: string; capabilities: ExperimentCapabilities; autoResearch?: AutoResearch;
  originPlan?: { runId: string; codeChanged: boolean; parametersChanged: boolean; datasetChanged: boolean };
  backend?:'bounded'|'docker-python'|'nebius-sandbox'; researchSessionId?:string;
  remote?:RemoteExecutionState; sandboxGrantFingerprint?:string;
  manualCode?:boolean; language?:string; codeSource?:CodeDocument; inputMode?:'none'|'single-csv';
};
type WorkerOutput = { outputs: { kind: 'table' | 'metric' | 'plot'; title: string; data: unknown }[]; dataset: { columns: string[]; rowCount: number }; runtime: string; stdout: string };
type Active = { process?: ChildProcess; cancel?:()=>void; done: Promise<void>; stop?: 'cancelled' | 'interrupted'; reason?: string };

/** Local authority is independent of model generation and provider spend admission.
 * The interpreter exposes a closed numerical API, never eval/exec or shell access.
 */
export class ExperimentService {
  private readonly python: string;
  private readonly capabilitiesValue: ExperimentCapabilities;
  private active = new Map<string, Active>();
  private queue: string[] = [];
  private closed = false;
  readonly authority:Authority;
  private readonly sandbox:ExecutionBackend;
  private readonly nebiusSandbox:ExecutionBackend & {reconcile?:(operationId:string,onProgress?:(state:RemoteExecutionState)=>void)=>Promise<RemoteExecutionState>};
  private readonly sandboxBudget:SandboxBudget;
  private readonly recovery:Promise<unknown>[]=[];

  constructor(private readonly store: Store, options: { python?: string; timeoutMs?: number; sandbox?:ExecutionBackend; nebiusSandbox?:ExecutionBackend & {reconcile?:(operationId:string,onProgress?:(state:RemoteExecutionState)=>void)=>Promise<RemoteExecutionState>}; sandboxBudget?:SandboxBudget } = {}) {
    this.authority=new Authority(store);
    this.sandbox=options.sandbox??new DockerPythonBackend();
    this.nebiusSandbox=options.nebiusSandbox??new NebiusSandboxBackend();
    this.sandboxBudget=options.sandboxBudget??new SandboxBudget(store);
    this.python = options.python ?? '/usr/bin/python3';
    const probe = spawnSync(this.python, ['-I', '-S', '-c', 'import sys; print(sys.version.split()[0])'], { encoding: 'utf8', timeout: 3000, env: environment, maxBuffer: 10000 });
    this.capabilitiesValue = {
      available: probe.status === 0, permissionMode: 'ask', executionTarget: 'Local Python numerical interpreter', runtime: probe.status === 0 ? `Python ${probe.stdout.trim()}` : null, workerHash: hash(readFileSync(workerPath, 'utf8')),
      approveForMe: { available: true, reason: 'Independent deterministic reviewer checks scoped nodes, exact datasets, imports/I/O and shared limits; unfamiliar actions escalate.' }, fullAccess: true,
      sandbox:this.sandbox.capabilities(),
      nebiusSandbox:this.nebiusSandbox.capabilities(),
      enforcement: ['Python AST allowlist; no imports, attributes, loops, filesystem, network, shell, or package installation API.', 'Child receives only explicit CSV/code/parameters, with an allowlisted environment excluding provider credentials.', '10,000 rows, 40 columns, 2,000 syntax nodes, 20 outputs; stdout/stderr caps and process timeout; at most two active workers.', 'CPU limit is requested through Python resource; application timeout always kills the child.'],
      limitations: ['Application capability controls are not an OS sandbox. Python/interpreter vulnerabilities are outside this boundary.', 'No general Python, third-party packages, arbitrary local files, or guaranteed memory isolation on macOS.', 'Closing the browser leaves the local server working. Server/laptop shutdown interrupts work; there is no remote worker or automatic restart/retry.'],
      maxConcurrency: 2, timeoutMs: Math.max(100, Math.min(options.timeoutMs ?? 10000, 30000)), sampleCsv: SAMPLE, exampleCode: EXAMPLE,
    };
    this.recoverRemoteRuns();
  }

  capabilities(): ExperimentCapabilities { return structuredClone({...this.capabilitiesValue,nebiusSandbox:{...this.nebiusSandbox.capabilities(),costGate:this.sandboxBudget.status()}}); }
  private backend(config:LocalConfiguration){return config.backend==='nebius-sandbox'?this.nebiusSandbox:this.sandbox;}
  private isSandbox(config:LocalConfiguration){return config.backend==='docker-python'||config.backend==='nebius-sandbox';}
  private remoteProgress(runId:string,state:RemoteExecutionState){
    const current=this.store.getRun(runId), config=this.config(current);
    // Finished attempts remain immutable. Recovery is a separate audit record.
    if(!['queued','running'].includes(current.status)){
      const prior=this.store.record<{state:RemoteExecutionState;events:{at:string;state:RemoteExecutionState}[]}>('remote-recovery',runId);
      this.store.saveRecord('remote-recovery',runId,current.projectId,{state,events:[...(prior?.events??[]),{at:now(),state}]});return;
    }
    this.store.updateRun(runId,{configuration:{...config,remote:state},events:[...current.events,{at:now(),type:`remote-${state.phase}`,message:state.phase==='uncertain'?'Remote outcome is uncertain. This attempt will not be resubmitted automatically.':`Nebius sandbox ${state.phase}${state.status?`: ${state.status}`:''}.`,data:state}]});
  }
  private recoverRemoteRuns(){
    for(const project of this.store.listProjects())for(const run of this.store.listRuns(project.id)){
      if(run.configuration.kind!=='local-experiment'||run.configuration.backend!=='nebius-sandbox')continue;
      const state=this.store.record<{state:RemoteExecutionState}>('remote-recovery',run.id)?.state??this.config(run).remote;
      if(!state||state.phase==='terminal')continue;
      if(state.operationId&&this.nebiusSandbox.reconcile&&this.nebiusSandbox.capabilities().available){
        this.recovery.push(this.nebiusSandbox.reconcile(state.operationId,next=>this.remoteProgress(run.id,next)).then(next=>this.remoteProgress(run.id,next)).catch(()=>this.remoteProgress(run.id,{...state,phase:'uncertain',error:'Unable to reconcile the remote operation after restart; no new execution was submitted.'})));
      }else this.remoteProgress(run.id,{...state,phase:'uncertain',error:state.operationId?'Remote credentials unavailable; termination could not be confirmed.':'Submission identity is unknown; no automatic retry. The requested provider execution timeout still applies.'});
    }
  }
  owns(runId: string): boolean { return this.store.getRun(runId).configuration.kind === 'local-experiment'; }
  private config(run: Run): LocalConfiguration {
    if (run.configuration.kind !== 'local-experiment') throw new StoreError('This is not a local experiment run.');
    return run.configuration as LocalConfiguration;
  }
  inspect(runId: string): ExperimentPreview {
    const run = this.store.getRun(runId), config = this.config(run);
    return { run, approval: config.approval, code: config.code, csv: config.csv, parameters: config.parameters, planner: config.planner, ...(config.manualCode?{manualCode:true,inputMode:config.inputMode,codeSource:config.codeSource}:{}), remoteRecovery:this.store.record<{state:RemoteExecutionState}>('remote-recovery',run.id)?.state };
  }
  private saveConfig(runId: string, config: LocalConfiguration): Run { return this.store.updateRun(runId, { configuration: config }); }
  private event(runId: string, type: string, message: string, data?: unknown) {
    const run = this.store.getRun(runId);
    if (!['queued', 'running'].includes(run.status)) return;
    this.store.updateRun(runId, { events: [...run.events, { at: now(), type, message, ...(data === undefined ? {} : { data }) }] });
  }
  private selected(projectId: string, nodeId: string) {
    return this.store.detail(projectId).inputs.filter(input => input.nodeId === nodeId).map(input => ({ ...input, artifact: this.store.getArtifact(input.artifactId) }));
  }
  private stateSignature(run: Run): string {
    // Canvas placement and width are presentation only. Compare every other captured field
    // without changing the saved node snapshot or its original approval token.
    const node=executionNodeContext(run.node);
    return hash(JSON.stringify({ node, inputs: run.inputs.map(input => ({ id: input.id, artifactId: input.artifactId, hash: input.artifact.hash, excerpt: input.excerpt })) }));
  }
  private assertCurrent(run: Run) {
    const config=this.config(run);
    const captured=config.backend==='nebius-sandbox'?config.capabilities.nebiusSandbox:config.capabilities.sandbox;
    if (this.isSandbox(config) ? captured?.workerHash!==this.backend(config).capabilities().workerHash||captured?.imageId!==this.backend(config).capabilities().imageId||captured?.timeoutMs!==this.backend(config).capabilities().timeoutMs : config.capabilities.workerHash !== hash(readFileSync(workerPath, 'utf8'))) throw new StoreError('The execution runtime changed. Preview a new action before approving execution.', 409);
    if(config.backend==='nebius-sandbox'&&config.sandboxGrantFingerprint!==this.sandboxBudget.fingerprint())throw new StoreError('The remote pricing or authorization changed. Preview a new action before approving execution.',409);
    const node = this.store.getProject(run.projectId).canvas.nodes.find(item => item.id === run.nodeId);
    // Code's saved single-input choice is explicit and independent of the other
    // versions available in this block's input pool. They are not runtime inputs.
    const inputs = config.manualCode ? run.inputs : this.selected(run.projectId, run.nodeId);
    if (!node || this.stateSignature(run) !== this.stateSignature({ ...run, node, inputs })) {
      throw new StoreError('This approval is stale: the node or selected input versions changed. Preview a new attempt.', 409);
    }
  }
  preview(projectId: string, supplied: PreviewRequest): ExperimentPreview {
    if (this.closed) throw new StoreError('The local runner is shutting down.', 503);
    const request = previewSchema.parse(supplied);
    const project = this.store.getProject(projectId);
    const node = project.canvas.nodes.find(item => item.id === request.nodeId);
    if (!node) throw new StoreError('Node not found in this project.', 404);
    if(node.blockType==='code')request.manualCode=true;
    if(request.manualCode){
      if(node.blockType!=='code'||!node.code)throw new StoreError('Save this Code block before running it.');
      if(node.code.language.toLowerCase()!=='python')throw new StoreError(`Execution for ${node.code.language} is not implemented. Python uses the isolated Docker runtime.`);
      if(supplied.backend===undefined)request.backend='docker-python';
      if(request.backend!=='docker-python'||request.planRunId||request.researchSessionId)throw new StoreError('Manual Code blocks use isolated Docker Python, without a model planner or another runtime.');
      if(request.code!==undefined&&request.code!==node.code.source)throw new StoreError('The program differs from the saved Code block. Save it before running.',409);
      if(supplied.parameters!==undefined&&JSON.stringify(request.parameters)!==JSON.stringify(node.code.parameters))throw new StoreError('The parameters differ from the saved Code block. Save them before running.',409);
      const inputId=node.code.inputArtifactId??undefined;
      if(request.datasetArtifactId!==undefined&&request.datasetArtifactId!==inputId)throw new StoreError('The chosen input differs from the saved Code block. Save the input selection before running.',409);
      if(request.csv!==undefined&&request.csv!=='')throw new StoreError('Code blocks run zero or one exact saved CSV version. Capture the supplied CSV and select it first.');
      request.code=node.code.source;request.parameters=paramsSchema.parse(node.code.parameters);request.datasetArtifactId=inputId;request.csv=undefined;
      if(!request.code.trim()||Buffer.byteLength(request.code)>100000)throw new StoreError('Code must be nonempty and at most 100 KB.');
    }else if(request.csv!==undefined&&!request.csv.trim())throw new StoreError('A supplied CSV must be nonempty.');
    // A revision belongs to the same observable experiment lineage. The client
    // need not mint or copy a session identity, and a retry is never a new grant.
    let previousConfig:LocalConfiguration|undefined;
    if(request.retryOf){
      const previous=this.store.getRun(request.retryOf);
      if(previous.projectId!==projectId||previous.nodeId!==node.id)throw new StoreError('Choose a prior experiment from this same Action.');
      previousConfig=this.config(previous);
      if(request.researchSessionId&&request.researchSessionId!==previousConfig.researchSessionId)throw new StoreError('A revision cannot change its research session.');
      request.researchSessionId??=previousConfig.researchSessionId;
      request.planRunId??=previousConfig.originPlan?.runId;
      if(!request.manualCode&&request.csv===undefined&&request.datasetArtifactId===undefined)request.datasetArtifactId=previousConfig.sourceDatasetArtifactId;
    }
    if(request.manualCode&&(request.planRunId||request.researchSessionId))throw new StoreError('Manual Code retries cannot inherit a model-planning or research-session action. Run the saved program as a new Code attempt.');
    if(request.backend==='nebius-sandbox'&&request.researchSessionId)throw new StoreError('The research collaborator currently uses local Docker. Start a separate Action to approve remote execution.');
    let inputs = request.manualCode ? [] as Run['inputs'] : this.selected(projectId, node.id);
    let planRun: Run | undefined;
    let plan: { explanation: string; code: string; parameters: ExperimentParameters } | undefined;
    if (request.planRunId) {
      planRun = this.store.getRun(request.planRunId);
      if (planRun.projectId !== projectId || planRun.nodeId !== node.id || planRun.status !== 'completed' || !['experiment-plan','research-step'].includes(String(planRun.configuration.purpose))) throw new StoreError('Choose a completed experiment plan from this same node.');
      let raw=planRun.configuration.experimentPlan;
      if(planRun.configuration.purpose==='research-step'){const step=JSON.parse(String(planRun.configuration.researchResponse));if(step.type!=='experiment')throw new StoreError('Research step does not propose an experiment.');raw={explanation:step.summary,code:step.code,parameters:step.parameters};}
      plan = z.object({ explanation: z.string(), code: z.string().min(1).max(20000), parameters: paramsSchema }).parse(raw);
      if (!request.datasetArtifactId && request.csv === undefined && typeof planRun.configuration.datasetArtifactId === 'string') request.datasetArtifactId = planRun.configuration.datasetArtifactId;
      request.code ??= plan.code;
      if (supplied.parameters === undefined) request.parameters = plan.parameters;
    }
    if (request.csv !== undefined && request.datasetArtifactId) throw new StoreError('Choose supplied CSV or one exact dataset artifact, not both.');
    let csv = request.csv;
    let sourceDatasetArtifactId = request.datasetArtifactId;
    if (!request.manualCode && !sourceDatasetArtifactId && csv === undefined) {
      const datasets = inputs.filter(input => input.artifact.kind === 'dataset');
      if (datasets.length > 1) throw new StoreError('Choose one dataset explicitly when several dataset versions are attached.');
      if (datasets.length === 1) { sourceDatasetArtifactId = datasets[0].artifactId; csv = datasets[0].excerpt; }
    }
    if (sourceDatasetArtifactId) {
      const artifact = this.store.getArtifact(sourceDatasetArtifactId);
      if (artifact.projectId !== projectId || (request.manualCode ? !['dataset','table'].includes(artifact.kind)||artifact.mediaType!=='text/csv' : artifact.kind !== 'dataset')) throw new StoreError(request.manualCode?'Choose a full CSV dataset or CSV table version in this project. JSON tables require an explicit CSV conversion.':'Choose a dataset version in this project.');
      csv ??= artifact.content;
      if(request.manualCode){
        const selected=this.selected(projectId,node.id).find(input=>input.artifactId===artifact.id&&input.excerpt===artifact.content);
        inputs=[selected??{id:randomUUID(),projectId,nodeId:node.id,artifactId:artifact.id,excerpt:artifact.content,createdAt:now(),artifact}];
      }
    }
    csv ??= request.manualCode ? '' : SAMPLE;
    if (csv.length > 500000 || Buffer.byteLength(csv)>500000) throw new StoreError('CSV is limited to 500 KB.');
    if(request.manualCode&&sourceDatasetArtifactId&&!csv.trim())throw new StoreError('The selected CSV version is empty. Choose a nonempty captured input or run without an input.');
    if(previousConfig?.researchSessionId&&hash(csv)!==previousConfig.datasetHash)throw new StoreError('A research-session revision must keep its captured dataset. Start a separate Action to analyze changed data.');
    if(previousConfig?.researchSessionId)sourceDatasetArtifactId??=previousConfig.sourceDatasetArtifactId;
    const column = firstNumericColumn(csv);
    const code = request.code ?? (request.backend==='nebius-sandbox'?`import statistics\nvalues = [float(row[${JSON.stringify(column)}]) for row in rows]\nmetric("Mean", statistics.mean(values))\ntable("Summary", [{"count": len(values), "mean": statistics.mean(values)}])\nplot("Values", values)`:`values = column(${JSON.stringify(column)})\ntable("Summary", describe(values))\nmetric("Mean", mean(values))\nplot("Values", values)`);
    const previous = this.store.listRuns(projectId).find(run => run.nodeId === node.id && ['queued', 'running'].includes(run.status));
    if (previous) {
      if (previous.configuration.kind === 'local-experiment' && this.config(previous).approval.status === 'pending') this.cancel(previous.id, 'Superseded by a new code/input preview.');
      else throw new StoreError('This node already has active work.', 409);
    }
    if (this.store.listProjects().flatMap(item => this.store.listRuns(item.id)).filter(run => run.configuration.kind === 'local-experiment' && ['queued', 'running'].includes(run.status)).length >= MAX_QUEUE) throw new StoreError('Local experiment queue is full.', 409);
    const runId = randomUUID(), timestamp = now();
    const fingerprint = hash(JSON.stringify({ policy: POLICY, backend:request.backend, code, csv:request.manualCode&&!sourceDatasetArtifactId?null:csv, parameters: request.parameters, node, inputs, request: request.request, capabilities: this.capabilities(),...(request.backend==='nebius-sandbox'?{grant:this.sandboxBudget.fingerprint()}:{}) }));
    const configuration: LocalConfiguration = { kind: 'local-experiment', policy: POLICY, approval: { fingerprint, status: 'pending', requestedAt: timestamp }, code, csv, datasetHash: request.manualCode&&!sourceDatasetArtifactId?null:hash(csv), codeHash: hash(code), parameters: request.parameters, planner: request.manualCode?'User-authored saved Code block. No model inference or hidden sample input.':planRun ? `Code originates from saved ${planRun.provider}/${planRun.model} plan ${planRun.id}. Local execution is a separate permission decision.` : request.code ? 'User-supplied or separately proposed code; no model inference in local preview.' : 'Built-in local descriptive-analysis recipe. This is not an AI-generated plan; review or edit it for your request.', ...(request.manualCode?{manualCode:true,language:node.code!.language,codeSource:structuredClone(node.code!),inputMode:sourceDatasetArtifactId?'single-csv' as const:'none' as const}:{}), ...(sourceDatasetArtifactId ? { sourceDatasetArtifactId } : {}), ...(planRun && plan ? { originPlan: { runId: planRun.id, codeChanged: code !== plan.code, parametersChanged: JSON.stringify(request.parameters) !== JSON.stringify(plan.parameters), datasetChanged: hash(csv) !== planRun.inputs.find(input => input.artifactId === planRun!.configuration.datasetArtifactId)?.artifact.hash } } : {}), capabilities: this.capabilities() };
    configuration.backend=request.backend;configuration.researchSessionId=request.researchSessionId;
    if(this.isSandbox(configuration))configuration.policy=this.backend(configuration).capabilities().policy;
    if(request.backend==='nebius-sandbox'){
      configuration.sandboxGrantFingerprint=this.sandboxBudget.fingerprint();
      configuration.planner=planRun?`Code originates from saved ${planRun.provider}/${planRun.model} plan ${planRun.id}. Sending it and the captured dataset to Nebius requires separate approval.`:request.code?'User-supplied or separately proposed code; no model inference in remote preview.':'Built-in descriptive-analysis recipe for remote Python. Review or edit it for your request.';
    }
    let run = this.store.createRun({ id: runId, projectId, nodeId: node.id, request: request.request, useSearch: false, status: 'queued', ...(request.retryOf ? { retryOf: request.retryOf } : {}), createdAt: timestamp, projectRevision: project.revision, node: structuredClone(node), inputs, messages: [], provider: request.backend==='nebius-sandbox'?'nebius-sandbox':'local', model: request.backend==='nebius-sandbox'?'python-3.12-stdlib':request.backend==='docker-python'?'isolated-python':'bounded-python-recipe-v1', modelVersion: null, configuration, tools: [{ name: request.backend==='nebius-sandbox'?'nebius_sandbox_python':request.backend==='docker-python'?'isolated_python':'python_numerical', codeHash: configuration.codeHash, datasetHash: configuration.datasetHash, parameters: request.parameters, permissionMode: request.backend==='nebius-sandbox'?'ask':this.authority.mode(projectId,node.id), policy: configuration.policy }], events: [{ at: timestamp, type: 'approval-requested', message: 'Waiting for approval of the exact code, CSV, parameters, selected inputs, and selected execution policy.', data: { fingerprint } }], artifactIds: [], cost: request.backend==='nebius-sandbox'?{estimatedUsd:null,basis:'Sandbox cost is not reported in a verified USD unit. A separate conservative allowance is required before execution.'}:{ estimatedUsd: 0, basis: 'Local execution only; no provider request or cloud charge.' } });
    const dataset = request.manualCode&&!sourceDatasetArtifactId?undefined:this.artifact(run, 'dataset', 'Dataset — captured CSV', csv, 'text/csv', { executionRole:'input', origin: sourceDatasetArtifactId ? 'selected-artifact-version' : request.csv === undefined ? 'built-in-sample' : 'user-supplied', ...(sourceDatasetArtifactId ? { sourceArtifactId: sourceDatasetArtifactId } : {}) });
    const codeArtifact = this.artifact(run, 'code', request.backend==='nebius-sandbox'?'Program — Nebius sandbox Python':request.backend==='docker-python'?'Program — isolated Python':'Program — bounded Python', code, 'text/x-python',{executionRole:'program'});
    run = this.store.updateRun(runId, { artifactIds: [...(dataset?[dataset.id]:[]), codeArtifact.id] });
    if(request.backend==='nebius-sandbox')run=this.store.updateRun(runId,{events:[...run.events,{at:now(),type:'external-transfer-preview',message:'Exact approval sends the captured code, CSV and parameters to a disposable Nebius VM. Networking is disabled; provider retention of request data and logs is undocumented. Credentials remain on the local server.'}]});
    this.store.addMessage(projectId, node.id, 'user', request.request, runId);
    const review=this.authority.review(projectId,{kind:'experiment',nodeId:node.id,fingerprint,datasetId:sourceDatasetArtifactId,code,runtimeSeconds:this.timeout(configuration)/1000});
    this.event(runId,'permission-review',review.reason,review);
    if(request.backend==='nebius-sandbox')this.event(runId,'remote-approval-required','Remote execution always requires explicit approval of this exact external transfer, independently of the project automatic mode.');
    else if(review.outcome==='allow')this.decide(run.id,fingerprint,'allow',`Automatic ${review.mode}: ${review.reason}`);
    return this.inspect(run.id);
  }

  private artifact(run: Run, kind: Artifact['kind'], title: string, content: string, mediaType: string, metadata?: Record<string, unknown>) {
    const config=this.config(run);
    const provenance=config.manualCode?{origin:'code-block-execution',executionRole:kind==='log'?'log':metadata?.executionRole??'output',codeSource:config.codeSource,codeHash:config.codeHash,language:config.language,backend:config.backend,inputMode:config.inputMode,sourceDatasetArtifactId:config.sourceDatasetArtifactId??null,sourceDatasetHash:config.datasetHash}:{};
    return this.store.addArtifact({ projectId: run.projectId, nodeId: run.nodeId, runId: run.id, kind, title, content, mediaType, capture: kind === 'dataset' ? 'full-content' : 'generated', metadata:{...metadata,...provenance} });
  }
  private validateDecision(runId: string, fingerprint: string, checkCurrent = true) {
    const run = this.store.getRun(runId), config = this.config(run);
    if (run.status !== 'queued' || config.approval.status !== 'pending') throw new StoreError('This approval is no longer pending. Create a new preview for another attempt.', 409);
    if (config.approval.fingerprint !== fingerprint) throw new StoreError('Approval fingerprint does not match this exact action.', 409);
    if (checkCurrent) this.assertCurrent(run);
    return { run, config };
  }
  private timeout(config:LocalConfiguration){return this.isSandbox(config)?(config.backend==='nebius-sandbox'?config.capabilities.nebiusSandbox:config.capabilities.sandbox)?.timeoutMs??this.backend(config).capabilities().timeoutMs:config.capabilities.timeoutMs;}
  decide(runId: string, fingerprint: string, decision: 'allow' | 'deny' | 'cancel', reason?:string): Run {
    const { run, config } = this.validateDecision(runId, fingerprint, decision === 'allow');
    if (decision === 'allow' && !(this.isSandbox(config)?this.backend(config).capabilities().available:this.capabilitiesValue.available)) throw new StoreError('Python runtime unavailable. No permission was granted and no fallback will run.', 503);
    config.approval = { ...config.approval, status: decision === 'allow' ? 'allowed' : decision === 'deny' ? 'denied' : 'cancelled', decidedAt: now(), decisionReason: reason??`User ${decision}; exact action fingerprint ${fingerprint}` };
    this.store.atomic(()=>{
      if(decision==='allow'){
        const spendUsd=config.backend==='nebius-sandbox'?this.sandboxBudget.reserve(run.id,run.projectId):0;
        this.authority.reserve(run.projectId,{kind:'experiment',nodeId:run.nodeId,fingerprint:run.id,runtimeSeconds:this.timeout(config)/1000,spendUsd});
        if(config.backend==='nebius-sandbox')this.store.updateRun(run.id,{cost:{reservedUsd:spendUsd,estimatedUsd:null,basis:'Worst-case USD ceiling reserved from a separate sandbox grant, not a measured charge. Raw provider cost has undocumented units.'}});
      }
      this.saveConfig(runId, config);
      this.event(runId, `approval-${decision}`, decision === 'allow' ? 'User approved this exact action. Queued within the two-worker limit.' : 'Execution prevented by the permission decision.', { fingerprint });
    });
    if (decision !== 'allow') return this.store.updateRun(runId, { status: 'cancelled', endedAt: now(), error: decision === 'deny' ? 'Permission denied. No code executed.' : 'Approval cancelled. No code executed.' });
    this.queue.push(run.id);
    this.drain();
    return this.store.getRun(runId);
  }
  private drain() {
    if (this.closed) return;
    while (this.active.size < 2 && this.queue.length) {
      const index = this.queue.findIndex(id => {
        const group = this.config(this.store.getRun(id)).autoResearch;
        return !group || [...this.active.keys()].filter(activeId => this.config(this.store.getRun(activeId)).autoResearch?.id === group.id).length < group.maxConcurrency;
      });
      if (index < 0) return;
      const [runId] = this.queue.splice(index, 1);
      if (this.store.getRun(runId).status !== 'queued') continue;
      this.execute(runId);
    }
  }
  private execute(runId: string) {
    const run = this.store.getRun(runId), config = this.config(run);
    try { this.assertCurrent(run); }
    catch (error) { this.store.updateRun(runId, { status: 'failed', endedAt: now(), error: error instanceof Error ? error.message : 'Stale action.' }); return; }
    if(this.authority.policy(run.projectId).stopped){this.store.updateRun(runId,{status:'cancelled',endedAt:now(),error:'Project research stopped before execution.'});return;}
    if(this.isSandbox(config)){this.executeSandbox(run,config);return;}
    this.store.updateRun(runId, { status: 'running', startedAt: now() });
    this.event(runId, 'process-start', 'Executing the approved numerical program in a local Python child.', { python: this.python, arguments: ['-I', '-S', 'experiment_worker.py'], policy: POLICY });
    const child = spawn(this.python, ['-I', '-S', workerPath], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', termination: string | undefined;
    const terminate = (reason: string) => { termination ??= reason; child.kill('SIGKILL'); };
    child.stdout!.on('data', (buffer: Buffer) => { stdout += buffer.toString(); if (stdout.length > 1000000) { stdout = stdout.slice(0, 1000000); terminate('Worker exceeded its 1 MB output limit.'); } });
    child.stderr!.on('data', (buffer: Buffer) => { stderr += buffer.toString(); if (stderr.length > 20000) { stderr = stderr.slice(0, 20000); terminate('Worker exceeded its stderr limit.'); } });
    child.stdin!.on('error', () => { /* A killed child may close stdin before input is written. */ });
    const timer = setTimeout(() => terminate('Local experiment timed out and its child was killed.'), this.capabilitiesValue.timeoutMs);
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    this.active.set(runId, { process: child, done });
    child.on('error', error => { termination = `Python could not start: ${error.message.slice(0, 200)}`; });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      try {
        const current = this.store.getRun(runId);
        if (!['queued', 'running'].includes(current.status)) return;
        const record = { stdout: stdout.slice(0, 1000000), stderr: stderr.slice(0, 20000), exitCode, signal, runtime: this.capabilitiesValue.runtime, policy: POLICY, codeHash: config.codeHash, datasetHash: config.datasetHash, parameters: config.parameters, startedAt: current.startedAt, endedAt: now() };
        const log = this.artifact(current, 'log', 'Execution log and runtime', JSON.stringify(record, null, 2), 'application/json');
        this.store.updateRun(runId, { artifactIds: [...current.artifactIds, log.id] });
        const stopping = this.active.get(runId);
        if (stopping?.stop) {
          this.event(runId, 'process-stopped', 'Local child exited after the stop request.', { exitCode, signal });
          this.store.updateRun(runId, { status: stopping.stop, endedAt: now(), error: stopping.reason });
          return;
        }
        if (termination || exitCode !== 0) throw new Error(termination ?? `Python exited ${exitCode}: ${stderr.slice(0, 500) || signal || 'unknown error'}`);
        const result = JSON.parse(stdout) as WorkerOutput;
        for (const output of result.outputs) {
          let artifact: Artifact;
          if (output.kind === 'plot') artifact = this.artifact(current, 'plot', output.title, svgPlot(output.title, output.data as { values: number[]; labels?: unknown[] }), 'image/svg+xml', { data: output.data });
          else artifact = this.artifact(current, output.kind, output.title, JSON.stringify(output.kind === 'metric' ? { value: output.data } : output.data, null, 2), 'application/json');
          const latest = this.store.getRun(runId);
          this.store.updateRun(runId, { artifactIds: [...latest.artifactIds, artifact.id] });
          this.event(runId, 'artifact', `Captured ${output.kind}: ${output.title}`, { artifactId: artifact.id, hash: artifact.hash });
        }
        this.event(runId, 'process-complete', result.stdout, { exitCode, dataset: result.dataset, pythonVersion: result.runtime });
        this.store.addMessage(current.projectId, current.nodeId, 'assistant', `Local numerical experiment completed: ${result.dataset.rowCount} rows; ${result.outputs.length} outputs. The code, CSV, parameters, logs, and exact artifact versions are saved. No model interpretation was requested.`, runId);
        this.store.updateRun(runId, { status: 'completed', endedAt: now() });
      } catch (error) {
        const current = this.store.getRun(runId);
        if (['queued', 'running'].includes(current.status)) {
          const message = error instanceof Error ? error.message.slice(0, 700) : 'Local worker failed.';
          this.event(runId, 'error', message);
          this.store.updateRun(runId, { status: 'failed', endedAt: now(), error: message });
        }
      } finally { this.active.delete(runId); resolveDone(); this.drain(); }
    });
    child.stdin!.end(JSON.stringify({ csv: config.csv, code: config.code, parameters: config.parameters }));
  }
  private executeSandbox(run:Run,config:LocalConfiguration){
    this.store.updateRun(run.id,{status:'running',startedAt:now()});
    const backend=this.backend(config);
    this.event(run.id,'process-start',config.backend==='nebius-sandbox'?'Submitting the approved Python and captured inputs to a disposable Nebius sandbox.':'Executing model/user Python in the isolated local research container.',{backend:backend.capabilities()});
    try {
      const handle=backend.start({code:config.code,...(config.manualCode&&config.inputMode==='none'?{}:{csv:config.csv}),parameters:config.parameters,timeoutMs:this.timeout(config),...(config.backend==='nebius-sandbox'?{onProgress:(state:RemoteExecutionState)=>this.remoteProgress(run.id,state)}:{})});
      const active:Active={done:Promise.resolve(),cancel:()=>handle.cancel('User stopped this experiment.')};
      this.active.set(run.id,active);
      active.done=handle.done.then(result=>{
        if(result.remote)this.remoteProgress(run.id,result.remote);
        const current=this.store.getRun(run.id);
        const log=this.artifact(current,'log','Execution log and runtime',JSON.stringify({...result,outputs:result.outputs.map(o=>({kind:o.kind,title:o.title,mediaType:o.mediaType})),codeHash:config.codeHash,datasetHash:config.datasetHash,parameters:config.parameters},null,2),'application/json');
        const ids=[...current.artifactIds,log.id];
        for(const output of result.outputs){const artifact=this.artifact(current,output.kind,output.title,output.content,output.mediaType,{...output.metadata,executionRole:'output'});ids.push(artifact.id);this.event(run.id,'artifact',`Captured ${output.kind}: ${output.title}`,{artifactId:artifact.id,hash:artifact.hash});}
        const status=result.remote?.phase==='uncertain'?'interrupted':active.stop??result.status;
        this.store.addMessage(run.projectId,run.nodeId,status==='completed'?'assistant':'system',status==='completed'?`Isolated Python completed with ${result.outputs.length} saved outputs. Inputs, code, runtime and logs are preserved.`:result.error??active.reason??'Experiment stopped.',run.id);
        this.store.updateRun(run.id,{artifactIds:ids,status,endedAt:now(),error:result.remote?.phase==='uncertain'?result.error??'Remote termination is unconfirmed; no automatic retry.':active.reason??result.error});
      }).catch(error=>{const current=this.store.getRun(run.id);if(['queued','running'].includes(current.status))this.store.updateRun(run.id,{status:'failed',endedAt:now(),error:String(error).slice(0,1000)});}).finally(()=>{this.active.delete(run.id);this.drain();});
    } catch(error){this.store.updateRun(run.id,{status:'failed',endedAt:now(),error:String(error).slice(0,1000)});}
  }
  cancel(runId: string, reason = 'User stopped this experiment only.'): Run {
    const run = this.store.getRun(runId), config = this.config(run);
    if (!['queued', 'running'].includes(run.status)) return run;
    this.queue = this.queue.filter(id => id !== runId);
    const active = this.active.get(runId);
    if (active) {
      active.stop = 'cancelled'; active.reason = reason;
      active.cancel?.();active.process?.kill('SIGKILL');
    }
    if (config.approval.status === 'pending') this.saveConfig(runId, { ...config, approval: { ...config.approval, status: 'cancelled', decidedAt: now(), decisionReason: reason } });
    this.event(runId, 'cancelled', reason, { processKillRequested: Boolean(active) });
    if (active) return this.store.getRun(runId);
    return this.store.updateRun(runId, { status: 'cancelled', endedAt: now(), error: 'Stopped before execution.' });
  }
  retry(runId: string): ExperimentPreview {
    const run = this.store.getRun(runId), config = this.config(run);
    if (['queued', 'running'].includes(run.status)) throw new StoreError('Stop active work before creating another attempt.', 409);
    return this.preview(run.projectId, { nodeId: run.nodeId, request: run.request, ...(config.sourceDatasetArtifactId?{datasetArtifactId:config.sourceDatasetArtifactId}:config.manualCode?{}:{csv:config.csv}), code: config.code, parameters: config.parameters, retryOf: runId, backend:config.backend??'bounded', ...(config.manualCode?{manualCode:true}:{}), ...(config.originPlan ? { planRunId: config.originPlan.runId } : {}) });
  }
  startAuto(projectId: string, supplied: unknown): AutoResearch {
    const body = z.object({ scope: z.string().trim().min(1).max(1000), outcome: z.string().trim().min(1).max(1000), runIds: z.array(z.string()).min(1).max(4), fingerprints: z.record(z.string(), z.string()), maxConcurrency: z.number().int().min(1).max(2).default(2) }).strict().parse(supplied);
    if (new Set(body.runIds).size !== body.runIds.length) throw new StoreError('Auto Research needs distinct run IDs.');
    if (!this.capabilitiesValue.available) throw new StoreError('Python runtime unavailable; Auto Research was not authorized.', 503);
    const captured = body.runIds.map(id => {
      const value = this.validateDecision(id, body.fingerprints[id]);
      if (value.run.projectId !== projectId) throw new StoreError('Auto Research cannot include another project.');
      if(value.config.backend==='nebius-sandbox')throw new StoreError('Remote execution requires individual approval; it is not part of local Auto Research.');
      if(!(value.config.backend==='docker-python'?this.sandbox.capabilities().available:this.capabilitiesValue.available))throw new StoreError('Selected experiment runtime unavailable; no group was admitted.',503);
      return value;
    });
    const group: AutoResearch = { id: randomUUID(), scope: body.scope, outcome: body.outcome, runIds: body.runIds, createdAt: now(), maxConcurrency: body.maxConcurrency, status: 'running' };
    this.store.atomic(()=>{for (const { run, config } of captured) {
      this.authority.reserve(projectId,{kind:'experiment',nodeId:run.nodeId,fingerprint:run.id,runtimeSeconds:this.timeout(config)/1000});
      this.saveConfig(run.id, { ...config, autoResearch: group, approval: { ...config.approval, status: 'allowed', decidedAt: now(), decisionReason: `Explicit bounded Auto Research ${group.id}: this exact run, local numerical API only, no external spend, no new nodes or retries.` } });
      this.event(run.id, 'auto-research-authorized', 'Accepted exact local experiment under bounded Auto Research.', { group, resources: { maxRuns: group.runIds.length, timeoutMsPerRun: this.capabilitiesValue.timeoutMs, externalSpendUsd: 0, newStructuralChanges: false, automaticRetries: false } });
    }});
    this.queue.push(...group.runIds);
    this.drain();
    return group;
  }
  listAuto(projectId: string): AutoResearch[] {
    const runs = this.store.listRuns(projectId);
    const groups = new Map<string, AutoResearch>();
    for (const run of runs) if (run.configuration.kind === 'local-experiment') {
      const group = this.config(run).autoResearch;
      if (group) groups.set(group.id, { ...group });
    }
    return [...groups.values()].map(group => ({ ...group, status: group.runIds.some(id => ['queued', 'running'].includes(this.store.getRun(id).status)) ? 'running' : group.runIds.every(id => this.store.getRun(id).status === 'completed') ? 'completed' : 'stopped' }));
  }
  cancelAuto(projectId: string, groupId: string): AutoResearch {
    const group = this.listAuto(projectId).find(item => item.id === groupId);
    if (!group) throw new StoreError('Auto Research scope not found.', 404);
    for (const id of group.runIds) this.cancel(id, 'User stopped this Auto Research scope.');
    return this.listAuto(projectId).find(item => item.id === groupId)!;
  }
  async shutdown() {
    this.closed = true;
    const active = [...this.active.values()];
    for (const project of this.store.listProjects()) for (const run of this.store.listRuns(project.id)) {
      if (run.configuration.kind !== 'local-experiment' || !['queued', 'running'].includes(run.status)) continue;
      const worker = this.active.get(run.id);
      if (worker) { worker.stop = 'interrupted'; worker.reason = 'Local service stopped; explicitly preview a new attempt to retry.'; worker.cancel?.();worker.process?.kill('SIGKILL'); }
      const config = this.config(run);
      if (config.approval.status === 'pending') this.saveConfig(run.id, { ...config, approval: { ...config.approval, status: 'cancelled', decidedAt: now(), decisionReason: 'Local service stopped; preview again to obtain a new grant.' } });
      this.event(run.id, 'interrupted', 'Local service stopped. No automatic restart or permission reuse; create a new preview to retry.');
      if (!worker) this.store.updateRun(run.id, { status: 'interrupted', endedAt: now() });
    }
    this.queue = [];
    await Promise.allSettled([...active.map(item => item.done),...this.recovery]);
  }
}

function firstNumericColumn(csv: string): string {
  // This starter choice is only a convenience; Python performs complete CSV validation.
  const records: string[][] = [[]];
  let value = '', quoted = false;
  for (let index = 0; index < csv.length && records.length <= 20; index++) {
    const ch = csv[index];
    if (ch === '"') { if (quoted && csv[index + 1] === '"') { value += '"'; index++; } else quoted = !quoted; }
    else if (!quoted && (ch === ',' || ch === '\n')) { records.at(-1)!.push(value.replace(/\r$/, '')); value = ''; if (ch === '\n') records.push([]); }
    else value += ch;
  }
  if (value) records.at(-1)!.push(value);
  const headers = records[0];
  const index = headers.findIndex((_, i) => records.slice(1).filter(row => row.length).every(row => row[i]?.trim() && Number.isFinite(Number(row[i]))));
  return headers[index < 0 ? 0 : index] ?? 'value';
}

function svgPlot(title: string, data: { values: number[]; labels?: unknown[] }): string {
  const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]!));
  const values = data.values, low = Math.min(...values), high = Math.max(...values), span = high - low || 1;
  const points = values.map((value, i) => `${(55 + 525 * i / Math.max(1, values.length - 1)).toFixed(2)},${(235 - 175 * (value - low) / span).toFixed(2)}`).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="290" viewBox="0 0 640 290" role="img" aria-label="${escape(title)}"><rect width="640" height="290" fill="white"/><text x="28" y="30" font-family="sans-serif" font-size="18" fill="#111">${escape(title)}</text><path d="M55 50V235H590" fill="none" stroke="#444"/><polyline points="${points}" fill="none" stroke="#23734b" stroke-width="3"/><text x="8" y="62" font-family="sans-serif" font-size="12">${escape(String(high))}</text><text x="8" y="235" font-family="sans-serif" font-size="12">${escape(String(low))}</text><text x="55" y="265" font-family="sans-serif" font-size="12">Row 1</text><text x="520" y="265" font-family="sans-serif" font-size="12">Row ${values.length}</text></svg>`;
}

export function attachExperimentRoutes(app: Express, service: ExperimentService) {
  app.get('/api/experiments/capabilities', (_req, res) => res.json(service.capabilities()));
  app.post('/api/projects/:id/experiments/preview', (req, res) => res.status(201).json(service.preview(String(req.params.id), req.body)));
  app.get('/api/experiments/:id', (req, res) => res.json(service.inspect(String(req.params.id))));
  app.post('/api/experiments/:id/decision', (req, res) => {
    const body = z.object({ fingerprint: z.string().length(64), decision: z.enum(['allow', 'deny', 'cancel']) }).strict().parse(req.body);
    res.json(service.decide(String(req.params.id), body.fingerprint, body.decision));
  });
  app.post('/api/experiments/:id/cancel', (req, res) => res.json(service.cancel(String(req.params.id))));
  app.post('/api/experiments/:id/retry', (req, res) => res.status(201).json(service.retry(String(req.params.id))));
  app.get('/api/projects/:id/auto-research', (req, res) => res.json(service.listAuto(String(req.params.id))));
  app.post('/api/projects/:id/auto-research', (req, res) => res.status(201).json(service.startAuto(String(req.params.id), req.body)));
  app.post('/api/auto-research/:id/cancel', (req, res) => {
    const { projectId } = z.object({ projectId: z.string().min(1) }).strict().parse(req.body);
    res.json(service.cancelAuto(projectId, String(req.params.id)));
  });
}
