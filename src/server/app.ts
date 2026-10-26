import express, { type ErrorRequestHandler } from 'express';
import { z, ZodError } from 'zod';
import { StoreError, type Store } from './store.js';
import type { ExecutionService } from './execution.js';
import { attachResultHandoffRoutes } from './result-handoff.js';
import { attachCloudAccountRoutes, type CloudAccount } from './cloud-account.js';
import { attachLocalRosRoutes, type LocalRos } from './local-ros.js';
import { attachExperimentRoutes, type ExperimentService } from './experiments.js';
import { LocalConnections, Highlights } from './connections.js';
import { Authority, modeSchema } from './authority.js';
import type { ResearchService } from './research.js';
import { attachAssistantRoutes, type AssistantService } from './assistant.js';
import { attachCodexAgentRoutes,type CodexAgentService } from './codex-agent.js';
import { attachClaudeAgentRoutes,type ClaudeAgentService } from './claude-agent.js';
import { attachAcpAgentRoutes,type AcpAgentService } from './acp-agent.js';
import { attachOutsideAgentRoutes, type OutsideAgents } from './outside-agents.js';
import { AgentWorkspaceTools } from './agent-tools.js';
import { attachSetupRoutes, type Setup } from './setup.js';
import { attachPersonalMemoryRoutes, type PersonalMemory } from './personal-memory.js';
import { attachSkillRoutes, type SkillLibrary } from './skills.js';
import { attachArtifactEditingRoutes } from './artifact-editing.js';
import { seedDemo } from './demo.js';
import { projectBudgetReport, usageAnalytics } from './budget-report.js';
import { providerBalances } from './provider-balances.js';
import { attachSpendingBudgetRoutes, SpendingBudget } from './spending-budget.js';
import { ModelSettings } from './model-settings.js';
import { ProviderUsage } from './provider-usage.js';
import { attachTutorialRoutes, TutorialService } from './tutorial.js';
import { attachToolCredentialRoutes, type ToolCredentials } from './tool-credentials.js';
import { attachGoogleDriveRoutes, type GoogleDriveConnection } from './google-drive.js';
import { attachGoogleRoutes, type GoogleWorkspace } from './google-workspace.js';
import { attachPaperRoutes, type Papers } from './papers.js';
import { attachPluginRoutes, type PluginTokens } from './plugins.js';
import { attachAppRoutes, type RemoteApps } from './remote-apps.js';
import { attachNotionViewRoutes, NotionViews } from './notion-view.js';
import { ProjectCache } from './project-cache.js';
import { attachConnectionBudgetRoutes } from './connection-budgets.js';
import { attachInferenceConnectionRoutes } from './inference-connections.js';
import { attachWorkspaceGuideRoutes,type WorkspaceGuideService } from './workspace-guide.js';
import { attachNotebookRoutes, NOTEBOOK_ROUTE } from './notebooks.js';
import { attachNetworkRoutes, attachPythonSetupRoute } from './network-gate.js';
import { attachProjectFolderRoutes, ProjectFolders } from './project-folders.js';
import { attachSqlRoutes, SqlService } from './sql.js';

const identifier = z.string().min(1).max(120);
const routeId = (value: unknown) => identifier.parse(value);

