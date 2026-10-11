import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { Artifact, CanvasNode, Mutation, Run } from '../shared/types.js';
import type { TutorialCatalog, TutorialExecution, TutorialScenarioId, TutorialSession } from '../shared/tutorial.js';
import type { ExperimentService } from './experiments.js';
import { Highlights } from './connections.js';
import { Store, StoreError } from './store.js';
import type { ProjectFolders } from './project-folders.js';
import { WORKFLOW_STEPS, WorkflowTutorial, type WorkflowSession } from './demo-workflow.js';
import { loadTutorialContent, localMarketDataAvailable } from './tutorial-content.js';
import { CARD_DEFAULT_WIDTH, CARD_MAX_HEIGHT } from '../shared/card-size.js';
import { LAYOUT_GAP } from '../shared/layout.js';

type LessonSession = {
  projectId:string; scenario:Exclude<TutorialScenarioId,'workflow'>; step:number; createdAt:string;
  stageNodeIds:string[]; questionArtifactId:string; sourceArtifactIds:string[];
  datasetArtifactId?:string; analysisNodeId?:string; outputArtifactIds:string[];
  runId?:string; draftNodeId?:string; draftArtifactId?:string;
};
type SavedSession = LessonSession | WorkflowSession;
export type ImportArtifact = Pick<Artifact,'kind'|'title'|'content'> & Partial<Pick<Artifact,'url'|'mediaType'|'metadata'|'capture'|'sourceId'>>;
const lessonSchema = z.enum(['banking','market']);
const identifier = z.string().min(1).max(128);
const now = () => new Date().toISOString();
const isOutput = (artifact:Artifact) => ['plot','table','metric','result'].includes(artifact.kind);

/** A visitor advances a prepared lesson explicitly. Saved evidence imports are
 * not research executions; the optional rerun uses the existing exact approval. */
export class TutorialService {
  private highlights:Highlights;
  /** The guided workflow builds its canvas in a project folder, so it needs the local app. */
  private workflow?:WorkflowTutorial;
  constructor(private store:Store, private experiments?:ExperimentService, private options:{publicDemo?:boolean;folders?:ProjectFolders}={}) {
    this.highlights = new Highlights(store);
    if (options.folders && !options.publicDemo) this.workflow = new WorkflowTutorial(store,options.folders,(...args) => this.importArtifacts(...args));
  }

  private marketAvailable() { return !this.options.publicDemo && localMarketDataAvailable(); }

  private execution():TutorialExecution {
    const available = this.experiments?.capabilities().sandbox?.available ?? false;
    return { available, backend:'docker-python', reason:available
      ? 'Optional: review the captured CSV and Python, then approve a new isolated local execution. No model, web search or paid sandbox call is needed.'
      : 'Saved results are ready to explore. Fresh execution needs a configured isolated runner; no unrestricted fallback is used.' };
  }

  catalog():TutorialCatalog {
    return {
      scenarios:[{id:'workflow' as const,title:'From idea to report · AI in Dutch business',
        summary:'The whole workflow in seven steps: web searches from a first idea, findings read from the pages, themes and a leading conclusion, a calculation and a notebook on CBS data, charts and a final report.',
        question:'How is AI changing Dutch businesses, and what does it mean for a bank such as ABN AMRO?',publicDataReady:false,publicDataStatus:'',available:Boolean(this.workflow),
        ...this.workflow ? {} : {unavailableReason:'Available in the local app, where projects are folders on your computer.'}},
      ...lessonSchema.options.map(id => {
        // Restricted market files are deliberately absent from the public image.
        // Listing the unavailable choice must not read or package its snapshot.
        if (id === 'market' && !this.marketAvailable()) return {
          id,title:'When market conditions change · a historical risk baseline',
          summary:'Explore historical risk thresholds and their limits. This real-data demonstration is currently available in the local research workspace.',
          question:'How well does a simple historical risk baseline describe losses as market conditions change?',
          publicDataReady:false,available:false,
          publicDataStatus:'The captured S&P/FRED series and derived figures require reproduction permission before public distribution.',
          unavailableReason:this.options.publicDemo
            ? 'The market scenario remains local until reproduction permission or an approved replacement dataset is available. Its data and figures are not included in this public website.'
            : 'The market scenario needs its captured S&P/FRED data, which is kept outside the repository. Add the local research files under examples/demo-market-risk to enable it.',
        };
        const content = loadTutorialContent(id);
        return { id, title:content.title, summary:content.summary, question:content.question,
          publicDataReady:content.publicDataReady, publicDataStatus:content.publicDataStatus,
          available:!this.options.publicDemo || content.publicDataReady,
          ...this.options.publicDemo && !content.publicDataReady ? {unavailableReason:content.publicDataStatus} : {} };
      })],
      execution:this.execution(),
      hosting:this.options.publicDemo
        ? {mode:'public-demo',publicReady:true,reason:'Your browser has a separate demo workspace. Saved results and manual editing are available; fresh execution and paid provider calls are disabled in this public demo.'}
        : {mode:'local',publicReady:false,reason:'This service currently accepts local requests only. Public interactive hosting needs an approved server deployment, visitor isolation and a supported runner; static website hosting cannot run this backend.'},
    };
  }

