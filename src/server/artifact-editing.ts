import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import { artifactTable, columnSummary, tableCsv, transformTable } from '../shared/data-view.js';
import { canonicalReport, evidenceClaim, reportHtml, reportMarkdown, reportReferences } from '../shared/reports.js';
import type { Artifact, CanvasNode, Run } from '../shared/types.js';
import { LocalConnections } from './connections.js';
import { Store, StoreError } from './store.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u), hash = z.string().regex(/^[a-f0-9]{64}$/u);
const operationSchema = z.object({ trim:z.boolean(), dropEmptyRows:z.boolean(), deduplicate:z.boolean(), dropMissing:z.array(z.string()).max(500), search:z.string().max(2000), filterColumn:z.number().int().nonnegative().nullable(), filter:z.string().max(2000), sortColumn:z.number().int().nonnegative().nullable(), descending:z.boolean() }).strict();
const now = () => new Date().toISOString();
export type AgentReportProvenance = {agent:'codex';assistantTurnId:string;captureHash:string};
/** Manual, fixed-operation edits. No model, code execution, source writes or
 * authority changes occur here. Each save creates a new immutable artifact. */
export class ArtifactEditingService {
  constructor(private store: Store, private connections = new LocalConnections(store)) {}
  private owned(projectId: string, artifactId: string) { const artifact = this.store.getArtifact(artifactId); if (artifact.projectId !== projectId) throw new StoreError('Choose saved evidence in this project.'); return artifact; }
  private save(projectId: string, node: CanvasNode, input: Omit<Artifact,'id'|'hash'|'createdAt'|'projectId'|'nodeId'|'runId'>, sources: Artifact[], configuration: Record<string, unknown>) {
    const project = this.store.getProject(projectId);
    const inputs = sources.map(source => ({ ...this.store.addInput(projectId,node.id,source.id), artifact:source }));
    const agent = configuration.agent === 'codex';
    const run: Run = { id:randomUUID(),projectId,nodeId:node.id,request:input.title,useSearch:false,status:'running',createdAt:now(),startedAt:now(),projectRevision:project.revision,node,inputs,messages:[],provider:'local',model:agent?'codex-approved-report-revision-v1':'manual-artifact-edit-v1',modelVersion:null,configuration:{kind:agent?'accepted-agent-report':'manual-artifact-edit',...configuration},tools:[],events:[{at:now(),type:agent?'accepted-agent-report':'manual-edit',message:agent?'User accepted this exact recorded Codex report proposal. The proposal capture is retained; accepting does not call a model or execute code.':'User saved a derived version. No model or code execution was used.'}],artifactIds:[] };
    this.store.createRun(run);
    const artifact = this.store.addArtifact({ ...input,projectId,nodeId:node.id,runId:run.id });
    this.store.updateRun(run.id,{status:'completed',endedAt:now(),artifactIds:[artifact.id]});
    return artifact;
  }
  private newBlock(projectId: string, title: string, blockType: 'dataset'|'report', parentId?: string|null): CanvasNode {
    const node: CanvasNode = {id:randomUUID(),title,description:'',x:0,y:0,kind:'topic',blockType,...(parentId ? {parentId} : {})};
    this.store.mutate(projectId,[{type:'addNode',node}],`Add ${blockType}: ${title}`);
    return this.store.getProject(projectId).canvas.nodes.find(item => item.id === node.id)!;
  }
  deriveDataset(projectId: string, supplied: unknown, preview = false) {
    const body = z.object({ sourceArtifactId:id.optional(),resourceId:id.optional(),expectedHash:hash,title:z.string().trim().min(1).max(200),transformation:operationSchema }).strict().refine(value => Boolean(value.sourceArtifactId) !== Boolean(value.resourceId),'Choose one captured artifact or resource.').parse(supplied);
    const source = body.sourceArtifactId ? this.owned(projectId,body.sourceArtifactId) : undefined;
    if (source && !['dataset','table'].includes(source.kind)) throw new StoreError('Choose a dataset or table.');
    const resource = body.resourceId ? this.connections.previewResource(projectId,body.resourceId) : undefined;
    if (resource?.resource.kind !== 'csv') { if (resource) throw new StoreError('Choose a CSV resource.'); }
    const content = source?.content ?? resource!.content, actualHash = source?.hash ?? resource!.hash;
    if (actualHash !== body.expectedHash) throw new StoreError('The source changed. Reopen its current version before saving a derived copy.',409);
    if (Buffer.byteLength(content,'utf8') > 500000) throw new StoreError('Dataset transformations retain the 500,000-byte limit.');
    const before = artifactTable(content, !source || source.kind === 'dataset' || source.mediaType === 'text/csv');
    for (const index of [body.transformation.filterColumn,body.transformation.sortColumn]) if (index !== null && index >= before.columns.length) throw new StoreError('The selected column is unavailable.');
    if (body.transformation.dropMissing.some(column => !before.columns.includes(column))) throw new StoreError('The required column is unavailable.');
    const after = transformTable(before,body.transformation), csv = tableCsv(after);
    if (Buffer.byteLength(csv,'utf8') > 500000) throw new StoreError('Derived CSV exceeds the 500,000-byte limit.');
    const comparison = {before:{rows:before.rows.length,columns:before.columns,summary:columnSummary(before),sample:before.rows.slice(0,5)},after:{rows:after.rows.length,columns:after.columns,summary:columnSummary(after),sample:after.rows.slice(0,5)},sourceHash:actualHash,transformation:body.transformation};
    if (preview) return comparison;
    return this.store.atomic(() => {
      const parentId = source ? this.store.getProject(projectId).canvas.nodes.find(node => node.id === source.nodeId)?.parentId : undefined;
      const node = this.newBlock(projectId,body.title,'dataset',parentId);
      const captured = source ?? this.connections.useResource(projectId,body.resourceId!,node.id);
      // A linked file can change between preview and capture; roll back all saved
      // records rather than derive from an unchecked second read.
      if (captured.hash !== actualHash) throw new StoreError('The linked source changed while saving. Preview it again.',409);
      const artifact = this.save(projectId,node,{kind:'dataset',title:body.title,content:csv,mediaType:'text/csv',capture:'generated',metadata:{sourceArtifactId:captured.id,sourceHash:captured.hash,transformation:body.transformation,beforeRows:before.rows.length,afterRows:after.rows.length,contribution:'user interpretation'}},[captured],{operation:'derive-dataset',...comparison});
      this.store.mutate(projectId,[{type:'updateNode',id:node.id,patch:{artifactId:artifact.id}}],`Save derived dataset: ${body.title}`);
      return {artifact,nodeId:node.id,comparison};
    });
  }
  figurePresentation(projectId: string, artifactId: string, supplied: unknown) {
    const body = z.object({expectedHash:hash,title:z.string().trim().min(1).max(200),caption:z.string().max(4000),width:z.number().int().min(25).max(100)}).strict().parse(supplied);
    const source = this.owned(projectId,artifactId);
    if (source.kind !== 'plot') throw new StoreError('Choose a saved figure.');
    if (source.hash !== body.expectedHash) throw new StoreError('Figure source version changed.',409);
    const node = this.store.getProject(projectId).canvas.nodes.find(node => node.id === source.nodeId); if (!node) throw new StoreError('Restore the figure’s original block before saving a refinement.');
    return this.store.atomic(() => {
      const artifact = this.save(projectId,node,{kind:'plot',title:body.title,content:source.content,mediaType:source.mediaType??'image/svg+xml',capture:source.capture,metadata:{...source.metadata,sourceArtifactId:source.id,sourceHash:source.hash,caption:body.caption,presentationWidth:body.width,refinement:'presentation only; analysis image unchanged'}},[source],{operation:'figure-presentation',caption:body.caption,width:body.width});
      if (node.blockType === 'figure' && node.artifactId === source.id) this.store.mutate(projectId,[{type:'updateNode',id:node.id,patch:{artifactId:artifact.id}}],`Refine figure presentation: ${body.title}`);
      return artifact;
    });
  }
  saveReport(projectId: string, supplied: unknown, agent?:AgentReportProvenance) {
    if(agent) z.object({agent:z.literal('codex'),assistantTurnId:id,captureHash:hash}).strict().parse(agent);
    const body = z.object({ nodeId:id.optional(),sourceArtifactId:id.optional(),title:z.string().trim().min(1).max(200),text:z.string().max(200000),evidenceIds:z.array(id).max(100),expectedRevision:z.number().int().nonnegative().optional() }).strict().parse(supplied);
    const project = this.store.getProject(projectId);
    if (body.expectedRevision !== undefined && project.revision !== body.expectedRevision) throw new StoreError('The project changed. Reload and review before saving the report.',409);
    const previous = body.sourceArtifactId ? this.owned(projectId,body.sourceArtifactId) : undefined;
    const evidence = [...new Set(body.evidenceIds)].map(artifactId => this.owned(projectId,artifactId));
    const text = canonicalReport(body.text,evidence), referenced = reportReferences(text);
    if (referenced.some(artifactId => !evidence.some(artifact => artifact.id === artifactId))) throw new StoreError('Every inline figure, table and evidence link must select its exact saved artifact.');
    if (previous && body.nodeId && previous.nodeId !== body.nodeId) throw new StoreError('Report revision must belong to its original block.');
    return this.store.atomic(() => {
      const node = body.nodeId ? project.canvas.nodes.find(node => node.id === body.nodeId) : this.newBlock(projectId,body.title,'report');
      if (!node) throw new StoreError('Report block not found.');
      if (body.nodeId && node.artifactId && node.artifactId !== previous?.id) throw new StoreError('A newer report version is current. Open that version before editing.',409);
      const artifact = this.save(projectId,node,{kind:'result',title:body.title,content:text,mediaType:'text/markdown',capture:'generated',metadata:{report:true,contribution:agent?'model claim':'user interpretation',...(agent??{}),...(previous ? {sourceArtifactId:previous.id,sourceHash:previous.hash} : {}),evidence:evidence.map(item => ({artifactId:item.id,hash:item.hash,title:item.title,kind:item.kind,claimType:evidenceClaim(item)}))}},[...evidence,...(previous ? [previous] : [])],{operation:'save-report',...(agent??{}),sourceArtifactId:previous?.id,evidenceIds:evidence.map(item => item.id)});
      this.store.mutate(projectId,[{type:'updateNode',id:node.id,patch:{title:body.title,blockType:'report',artifactId:artifact.id}}],`Save report: ${body.title}`);
      return {artifact,nodeId:node.id};
    });
  }
  exportReport(projectId: string, artifactId: string, format: 'html'|'markdown') {
    const artifact = this.owned(projectId,artifactId);
    const selected = this.store.detail(projectId).inputs.filter(input => input.nodeId === artifact.nodeId).map(input => this.owned(projectId,input.artifactId));
    const descriptors = artifact.metadata?.evidence;
    const evidence = Array.isArray(descriptors) ? descriptors.map(value => {
      if (!value || typeof value !== 'object' || typeof value.artifactId !== 'string') throw new StoreError('Report evidence manifest is invalid.');
      const saved = this.owned(projectId,value.artifactId); if (saved.hash !== value.hash) throw new StoreError('Captured evidence hash differs from the report manifest.',500); return saved;
    }) : selected;
    return format === 'html' ? reportHtml(artifact.title,artifact.content,evidence,artifact) : reportMarkdown(artifact.title,artifact.content,evidence,artifact);
  }
}
export function attachArtifactEditingRoutes(app: Express, store: Store) {
  const service = new ArtifactEditingService(store);
  app.post('/api/projects/:id/datasets/derive/preview',(req,res) => res.json(service.deriveDataset(id.parse(req.params.id),req.body,true)));
  app.post('/api/projects/:id/datasets/derive',(req,res) => res.status(201).json(service.deriveDataset(id.parse(req.params.id),req.body)));
  app.post('/api/projects/:id/artifacts/:artifactId/presentation',(req,res) => res.status(201).json(service.figurePresentation(id.parse(req.params.id),id.parse(req.params.artifactId),req.body)));
  app.post('/api/projects/:id/reports',(req,res) => res.status(201).json(service.saveReport(id.parse(req.params.id),req.body)));
  app.get('/api/projects/:id/reports/:artifactId/export',(req,res) => {
    const format = z.enum(['html','markdown']).default('html').parse(req.query.format);
    const content = service.exportReport(id.parse(req.params.id),id.parse(req.params.artifactId),format);
    res.type(format === 'html' ? 'html' : 'text/markdown').setHeader('Content-Disposition',`attachment; filename="ros-ai-report.${format === 'html' ? 'html' : 'md'}"`);
    res.send(content);
  });
}