/** The HTTP boundary never returns provider credentials or exposes arbitrary filesystem access. */
type AppExecution = Pick<ExecutionService, 'chat' | 'startRun' | 'cancelRun' | 'retryRun' | 'connectionStatuses'> & Partial<Pick<ExecutionService, 'startExperimentPlan'|'acceptGovernedProposal'|'connectionBudgets'|'inference'|'searchStatus'|'chooseSearch'>>;
export function createApp(store: Store, execution: AppExecution, experiments?: ExperimentService, research?:ResearchService, assistant?:AssistantService, options:{publicDemo?:boolean;projectFolders?:{reserved:string[]};notebooks?:Parameters<typeof attachNotebookRoutes>[3];localPaths?:{dataDir:string;keysFile:string|null}}={},agent?:CodexAgentService,tools?:{credentials:ToolCredentials;googleDrive:GoogleDriveConnection;google?:GoogleWorkspace;papers?:Papers;claude?:ClaudeAgentService;acp?:AcpAgentService;plugins?:PluginTokens;apps?:RemoteApps;outside?:OutsideAgents;cloud?:CloudAccount;localRos?:LocalRos;memory?:PersonalMemory;skills?:SkillLibrary;setup?:Setup},guide?:WorkspaceGuideService) {
  const authority=experiments?.authority??new Authority(store),connections=new LocalConnections(store),highlights=new Highlights(store);
  const app = express();
  const providerUsage = new ProviderUsage(store);
  const modelSettings = new ModelSettings(store);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host ?? '';
    if (!options.publicDemo && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      return res.status(403).json({ error: 'ros.ai accepts only local host requests.' });
    }
    const origin = req.headers.origin;
    if (!options.publicDemo && origin && origin !== `http://${host}`) {
      return res.status(403).json({ error: 'Cross-origin requests are not permitted.' });
    }
    // Changes arrive only as JSON from ros.ai's own page. A form or a request from another site cannot send that without permission.
    if (!options.publicDemo && req.path.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method)) {
      if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Cross-site requests are not permitted.' });
      const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      // A file dropped on the canvas is sent as itself. A form cannot send these types, and a script from another site needs a CORS preflight ros.ai never answers.
      const file = /\/folder\/files$/u.test(req.path) && ['application/pdf', 'image/png', 'image/jpeg'].includes(type);
      if (type !== 'application/json' && !file) return res.status(415).json({ error: 'Send ros.ai requests as JSON.' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get(['/waitlist','/waitlist/pitch'],(_req,res) => res.redirect(302,'/app'));
  app.all('/api/waitlist',(_req,res) => res.status(410).json({error:'Signup has closed. Explore the demo at /app.'}));
  // A notebook can carry figures and tables, so its routes read larger requests than the rest of the API.
  if (!options.publicDemo) app.use(NOTEBOOK_ROUTE, express.json({ limit: '25mb' }));
  // A skill archive (.zip, up to 12 MB) arrives as base64 inside JSON.
  if (!options.publicDemo) app.use('/api/skills/preview', express.json({ limit: '17mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'ros.ai' }));
  app.get('/api/projects', (_req, res) => res.json(store.listProjects()));
  if(!options.publicDemo)attachArtifactEditingRoutes(app,store);
  const notebooks=options.publicDemo?undefined:attachNotebookRoutes(app,store,authority,options.notebooks);
  if(!options.publicDemo&&options.notebooks?.python?.gate)attachNetworkRoutes(app,options.notebooks.python.gate);
  if(!options.publicDemo&&options.notebooks?.python)attachPythonSetupRoute(app,options.notebooks.python.runtime);
  const folders=notebooks&&options.projectFolders?new ProjectFolders(store,{reserved:options.projectFolders.reserved,notebooks}):undefined;
  if(folders){attachProjectFolderRoutes(app,folders);app.locals.projectFolders=folders;AgentWorkspaceTools.folders=folders;folders.start();}
  attachTutorialRoutes(app,new TutorialService(store,experiments,{...options,folders}));
  // SQL over the project's Data blocks and folder files runs DuckDB on this computer, so the public demo leaves it out.
  if(!options.publicDemo)attachSqlRoutes(app,new SqlService(store,{folders,...(options.localPaths?{extensionDirectory:`${options.localPaths.dataDir}/duckdb/extensions`}:{})}));
  if(agent&&!options.publicDemo)attachCodexAgentRoutes(app,agent);
  if(tools&&!options.publicDemo){attachToolCredentialRoutes(app,tools.credentials);attachGoogleDriveRoutes(app,tools.googleDrive,store);if(tools.google)attachGoogleRoutes(app,store,tools.google);if(tools.papers)attachPaperRoutes(app,store,tools.papers,folders);if(tools.claude)attachClaudeAgentRoutes(app,tools.claude);if(tools.acp)attachAcpAgentRoutes(app,tools.acp);if(tools.plugins)attachPluginRoutes(app,tools.plugins);if(tools.apps){attachAppRoutes(app,tools.apps);const notionViews=new NotionViews(tools.apps,new ProjectCache(store));AgentWorkspaceTools.views=notionViews;attachNotionViewRoutes(app,store,notionViews);}if(tools.cloud)attachCloudAccountRoutes(app,tools.cloud);if(tools.localRos)attachLocalRosRoutes(app,tools.localRos);if(tools.setup)attachSetupRoutes(app,tools.setup);}
  if(execution.connectionBudgets&&!options.publicDemo)attachConnectionBudgetRoutes(app,execution.connectionBudgets);
  if(execution.inference&&!options.publicDemo)attachInferenceConnectionRoutes(app,execution.inference);
  // Which web search service agents use: Tavily, Exa or Brave Search, each with its own key.
  if(execution.searchStatus&&execution.chooseSearch&&!options.publicDemo){
    app.get('/api/connections/search',(_req,res)=>res.json(execution.searchStatus!()));
    app.put('/api/connections/search',(req,res)=>{if(!req.is('application/json'))throw new StoreError('Send a JSON search choice.',415);res.json(execution.chooseSearch!(req.body));});
  }
  if(guide&&!options.publicDemo)attachWorkspaceGuideRoutes(app,guide);
  app.get('/api/projects/trash', (_req,res)=>res.json(store.listTrashedProjects()));
  app.post('/api/projects', (req, res) => {
    const { title,start,folder } = z.object({ title: z.string().trim().min(1).max(160),start:z.enum(['blank','conversation','demo']).optional(),folder:z.string().trim().min(1).max(4000).optional() }).strict().parse(req.body);
    if(folder&&!folders)throw new StoreError('Project folders are available in the local app.');
    // Check the folder before the project exists, so a refused folder leaves nothing behind.
    if(folder)folders!.prepare(folder);
    const project=store.createProject(title);
    if(folder)try{folders!.attach(project.id,folder);}catch(error){store.trashProject(project.id);throw error;}
    res.status(201).json(start==='demo'?seedDemo(store,project.id):store.getProject(project.id));
  });
  app.post('/api/projects/:id/trash',(req,res)=>res.json(store.trashProject(routeId(req.params.id))));
  app.post('/api/projects/:id/restore',(req,res)=>res.json(store.restoreProject(routeId(req.params.id))));
  app.get('/api/projects/:id/models', (req,res)=>res.json(modelSettings.read(routeId(req.params.id))));
  app.patch('/api/projects/:id/models', (req,res)=>res.json(modelSettings.update(routeId(req.params.id),req.body)));
  app.get('/api/projects/:id', (req, res) => {
    const detail = store.detail(routeId(req.params.id)), running = notebooks?.running(detail.project.id);
    // Notebook cards show Python still working after their notebook closes, and the page keeps reading until it stops.
    res.json(running?.size ? { ...detail, notebooks: detail.notebooks?.map(summary => running.has(summary.nodeId) ? { ...summary, running: true } : summary) } : detail);
  });
  app.post('/api/projects/:id/mutations', (req, res) => {
    const body = z.object({ operations: z.array(z.unknown()).min(1).max(500), label: z.string().min(1).max(240), expectedRevision: z.number().int().nonnegative().optional() }).strict().parse(req.body);
    res.json(store.mutate(routeId(req.params.id), body.operations as never, body.label, body.expectedRevision));
  });
  app.post('/api/projects/:id/undo', (req, res) => res.json(store.undo(routeId(req.params.id))));
  app.post('/api/projects/:id/redo', (req, res) => res.json(store.redo(routeId(req.params.id))));
  app.post('/api/projects/:id/chat', async (req, res) => {
    const { message } = z.object({ message: z.string().trim().min(1).max(12000) }).strict().parse(req.body);
    res.json(await execution.chat(routeId(req.params.id), message));
  });
  app.post('/api/projects/:id/proposals/:proposalId/accept', (req, res) => {const id=routeId(req.params.id),proposalId=routeId(req.params.proposalId);res.json(research?.acceptProposal(id,proposalId)||execution.acceptGovernedProposal?.(id,proposalId)?store.getProject(id):store.acceptProposal(id,proposalId));});
  app.post('/api/projects/:id/proposals/:proposalId/dismiss', (req, res) => res.json(store.dismissProposal(routeId(req.params.id), routeId(req.params.proposalId))));
  app.post('/api/projects/:id/runs', (req, res) => {
    const { nodeId, ...options } = z.object({ nodeId: identifier, request: z.string().trim().min(1).max(12000), useSearch: z.boolean().default(false) }).strict().parse(req.body);
    res.status(201).json(execution.startRun(routeId(req.params.id), nodeId, options));
  });
  app.post('/api/projects/:id/nodes/:nodeId/experiment-plan', (req, res) => {
    const body = z.object({ request: z.string().trim().min(1).max(12000), datasetArtifactId: identifier, backend: z.enum(['bounded','docker-python','nebius-sandbox']).default('bounded') }).strict().parse(req.body);
    if (!execution.startExperimentPlan) throw new StoreError('Model experiment planning is unavailable', 503);
    res.status(201).json(execution.startExperimentPlan(routeId(req.params.id), routeId(req.params.nodeId), body));
  });
  app.post('/api/runs/:id/cancel', (req, res) => {
    const id = routeId(req.params.id);
    res.json(experiments?.owns(id) ? experiments.cancel(id) : execution.cancelRun(id));
  });
  app.post('/api/runs/:id/retry', (req, res) => {
    const id = routeId(req.params.id);
    res.status(201).json(experiments?.owns(id) ? experiments.retry(id).run : execution.retryRun(id));
  });
  attachResultHandoffRoutes(app,store);
  app.post('/api/projects/:id/inputs', (req, res) => {
    const body = z.object({ nodeId: identifier, artifactId: identifier, excerpt: z.string().max(200000).optional() }).strict().parse(req.body);
    res.status(201).json(store.addInput(routeId(req.params.id), body.nodeId, body.artifactId, body.excerpt));
  });
  app.delete('/api/projects/:id/inputs/:inputId', (req, res) => {
    store.removeInput(routeId(req.params.id), routeId(req.params.inputId));
    res.json({ ok: true });
  });
  app.get('/api/connections', (_req, res) => res.json(execution.connectionStatuses()));
  app.get('/api/usage', (_req, res) => res.json(store.listUsage()));
  app.get('/api/settings/general', (_req, res) => res.json({ dataDir: options.localPaths?.dataDir ?? null, keysFile: options.localPaths?.keysFile ?? null }));
  const spendingBudget = new SpendingBudget(store);
  if (!options.publicDemo) attachSpendingBudgetRoutes(app, spendingBudget);
  if (!options.publicDemo) app.get('/api/usage/balances', async (_req, res) => res.json({ balances: await providerBalances({ usage: providerUsage, budget: spendingBudget, cloud: tools?.cloud, codex: agent ? () => agent.rateLimits() : undefined }) }));
  app.get('/api/usage/analytics', (_req, res) => res.json(usageAnalytics(store, Object.fromEntries((execution.inference?.statuses() ?? []).map(item => [item.id, item.name])))));
  app.get('/api/projects/:id/budget', async (req, res) => {
    const report = projectBudgetReport(store, routeId(req.params.id), { connections: execution.connectionStatuses(), sandbox: experiments?.capabilities().nebiusSandbox?.costGate });
    res.json({ ...report, providerAccounts: await providerUsage.read() });
  });
  app.get('/api/projects/:id/policy',(req,res)=>res.json(authority.policy(routeId(req.params.id))));
  app.put('/api/projects/:id/policy',(req,res)=>res.json(authority.configure(routeId(req.params.id),req.body)));
  app.patch('/api/projects/:id/nodes/:nodeId/policy',(req,res)=>{const {mode}=z.object({mode:modeSchema.nullable()}).strict().parse(req.body);res.json(authority.override(routeId(req.params.id),routeId(req.params.nodeId),mode));});
  app.post('/api/projects/:id/policy/resume',(req,res)=>res.json(authority.setStopped(routeId(req.params.id),false)));
  app.post('/api/projects/:id/stop',(req,res)=>{const id=routeId(req.params.id);assistant?.stopProject(id);guide?.stopProject(id);if(research)res.json(research.stopProject(id));else{authority.setStopped(id,true);for(const run of store.listRuns(id))if(['queued','running'].includes(run.status)){if(experiments?.owns(run.id))experiments.cancel(run.id);else execution.cancelRun(run.id);}res.json(authority.policy(id));}});
  app.get('/api/projects/:id/reviews',(req,res)=>res.json(store.records('review',routeId(req.params.id))));
  app.get('/api/projects/:id/local-connections',(req,res)=>res.json(connections.list(routeId(req.params.id))));
  app.get('/api/projects/:id/resources',(req,res)=>res.json(connections.resources(routeId(req.params.id))));
  app.post('/api/projects/:id/resources',(req,res)=>res.status(201).json(connections.addResource(routeId(req.params.id),req.body)));
  app.get('/api/projects/:id/resources/:resourceId',(req,res)=>res.json(connections.previewResource(routeId(req.params.id),routeId(req.params.resourceId))));
  app.post('/api/projects/:id/resources/:resourceId/use',(req,res)=>{const {nodeId}=z.object({nodeId:identifier}).strict().parse(req.body);res.status(201).json(connections.useResource(routeId(req.params.id),routeId(req.params.resourceId),nodeId));});
  app.post('/api/projects/:id/local-connections',(req,res)=>res.status(201).json(connections.add(routeId(req.params.id),req.body)));
  app.patch('/api/projects/:id/local-connections/:connectionId',(req,res)=>{const {writable}=z.object({writable:z.boolean()}).strict().parse(req.body);res.json(connections.setWritable(routeId(req.params.id),routeId(req.params.connectionId),writable));});
  app.post('/api/projects/:id/local-connections/:connectionId/import',(req,res)=>{const {nodeId}=z.object({nodeId:identifier}).strict().parse(req.body);res.status(201).json(connections.import(routeId(req.params.id),routeId(req.params.connectionId),nodeId));});
  app.post('/api/projects/:id/local-connections/:connectionId/export',(req,res)=>{const {artifactIds}=z.object({artifactIds:z.array(identifier).min(1).max(50)}).strict().parse(req.body);res.json(connections.export(routeId(req.params.id),routeId(req.params.connectionId),artifactIds));});
  app.post('/api/projects/:id/local-connections/:connectionId/write',(req,res)=>{const body=z.object({expectedHash:z.string().regex(/^[a-f0-9]{64}$/),content:z.string().min(1).max(500000)}).strict().parse(req.body);res.json(connections.replace(routeId(req.params.id),routeId(req.params.connectionId),body.expectedHash,body.content));});
  app.post('/api/projects/:id/highlights',(req,res)=>res.status(201).json(highlights.save(routeId(req.params.id),req.body)));
  app.patch('/api/projects/:id/highlights/:highlightId',(req,res)=>res.json(highlights.save(routeId(req.params.id),req.body,routeId(req.params.highlightId))));
  app.delete('/api/projects/:id/highlights/:highlightId',(req,res)=>{highlights.remove(routeId(req.params.id),routeId(req.params.highlightId));res.json({ok:true});});
  if(research){
    app.get('/api/projects/:id/research',(req,res)=>res.json(research.list(routeId(req.params.id))));
    app.post('/api/projects/:id/research',(req,res)=>res.status(201).json(research.start(routeId(req.params.id),req.body)));
    app.post('/api/research/:id/continue',(req,res)=>{const {message}=z.object({message:z.string().trim().min(1).max(12000).optional()}).strict().parse(req.body);res.json(research.continue(routeId(req.params.id),message));});
    app.post('/api/research/:id/stop',(req,res)=>res.json(research.stop(routeId(req.params.id))));
  }
  if (assistant) attachAssistantRoutes(app,assistant);
  if (tools?.outside) attachOutsideAgentRoutes(app,tools.outside);
  if (tools?.memory && !options.publicDemo) attachPersonalMemoryRoutes(app,tools.memory);
  if (tools?.skills && !options.publicDemo) attachSkillRoutes(app,tools.skills);
  if (experiments) attachExperimentRoutes(app, experiments);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'This API route does not exist.' }));
  return app;
}

export const apiErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({ error: error.issues.map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ') });
    return;
  }
  const message = error instanceof Error ? error.message : 'The request could not be completed.';
  // Provider adapters return curated errors, never upstream authorization/body details.
  const status = error instanceof StoreError ? error.status : /not found|does not exist/i.test(message) ? 404
    : /stale|revision|already|concurren|busy|running|conflict/i.test(message) ? 409
    : /budget|credential|configured|unavailable/i.test(message) ? 503 : 400;
  res.status(status).json({ error: message });
};