  private saved(projectId:string):SavedSession|undefined {
    this.store.getProject(projectId);
    return this.store.record<SavedSession>('demo-session',projectId);
  }

  read(projectId:string):TutorialSession|null {
    const saved = this.saved(projectId);
    if (!saved) return null;
    if (saved.scenario === 'workflow') {
      if (!this.workflow) throw new StoreError('The guided workflow demo needs the local app, where projects are folders.',409);
      return this.workflow.read(saved,this.execution());
    }
    const content = loadTutorialContent(saved.scenario);
    const preview = saved.runId && this.experiments ? this.experiments.inspect(saved.runId) : null;
    const run = preview?.run;
    const freshOutputArtifactIds = run?.status === 'completed'
      ? run.artifactIds.filter(id => isOutput(this.store.getArtifact(id))) : [];
    const statuses = content.stages.map((stage,index) => ({
      index, title:stage.title, nodeId:saved.stageNodeIds[index] ?? null,
      summary:index === 2 && index <= saved.step ? content.reference.findings : stage.description,
      status:index > saved.step ? 'pending' as const : 'completed' as const,
    }));
    const notice = run?.status === 'running' || (run?.status === 'queued' && preview?.approval.status === 'allowed')
      ? 'A new local calculation is running. Saved results below remain labelled as earlier evidence.'
      : run?.status === 'completed'
        ? 'The optional local calculation completed. Its new outputs are separate from the saved demonstration results.'
        : run && ['failed','cancelled','interrupted'].includes(run.status)
          ? `The optional calculation ${run.status}. ${run.error ?? 'Saved evidence and the tutorial remain available; retry requires a new exact preview.'}`
          : preview?.approval.status === 'pending'
            ? 'An optional new calculation is awaiting exact approval. Continuing the saved tutorial does not run it.'
            : 'This tutorial reuses genuine saved evidence and execution results. Advancing creates notes in this separate workspace; it does not make new model, search or sandbox calls.';
    return { projectId, scenario:saved.scenario, title:content.title, step:saved.step,
      stages:statuses, runId:saved.runId ?? null, preview, outputArtifactIds:saved.outputArtifactIds,
      freshOutputArtifactIds, draftNodeId:saved.draftNodeId ?? null, draftArtifactId:saved.draftArtifactId ?? null,
      execution:this.execution(), notice, createdAt:saved.createdAt };
  }

  create(scenario:TutorialScenarioId):TutorialSession {
    if (scenario === 'workflow') {
      if (!this.workflow) throw new StoreError('The guided workflow demo needs the local app, where projects are folders.',403);
      return this.read(this.workflow.create())!;
    }
    if (scenario === 'market' && !this.marketAvailable()) throw new StoreError(this.options.publicDemo
      ? 'The market scenario is unavailable publicly: its captured S&P/FRED data and derived figures need reproduction permission or an approved replacement dataset.'
      : 'The market scenario needs its captured S&P/FRED data, which is not in this checkout.',this.options.publicDemo ? 403 : 409);
    const content = loadTutorialContent(scenario);
    if (this.options.publicDemo && !content.publicDataReady) throw new StoreError(content.publicDataStatus,403);
    return this.store.atomic(() => {
      const project = this.store.createProject(scenario === 'banking' ? 'Dutch AI adoption' : 'Historical market risk');
      const saved:LessonSession = { projectId:project.id, scenario, step:0, createdAt:now(),
        stageNodeIds:[], questionArtifactId:'', sourceArtifactIds:[], outputArtifactIds:[] };
      const stage = this.addStage(saved,0,content.stages[0].description);
      const question = this.addNote(project.id,stage.id,'The question and its scope',
        `Original question\n${content.question}\n\nFocused question\n${content.focusedQuestion}\n\nThis is the prepared starting point for a demonstration. You can edit this note and explore another direction.`,0);
      const [artifact] = this.importArtifacts(project.id,question.id,[{
        kind:'result', title:'Prepared research question', content:question.description,
        metadata:{tutorialOrigin:'prepared',demoRole:'direction'},
      }],'Load the prepared question');
      saved.questionArtifactId = artifact.id;
      this.store.addInput(project.id,stage.id,artifact.id);
      this.store.addMessage(project.id,null,'system',
        'Demo mode creates four stages as you advance. Questions and explanatory prose are prepared; evidence and results are copied from the recorded demonstration. No new model inference, search or experiment has run. Optional local reruns require reviewing and approving exact code. Your other projects are unchanged.');
      this.save(saved);
      return this.read(project.id)!;
    });
  }

  private save(session:SavedSession) { return this.store.saveRecord('demo-session',session.projectId,session.projectId,session); }

  advance(projectId:string, expectedStep?:number):TutorialSession {
    const saved = this.saved(projectId);
    if (!saved) throw new StoreError('This project is not a demo workspace.',404);
    if (expectedStep !== undefined && expectedStep !== saved.step) throw new StoreError('The tutorial has already moved. Refresh before advancing again.',409);
    if (saved.scenario === 'workflow') {
      if (!this.workflow) throw new StoreError('The guided workflow demo needs the local app, where projects are folders.',409);
      this.workflow.advance(saved);
      return this.read(projectId)!;
    }
    if (saved.step === 3) return this.read(projectId)!;
    return this.store.atomic(() => {
      const content = loadTutorialContent(saved.scenario);
      const step = saved.step + 1;
      if (step === 1) {
        const stage = this.addStage(saved,1,content.stages[1].description);
        const sourceNote = this.addNote(projectId,stage.id,'Sources, coverage and limits',
          content.sources.map(source => `${source.title}\n${source.url}\n${source.content}`).join('\n\n'),0);
        const sources = this.importArtifacts(projectId,sourceNote.id,content.sources.map(source => ({
          kind:'source' as const, ...source, metadata:{tutorialOrigin:'prepared',provenance:'Prepared attributed source summaries accompanying the captured demonstration dataset.'},
        })),'Import prepared attributed source notes');
        saved.sourceArtifactIds = sources.map(source => source.id);
        const dataNote = this.addNote(projectId,stage.id,content.dataset.title,content.dataset.provenance,1);
        const [dataset] = this.importArtifacts(projectId,dataNote.id,[{
          kind:'dataset', title:content.dataset.title, content:content.dataset.csv, mediaType:'text/csv',
          metadata:{tutorialOrigin:'saved',provenance:content.dataset.provenance,publicDataStatus:content.publicDataStatus},
        }],'Import the captured demonstration CSV');
        saved.datasetArtifactId = dataset.id;
        this.store.addInput(projectId,stage.id,saved.questionArtifactId);
        for (const artifact of [...sources,dataset]) this.store.addInput(projectId,stage.id,artifact.id);
        for (const source of sources) this.store.addInput(projectId,dataNote.id,source.id);
        this.link(projectId,sourceNote.id,dataNote.id,'Documents the captured data');
      } else if (step === 2) {
        const stage = this.addStage(saved,2,content.reference.findings);
        const analysis = this.addNote(projectId,stage.id,content.analysis.title,
          `${content.reference.findings}\n\nSaved execution results\n${content.reference.provenance}\n\nYou can inspect the code, CSV, plots and metrics below. Review & rerun locally is optional and creates a separate execution.`,0,'activity');
        saved.analysisNodeId = analysis.id;
        this.experiments?.authority.override(projectId,analysis.id,'ask');
        for (const id of [saved.datasetArtifactId!,...saved.sourceArtifactIds]) this.store.addInput(projectId,analysis.id,id);
        const outputs = this.importArtifacts(projectId,analysis.id,content.reference.outputs.map(output => ({
          kind:output.kind, title:output.title, content:output.content, mediaType:output.mediaType,
          metadata:{tutorialOrigin:'saved',originalExecution:output.provenance,provenance:content.reference.provenance},
        })),'Import genuine saved calculation outputs');
        saved.outputArtifactIds = outputs.map(output => output.id);
        this.importArtifacts(projectId,analysis.id,[{
          kind:'code', title:'Prepared program for an optional new local calculation', content:content.analysis.code, mediaType:'text/x-python',
          metadata:{tutorialOrigin:'prepared',parameters:content.analysis.parameters},
        }],'Load the inspectable rerun program');
        const challenge = this.addNote(projectId,stage.id,'Challenge the conclusion',
          `${content.reference.findings}\n\nEvidence boundary\n${content.reference.provenance}\n\nRead the source definitions before extending this conclusion. A saved calculation is evidence for its captured dataset and assumptions; it does not establish causality or predict future outcomes.`,1);
        this.importArtifacts(projectId,challenge.id,[{kind:'result',title:'Saved findings and limits',content:challenge.description,
          metadata:{tutorialOrigin:'saved',demoRole:'synthesis',provenance:content.reference.provenance}}],'Load the saved findings and their limits');
        for (const output of outputs) {
          this.store.addInput(projectId,challenge.id,output.id);
          this.store.addInput(projectId,stage.id,output.id);
        }
        this.link(projectId,analysis.id,challenge.id,'Findings to challenge');
        this.pin(projectId,analysis.id,outputs.filter(output => output.kind === 'plot'));
        this.pin(projectId,stage.id,outputs.filter(output => output.kind === 'plot'));
      } else {
        const stage = this.addStage(saved,3,content.stages[3].description);
        const draftText = `Saved research draft\n\nThis draft was prepared for the recorded demonstration; opening this tutorial has not generated a new model response. ${content.reference.provenance}\n\n${content.reference.draft}`;
        const draft = this.addNote(projectId,stage.id,'Research draft · editable',draftText,0);
        saved.draftNodeId = draft.id;
        for (const id of [saved.questionArtifactId,...saved.sourceArtifactIds,...saved.outputArtifactIds]) this.store.addInput(projectId,draft.id,id);
        const [artifact] = this.importArtifacts(projectId,draft.id,[{
          kind:'result',title:'Saved cited research draft',content:draftText,mediaType:'text/markdown',
          metadata:{tutorialOrigin:'saved',demoRole:'article',provenance:content.reference.provenance},
        }],'Import the saved research draft for editing');
        saved.draftArtifactId = artifact.id;
        this.store.addInput(projectId,stage.id,artifact.id);
        const guide = this.addNote(projectId,stage.id,'Make the draft your own',content.draftGuide,1);
        this.importArtifacts(projectId,guide.id,[{kind:'result',title:'Prepared writing guide',content:content.draftGuide,
          metadata:{tutorialOrigin:'prepared'}}],'Load the tutorial writing guide');
        this.link(projectId,guide.id,draft.id,'Revision guidance');
        this.pin(projectId,draft.id,saved.outputArtifactIds.map(id => this.store.getArtifact(id)).filter(output => output.kind === 'plot'));
      }
      saved.step = step;
      this.save(saved);
      return this.read(projectId)!;
    });
  }

  preview(projectId:string):TutorialSession {
    const saved = this.saved(projectId);
    if (!saved || saved.scenario === 'workflow' || !saved.analysisNodeId || !saved.datasetArtifactId) throw new StoreError('Reach Analyze and challenge before preparing a new calculation.',409);
    if (!this.experiments) throw new StoreError('The execution service is unavailable.',503);
    if (!this.execution().available) throw new StoreError(this.execution().reason,503);
    const current = saved.runId ? this.experiments.inspect(saved.runId) : null;
    if (current && ['queued','running'].includes(current.run.status)) return this.read(projectId)!;
    const content = loadTutorialContent(saved.scenario);
    // The tutorial always asks for this optional fresh execution even if the
    // visitor later changes the rest of their project to an automatic mode.
    this.experiments.authority.override(projectId,saved.analysisNodeId,'ask');
    const preview = this.experiments.preview(projectId,{
      nodeId:saved.analysisNodeId, request:content.analysis.request ?? content.analysis.title,
      datasetArtifactId:saved.datasetArtifactId, code:content.analysis.code, parameters:content.analysis.parameters,
      backend:'docker-python', ...(current ? {retryOf:current.run.id} : {}),
    });
    saved.runId = preview.run.id;
    this.save(saved);
    return this.read(projectId)!;
  }

  private addStage(saved:LessonSession,index:number,summary:string):CanvasNode {
    const content = loadTutorialContent(saved.scenario);
    const roots = this.store.getProject(saved.projectId).canvas.nodes.filter(node => !node.parentId);
    const previous = roots.find(node => node.id === saved.stageNodeIds.at(-1));
    const node:CanvasNode = {id:randomUUID(),title:content.stages[index].title,
      description:summary,kind:'group',parentId:null,x:previous?.x ?? 0,
      y:roots.length ? Math.max(...roots.map(node => node.y)) + CARD_MAX_HEIGHT + LAYOUT_GAP : 0,width:480};
    const operations:Mutation[] = [{type:'addNode',node}];
    if (index) operations.push({type:'addConnection',connection:{id:randomUUID(),source:saved.stageNodeIds[index-1],target:node.id,
      label:['','Question guides evidence','Evidence supports the analysis','Findings support the draft'][index]}});
    this.store.mutate(saved.projectId,operations,`Demo: create ${content.stages[index].title}`);
    saved.stageNodeIds.push(node.id);
    const [artifact] = this.importArtifacts(saved.projectId,node.id,[{
      kind:'result',title:`Stage summary · ${content.stages[index].title}`,content:summary,
      metadata:{tutorialOrigin:index === 2 ? 'saved' : 'prepared',demoRole:'stage-summary'},
    }],'Load the tutorial stage summary');
    this.pin(saved.projectId,node.id,[artifact]);
    return node;
  }

  private addNote(projectId:string,parentId:string,title:string,description:string,index:number,kind:CanvasNode['kind']='topic') {
    // Positions are relative to the group's content area: the renderer already
    // supplies the header and side padding. Keep the generated notes in a row.
    const node:CanvasNode = {id:randomUUID(),title,description,kind,parentId,
      x:index * (CARD_DEFAULT_WIDTH + LAYOUT_GAP),y:0,width:CARD_DEFAULT_WIDTH};
    this.store.mutate(projectId,[{type:'addNode',node}],`Demo: add ${title}`);
    return node;
  }

  private link(projectId:string,source:string,target:string,label:string) {
    this.store.mutate(projectId,[{type:'addConnection',connection:{id:randomUUID(),source,target,label}}],`Demo: ${label}`);
  }

  private pin(projectId:string,nodeId:string,artifacts:Artifact[]) {
    artifacts.forEach((artifact,index) => this.highlights.save(projectId,{nodeId,artifactId:artifact.id,x:32,y:420+index*280}));
  }

  private importArtifacts(projectId:string,nodeId:string,artifacts:ImportArtifact[],request:string):Artifact[] {
    const project = this.store.getProject(projectId), node = project.canvas.nodes.find(item => item.id === nodeId)!;
    const timestamp = now();
    const inputs = this.store.detail(projectId).inputs.filter(input => input.nodeId === nodeId)
      .map(input => ({...input,artifact:this.store.getArtifact(input.artifactId)}));
    const run:Run = { id:randomUUID(),projectId,nodeId,request,useSearch:false,status:'running',
      createdAt:timestamp,startedAt:timestamp,projectRevision:project.revision,node,inputs,messages:[],
      provider:'local',model:'saved-demo-import-v1',modelVersion:null,
      configuration:{kind:'tutorial-saved-import',freshExecution:false,preparedTutorial:true},
      tools:[],events:[{at:timestamp,type:'saved-evidence-import',message:'Copied prepared tutorial content or genuine saved evidence. No new research execution or provider request.'}],artifactIds:[],
      cost:{estimatedUsd:0,basis:'Local copy of tutorial evidence; no external request.'} };
    this.store.createRun(run);
    const results = artifacts.map(artifact => this.store.addArtifact({
      capture:'full-content',...artifact,projectId,nodeId,runId:run.id,
      metadata:{...artifact.metadata,importedAt:timestamp,freshExecution:false},
    }));
    this.store.updateRun(run.id,{status:'completed',endedAt:timestamp,artifactIds:results.map(artifact => artifact.id)});
    return results;
  }
}

export function attachTutorialRoutes(app:Express,service:TutorialService) {
  app.get('/api/demo-scenarios',(_req,res) => res.json(service.catalog()));
  app.post('/api/demo-sessions',(req,res) => {
    const {scenario} = z.object({scenario:z.enum(['workflow',...lessonSchema.options])}).strict().parse(req.body);
    res.status(201).json(service.create(scenario));
  });
  app.get('/api/projects/:id/demo-session',(req,res) => res.json(service.read(identifier.parse(req.params.id))));
  app.post('/api/projects/:id/demo-session/advance',(req,res) => {
    const {step} = z.object({step:z.number().int().min(0).max(WORKFLOW_STEPS - 1).optional()}).strict().parse(req.body ?? {});
    res.json(service.advance(identifier.parse(req.params.id),step));
  });
  app.post('/api/projects/:id/demo-session/preview',(req,res) => res.json(service.preview(identifier.parse(req.params.id))));
}
